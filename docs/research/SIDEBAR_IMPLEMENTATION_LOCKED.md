# Sidebar Implementation — LOCKED

2026-04-25 (rev 3 — folded in v2 bundle Tier-1 deliveries:
shelves system, subject expansion, multi-facet rendering, empty
progression, resize+collapse, mobile drawer). Synthesized from
the design deliverable (v1) + the v2 sidebar-states artboards
(1730L of new state-specific artboards). Locks the structural
decisions for Sprint 10+ sidebar work.

**Status: locked for implementation.** Open questions remaining are tagged `// open` inline;
the maintainer can override any locked decision before code lands.

---

## What the designer actually delivered

The bundle contains **two competing sidebar shapes**, drawn for
comparison:

### Shape A — "Catalog tree" (sidebar-v1 → v4, sidebar-shelves, sidebar-empty)

Heavy on auto-derived BIBFRAME facet trees. Sections: `LIBRARY` /
`CATALOG · BIBFRAME` (or `AUTO-FACETS · BIBFRAME` in earlier variants).
Subject tree fully expanded with bullet-dot markers, italic serif genre
labels, per-tree provenance footer.

```
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
        • Cyberpunk            12
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
  ▼ Language                 1,247
      EN  English            1,103
      JA  Japanese              44
      …
  ▼ Era                      1,247
      Pre-1800                   8
      1800-1900                 52
      …
```

### Shape B — "Curation" (a-balanced.png, a-balanced-v2.png, a-balanced-v3.png + the handoff README)

Flatter, BIBFRAME-shape-driven sections. Authors and Tags appear as
named children inline. Subjects/Series/Tags collapse into a single
`CURATION` umbrella. Reading-state filters (`Now reading` / `Finished` /
`Unread`) live at top-level under LIBRARY, not as user shelves.

```
LIBRARY
  📖 All books                28
  =  Now reading              17
  ⏱  New arrivals              3
  ✓  Finished                  9
  ○  Unread                    2

AGENTS
  👤 Authors                  24
       Shelley, Mary
       Herbert, Frank
       Melville, Herman
  🌐 Translators               7

CURATION
  ▣  Series                    2
  🏷 Subjects (LCSH)          62
  🔖 Tags                     14
       work
       reference
       classics

MAINTENANCE
  ⚠ Needs reconcile (3)
  ⊘ Missing file (1)
```

The handoff README is **explicit**: "Sidebar sections in order:
**Library** · **Agents** · **Curation** · **Maintenance**". Shape B is
the canonical design. Shape A is the **detail view** — what a Subject
tree looks like once you expand it.

---

## LOCKED decision

**Adopt Shape B as the structural backbone, with Shape A as the detail
expansion view inside `CURATION → Subjects`.** Add **Shelves** as a
fifth `CURATION` child (extension to satisfy the "user-created
hierarchy" ask, which the designer didn't draw).

Final locked structure:

```
[S] Main Library                       ▼      ← header card (extension)
    ~/Books/spine.db

LIBRARY
  📖 All books                       1,247
  =  Now reading                        17
  ⏱  New arrivals                        3
  ✓  Finished                            9
  ○  Unread                              2

AGENTS
  ▼ 👤 Authors                          24
       Shelley, Mary                     3
       Herbert, Frank                    2
       Melville, Herman                  3
       … (top 8 by book count, "Show all" link)
  🌐 Translators                         7

CURATION
  ▣  Series                              2
  🏷 Subjects (LCSH)                    62      ← click expands Shape A detail tree
  🔖 Tags                               14
       work                              4
       reference                         3
       classics                          7
       … (top 8 by use, "Show all" link)
  📚 Shelves                             5  + new   ← shelves extension
       📖 Currently reading              4
       📚 Reading with Aila              12  ▶
       🎁 Loaned out                      3
       ⭐ Favourites                     47

MAINTENANCE
  ⚠ Needs reconcile                      3
  ⊘ Missing file                         1
```

---

## Why this combination

| Concern | Decision | Rationale |
|---|---|---|
| Reading-state grouping | Top-level under LIBRARY (Shape B) | Data-driven, not user-curated; doesn't pollute Shelves |
| Author browsing | Top 8 named under AGENTS (Shape B) | Power browsing pattern from calibre; free with reconciled `bf:Agent` data |
| Subject hierarchy | Click `Subjects` → expands Shape A detail tree | Shape B's flat 62-count is the summary; Shape A is the drill-down |
| User shelves | New `📚 Shelves` child in CURATION | Designer didn't draw shelves; requested by the maintainer; folds in cleanly without restructuring |
| Header card | Library glyph + DB path subtitle | All sidebar variants show it; better than current App.tsx TitleBar treatment alone |
| Provenance footer | Inside Subject detail tree only | High signal-to-noise for the one section where it matters; not cluttering top-level |
| Calibre-style flat tags | Stays as `🔖 Tags` under CURATION | Reads `metadata.db` directly; no `spine.db` involvement; ships day-one |

---

## Data model for new primitives

### Shelves visual contract (LOCKED from v2)

The designer locked these on the v2 pass — adopt verbatim, don't
reinvent:

- **Glyph: single italic-serif letter** in a tinted square (14×14 in
  sidebar, 16×16 in rail, 20×20 mobile). Background is a vertical
  gradient of the tone color at 22%→11% alpha, 1px border at 55%. Letter
  is `Source Serif italic 600` at `min(9px, 0.6× size)`. NOT emoji —
  emoji rendering varies cross-platform and breaks the typographic
  feel.
- **Six-color palette** (`spine-sidebar-states.jsx:1077`):
  - `#c8a15a` Brass — default / system shelves (e.g. Currently reading)
  - `#94b0c4` Slate — co-reading / plural ("Reading with Aila")
  - `#a83040` Oxblood — caution / loans / holds
  - `#e4b84f` Amber — Favourites / highlight
  - `#8ab07a` Sage — research / ongoing
  - `#6b8aa0` Steel — genre / neutral
- **Empty state**: dashed-border card with italic-serif explainer +
  accent "+ New shelf" button (see `ShelvesEmpty` in v2 source).
- **Flat list**: simple rows with glyph + label + count.
- **Nested**: tree-guide hairlines (1px borderSoft) connect parent
  to children at indent×14px. `caret="down"` on parent, indented
  italic children.
- **Inline edit**: row gets `1px accent` border + 2px accent-glow
  outer ring; glyph + color picker panel pops below with letter
  palette (P/R/L/S/K/F/T/A/M/C row) + 8 color swatches; commit
  on `↵`.
- **Drop target**: row gets `1px dashed accent` outline; dragging
  book renders as a `70×100px` rotated card with `+1` delta badge.
- **Right-click menu**: Rename (F2) · Nest under… · Pin to top ·
  Move up (⌘↑) · Move down (⌘↓) · Hide · **Delete shelf** (danger,
  alert color). Anchored at click position, 200px wide.
- **Hover affordances**: 3 right-aligned icon buttons on row hover
  (add / settings / ⋯). ⋯ opens the action menu beside the row.

### Shelves (extension) — data model

User shelves are spine-internal, not bibliographic — they live in
`spine.db` as RDF triples in dedicated graph
`urn:spine:graph:shelves`:

```
:shelf/<uuid>     a              spine:Shelf ;
                  spine:label    "Reading with Aila" ;
                  spine:parent   :shelf/<parent-uuid> ;   # optional
                  spine:order    7 ;                       # sibling sort
                  spine:icon     "book-open" ;             # optional glyph
                  spine:created  "2026-04-25T..."^^xsd:dateTime ;
                  spine:hidden   false .

:shelf/<uuid>     spine:contains :book/<book-uuid> .       # member edge
```

- Membership is a triple, not a join table. Same book on N shelves = N triples.
- `spine:parent` makes the shelf tree.
- SHACL shapes enforce acyclicity + label uniqueness within parent.
- Backend: `spine-bf` adds 5 fns (create / rename / delete / add-member
  / remove-member / reorder). 4 HTTP endpoints under `/api/v1/shelf/`.

### Catalog facet projections

No new storage. Projections over the asserted graph, cached by
`spine.db` revision number. New backend module `spine-bf::facets`:

```rust
pub fn subjects(store: &SpineStore) -> SubjectTree;
pub fn classification(store: &SpineStore) -> ClassificationFlat;
pub fn agents(store: &SpineStore) -> AgentBuckets;
pub fn languages(store: &SpineStore) -> LanguageBuckets;
pub fn era(store: &SpineStore) -> EraBuckets;
```

One HTTP endpoint: `GET /api/v1/library/facets` returns all five.
Cached in spine-srv until `spine.db` revision tick. Re-projection cost
is the open question for libraries past 10k books — measure during M2.

### Provenance footer

Computed by counting `spine:uriSource` values across the subject
triples for the current filter scope. Returned as
`{ loc: 892, manual: 143, imported: 48, inferred: 18 }` on the
`/api/v1/library/facets` response.

**Visual contract (LOCKED from v2)**: rendered as a 4-dot strip below
the subject tree, separated by a `1px dashed borderSoft` top border.
Each dot is 5px with a 1px ring; tones:
- `lcsh` — solid accent fill + ring (`#c8a15a`)
- `user` — solid ok fill + ring (`#8ab07a`)
- `imported` — solid link fill + ring (`#94b0c4`)
- `inferred` — **transparent fill** + textFaint ring (signals
  "uncommitted/provisional" by being hollow, not just colored)

Each dot is followed by sans label + mono count (e.g. `● LoC 892`).
The hollow-vs-filled treatment is meaningful — don't reduce inferred
to just a different color.

---

## v2 LOCKED interaction decisions

Beyond the structural backbone, v2 locked these interaction details:

### Subject expansion (Ask 2 — COMMITTED: inline expand)

Click the `Subjects` row in CATALOG · BIBFRAME → caret flips
right→down, the tree expands **inline**, pushing Classification /
Languages / Era down within the same sidebar. NO modal, NO sidebar
replacement, NO drawer. 200-220px width holds.

### Multi-facet active rendering (Ask 3)

- **Active leaf**: full `2px accent` left-border + `surfaceHi` bg +
  500-weight label (the existing rule).
- **Ancestor of active leaf**: faint accent dot (`opacity 0.6`,
  `4×4px`) in the caret slot. So clicking `Science fiction` lights
  up `Science fiction` (full) AND drops a faint dot indicator next
  to `Subjects` and `Fiction` ancestors. Visual breadcrumb without
  competing with the leaf for attention.
- **Multiple actives across sections**: each gets full leaf treatment
  independently. Up to ~5 simultaneous active facets remain readable.
- **FilterBar above grid** mirrors all active facets as removable
  chips: `subject: Science fiction × · shelf: Currently reading × ·
  language: English × · × Clear all`. Result count mono right.
  This is the canonical "what's filtered" display; the sidebar
  signals participation, the FilterBar enumerates.

### Resize + collapse (Ask 6 — COMMITTED: BOTH)

- **Drag-resize handle**: 4px accent strip at sidebar right edge,
  cursor `ew-resize`, `boxShadow 0 0 18px accent` while grabbed.
  Width readout floats to the right (`Geist Mono 10px`, panel bg,
  borderHi border, 3-7-3 padding).
- **Snap-points** (rendered as right-side ruler ticks while dragging):
  - `200 · min` (existing minimum)
  - `240 · default` (current default)
  - `320 · wide`
  - `rail · 56` (collapse trigger)
- **Rail mode** at 56px: brand square at top, vertical icon stack with
  count below each (mono 8px tabular-nums), accent dot badge for
  unread/changes, hover reveals full-label tooltip with arrow pointer
  beside the rail. Settings + status-dot pinned at bottom. Toggle
  affordance is a small chev tab anchored to the rail's right edge.
- Persist resize state to localStorage; rail/expanded state survives
  reloads.

### Empty-state progression (Ask 4 — three stages)

- **0 books (cold start)**:
  - `LIBRARY > All books` shows `0` count
  - Inline card below with italic-serif heading "An empty shelf." +
    explainer + accent "+ Add books…" button + "Import from Calibre"
    secondary button
  - `CATALOG · BIBFRAME` shows the section header with italic-serif
    explainer "Subjects, classification, language, and era appear
    here once books are reconciled."
  - `SHELVES` shows "Hand-curated collections live here." (italic
    serif, faint)
  - No footer (we know nothing yet)
- **1 book**:
  - All books = 1 (active)
  - Currently reading = 0
  - Recently added = 1
  - Catalog explainer flips to "Auto-facets populate after the first
    reconcile pass. Took ~2s for this book."
  - Shelves explainer flips to "No shelves yet. Drag a book to
    create one."
  - Footer activates: mono dot + "1 work · reconciled"
- **10 unreconciled**:
  - All books = 10 (active)
  - Catalog section gets a `canvasAlt` callout box with warn dot
    + "10 books · 0 reconciled" + italic-serif copy + "Reconcile
    all →" CTA button. This is the primary "you need to do
    something" affordance at this state.
  - Footer: warn-dot + "10 works · 0 reconciled"

### Mobile drawer (Ask 11)

- Drawer width = `84% of viewport width`
- Backdrop overlay `rgba(0,0,0,.55)` + base content rendered at
  `filter: brightness(.75)`
- Header: `52px top padding` (iPhone notch), `36px` brand square +
  library name + mono "1,247 works · synced 2m" + small "edit" pill
- Rows: **44px min-height** (Apple HIG touch target), `18px`
  horizontal padding, `15px` sans label, `14px` icon, `11.5px` mono
  count
- Section headers: 18px-top padding, all-caps faint, with optional
  inline action affordance on right (`Browse →` for Catalog,
  `+ New` for Shelves, both in accent)
- Footer: settings icon + label + mono version
- Right-edge "drag handle" pill (3×38px) for swipe-to-close gesture
- Settings shown on home-bar zone, not in section list

### Search-active (BONUS — Ask not made, designer over-delivered)

Sidebar search input (when activated):
- Accent border + glow on focus, mono `esc` hint right
- Below input: italic-serif "14 matches across 3 sections" + mono
  match-time ("0.3ms")
- Results grouped under section headers (`Catalog · Subject` (4),
  `Catalog · Classification` (2), `Shelves` (1), `Books` (7))
- Match highlighting: accent bg @ 18% alpha + 1px accent-66
  underline on the matched substring
- Per-result kbd shortcut chip (mono 9px, borderSoft pill) on the
  selected result; arrow keys navigate
- Footer keyboard hints: `↑↓` navigate · `↵` open · `⌘↵` focus

This is a meaningful sub-feature — defer to M2.5 or M3 follow-on.

## Component structure

Existing `apps/desktop/src/shell/Sidebar.tsx` already implements ~70%
of the lockstep design (200px, panel bg, 2px accent left-border on
active, mono counts, accent dot, indent). Required extensions:

### New: `LibraryHeaderCard.tsx`

Above the sections. Renders:
- Spine glyph in accent square (28×28, surfaceHi bg, accent ink)
- Library name (sans 13/500)
- Mono 10 textDim DB path (`displayPath()`-truncated)
- Disclosure caret right-aligned → opens existing library-switcher dropdown

Replaces the current `onLibrarySwitch` button placement in TitleBar
(stays in TitleBar for backwards compat; the card is the new primary
affordance).

### Extend: `SidebarItem`

```ts
export interface SidebarItem {
  id: string;
  label: string;
  icon?: IconName;
  indent?: number;
  count?: number;
  accent?: string;
  // NEW:
  expandable?: boolean;          // shows ▶/▼ caret on left of icon
  expanded?: boolean;             // disclosure state (parent-owned)
  onToggle?: () => void;          // caret click handler (separate from row click)
  marker?: "bullet" | "none";     // "•" before label (Subject genre rows)
  italic?: boolean;               // serif italic label (Subject genre rows)
  monoPrefix?: string;            // "100 ·" mono prefix (DDC, Language code)
  glyph?: string;                 // single-char prefix glyph (📖 📚 ⭐)
  meta?: ReactNode;               // arbitrary right-aligned slot (replaces count)
}
```

### New: `SidebarSubtree.tsx`

Renders `Subjects` detail-tree expansion when clicked. Returns lazily-
fetched `subjectTree.children` rendered as nested `SidebarItem` rows
with bullet markers + italic + provenance footer.

### New: `ShelfMark.tsx`

The letter-monogram glyph component. Single italic-serif letter
inside a tinted-gradient square. Props: `letter: string`, `tone:
string` (one of the 6 palette hex values), `size?: number`. Used by
ShelvesSection AND any other place a shelf reference renders
(Inspector chips, command palette results, etc.).

### New: `ShelvesSection.tsx`

CURATION sub-component with inline "+ new" trigger, drag-drop target,
right-click context menu (rename / nest / delete / hide). Owns its own
state for in-flight CRUD. Uses `ShelfMark.tsx` for glyphs.

### New: `ShelfInlineEditor.tsx`

The focused-input + glyph/color picker panel. Letter palette
(`P/R/L/S/K/F/T/A/M/C`) and 8-color swatch row, commit on Enter,
cancel on Escape, blur to canvas dismisses without commit.

### Extend: `Sidebar.tsx`

- Accept `header?: ReactNode` prop for `LibraryHeaderCard`
- Render expandable rows with toggle caret on left
- Render bullet/italic/monoPrefix/glyph variants
- Render arbitrary `meta` slot in place of count

---

## Backend wire plan

Three endpoint clusters:

### `/api/v1/library/facets` (read)

```
GET  /api/v1/library/facets
  → {
      subjects: SubjectTree,
      classification: ClassificationFlat,
      agents: AgentBuckets,
      languages: LanguageBuckets,
      era: EraBuckets,
      reading: { now: 17, finished: 9, unread: 2, newArrivals: 3 },
      maintenance: { needsReconcile: 3, missingFile: 1 },
    }
```

Cached. Single round-trip per sidebar load.

### `/api/v1/shelf/*` (write)

```
POST   /api/v1/shelf                     {label, parent?, icon?}     → 201 {uuid}
PATCH  /api/v1/shelf/:uuid               {label?, parent?, order?}   → 200
DELETE /api/v1/shelf/:uuid                                            → 204
POST   /api/v1/shelf/:uuid/members       {bookUuids: [...]}          → 200
DELETE /api/v1/shelf/:uuid/members/:book                              → 204
GET    /api/v1/shelves                                                → ShelfTree
```

All graph mutations through `spine-bf::shelves` (locked invariant per
CLAUDE.md). SHACL enforces acyclicity + per-parent label uniqueness.

### `/api/v1/library/filter` (filter dispatch)

Existing `/api/v1/book?filter=…` may need extension to take facet
predicate combinations: `?subject=loc:sh85118553&shelf=<uuid>&lang=en`.
Backend ANDs all predicates. Empty result is a normal response with
`books: []`.

---

## Phasing — four milestones

### M1 — Curation backbone (Shape B without shelves) — **~3 days**

Frontend-only, against existing endpoints. No new backend.

- Lift sidebar shape from `App.tsx` `sidebarSections` constants into
  Shape B structure (LIBRARY / AGENTS / CURATION / MAINTENANCE)
- Build `LibraryHeaderCard.tsx`
- Promote MAINTENANCE items (`maint:reconcile`, `maint:missing-file`)
  from ad-hoc state to first-class section
- Read counts from existing `/api/v1/book?filter=…` (one call per
  reading-state pre-baked into spine-srv as a derived view; if that
  endpoint doesn't exist, M1 ships with hardcoded zeros and lights up
  on the M1.5 facets endpoint)
- AGENTS top-N authors: pull from `/api/v1/library/agents?top=8`
  (new endpoint — minimal: `SELECT ?agent COUNT(?book) GROUP BY ?agent
  ORDER BY count DESC LIMIT 8`). Block on confirmation that this is trivial.
- Sub-day for `LibraryHeaderCard` + 2 days for sidebar restructure +
  half-day testing.

### M2 — Catalog facets + Subject detail tree — **~5 days**

Backend: `spine-bf::facets` module + `GET /api/v1/library/facets`.
Frontend: `SidebarSubtree.tsx` with bullet/italic/provenance.

- `subjects()` — recurse `bf:subject` → LCSH URI → `skos:broader` chain
  via cached LoC suggestions; user-extended subject branches (no
  LCSH parent) sort alphabetically below the LCSH-rooted tree
- `classification()` — `bf:classification` of type DDC, top-3-digit
  buckets, sorted numerically
- `agents()` — top-N split between Authors and Translators
- `languages()` — flat by `dc:language` ISO-639 code
- `era()` — bucketize `bf:originDate` decade ranges (Pre-1800, 1800-
  1900, 1900-1950, 1950-2000, 2000+)
- Provenance footer counts `spine:uriSource` across asserted subject
  triples for current scope
- Cache by `spine.db` revision — invalidate on any write tx commit
- Empty-state CTA when subject coverage < 30%: "Reconcile books to
  surface subject and classification trees" → triggers existing
  batch-reconcile flow

### M3 — User shelves (extension) — **~5 days**

Backend: `spine-bf::shelves` + 5 fns + 4 HTTP endpoints + SHACL shapes.
Frontend: `ShelvesSection.tsx` with create/rename/delete/drag-drop/
nest/right-click.

- Flat shelves first (no nesting) — ships immediately
- Drag-drop from grid onto a shelf row creates membership triple
- Right-click context menu: rename / nest under… / delete / hide
- Inline "+ new shelf" trigger at section bottom
- ADR 016 amendment: shelves DO NOT participate in the inferred-graph
  promotion path (they're user-curated, never inferred)

### M4 — Shelf nesting + ordering polish — **~2 days**

- `spine:parent` + `spine:order` fully wired
- Drag-reorder siblings, drag-into-parent to nest
- Per-shelf `spine:itemOrder` for user-curated reading order (book
  queue use case)
- Hide/show shelves; archive vs delete
- Drag-target visual: dashed accent border + bg lift

---

## Out-of-scope for these milestones

- Smart shelves (saved searches with predicate AST) — calibre
  parity feature, M5+
- Per-device sync — single-library-per-spine.db today, multi-device
  later
- Cross-library shelves — explicitly rejected
- Shape B → Shape C evolution toward `a-balanced-v3` style nested
  facets ("Subjects" as direct expandable children of CURATION rather
  than a "click to drill in" detail view) — possible M5+ if usage
  data shows users want it always-on

---

## Implementation file map

| File | Status | Action |
|---|---|---|
| `apps/desktop/src/shell/Sidebar.tsx` | exists | extend `SidebarItem` shape + render expandable / bullet / italic / monoPrefix / glyph / meta / ancestorActive / drop / hovered / treeGuide |
| `apps/desktop/src/shell/LibraryHeaderCard.tsx` | new | header card above sections (`IdentityStrip` in v2 source) |
| `apps/desktop/src/shell/SidebarSubtree.tsx` | new | Subjects detail expansion (M2) |
| `apps/desktop/src/shell/ShelfMark.tsx` | new | letter-monogram glyph (M3) |
| `apps/desktop/src/shell/ShelvesSection.tsx` | new | Shelves CRUD UI (M3) |
| `apps/desktop/src/shell/ShelfInlineEditor.tsx` | new | focused inline-edit + picker (M3) |
| `apps/desktop/src/shell/SidebarRail.tsx` | new | collapsed 56px rail mode (M2.5) |
| `apps/desktop/src/shell/SidebarResizeHandle.tsx` | new | drag-resize + snap-points + width readout (M2.5) |
| `apps/desktop/src/shell/SidebarSearchPanel.tsx` | new | search-active state (M3+ deferred) |
| `apps/desktop/src/shell/MobileSidebarDrawer.tsx` | new | mobile 84%-width drawer (post-desktop) |
| `apps/desktop/src/shell/EmptyStateCard.tsx` | new | reusable empty-state card (cold/1-book/N-unreconciled) |
| `apps/desktop/src/App.tsx` | exists | replace `sidebarSections` constant with Shape B structure (M1) + wire facets fetch (M2) + mount ShelvesSection (M3) |
| `core/spine-bf/src/facets.rs` | new | M2 |
| `core/spine-bf/src/shelves.rs` | new | M3 |
| `core/spine-srv/src/api/library.rs` | exists | add `/facets`, `/agents` (M2) |
| `core/spine-srv/src/api/shelf.rs` | new | M3 |
| `core/spine-bf/shacl/shelves.shapes.ttl` | new | M3 SHACL |

---

## Visual contract

Reference artifacts:
- `2026-04-25-spine-sidebar/screenshots/sidebar-v4.png` — Subjects
  detail expansion target
- `2026-04-25-spine-sidebar/screenshots/a-balanced-v3.png` — top-level
  sidebar shape target
- `2026-04-25-spine-sidebar/design_handoff_spine_library/README.md
  §Sidebar` — exact pixel specs (200px, 5px pad, indent×12, etc.)
- `2026-04-25-spine-sidebar-v2/spine-sidebar-states.jsx` — all v2
  state-specific artboards (shelves / subject expansion / multi-facet
  / empty progression / resize+collapse / mobile / search-active /
  hover-actions). Lift component-by-component into TypeScript;
  preserve every spacing/border/transform decision.

Every implementation PR carries before/after screenshots vs. these
references in the commit body. Designer-approved rendering only.

---

## Open questions

- **Authors as top-8-named in sidebar** — at what library size does
  this break? Probably fine through 1k authors (top-8 still meaningful);
  past that the named list becomes noise. Lean: keep top-8, scale
  threshold to `top-N where N = min(8, distinct_authors / 50)`.
- **Provenance footer rendering on small libraries** — when the
  library has <10 reconciled subjects, the footer reads
  `LoC 4 · manual 1` and looks silly. Lean: hide footer when
  `total < 20`.
- **DDC depth** — the design shows top-3 levels (`100`, `500`, `800`,
  `900`). Real DDC goes 6 digits deep. Do we expand on click? Lean:
  yes for M2, with same disclosure-caret pattern as Subject tree.
- **Reading-state source of truth** — `metadata.db` has no progress
  column; we'd derive Now Reading from `spine.db` reading-events. If
  Spine doesn't track reading events yet, M1 ships with hardcoded
  zeros until that subsystem exists. // open — block on confirming reading-events status.

## Closed-out questions (resolved by v2 delivery)

These were marked open in rev 2; v2 closed them:

- **Auto-facet thresholds** — not addressed by designer; staying with
  rev-2 default ("grey, click expands"). // still open
- **Sidebar resize/collapse** — RESOLVED: BOTH (drag-resize + rail).
- **Empty-state visuals** — RESOLVED: 3-stage progression with
  specific copy and CTAs.
- **Multi-facet active rendering** — RESOLVED: full active leaf +
  faint dot ancestor + FilterBar mirror.
- **Subject expansion model** — RESOLVED: inline expand.
- **Mobile sidebar adaptation** — RESOLVED: 84%-width drawer with
  44px touch-target rows.
- **Inspector "Shelves" section** — NOT YET in v2; still tier-1 ask.
- **Authority Entity Overlay** — NOT YET in v2; tier-2.
- **Series detail view** — NOT YET in v2; tier-2.
- **Loading/async/error states** — NOT YET in v2; tier-2.
- **Light theme** — NOT YET in v2; tier-2.
- **Brand mark / icon set** — NOT YET in v2; tier-2.
