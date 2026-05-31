import type { ShelfTone } from "./ShelfMark";

export interface Shelf {
  id: string;
  label: string;
  letter: string;
  tone: ShelfTone;
  parentId?: string | null;
  order: number;
  hidden?: boolean;
  /** Member book ids — populated locally for now; Sprint M3 backend
   *  will source these from `spine:contains` triples. */
  memberIds: string[];
}

const STORAGE_KEY = "spine.shelves.v1";

const SEED: Shelf[] = [
  {
    id: "shelf-currently-reading",
    label: "Currently reading",
    letter: "R",
    tone: "brass",
    parentId: null,
    order: 0,
    memberIds: [],
  },
  {
    id: "shelf-favourites",
    label: "Favourites",
    letter: "F",
    tone: "amber",
    parentId: null,
    order: 1,
    memberIds: [],
  },
  {
    id: "shelf-loaned-out",
    label: "Loaned out",
    letter: "L",
    tone: "oxblood",
    parentId: null,
    order: 2,
    memberIds: [],
  },
];

// Local-only persistence for shelves. Replace with `spine-bf::shelves`
// HTTP endpoints in Sprint M3 — for now, all shelf state lives in
// localStorage so the UI ships ahead of the backend. Schema is
// forward-compatible: same field names as the planned RDF graph.
export function loadShelves(): Shelf[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...SEED];
    const parsed = JSON.parse(raw) as Shelf[];
    if (!Array.isArray(parsed)) return [...SEED];
    return parsed;
  } catch {
    return [...SEED];
  }
}

export function saveShelves(shelves: Shelf[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shelves));
  } catch {
    // localStorage may be unavailable (private mode etc.); silently no-op
    // — shelves still work in-memory for the current session.
  }
}

export function nextShelfId(): string {
  return `shelf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const PALETTE: ShelfTone[] = [
  "brass",
  "slate",
  "oxblood",
  "amber",
  "sage",
  "steel",
];

// Pick the next free tone based on a simple round-robin over the
// palette — avoids two adjacent shelves accidentally sharing a color.
export function nextShelfTone(existing: Shelf[]): ShelfTone {
  if (existing.length === 0) return "brass";
  const last = existing[existing.length - 1].tone;
  const lastIdx = PALETTE.indexOf(last);
  return PALETTE[(lastIdx + 1) % PALETTE.length];
}

// First letter of a label, uppercased. Used as the default letter for
// inline-create — designer left this user-overridable in v2 (sticky
// note on Ask 1: "Should the letter be editable, or always pinned to
// the first letter? I lean editable"). We default to first letter, let
// the user override.
export function defaultLetterFor(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "S";
  return trimmed.charAt(0).toUpperCase();
}
