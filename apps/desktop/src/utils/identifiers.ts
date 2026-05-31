import type { BookUpdate } from "../types";

// Buildable external URL for a few common identifier schemes in the graph.
// Returns null if we don't know how to link the identifier; the UI renders
// plain text in that case.
export function identifierUrl(kind: string, value: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  switch (kind) {
    case "isbn":
      return `https://openlibrary.org/isbn/${encodeURIComponent(v.replace(/[-\s]/g, ""))}`;
    case "lccn":
      return `https://id.loc.gov/authorities/names/${encodeURIComponent(v)}.html`;
    case "oclc":
      return `https://www.worldcat.org/oclc/${encodeURIComponent(v)}`;
    case "ddc":
      return `https://dewey.info/class/${encodeURIComponent(v)}/e23/`;
    default:
      return null;
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Compute the diff between an edited BibliographicGraph and the selected
// book's existing calibre surface. Only the fields the user actually changed
// are included in the returned `BookUpdate` so the backend projection path
// doesn't clobber untouched calibre columns (trigger-maintained sort fields
// are especially sensitive).
export function diffProjection(
  base: {
    title: string;
    authors: string[];
    tags: string[];
    series?: string;
    seriesIndex?: number;
    publisher?: string;
    pubDate?: string;
    language?: string;
  },
  draft: {
    title?: string;
    authors?: string[];
    tags?: string[];
    series?: string | null;
    seriesIndex?: number;
    publisher?: string | null;
    pubDate?: string | null;
    language?: string;
  }
): BookUpdate {
  const update: BookUpdate = {};
  if (draft.title !== undefined && draft.title !== base.title) {
    update.title = draft.title;
  }
  if (draft.authors !== undefined && !arraysEqual(draft.authors, base.authors)) {
    update.authors = draft.authors;
  }
  if (draft.tags !== undefined && !arraysEqual(draft.tags, base.tags)) {
    update.tags = draft.tags;
  }
  if (draft.series !== undefined && (draft.series ?? null) !== (base.series ?? null)) {
    // Treat whitespace-only input the same as empty — both clear the field.
    update.series = (draft.series == null || draft.series.trim() === "") ? null : draft.series;
  }
  if (
    draft.seriesIndex !== undefined &&
    draft.seriesIndex !== base.seriesIndex
  ) {
    update.seriesIndex = draft.seriesIndex;
  }
  if (
    draft.publisher !== undefined &&
    (draft.publisher ?? null) !== (base.publisher ?? null)
  ) {
    // Treat whitespace-only input the same as empty — both clear the field.
    update.publisher = (draft.publisher == null || draft.publisher.trim() === "") ? null : draft.publisher;
  }
  if (draft.pubDate !== undefined && (draft.pubDate ?? null) !== (base.pubDate ?? null)) {
    // `pubdate` expects an RFC3339 datetime on the backend; if the user only
    // entered a year, normalise to the start of that year. Empty string or
    // whitespace-only input clears the field.
    if (draft.pubDate == null || draft.pubDate.trim() === "") {
      update.pubdate = null;
    } else {
      const year = /^\d{4}$/.exec(draft.pubDate.trim());
      update.pubdate = year
        ? `${year[0]}-01-01T00:00:00Z`
        : draft.pubDate;
    }
  }
  if (draft.language !== undefined && draft.language !== base.language) {
    update.languages = [draft.language];
  }
  return update;
}
