// Minimal book metadata for the alpha.
// Aligned conceptually with the desktop's Metadata model in
// core/spine-oeb/src/metadata.rs (titles[], creators[], identifiers[]),
// but flattened to first-only because the alpha doesn't yet model BIBFRAME.

export interface BookRecord {
  id: string; // uuid v4
  title: string;
  author: string; // "first creator", joined if multiple
  /** Path inside expo-file-system documentDirectory (filename only, no scheme). */
  filename: string;
  /** Path inside documentDirectory for the extracted cover image, or null. */
  coverFilename: string | null;
  /** Filesize in bytes for display. */
  size: number;
  /** Locale or BCP-47 lang tag from OPF, if present. */
  language: string | null;
  /** ISO date string (timezone-naive) when the file was imported. */
  importedAt: string;
  /** ISO date string of last open, or null if never opened. */
  lastOpenedAt: string | null;
  /** 0..1 progress, or 0 when never opened. */
  progress: number;
  /** EPUB CFI of the last visible location, passed to rendition.display() on
   * next open so reading position survives app restart. */
  lastCfi: string | null;
  /** Tags/subjects discovered from EPUB metadata. */
  tags: string[];
  /** Cumulative active reading time in ms across all sessions. Excludes
   * partial-page dwell (<3s, looks like skip-past) and lock-time
   * (>60s, looks like the device was off). Persisted on every location
   * event so the panel pace stats survive app restart. */
  activeReadMs: number;
  /** Cumulative characters read across all sessions. Used with
   * activeReadMs to derive a stable WPM that doesn't reset every open. */
  charsRead: number;
  /** Estimated total character count of the book (≈ N * 1024 from
   * book.locations.length()). Cached after the first open since
   * locations.generate runs once per session and the result is stable. */
  totalChars: number | null;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string | null;
  subjects: string[];
  /** Raw cover image bytes + mediaType, or null if no cover. */
  cover: { data: Uint8Array; mediaType: string; ext: string } | null;
}

/** Five colors. More turns into a menu nobody reads; fewer can't carry
 * the user's "by topic" / "by character" / "to revisit" mental model.
 * Yellow is the default because every paper book the user has ever
 * highlighted in was yellow. */
export type HighlightColor = "yellow" | "pink" | "green" | "blue" | "orange";

/** Highlights and Bookmarks are persisted as flat arrays in AsyncStorage,
 * keyed by spine.highlights.v1 / spine.bookmarks.v1. The schema is
 * deliberately a 1:1 row mapping to the future SQLite tables — same
 * field names, same nullability — so the migration is a copy-out, not
 * a rewrite. `schemaVersion` lets a forward-only reader skip records
 * it doesn't recognise rather than crashing. */
export interface Highlight {
  id: string; // uuid v4
  /** FK → BookRecord.id. Cascade-deleted when the book is removed. */
  bookId: string;
  /** epubjs CFI range expression for the highlighted span. */
  cfiRange: string;
  /** The selected text, captured at create time. Lets the browser
   * sheet show a snippet without re-rendering the EPUB, and gives
   * the re-anchor pass a target string when CFI breaks. */
  text: string;
  /** Up to 64 chars BEFORE the selection. Used to disambiguate when
   * the same text appears multiple times in a chapter — the
   * re-anchor pass searches for textBefore + text + textAfter. */
  textBefore: string;
  /** Up to 64 chars AFTER the selection. Same purpose. */
  textAfter: string;
  /** Spine href the selection lives under, hash stripped. Used to
   * group rows in the browser sheet by chapter. */
  chapterHref: string;
  /** Display label for the chapter (from the TOC). Persisted because
   * the TOC isn't always available when rendering the browser sheet
   * cold (e.g. before the rendition has loaded). */
  chapterLabel: string;
  color: HighlightColor;
  /** Reserved for the future "add note to highlight" feature. Not
   * editable in 0.3.0 — but persisted so an external import (Calibre,
   * Apple Books export) can land notes without losing them. */
  note: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  schemaVersion: 1;
}

export interface Bookmark {
  id: string; // uuid v4
  /** FK → BookRecord.id. Cascade-deleted when the book is removed. */
  bookId: string;
  /** epubjs CFI for the location. */
  cfi: string;
  /** Spine href the bookmark lives under, hash stripped. */
  chapterHref: string;
  /** Display label for the chapter (from the TOC). */
  chapterLabel: string;
  /** One line of context from the bookmarked location — first ~80
   * chars of visible text. Helps the browser sheet show meaningful
   * rows without having to re-open the EPUB. */
  snippet: string;
  createdAt: string; // ISO
  schemaVersion: 1;
}
