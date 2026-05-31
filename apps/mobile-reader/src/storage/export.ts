// Library export — writes a JSON snapshot of metadata (no EPUB blobs) to
// documentDirectory/exports/. Matches the mockup's "JSON · BIBFRAME-Lite"
// label conceptually: a flat per-book record, not yet a real BIBFRAME graph.

import * as FileSystem from "expo-file-system/legacy";

import type { BookRecord, Bookmark, Highlight } from "../types";

const EXPORT_DIR = `${FileSystem.documentDirectory}exports/`;

const FS_ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
function safeBaseName(raw: string): string {
  return raw.replace(FS_ILLEGAL, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "book";
}

async function ensureExportDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  }
}

interface ExportEnvelope {
  format: "spine.library.v1";
  generatedAt: string;
  /** Hint that this is the alpha's flat projection, not the BIBFRAME graph. */
  schema: "flat";
  count: number;
  books: Array<Omit<BookRecord, "filename" | "coverFilename">>;
}

export async function exportLibraryJson(books: BookRecord[]): Promise<string> {
  await ensureExportDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${EXPORT_DIR}spine-library-${stamp}.json`;

  const envelope: ExportEnvelope = {
    format: "spine.library.v1",
    generatedAt: new Date().toISOString(),
    schema: "flat",
    count: books.length,
    books: books.map(({ filename: _f, coverFilename: _c, ...rest }) => rest),
  };

  await FileSystem.writeAsStringAsync(path, JSON.stringify(envelope, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });

  return path;
}

interface AnnotationsEnvelope {
  format: "spine.annotations.v1";
  generatedAt: string;
  book: {
    id: string;
    title: string;
    author: string;
    language: string | null;
  };
  highlights: Highlight[];
  bookmarks: Bookmark[];
}

/** Write the per-book annotations JSON to the exports directory and
 * return the absolute path. Caller is responsible for handing the path
 * to the system share sheet (or whatever else). */
export async function exportAnnotationsJson(
  book: BookRecord,
  highlights: Highlight[],
  bookmarks: Bookmark[],
): Promise<string> {
  await ensureExportDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = safeBaseName(`spine-annotations-${book.title}`);
  const path = `${EXPORT_DIR}${stem}-${stamp}.json`;

  const envelope: AnnotationsEnvelope = {
    format: "spine.annotations.v1",
    generatedAt: new Date().toISOString(),
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      language: book.language,
    },
    highlights,
    bookmarks,
  };

  await FileSystem.writeAsStringAsync(path, JSON.stringify(envelope, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return path;
}
