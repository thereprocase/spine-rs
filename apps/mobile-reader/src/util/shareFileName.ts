// Compose a human-readable share filename: "<title> by <author> (Spine).epub".
// The "(Spine)" tag is the source-abbrev the user asked for so receivers can
// see at a glance where the file came from.

// Filesystem-illegal characters on Android (POSIX-style) plus the cross-
// platform Windows/macOS-illegal set. Hyphens, spaces, periods, and other
// printable characters are PRESERVED so titles like "Foo - The Bar" or
// "C++ Primer" survive intact. Earlier versions of this regex used
// [\\/:*?"<>| -] which interpreted `| -]` as a malformed range and ate
// every hyphen in every title.
const PATH_ILLEGAL = /[\\/:*?"<>|]/g;
const WHITESPACE = /\s+/g;

function sanitizeFragment(s: string): string {
  // Replace illegal chars with a space (then collapse) rather than
  // stripping outright — "Art:History" should read "Art History",
  // not "ArtHistory". Whitespace collapse handles the run.
  return s.replace(PATH_ILLEGAL, " ").replace(WHITESPACE, " ").trim();
}

export function shareFileName(title: string, author: string): string {
  const cleanTitle = sanitizeFragment(title || "Book") || "Book";
  const cleanAuthor = sanitizeFragment(author || "");
  const isUnknown = !cleanAuthor || cleanAuthor.toLowerCase() === "unknown author";
  const base = isUnknown ? cleanTitle : `${cleanTitle} by ${cleanAuthor}`;
  return `${base} (Spine).epub`;
}
