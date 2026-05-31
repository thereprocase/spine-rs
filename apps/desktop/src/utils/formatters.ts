// Extract a 4-digit year from a date-ish string without timezone skew.
// `new Date("1984-01-01").getFullYear()` can return 1983 in negative-UTC zones,
// which quietly corrupted historical dates; prefer the literal leading year
// when one is present and only fall through to Date parsing if it isn't.
export function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const trimmed = String(dateStr).trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^-?\d{4}/);
  if (match) {
    const parsed = parseInt(match[0], 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const date = new Date(trimmed);
  const year = date.getFullYear();
  if (Number.isNaN(year)) return null;
  return year;
}

// Translate backend error strings into something the user can act on.
// Raw rusqlite/SqliteFailure strings leak implementation detail; network
// failures need a clear "check your connection" so users on corporate proxies
// or offline know it's not the app's fault.
// Long un-humanized strings are truncated to avoid toast walls; the full text
// still reaches the console for debugging.
/** Classify an `open_library` / `create_library` error into a known
 *  recovery shape. Backend (per Sprint 8.5 hot-fix) returns typed
 *  `LibraryError::Uninitialized` / `LibraryError::WrongDatabaseFile`
 *  surfaced as text through the Tauri bridge. The classifier matches
 *  on robust text patterns so it works pre- and post-merge of the
 *  typed errors — pre-merge, the legacy "no such table: books"
 *  surface still classifies cleanly to Uninitialized.
 *
 *  Returns `null` when the error doesn't fit either bucket; callers
 *  fall back to the generic libraryError string display. */
export type LibraryErrorKind = "uninitialized" | "wrong-database-file";
export function classifyLibraryError(raw: unknown): LibraryErrorKind | null {
  const text = raw == null ? "" : String(raw);
  if (!text) return null;
  if (
    /LibraryError::Uninitialized|library[\s-]?uninitialized|0[\s-]?byte|no such table:?\s*books/i.test(
      text,
    )
  ) {
    return "uninitialized";
  }
  if (/LibraryError::WrongDatabaseFile|wrong[\s-]?database[\s-]?file|not a calibre/i.test(text)) {
    return "wrong-database-file";
  }
  return null;
}

export function humanizeBackendError(raw: unknown): string {
  const text = raw == null ? "" : String(raw);
  if (!text) return "Unknown error";
  if (/SqliteFailure|rusqlite::Error|database is locked/i.test(text)) {
    console.error("Database error:", text);
    if (/database is locked/i.test(text)) {
      return "Database is locked — close other apps using this library and try again";
    }
    return "Database error (technical detail in console)";
  }
  if (/\bconnect(ion)?\b|connection refused|timed? out|timeout|dns error|getaddrinfo|failed to lookup|network is unreachable|unreachable|\beconn|\bproxy\b|\btls\b|certificate|\bdns\b/i.test(text)) {
    return "Network error — check your connection";
  }
  if (text.length > 200) {
    console.error("Backend error (truncated):", text);
    return text.slice(0, 200) + "… (full detail in console)";
  }
  return text;
}

// Strip Windows `\\?\` extended-length prefix for display only.
// The canonical form returned by `build_session` is load-bearing for the
// backend — keep the stored path intact, just shorten the UI string.
export function displayPath(path: string): string {
  if (!path) return path;
  return path.replace(/^\\\\\?\\/, "");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Cap the rejected-file list at 3 names to avoid toast walls when the user
// drags a whole download folder of PDFs onto the window.
export function formatRejected(rejected: string[]): string {
  if (rejected.length === 0) return "";
  const suffix = rejected.length === 1 ? "" : "s";
  const head = rejected.slice(0, 3).map(basename).join(", ");
  const tail = rejected.length > 3 ? ` and ${rejected.length - 3} more` : "";
  return `  Skipped ${rejected.length} unsupported file${suffix}: ${head}${tail}`;
}

export function emptyProjectionMessage(navSection: "core" | "sidecar" | "reading", searchQuery: string): string {
  if (searchQuery) return "No books match this search.";
  if (navSection === "sidecar") return "No books need review.";
  if (navSection === "reading") return "No books have saved reading progress yet.";
  return "No books are available in this library.";
}

// Thousands separator for counts across the library chrome (sidebar
// counts, toolbar "N books"). Uses en-US locale intentionally — the
// design spec assumes a fixed thin-space-free grouping for tabular-nums
// alignment. Revisit if we add i18n.
export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

// Compact byte-size string for the Footer storage block + StatusBar
// corpus row. Uses 1024-binary units (KB/MB/GB) per librarian-disk
// convention; one decimal for MB+, integer for KB and below. en-US
// locale to match `fmtNum`.
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 })} ${units[unit]}`;
}

const RELDATE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

// Elegant relative date: "just now" / "3h ago" / "yesterday" / "4d ago" /
// "2w ago" / "Apr 17" / "Apr 2024". Accepts an explicit `now` for
// deterministic tests.
export function relDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const diffMs = now.getTime() - then.getTime();
  const diffH = diffMs / 3_600_000;
  const diffD = diffH / 24;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffD < 2) return "yesterday";
  if (diffD < 7) return `${Math.floor(diffD)}d ago`;
  if (diffD < 30) return `${Math.floor(diffD / 7)}w ago`;
  const month = RELDATE_MONTHS[then.getMonth()];
  return then.getFullYear() === now.getFullYear()
    ? `${month} ${then.getDate()}`
    : `${month} ${then.getFullYear()}`;
}

export interface CoverPalette {
  bg: string;
  ink: string;
  rule: string;
}

// 8 warm-neutral book-cloth palettes from the design handoff. Entry #2
// (oxblood / brass) matches the brand accent; the rest are studio-neutral
// variants so a library of placeholders reads as a shelf of books rather
// than a swatch grid.
const COVER_PALETTES: readonly CoverPalette[] = [
  { bg: "#3d3530", ink: "#d9c9a8", rule: "#8a7a62" }, // canvas / cream
  { bg: "#2e3a3a", ink: "#c9d6cc", rule: "#6b857b" }, // bottle / sage
  { bg: "#44261f", ink: "#e4b84f", rule: "#a8802d" }, // oxblood / brass (brand)
  { bg: "#1f2a33", ink: "#b8c7d1", rule: "#5a7080" }, // naval
  { bg: "#332a24", ink: "#c9b9a3", rule: "#7a6753" }, // leather
  { bg: "#2a2e35", ink: "#b5b8c4", rule: "#626878" }, // charcoal cloth
  { bg: "#3a2e2a", ink: "#d4b39a", rule: "#8a6e5c" }, // russet
  { bg: "#243030", ink: "#a8c4bc", rule: "#5a7872" }, // pine
] as const;

// djb2-style hash — identical to the prototype so palette selection stays
// stable across the React prototype, the TS port, and any future Rust-side
// rendering. Do not swap algorithms without bumping a version.
function hashCode(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function coverPalette(title: string, author: string): CoverPalette {
  const h = hashCode(`${title}|${author}`);
  return COVER_PALETTES[h % COVER_PALETTES.length];
}
