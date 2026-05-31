# Collections / Shelves / Catalog Facets — Sketch

2026-04-25 (rev 2 — folded in design v1-v4 + balanced
workspace mockup observations). One-page workshop draft for sidebar
navigation past the "flat list of 100+ books" wall. Status: **draft**,
not locked.

**Design references**: design deliverable screenshots
— `sidebar-v4.png` (definitive populated state), `sidebar-shelves.png`
(Auto-Facets variant), `a-balanced-v3.png` (richer
Agents/Curation/Maintenance sidebar shape, future direction).

## Core decision

**Two-track navigation, both visible in the sidebar:**

1. **Catalog · BIBFRAME** (designer's label, adopted) — derived from
   BIBFRAME data Spine already has after reconcile. Subject (LCSH tree
   + user-extended branches like "Fanfic · Hornblower" / "Self-authored"),
   Classification (DDC top-3 levels), Agents (Authors / Translators),
   Language, Era. Zero user effort, scales to 100k+ books, only as
   good as reconcile coverage. Per-subtree footer shows provenance:
   `LoC 692 · manual 143 · imported 48 · inferred 18`.
2. **User shelves** — many-to-many named sets of books, optionally
   nested. Like calibre tags, plus order + nesting. A book can live on
   N shelves at once. Covers the "loaned to Sarah", "kid's bedtime
   stack" cases data will never group. Reading-state filters
   ("Currently reading", "Finished", "Unread") are NOT shelves —
   they're built-in smart filters in the LIBRARY section, auto-populated
   from book progress data.

Explicitly **not** filesystem-style folders. A book has many homes.
Calibre proved this with the tags-vs-categories split; we don't repeat
the mistake.

## Data model (spine.db RDF)

User shelves are a Spine-only concept — calibre's `metadata.db` has no
matching primitive — so they live in `spine.db` as triples in a
dedicated graph `urn:spine:graph:shelves`:

```
:shelf/<uuid>     a              spine:Shelf ;
                  spine:label    "Reading with Aila" ;
                  spine:parent   :shelf/<parent-uuid> ;   # optional
                  spine:order    7 ;                       # sibling ordering
                  spine:icon     "book-open" ;             # optional
                  spine:created  "2026-04-25T..."^^xsd:dateTime ;
                  spine:hidden   false .

:shelf/<uuid>     spine:contains :book/<book-uuid> ;       # member edge
                  spine:itemOrder ( :book/<a> :book/<b> ) . # if user-ordered
```

- Membership is a simple triple, not a join table. Same book on N
  shelves = N triples.
- `spine:parent` makes the shelf tree. Root shelves have no parent.
- `spine:order` is a sibling sort key (drag-reorderable in UI).
- No new SQL tables. Stays in the triple store. SHACL shapes enforce
  shelf-tree acyclicity + label uniqueness within a parent.

**Auto-facets need no new storage** — they're SPARQL projections over
the asserted graph. Subject tree comes from `bf:subject` → LCSH
URI → existing skos:broader chain on `id.loc.gov`. DDC tree comes
from `bf:classification` of type DDC. We cache the projection result
keyed by graph-revision so the sidebar stays snappy.

## Sidebar UX

Sidebar gets three sections beneath the library header card:

```
[S] Main Library                  ▼
    ~/Books/spine.db

LIBRARY
  📖 All books              1,247
  ⏱  Recently added            32
  =  Currently reading          4
  ⬚  On device                284

CATALOG · BIBFRAME
  ▼ Subject                 1,102
    ▼ Fiction                 203
        • Science fiction      47
        • Fantasy              31
        • Literary fiction     89
        • Crime & mystery      36
    ▶ Non-fiction             621
    ▶ Fanfic · Hornblower      28
    ▶ Poetry                   42
    ▶ Self-authored             6
    ▶ Drama                    18
    ─ LoC 892 · manual 143 · imported 48 · inferred 18
  ▼ Classification             892
      100 · Philosophy          12
      500 · Science             89
      800 · Literature         412
      900 · Hist. & geog.      147
  ▶ Agents                     ⋯  (Authors / Translators)
  ▼ Language                 1,247
      EN  English            1,103
      JA  Japanese              44
      FR  French                38
      DE  German                29
  ▼ Era                      1,247
      Pre-1800                   8
      1800-1900                 52
      1900-1950                203
      …

SHELVES                          ▼  + new
  📚 Reading with Aila (12)     ▶
      Picture books (8)
      Chapter books (4)
  🎁 Loaned out (3)
  ⭐ Favourites (47)
  …

MAINTENANCE
  ⚠ Needs reconcile (3)
  ⊘ Missing file (1)
```

Behaviour:

- Click a node → grid filters to books in that node (or any descendant).
- Multi-select facets across categories AND together (subject:sci-fi
  AND language:en AND shelf:reading).
- Drag a book onto a shelf → adds membership triple. Drop on a facet
  → no-op (auto-facets aren't editable; show a tooltip explaining).
- Right-click shelf → rename / nest under / hide / delete.
- Empty state for auto-facets when reconcile hasn't run: "Reconcile
  books to surface subject and classification trees" with a one-click
  "Reconcile all" CTA.

Sidebar caps at ~3 levels deep with progressive disclosure; deeper
trees scroll within their parent rather than expanding the sidebar.

## Phasing — three milestones

**M1 — Shelves MVP (~3 days, fully self-contained)**

- `spine.db` shelf graph + spine-bf CRUD API (create/rename/delete/
  add-member/remove-member/reorder)
- Sidebar Shelves section + drag-drop from grid + right-click menu
- New shelf via "+ new" inline editor
- No nesting yet. Flat shelves only. Ships value immediately.

**M2 — Catalog · BIBFRAME facets (~6 days, gated on reconcile coverage)**

- SPARQL projections for Subject (LCSH + user-extended) /
  Classification (DDC) / Agents (Authors + Translators) / Language / Era
- Cached projection table keyed by `spine.db` revision
- Sidebar Catalog section with lazy-expand subtrees
- Per-subtree provenance footer
  (`LoC N · manual N · imported N · inferred N`) computed from
  `spine:uriSource` triples
- User-extended Subject branches: triples without a `skos:broader`
  chain into LCSH still appear as top-level Subject children, sorted
  alphabetically below the LCSH-rooted tree
- Empty-state CTA when reconcile coverage < 30%
- Multi-select AND-combination with shelf filters
- MAINTENANCE section ("Needs reconcile" / "Missing file") promoted
  from `App.tsx` ad-hoc state to first-class sidebar section

**M3 — Shelf nesting + ordering polish (~2 days)**

- `spine:parent` + `spine:order` fully wired
- Drag-reorder siblings, drag-into-parent to nest
- Per-shelf `itemOrder` for user-curated reading order (book queue use case)
- Hide/show shelves; archive vs delete

**Open questions**

- Catalog-facet thresholds: do we hide a facet branch with <3 books, or
  show it greyed? (lean: grey, click expands)
- Smart shelves (saved searches): M4 or out of scope? Calibre has them;
  high signal-to-noise but adds a second shelf type.
- Sync: shelves are per-library, not per-device. If/when we add device
  sync, do shelves travel? Probably yes, via the existing spine.db
  replication path — no new infra.
- Cross-library shelves (a book in two libraries on the same shelf)
  are explicitly out of scope; shelves live in one library's spine.db.
- Phase-3+ sidebar shape: the `a-balanced-v3.png` mockup proposes a
  different organizing principle — `AGENTS` (Authors/Translators) /
  `CURATION` (Series/Subjects/Tags/Shelves) / `MAINTENANCE` as
  top-level sections, replacing the Catalog-vs-Shelves split. That's
  more BIBFRAME-shape-driven and may be the right end-state once users
  have hundreds of shelves. M3 stays with the simpler Catalog-vs-Shelves
  split; the v3 shape is captured here as a future direction to revisit
  after M3 ships and we have real usage data.

## Why this and not the alternatives

| Alt | Why rejected |
|---|---|
| Filesystem folders | "One home" lie; books legitimately want many homes |
| Calibre tags only | Flat namespace; users want hierarchy for "Aila > picture books" |
| Auto-facets only | Useless for "currently reading" / loaned-out / kid's stack |
| New SQL tables for shelves | Spine commits to RDF for everything user-curated; SQL tables become a parallel truth |
| Smart-shelves first | Solves a different problem (saved queries). Useful, but secondary; users want explicit shelves more |

## What this does **not** touch

- `metadata.db` schema — unchanged, locked invariant. Calibre's `tags`
  table can still be projected as a flat shelf-set if useful; orthogonal.
- ADR 014 BIBFRAME write API — shelves are spine-internal, not
  bibliographic; new write endpoints in spine-srv but not in spine-bf.
- Reconcile drawer — unrelated. Shelves are user data; reconcile is
  identity. No coupling.
