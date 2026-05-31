// File-system + AsyncStorage helpers.
//
// Layout under expo-file-system documentDirectory:
//   books/<filename>.epub      — copied EPUB blob (immutable)
//   covers/<filename>.<ext>    — extracted cover image (matched basename)
//
// `<filename>` is human-readable: prefer the original name the user
// shared; if missing, compose from metadata as "Title by Author".
// On collision we suffix " (2)", " (3)" etc. (Calibre / Apple Books
// pattern). The bookId UUID lives ONLY in BookRecord.id — never
// in a filename — so users see meaningful names in `Files`, share
// sheets, ADB pulls, and exported library backups.
//
// Older imports stored as `<bookId>.epub` continue to work (BookRecord
// .filename is the source of truth and isn't migrated).
//
// Metadata index (JSON array of BookRecord) is stored in AsyncStorage under
// SPINE_LIBRARY_KEY. AsyncStorage is fine for the alpha — well under the 6MB
// soft cap on Android even with hundreds of books.

import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { BookRecord, Bookmark, Highlight, ParsedEpub } from "./types";

export const SPINE_LIBRARY_KEY = "spine.library.v1";
export const SPINE_PREFS_KEY = "spine.prefs.v1";
// Highlights and bookmarks live in their own AsyncStorage keys rather
// than nested inside BookRecord — a single write of the library array
// shouldn't have to serialise a long list of annotation rows, and the
// future SQLite migration is cleaner with one table per concept.
export const SPINE_HIGHLIGHTS_KEY = "spine.highlights.v1";
export const SPINE_BOOKMARKS_KEY = "spine.bookmarks.v1";

export const BOOKS_DIR = `${FileSystem.documentDirectory}books/`;
export const COVERS_DIR = `${FileSystem.documentDirectory}covers/`;

async function ensureDir(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

export async function ensureLibraryDirs(): Promise<void> {
  await ensureDir(BOOKS_DIR);
  await ensureDir(COVERS_DIR);
}

export function bookFilePath(filename: string): string {
  return `${BOOKS_DIR}${filename}`;
}

export function coverFilePath(filename: string): string {
  return `${COVERS_DIR}${filename}`;
}

// --- Human-readable filename composition --------------------------------

// Characters illegal in Windows filenames + control chars. Android FAT/exFAT
// SD cards inherit Windows limits even on Linux phones, so being strict
// here means the EPUB stays portable across `adb pull`, sync apps, etc.
const FS_ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
const COLLAPSE_WS = /\s+/g;

function sanitizeBaseName(raw: string): string {
  // Strip filesystem-illegal bytes, fold whitespace, trim, and clip
  // to a safe length. 120 chars leaves headroom for " (12).epub"
  // suffixes without bumping the 255-byte UTF-8 ceiling on most FSes.
  const cleaned = raw
    .replace(FS_ILLEGAL, " ")
    .replace(COLLAPSE_WS, " ")
    .trim()
    .replace(/^\.+/, "") // no leading dots — POSIX hidden file convention
    .replace(/[. ]+$/, ""); // no trailing dots/spaces — Windows truncates
  if (cleaned.length === 0) return "";
  return cleaned.slice(0, 120);
}

function stripExtension(name: string, ext: string): string {
  const lower = name.toLowerCase();
  const dot = `.${ext.toLowerCase()}`;
  return lower.endsWith(dot) ? name.slice(0, name.length - dot.length) : name;
}

/** Pick a display-grade basename (no extension) for a book file.
 *
 *   - Prefer the original name the user shared, when it carries any
 *     useful information ("alice-in-wonderland" beats "tmp_47abc").
 *   - Fall back to the EPUB metadata: "Title by Author".
 *   - Final fallback: "Untitled" (caller will append a unique suffix).
 *
 * Never returns an empty string. */
export function composeStorageBasename(opts: {
  originalName?: string | null;
  title?: string | null;
  author?: string | null;
  ext: string;
}): string {
  const fromOriginal = opts.originalName
    ? sanitizeBaseName(stripExtension(opts.originalName, opts.ext))
    : "";
  // Reject opaque names like the ones from system content providers
  // ("tmp_xxxx", "share_1234", random hex). Heuristic: a meaningful
  // name has at least one letter AND isn't a bare hex string.
  const looksOpaque =
    fromOriginal.length === 0 ||
    /^[0-9a-f]{8,}$/i.test(fromOriginal) ||
    /^(?:tmp|temp|share|content|file)[_-]?\d*$/i.test(fromOriginal) ||
    !/[a-z]/i.test(fromOriginal);
  if (!looksOpaque) return fromOriginal;

  const title = opts.title ? sanitizeBaseName(opts.title) : "";
  const author = opts.author ? sanitizeBaseName(opts.author) : "";
  if (title && author && author.toLowerCase() !== "unknown author") {
    return sanitizeBaseName(`${title} by ${author}`) || "Untitled";
  }
  return title || "Untitled";
}

/** Resolve a unique filename in `dir` by appending " (2)", " (3)" …
 * until we find one that doesn't already exist. Mirrors the
 * Apple Books / Calibre / Windows Explorer collision pattern.
 *
 * `dir` must already end with "/" — every caller in this file uses
 * BOOKS_DIR / COVERS_DIR which do. */
async function nextAvailableFilename(
  dir: string,
  baseStem: string,
  ext: string,
): Promise<string> {
  // Pull the directory listing once and resolve in memory. Many
  // sequential getInfoAsync calls would round-trip the JSI bridge
  // for each candidate — slow when the user just imported 200 books
  // from a ZIP and 50 share a stem.
  let existing: Set<string>;
  try {
    const entries = await FileSystem.readDirectoryAsync(dir);
    existing = new Set(entries.map((e) => e.toLowerCase()));
  } catch {
    existing = new Set();
  }
  const stem = baseStem || "Untitled";
  const candidate = `${stem}.${ext}`;
  if (!existing.has(candidate.toLowerCase())) return candidate;
  // Cap at 9999 to avoid a runaway loop on a misbehaving filesystem
  // (e.g. readDir returns stale entries that won't ever go away).
  for (let n = 2; n < 10000; n++) {
    const variant = `${stem} (${n}).${ext}`;
    if (!existing.has(variant.toLowerCase())) return variant;
  }
  // Last-ditch: stamp with epoch ms. Should never happen.
  return `${stem} (${Date.now()}).${ext}`;
}

/** Copy a picked file (URI) into our document dir books/ folder.
 * `basename` should be the display-grade stem returned by
 * composeStorageBasename(); collision-resolution is handled here. */
export async function importEpubFile(
  srcUri: string,
  basename: string,
): Promise<string> {
  await ensureLibraryDirs();
  const filename = await nextAvailableFilename(BOOKS_DIR, basename, "epub");
  const dest = bookFilePath(filename);
  await FileSystem.copyAsync({ from: srcUri, to: dest });
  return filename;
}

/** Resolve a unique books/ filename for callers that write to the
 * destination themselves (e.g. the native ZIP extractor writes
 * directly to the path). Wraps the internal collision helper so
 * library.ts doesn't need to know about COVERS_DIR vs BOOKS_DIR. */
export async function nextAvailableBookFilename(
  basename: string,
): Promise<string> {
  await ensureLibraryDirs();
  return nextAvailableFilename(BOOKS_DIR, basename, "epub");
}

/** Persist extracted EPUB bytes into our document dir books/ folder. */
export async function writeEpubBytes(
  bytes: Uint8Array,
  basename: string,
): Promise<string> {
  await ensureLibraryDirs();
  const filename = await nextAvailableFilename(BOOKS_DIR, basename, "epub");
  const dest = bookFilePath(filename);
  await FileSystem.writeAsStringAsync(dest, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return filename;
}

/** Rename a book file in books/ to a new metadata-derived basename.
 * Returns the new filename, or null if the move failed. Handles
 * collisions via nextAvailableFilename so a rename can never overwrite
 * an existing book. Caller is responsible for updating BookRecord.filename
 * and the matching cover (use renameCoverFile for that).
 *
 * Used to upgrade a provisional "Untitled.epub" to a metadata-derived
 * name once parsing finishes. */
export async function renameBookFile(
  oldFilename: string,
  newBasename: string,
): Promise<string | null> {
  const newFilename = await nextAvailableFilename(BOOKS_DIR, newBasename, "epub");
  if (newFilename === oldFilename) return oldFilename;
  await FileSystem.moveAsync({
    from: bookFilePath(oldFilename),
    to: bookFilePath(newFilename),
  });
  return newFilename;
}

/** Read the imported EPUB back into memory for parsing. */
export async function readEpubBytes(filename: string): Promise<Uint8Array> {
  const path = bookFilePath(filename);
  const b64 = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(b64);
}

/** Write the cover image bytes to covers/. Returns the filename.
 * Cover basename is derived from the book's storage basename so the
 * cover and book sit side-by-side in `adb pull` output and library
 * exports. */
export async function writeCover(
  bookBasename: string,
  parsed: ParsedEpub,
): Promise<string | null> {
  if (!parsed.cover) return null;
  await ensureLibraryDirs();
  const filename = await nextAvailableFilename(
    COVERS_DIR,
    bookBasename || "Untitled",
    parsed.cover.ext,
  );
  const path = coverFilePath(filename);
  await FileSystem.writeAsStringAsync(path, bytesToBase64(parsed.cover.data), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return filename;
}

export async function deleteBookFiles(book: BookRecord): Promise<void> {
  await Promise.allSettled([
    FileSystem.deleteAsync(bookFilePath(book.filename), { idempotent: true }),
    book.coverFilename
      ? FileSystem.deleteAsync(coverFilePath(book.coverFilename), { idempotent: true })
      : Promise.resolve(),
  ]);
}

export async function deleteLibraryStorage(): Promise<void> {
  // Annotations belong to books — wiping the library wipes them too.
  // Dictionaries are deliberately left alone (different scope: a
  // user wiping their library shouldn't lose a 30 MB GCIDE download).
  await Promise.allSettled([
    FileSystem.deleteAsync(BOOKS_DIR, { idempotent: true }),
    FileSystem.deleteAsync(COVERS_DIR, { idempotent: true }),
    AsyncStorage.removeItem(SPINE_LIBRARY_KEY),
    AsyncStorage.removeItem(SPINE_HIGHLIGHTS_KEY),
    AsyncStorage.removeItem(SPINE_BOOKMARKS_KEY),
  ]);
  await ensureLibraryDirs();
}

export async function loadLibrary(): Promise<BookRecord[]> {
  const raw = await AsyncStorage.getItem(SPINE_LIBRARY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as BookRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveLibrary(books: BookRecord[]): Promise<void> {
  await AsyncStorage.setItem(SPINE_LIBRARY_KEY, JSON.stringify(books));
}

// --- Annotations: highlights + bookmarks -------------------------------
//
// Both arrays are loaded once at hydrate time and held in the library
// store. Reads are O(N) filters against in-memory arrays — fine up to
// a few thousand records. Writes serialise through booksMutationQueue
// (see store/library.ts) so they can never race with each other or
// with a concurrent book delete.
//
// Schema-version-aware load: rows missing schemaVersion or carrying a
// version newer than this build are dropped silently. No migration UI
// in the alpha — the export/import path lets the user round-trip
// across versions if they really need to recover.

function isHighlight(v: unknown): v is Highlight {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.bookId === "string" &&
    typeof r.cfiRange === "string" &&
    typeof r.text === "string" &&
    typeof r.color === "string" &&
    r.schemaVersion === 1
  );
}

function isBookmark(v: unknown): v is Bookmark {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.bookId === "string" &&
    typeof r.cfi === "string" &&
    r.schemaVersion === 1
  );
}

export async function loadHighlights(): Promise<Highlight[]> {
  const raw = await AsyncStorage.getItem(SPINE_HIGHLIGHTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHighlight);
  } catch {
    return [];
  }
}

export async function saveHighlights(highlights: Highlight[]): Promise<void> {
  await AsyncStorage.setItem(SPINE_HIGHLIGHTS_KEY, JSON.stringify(highlights));
}

export async function loadBookmarks(): Promise<Bookmark[]> {
  const raw = await AsyncStorage.getItem(SPINE_BOOKMARKS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBookmark);
  } catch {
    return [];
  }
}

export async function saveBookmarks(bookmarks: Bookmark[]): Promise<void> {
  await AsyncStorage.setItem(SPINE_BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

// --- base64 helpers (RN doesn't ship Buffer) ---

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)]!;
    out += B64_CHARS[((b & 0x0f) << 2) | (c >> 6)]!;
    out += B64_CHARS[c & 0x3f]!;
  }
  if (i < bytes.length) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) {
      out += B64_CHARS[(b & 0x0f) << 2]!;
      out += "=";
    } else {
      out += "==";
    }
  }
  return out;
}

// Sentinel for chars not in the b64 alphabet — pre-filled so we can reject
// malformed input. Without validation, an invalid char silently decoded as
// 0 and produced corrupt bytes (code review finding).
const B64_INVALID = 0xff;

const B64_LOOKUP = (() => {
  const t = new Uint8Array(128).fill(B64_INVALID);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) {
    throw new Error("base64ToBytes: input length not a multiple of 4");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytesLen = (clean.length / 4) * 3 - padding;
  const out = new Uint8Array(bytesLen);
  let p = 0;
  const lookupOrThrow = (charCode: number, padOk: boolean): number => {
    if (charCode === 0x3d) {
      if (!padOk) throw new Error("base64ToBytes: stray '=' before end");
      return 0;
    }
    if (charCode >= 128) {
      throw new Error("base64ToBytes: non-ASCII character in input");
    }
    const v = B64_LOOKUP[charCode]!;
    if (v === B64_INVALID) {
      throw new Error("base64ToBytes: invalid character in input");
    }
    return v;
  };
  for (let i = 0; i < clean.length; i += 4) {
    const isLast = i + 4 >= clean.length;
    const a = lookupOrThrow(clean.charCodeAt(i), false);
    const b = lookupOrThrow(clean.charCodeAt(i + 1), false);
    const c = lookupOrThrow(clean.charCodeAt(i + 2), isLast);
    const d = lookupOrThrow(clean.charCodeAt(i + 3), isLast);
    if (p < bytesLen) out[p++] = (a << 2) | (b >> 4);
    if (p < bytesLen) out[p++] = ((b & 0x0f) << 4) | (c >> 2);
    if (p < bytesLen) out[p++] = ((c & 0x03) << 6) | d;
  }
  return out;
}
