// Zustand store for the imported library. Hydrates from AsyncStorage on first
// access; mutations write through to disk + persisted index.

import { create } from "zustand";
import * as DocumentPicker from "expo-document-picker";
import { NativeModules, Platform } from "react-native";

import type { BookRecord, Bookmark, Highlight, HighlightColor, ParsedEpub } from "../types";
import {
  bookFilePath,
  deleteBookFiles,
  deleteLibraryStorage,
  ensureLibraryDirs,
  composeStorageBasename,
  importEpubFile,
  loadBookmarks,
  loadHighlights,
  nextAvailableBookFilename,
  renameBookFile,
  loadLibrary,
  readEpubBytes,
  saveBookmarks,
  saveHighlights,
  saveLibrary,
  writeCover,
} from "../storage";
import { parseEpubMetadata } from "../parser/epub";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function placeholderParsed(name: string | null): ParsedEpub {
  let title = (name ?? "").replace(/\.epub$/i, "").trim();
  // Some share-intent flows (WhatsApp's content-provider re-encoding) hand
  // us an opaque UUID-shaped filename. Don't surface that as the book
  // title — it looks like garbage in the library grid.
  if (!title || UUID_RE.test(title)) {
    return {
      title: "Untitled",
      author: "Unknown author",
      language: null,
      subjects: [],
      cover: null,
    };
  }
  // Calibre/fanfic exports name files like
  // "40k_Fic_Recs_by_Basiclus-zk2c966s.epub" — strip the trailing
  // `-<base32hash>` suffix and turn underscores into spaces so the library
  // shows a half-decent title when the OPF parse couldn't run.
  title = title.replace(/-[A-Za-z0-9_]{6,16}$/, "");
  title = title.replace(/_/g, " ").trim();
  if (!title) title = "Untitled";
  const byMatch = title.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      title: byMatch[1]!.trim(),
      author: byMatch[2]!.trim(),
      language: null,
      subjects: [],
      cover: null,
    };
  }
  return { title, author: "Unknown author", language: null, subjects: [], cover: null };
}

export interface ImportProgress {
  current: number;
  total: number;
  label: string;
}

interface LibraryState {
  hydrated: boolean;
  importing: boolean;
  importProgress: ImportProgress | null;
  books: BookRecord[];
  highlights: Highlight[];
  bookmarks: Bookmark[];
  error: string | null;
  hydrate: () => Promise<void>;
  importEpub: () => Promise<BookRecord | null>;
  deleteBook: (id: string) => Promise<void>;
  deleteLibrary: () => Promise<void>;
  clearError: () => void;
  /** Append a new highlight. Returns the persisted record (with
   * server-stamped id + timestamps) so the caller can render it
   * immediately. Concurrent calls are serialised through the books
   * mutation queue — same pattern, same correctness story. */
  addHighlight: (
    h: Omit<Highlight, "id" | "createdAt" | "updatedAt" | "schemaVersion">,
  ) => Promise<Highlight>;
  /** Update color and/or note on an existing highlight. */
  updateHighlight: (
    id: string,
    patch: Partial<Pick<Highlight, "color" | "note">>,
  ) => Promise<void>;
  removeHighlight: (id: string) => Promise<void>;
  /** Toggle a bookmark for a (book, cfi) pair. If a bookmark with
   * the same cfi already exists for this book, it's removed (returns
   * null). Otherwise a new one is created (returns the record). */
  toggleBookmark: (
    bookmark: Omit<Bookmark, "id" | "createdAt" | "schemaVersion">,
  ) => Promise<Bookmark | null>;
  removeBookmark: (id: string) => Promise<void>;
  setProgress: (id: string, progress: number) => Promise<void>;
  setReadingPosition: (
    id: string,
    cfi: string | null,
    progress: number,
    /** Active reading delta in ms to add to the cumulative counter. */
    activeMsDelta?: number,
    /** Characters read delta to add to the cumulative counter. */
    charsDelta?: number,
    /** Estimated total chars to cache on first compute. */
    totalChars?: number | null,
  ) => Promise<void>;
  touchOpened: (id: string) => Promise<void>;
  /** Import an EPUB from a URI received via a system "Open with" intent —
   * skips the document picker and goes straight to the persist + parse
   * pipeline. ZIPs are unpacked and every contained EPUB is copied into
   * app storage. Returns imported records, or an empty array. */
  importFromUri: (uri: string, name?: string | null, mimeType?: string | null) => Promise<BookRecord[]>;
}

function uuidv4(): string {
  // RFC4122 v4-ish. Math.random is sufficient for an alpha.
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      s += "-";
    } else if (i === 14) {
      s += "4";
    } else if (i === 19) {
      s += ((Math.random() * 4) | 0 | 8).toString(16);
    } else {
      s += ((Math.random() * 16) | 0).toString(16);
    }
  }
  return s;
}

// Single module-scoped serialization queue for ALL writes to
// state.books. Two patterns of races used to lose data here:
//
//   1. setReadingPosition fired from rapid `location` events read the
//      same snapshot, appended their deltas, and the latter's save
//      wiped the former's accumulation.
//   2. addImportedEpub firing concurrently from a share intent + an
//      "open with" deep-link both read books=[] and the second's
//      set({books: ...}) wiped the first's record.
//
// Originally fixed with two SEPARATE queues, but those still raced
// AGAINST EACH OTHER: an import's read+set could interleave with a
// reading-position's read+set across the queue boundary and either
// one could clobber the other (Zustand `set` is not transactional
// for concurrent callers). One queue means every read-modify-write
// of `books` happens in series.
let booksMutationQueue: Promise<unknown> = Promise.resolve();

function fileNameFromUri(uri: string): string {
  const stripped = uri.split("?")[0]!;
  const last = stripped.split("/").pop() ?? stripped;
  return decodeURIComponent(last);
}

/** Backfill fields added in newer schema versions onto records loaded
 * from older AsyncStorage snapshots. Defensive against type drift —
 * a hand-edited or schema-migrated record could carry a string where
 * a number is expected (e.g. tags="sci-fi" instead of ["sci-fi"]),
 * which would crash every consumer that iterates `book.tags`.
 * Idempotent: safe to call on records that already have everything. */
function normalizeRecord(b: BookRecord): BookRecord {
  // Treat NaN as "not a valid number" — Math.max etc would propagate
  // the NaN and corrupt downstream pace math.
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const tags = Array.isArray(b.tags)
    ? b.tags.filter((t) => typeof t === "string")
    : [];
  const progress = num(b.progress, 0);
  return {
    ...b,
    tags,
    progress: Math.max(0, Math.min(1, progress)),
    activeReadMs: Math.max(0, num(b.activeReadMs, 0)),
    charsRead: Math.max(0, num(b.charsRead, 0)),
    totalChars: numOrNull(b.totalChars),
    lastCfi: typeof b.lastCfi === "string" ? b.lastCfi : null,
    lastOpenedAt: typeof b.lastOpenedAt === "string" ? b.lastOpenedAt : null,
  };
}

interface NativeZipEntry {
  entryName: string;
  displayName: string;
  size: number;
}

interface SpineZipModule {
  /** Stage a content://… ZIP into a controlled inbox so the importer has
   * stable random-access. Returns the staged file's absolute path. */
  stageZipFromUri(uri: string): Promise<{ zipPath: string; size: number }>;
  /** Enumerate .epub entries without extracting any of them. */
  listEpubEntries(zipPath: string): Promise<NativeZipEntry[]>;
  /** Extract one entry to an absolute destination path (file:// URI ok). */
  extractEntry(zipPath: string, entryName: string, destPath: string): Promise<number>;
  /** Best-effort delete used to clean up the inbox after a finished run. */
  deleteFile(path: string): Promise<boolean>;
}

const SpineZip = NativeModules.SpineZip as SpineZipModule | undefined;

export const useLibrary = create<LibraryState>((set, get) => ({
  hydrated: false,
  importing: false,
  importProgress: null,
  books: [],
  highlights: [],
  bookmarks: [],
  error: null,

  hydrate: async () => {
    if (get().hydrated) return;
    await ensureLibraryDirs();
    // Load all three concurrently — three AsyncStorage reads have no
    // ordering dependency on each other.
    const [raw, highlights, bookmarks] = await Promise.all([
      loadLibrary(),
      loadHighlights(),
      loadBookmarks(),
    ]);
    const books = raw.map(normalizeRecord);
    set({ books, highlights, bookmarks, hydrated: true });
  },

  importEpub: async () => {
    set({ importing: true, error: null });
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          "application/epub+zip",
          "application/x-epub+zip",
          "application/zip",
          "application/x-zip-compressed",
          "*/*",
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) {
        set({ importing: false });
        return null;
      }
      const asset = res.assets[0]!;
      const lower = (asset.name ?? fileNameFromUri(asset.uri)).toLowerCase();
      if (lower.endsWith(".zip")) {
        const records = await ingestZipUri(asset.uri, asset.name ?? "Archive.zip", get, set);
        return records[0] ?? null;
      }
      if (!lower.endsWith(".epub")) {
        set({ importing: false, error: `Not an EPUB or ZIP: ${asset.name}` });
        return null;
      }
      return await ingestEpubUri(asset.uri, asset.name ?? null, asset.size ?? null, get, set);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Import failed";
      set({ importing: false, error: msg });
      return null;
    }
  },

  deleteBook: async (id) => {
    // Through the queue: a long-press delete during a setReadingPosition
    // tail would otherwise both read books, mutate independently, and
    // the second set() would resurrect the deleted record (or worse,
    // miss the in-flight progress write).
    //
    // Cascade-delete annotations in the SAME queue step. If we deferred
    // them to a follow-up tail, a render between the two steps would
    // briefly show orphan highlights pointing at a book that no longer
    // exists — and a crash between the two would leave permanent
    // orphans. One step, one set() at the end.
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const book = get().books.find((b) => b.id === id);
        if (!book) return;
        await deleteBookFiles(book);
        const next = get().books.filter((b) => b.id !== id);
        const nextHighlights = get().highlights.filter((h) => h.bookId !== id);
        const nextBookmarks = get().bookmarks.filter((b) => b.bookId !== id);
        await Promise.all([
          saveLibrary(next),
          saveHighlights(nextHighlights),
          saveBookmarks(nextBookmarks),
        ]);
        set({
          books: next,
          highlights: nextHighlights,
          bookmarks: nextBookmarks,
        });
      });
    booksMutationQueue = tail;
    return tail;
  },

  clearError: () => set({ error: null }),

  addHighlight: async (input) => {
    const now = new Date().toISOString();
    const record: Highlight = {
      id: uuidv4(),
      bookId: input.bookId,
      cfiRange: input.cfiRange,
      text: input.text,
      textBefore: input.textBefore,
      textAfter: input.textAfter,
      chapterHref: input.chapterHref,
      chapterLabel: input.chapterLabel,
      color: input.color,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    const tail: Promise<Highlight> = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = [record, ...get().highlights];
        await saveHighlights(next);
        set({ highlights: next });
        return record;
      });
    booksMutationQueue = tail;
    return tail;
  },

  updateHighlight: async (id, patch) => {
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const fresh = get().highlights;
        let changed = false;
        const next = fresh.map((h) => {
          if (h.id !== id) return h;
          changed = true;
          const color: HighlightColor = patch.color ?? h.color;
          return {
            ...h,
            color,
            note: patch.note !== undefined ? patch.note : h.note,
            updatedAt: new Date().toISOString(),
          };
        });
        if (!changed) return;
        await saveHighlights(next);
        set({ highlights: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  removeHighlight: async (id) => {
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = get().highlights.filter((h) => h.id !== id);
        if (next.length === get().highlights.length) return;
        await saveHighlights(next);
        set({ highlights: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  toggleBookmark: async (input) => {
    // Toggle vs. add: same book + same CFI = remove. The CFI compare
    // is exact-string. Two bookmarks resolved to the "same" page after
    // a font-size change can have different CFIs (epubjs anchors on
    // characters, not page boundaries) — that's by design. The dog-ear
    // glyph uses tolerant containment instead, separately.
    const tail: Promise<Bookmark | null> = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const fresh = get().bookmarks;
        const existing = fresh.find(
          (b) => b.bookId === input.bookId && b.cfi === input.cfi,
        );
        if (existing) {
          const next = fresh.filter((b) => b.id !== existing.id);
          await saveBookmarks(next);
          set({ bookmarks: next });
          return null;
        }
        const record: Bookmark = {
          id: uuidv4(),
          bookId: input.bookId,
          cfi: input.cfi,
          chapterHref: input.chapterHref,
          chapterLabel: input.chapterLabel,
          snippet: input.snippet,
          createdAt: new Date().toISOString(),
          schemaVersion: 1,
        };
        const next = [record, ...fresh];
        await saveBookmarks(next);
        set({ bookmarks: next });
        return record;
      });
    booksMutationQueue = tail;
    return tail;
  },

  removeBookmark: async (id) => {
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = get().bookmarks.filter((b) => b.id !== id);
        if (next.length === get().bookmarks.length) return;
        await saveBookmarks(next);
        set({ bookmarks: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  deleteLibrary: async () => {
    // Same queue. Without it, an in-flight setReadingPosition could
    // re-write a book record we just nuked.
    set({ importing: true, error: null });
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await deleteLibraryStorage();
          set({
            books: [],
            highlights: [],
            bookmarks: [],
            importing: false,
            error: null,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Delete library failed";
          set({ importing: false, error: msg });
        }
      });
    booksMutationQueue = tail;
    return tail;
  },

  setProgress: async (id, progress) => {
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = get().books.map((b) =>
          b.id === id ? { ...b, progress: Math.max(0, Math.min(1, progress)) } : b,
        );
        await saveLibrary(next);
        set({ books: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  setReadingPosition: async (id, cfi, progress, activeMsDelta, charsDelta, totalChars) => {
    // Serialize concurrent calls to avoid the rapid-page-turn race
    // where two handlers each read the same `books` snapshot, append
    // their deltas, and the second's write loses the first's
    // accumulation. Each call queues behind the previous so deltas
    // accumulate cleanly.
    // Capture our specific tail so we return a promise scoped to OUR
    // step, not to whatever happens to be at the queue head later.
    // Without this, awaiting setReadingPosition would also wait for
    // any unrelated mutation enqueued afterward.
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        // Read fresh from the store inside the serialized step so we
        // don't capture a stale `books` reference at call time.
        const fresh = get().books;
        // Guard against NaN/Infinity: epubjs has been observed to
        // emit percentage:NaN on some rendition transitions; without
        // this guard a single NaN would persist to disk and corrupt
        // the record forever.
        const pSafe = Number.isFinite(progress) ? progress : 0;
        const dActive = Number.isFinite(activeMsDelta ?? 0) ? Math.max(0, activeMsDelta ?? 0) : 0;
        const dChars = Number.isFinite(charsDelta ?? 0) ? Math.max(0, charsDelta ?? 0) : 0;
        const next = fresh.map((b) => {
          if (b.id !== id) return b;
          return {
            ...b,
            lastCfi: cfi,
            progress: Math.max(0, Math.min(1, pSafe)),
            activeReadMs: b.activeReadMs + dActive,
            charsRead: b.charsRead + dChars,
            totalChars:
              totalChars !== undefined && totalChars !== null && totalChars > 0
                ? totalChars
                : b.totalChars,
            lastOpenedAt: new Date().toISOString(),
          };
        });
        await saveLibrary(next);
        set({ books: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  touchOpened: async (id) => {
    // Through the queue: cover-tap → touchOpened can fire while the
    // previous reader's setReadingPosition tail is still landing.
    const tail = booksMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const now = new Date().toISOString();
        const next = get().books.map((b) =>
          b.id === id ? { ...b, lastOpenedAt: now } : b,
        );
        await saveLibrary(next);
        set({ books: next });
      });
    booksMutationQueue = tail;
    return tail;
  },

  importFromUri: async (uri, name, mimeType) => {
    set({ importing: true, error: null });
    try {
      const fname = name ?? fileNameFromUri(uri);
      const lower = fname.toLowerCase();
      const mime = mimeType?.toLowerCase() ?? "";
      const isEpub =
        lower.endsWith(".epub") ||
        mime === "application/epub+zip" ||
        mime === "application/x-epub+zip";
      if (isEpub) {
        const record = await ingestEpubUri(uri, fname, null, get, set);
        return record ? [record] : [];
      }
      // Default to the staged-ZIP path. It handles both .zip archives
      // (multiple EPUBs inside) and the case where the source is actually
      // a single EPUB whose share-intent metadata didn't identify it as
      // such — ingestZipUri detects 0 EPUB entries and falls back to
      // treating the staged file as one EPUB.
      return await ingestZipUri(uri, fname, get, set);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Import failed";
      set({ importing: false, importProgress: null, error: msg });
      return [];
    }
  },
}));

// Shared ingestion path. Used by both the document-picker import and the
// "Open with" launch-URI flow.
async function ingestEpubUri(
  srcUri: string,
  name: string | null,
  knownSize: number | null,
  get: () => LibraryState,
  set: (s: Partial<LibraryState>) => void,
): Promise<BookRecord | null> {
  const bookId = uuidv4();
  // Provisional basename from the picker / share-intent filename. If
  // that's missing or opaque (e.g. content-provider tmp names), fall
  // back to "Untitled" — we'll rename to metadata-derived form once
  // we've parsed the EPUB.
  const provisional = composeStorageBasename({ originalName: name, ext: "epub" });
  const filename = await importEpubFile(srcUri, provisional);

  // Reading the EPUB into a JS Uint8Array goes through expo-file-system's
  // base64 decoder, which spikes the heap to ~6× the on-disk size. For
  // large fanfic compendiums this OOMs (java.lang.OutOfMemoryError —
  // ExponentFileSystem.readAsStringAsync). Fall back to a placeholder
  // record so the import still lands; the file is on disk and openable.
  let parsed: ParsedEpub;
  let byteLength = 0;
  try {
    const bytes = await readEpubBytes(filename);
    byteLength = bytes.byteLength;
    parsed = await parseEpubMetadata(bytes, name ?? "Untitled");
  } catch {
    parsed = placeholderParsed(name);
  }

  // If the user gave us no useful filename (provisional landed as
  // "Untitled.epub"), upgrade it to the metadata-derived form now
  // that we know the title and author.
  let finalFilename = filename;
  if (filename.toLowerCase().startsWith("untitled")) {
    const better = composeStorageBasename({
      title: parsed.title,
      author: parsed.author,
      ext: "epub",
    });
    if (better && better.toLowerCase() !== "untitled") {
      try {
        const renamed = await renameBookFile(filename, better);
        if (renamed) finalFilename = renamed;
      } catch {
        // Rename is a nice-to-have; if FileSystem.moveAsync rejects
        // (rare; usually only when source is already gone), keep the
        // provisional name. The book is still openable.
      }
    }
  }

  return await addImportedEpub(finalFilename, bookId, parsed, knownSize ?? byteLength, get, set);
}

async function ingestZipUri(
  srcUri: string,
  name: string,
  get: () => LibraryState,
  set: (s: Partial<LibraryState>) => void,
): Promise<BookRecord[]> {
  if (Platform.OS !== "android" || !SpineZip) {
    set({ importing: false, error: "ZIP import is only available in the Android build." });
    return [];
  }

  // Stage the WhatsApp/Open-with content://… ZIP into a controlled inbox
  // location. The original URI is short-lived; the staged copy survives
  // process death and supports random-access ZipFile reads.
  let zipPath: string;
  try {
    const staged = await SpineZip.stageZipFromUri(srcUri);
    zipPath = staged.zipPath;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    set({ importing: false, error: `Could not read ${name}: ${msg}` });
    return [];
  }

  let entries: NativeZipEntry[];
  try {
    entries = await SpineZip.listEpubEntries(zipPath);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    await SpineZip.deleteFile(zipPath).catch(() => undefined);
    set({ importing: false, error: `Could not read ${name}: ${msg}` });
    return [];
  }

  if (!entries.length) {
    // No nested EPUBs — the source might actually BE an EPUB (a ZIP whose
    // own files don't have .epub extensions). Try ingesting the staged
    // file as a single EPUB before giving up.
    try {
      const record = await ingestEpubUri(`file://${zipPath}`, name, null, get, set);
      await SpineZip.deleteFile(zipPath).catch(() => undefined);
      if (record) return [record];
    } catch {
      // fall through to the "no EPUB" error below
    }
    await SpineZip.deleteFile(zipPath).catch(() => undefined);
    set({ importing: false, importProgress: null, error: `No EPUB files found in ${name}` });
    return [];
  }

  const records: BookRecord[] = [];
  const failures: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    set({
      importProgress: {
        current: i + 1,
        total: entries.length,
        label: entry.displayName,
      },
    });
    try {
      const bookId = uuidv4();
      // Use the ZIP entry's display name as the basename — the user
      // sent us a ZIP that the producer (Calibre, archive.org, etc)
      // already named meaningfully. Collision-resolve so two entries
      // with the same name don't clobber each other.
      const provisional = composeStorageBasename({
        originalName: entry.displayName,
        ext: "epub",
      });
      const filename = await nextAvailableBookFilename(provisional);
      const dest = bookFilePath(filename);
      await SpineZip.extractEntry(zipPath, entry.entryName, dest);

      let parsed: ParsedEpub;
      let byteLength = 0;
      try {
        const bytes = await readEpubBytes(filename);
        byteLength = bytes.byteLength;
        parsed = await parseEpubMetadata(bytes, entry.displayName);
      } catch {
        parsed = placeholderParsed(entry.displayName);
      }
      // Same upgrade path as ingestEpubUri: if the ZIP entry name
      // was opaque, rename to "Title by Author.epub" post-parse.
      let finalFilename = filename;
      if (filename.toLowerCase().startsWith("untitled")) {
        const better = composeStorageBasename({
          title: parsed.title,
          author: parsed.author,
          ext: "epub",
        });
        if (better && better.toLowerCase() !== "untitled") {
          try {
            const renamed = await renameBookFile(filename, better);
            if (renamed) finalFilename = renamed;
          } catch {
            /* keep provisional */
          }
        }
      }
      const size = entry.size > 0 ? entry.size : byteLength;
      const record = await addImportedEpub(finalFilename, bookId, parsed, size, get, set);
      if (record) records.push(record);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      failures.push(`${entry.displayName}: ${msg}`);
    }
  }

  await SpineZip.deleteFile(zipPath).catch(() => undefined);

  if (failures.length > 0 && records.length > 0) {
    set({
      importing: false,
      importProgress: null,
      error: `Imported ${records.length} of ${entries.length} from ${name}. Skipped: ${failures.length}.`,
    });
  } else if (failures.length > 0) {
    set({
      importing: false,
      importProgress: null,
      error: `Could not import any EPUB from ${name}.`,
    });
  } else {
    set({ importing: false, importProgress: null });
  }
  return records;
}

async function addImportedEpub(
  filename: string,
  bookId: string,
  parsed: ParsedEpub,
  size: number,
  get: () => LibraryState,
  set: (s: Partial<LibraryState>) => void,
): Promise<BookRecord | null> {
  // Cover write can run in parallel with another import's queue step;
  // it only touches its own basename-keyed file. The store mutation
  // below MUST be serialized.
  // Derive cover basename from the EPUB's filename so book + cover
  // sit side-by-side ("Title by Author.epub" / "Title by Author.png")
  // in adb pull / library export output.
  const bookBasename = filename.replace(/\.epub$/i, "");
  const coverFilename = await writeCover(bookBasename, parsed);

  const record: BookRecord = {
    id: bookId,
    title: parsed.title,
    author: parsed.author,
    filename,
    coverFilename,
    size,
    language: parsed.language,
    importedAt: new Date().toISOString(),
    lastOpenedAt: null,
    progress: 0,
    lastCfi: null,
    tags: parsed.subjects,
    activeReadMs: 0,
    charsRead: 0,
    totalChars: null,
  };

  const next: Promise<BookRecord> = booksMutationQueue
    .catch(() => undefined)
    .then(async () => {
      // Fresh snapshot inside the serialized step, AFTER the previous
      // mutation's set() has settled. Without this, two concurrent
      // imports — or an import racing against a setReadingPosition —
      // both read books=[…stale] and the later set wipes the earlier
      // mutation.
      const fresh = [record, ...get().books];
      await saveLibrary(fresh);
      set({ books: fresh, importing: false });
      return record;
    });
  booksMutationQueue = next;
  return next;
}
