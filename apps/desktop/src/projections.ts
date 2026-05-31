// Flat shape for the design-sprint grid + inspector components. The real
// Book type carries nested BIBFRAME graphs + legacy calibre metadata + a
// parallel reading-progress record; the design only wants a projected
// surface. Centralising the projection here keeps callsites declarative
// and makes the surface easy to reshape when Step 9 lands real
// multi-instance data from spine-bf.

import { extractYear } from "./utils/formatters";

interface ReadingProgressLite {
  progressFraction?: number;
  updatedAt?: string;
}

interface SubjectRef {
  uri?: string;
  label: string;
}

interface InstanceLite {
  format?: string;
  publicationDate?: string;
  publisher?: string;
  isbn?: string;
}

interface BookLike {
  id: string;
  title: string;
  authors: string[];
  legacyMetadata: {
    publisher?: string;
    pubDate?: string;
    tags?: string[];
    hasCover?: boolean;
    series?: string;
    seriesIndex?: number;
  };
  bibliographicGraph?: {
    work: {
      originDate?: string;
      subjects?: SubjectRef[];
      language?: string;
    };
    instances?: InstanceLite[];
  };
}

export type ReconciledStatus = "reconciled" | "local" | "missing" | "new";

export interface BookProjection {
  id: string;
  title: string;
  author: string;
  authors: string[];
  workDate?: string;
  pubDate?: string;
  publisher?: string;
  format?: string;
  isbn?: string;
  instances: number;
  subjects: string[];
  status: ReconciledStatus;
  hasFile: boolean;
  /** True when the legacy calibre metadata reports a cover. Drives the
   *  Cover component's bookId-fetch path (real cover art via
   *  `/api/v1/book/:id/cover`); false renders the deterministic placeholder. */
  hasCover: boolean;
  progress: { pct: number; finished: boolean } | null;
}

// `progress` may be undefined when the book has no saved reading state.
// `status` derives from the reconcile state on the graph; file-missing
// state is a runtime concern we can't infer from the Book shape today,
// so it stays false until a real `hasFile` field shows up.
export function projectBook(book: BookLike, progress?: ReadingProgressLite): BookProjection {
  const firstInstance = book.bibliographicGraph?.instances?.[0];
  const workDate = book.bibliographicGraph?.work?.originDate ?? undefined;
  const pubYear = extractYear(book.legacyMetadata.pubDate)?.toString();
  const pubDate = firstInstance?.publicationDate ?? pubYear;

  const subjectsFromGraph = book.bibliographicGraph?.work?.subjects?.map((s) => s.label) ?? [];
  const subjectsFromLegacy = book.legacyMetadata.tags ?? [];
  const subjects = subjectsFromGraph.length > 0 ? subjectsFromGraph : subjectsFromLegacy;

  const status: ReconciledStatus = book.bibliographicGraph ? "reconciled" : "local";

  const frac = progress?.progressFraction;
  const projectionProgress =
    typeof frac === "number"
      ? { pct: Math.round(Math.max(0, Math.min(frac, 1)) * 100), finished: frac >= 1 }
      : null;

  return {
    id: book.id,
    title: book.title,
    author: book.authors[0] ?? "Unknown",
    authors: book.authors,
    workDate,
    pubDate,
    publisher: firstInstance?.publisher ?? book.legacyMetadata.publisher ?? undefined,
    format: firstInstance?.format ?? "EPUB",
    isbn: firstInstance?.isbn ?? undefined,
    instances: book.bibliographicGraph?.instances?.length ?? 1,
    subjects,
    status,
    hasFile: true,
    hasCover: book.legacyMetadata.hasCover === true,
    progress: projectionProgress,
  };
}
