# Designer Follow-up Asks — Spine Library Workspace

2026-04-25 (rev 2 — Tier-1 mostly closed by v2 bundle delivery).
Generated after locking `SIDEBAR_IMPLEMENTATION_LOCKED.md` against the
v1 design bundle. These are the gaps that block clean implementation.
Tier-1 are needed for M1-M3 (next 2-3 sprints); tier-2 are nice-to-have.

**v2 STATUS** — designer over-delivered with
`spine-sidebar-states.jsx` (1730L) covering 6 of 7 Tier-1 asks plus
2 bonus states. Tier-1 status updated inline below.

To pass to the designer: copy each asks-block verbatim into a fresh
design session. Pair with a thumbnail of the relevant
existing screenshot so they have visual anchor.

---

## Tier 1 — needed to ship M1-M3

### Ask 1 — User shelves UI ✅ DELIVERED in v2

`ShelvesEmpty / ShelvesFlat / ShelvesNested / ShelfInlineEdit /
ShelvesDropTarget / ShelvesContextMenu / ShelfGlyphPalette` —
all 7 sub-states delivered. Letter-monogram glyph system locked
(6-color palette: Brass / Slate / Oxblood / Amber / Sage / Steel).
Original ask preserved below for archival.

### Ask 1 (original) — User shelves UI (the gap in the bundle)

Your sidebar doesn't include user-curated shelves — only
auto-derived BIBFRAME facets and calibre-style flat tags. Spine needs
a `📚 Shelves` section under CURATION for nested user collections.
Please produce:

1. Shelves section in three states: empty (just a "+ new shelf"
   inline trigger), populated-flat (4-5 shelves, no nesting), and
   populated-nested (one parent shelf with 2-3 children indented).
2. The "+ new shelf" inline-editor state — what does the focused
   text input look like? Where does the cursor sit? What's the
   commit affordance?
3. Drag-drop target visual: a book card hovering over a shelf row.
   Show the drop-target row with whatever bg/border treatment
   signals "drop here".
4. Right-click context menu on a shelf row — items
   (Rename / Nest under… / Hide / Delete / Move up / Move down).
5. Glyph palette — what's the canonical icon set for shelves?
   Six default options the user can pick from when creating.

### Ask 2 — Subject detail-tree expansion ✅ DELIVERED in v2

COMMITTED choice: **inline expand**. Subjects row caret toggles
right→down, tree expands within the same sidebar pushing
Classification/Languages/Era down. 200-220px width holds.
`SubjectsCollapsed` and `SubjectsExpanded` artboards in v2 source.

### Ask 2 (original) — Subject detail-tree expansion interaction

Your `sidebar-v4.png` shows the Subject tree fully expanded with
bullets, italic genre labels, and a provenance footer
(`LoC 892 · manual 143 · imported 48 · inferred 18`). But your
canonical `a-balanced-v3.png` sidebar shows `Subjects (LCSH) 62` as a
single flat row.

How does the user get from one to the other? Three plausible models;
please pick and draw the chosen one:

- **Inline expand** — click the row, the sidebar grows downward to
  reveal the tree, all other sections push down.
- **Sidebar replacement** — click the row, the entire sidebar
  contents replace with the Subject tree + a "← back" affordance.
- **Modal/sheet** — click the row, a drawer opens over the grid
  with the full tree.

For whichever you pick, draw two states: the trigger (sidebar before
click) and the result (sidebar after click). 200px width is a hard
constraint.

### Ask 3 — Multi-facet active rendering ✅ DELIVERED in v2

Active leaf gets full 2px-accent-border + surfaceHi. Ancestors of
active leaf get a faint accent dot (4×4, 0.6 opacity) in the caret
slot — visual breadcrumb. FilterBar mirrors all active facets as
removable chips. `MultiFacetView({ mode: 'one'|'three' })` artboards
in v2 source.

### Ask 3 (original) — Active filter rendering when multiple facets are combined

When a user has `Subject: Science fiction` AND `Shelf: Currently
reading` AND `Language: English` all active, how does the sidebar
render?

- Is each row highlighted with the existing 2px accent left-border?
- If a deep tree row (`Subject > Fiction > Science fiction`) is active,
  do its ancestors also get highlighted, or just the leaf?
- How does the sidebar interact with the existing FilterBar above the
  grid (which shows chips like `status · in progress + new × Clear all`
  — visible in `a-balanced-v3.png`)? Is the FilterBar the canonical
  display, with the sidebar just signaling "yes, this row is in the
  active set"?

Please draw 2 examples: 1 active facet, 3 active facets across
different sections.

### Ask 4 — Empty-state progression ✅ DELIVERED in v2

3-stage progression: 0 books / 1 book / 10 unreconciled. Each stage
locks specific copy and CTAs ("An empty shelf." card → reconcile-all
callout). `SidebarColdStart({ books: 0|1|10 })` in v2 source.

### Ask 4 (original) — Empty-state for the whole sidebar

A first-time user opens Spine with a 0-book library. What does the
sidebar look like?

- Do auto-facet sections collapse / hide / show "Reconcile books to
  populate"?
- Does AGENTS show "No authors yet"?
- Does CURATION still show empty stubs for Series / Subjects / Tags /
  Shelves?
- The MAINTENANCE section — does it stay visible at zero, or hide?

Same question for `1 book imported` and `~10 books, none reconciled`
states. The progression from cold-start → fully-populated is currently
guessed; we want it explicit.

### Ask 5 — Inspector "Shelves" section ⏳ NOT YET in v2

Still pending. Re-ask in next conversation paired with Tier-2 batch.

### Ask 5 (original) — Inspector "Shelves" section

Your inspector design (`a-balanced-v3.png` right pane) shows
Identifiers, Publication Dates, Subjects (LCSH), Work/Instance/Item.
There's no shelf-membership display. Where on the inspector do we
show "this book is on these shelves" (with affordances to add /
remove)? Is it a section after Subjects? Inline chips? Separate
panel?

### Ask 6 — Sidebar resize / collapse ✅ DELIVERED in v2

COMMITTED: **BOTH**. Drag-resize handle (4px accent, with floating
width readout + snap-points list at `200·min · 240·default · 320·wide
· rail·56`) AND collapsed rail mode at 56px (icon stack + count + hover
tooltip with arrow pointer). `SidebarDragResize` and `SidebarRail`
artboards in v2 source.

### Ask 6 (original) — Sidebar resize / collapse behavior

Currently 200px fixed. On small windows (1280px wide) the sidebar
takes ~16% of width, which is fine. On wider windows (2560px) it's
proportionally tiny. On laptops in vertical-split-screen, 200px
crowds the grid.

Please decide and draw:

- **Drag-resize handle** at sidebar's right edge?
- **Collapse to icons-only rail** (~48px) — like VSCode's activity bar
  + sidebar pattern?
- **Both** — drag-resize for fine control, double-click to toggle to
  rail?

If collapsed/icons-only: draw what each section looks like as
icons-only stack with hover-tooltips.

---

## Tier 2 — nice to have, can ship without

### Ask 7 — Authority Entity Overlay

Your handoff README mentions: *"Clicking [an author URI] opens
Authority Entity Overlay (not designed yet — future artboard)"*. This
is the canonical "drill into an author / subject / agent" view.
Per-author overlays are a power-user feature people will use a lot.
Please draw it.

Should include: author photo (if available from VIAF), name + dates
+ alt names, URI cluster (LoC / VIAF / Wikidata / ORCID), top works
(grid), translation network if applicable, "X books in your library".

### Ask 8 — Series detail view

CURATION includes `Series` as a count. Clicking a series should
show its books in series order. Please draw the result-grid state
when a series is the active filter. Is there a series-header strip
above the grid (cover montage, series name, total count, complete /
incomplete indicator)?

### Ask 9 — Loading & async states

While facets are computing on a 50k-book library, the sidebar might
take 500ms-2s to populate. Please draw:

- Skeleton state — what placeholder content fills sections while
  loading?
- Stale-while-revalidate — when does old data display while new
  loads?
- Error state — facet endpoint times out or 5xxs.

### Ask 10 — Light theme

Current bundle is dark-only ("light comes later" per README). Spine
already ships a light theme on the desktop (calibrated cream/tan
palette). When you produce a light-theme pass:

- The 4 sidebar variants in light + their populated states
- Cover swatch palette in light
- Inspector in light

Match the existing tokens at `apps/desktop/src/tokens.css` light-mode
section.

### Ask 11 — Mobile sidebar adaptation ✅ DELIVERED in v2

84%-width drawer with backdrop overlay, 52px notch padding, 36px
brand square, 44px-min-height touch-target rows, edge-swipe gesture
indicator. `MobileDrawer({ width, height })` artboard in v2 source.
Pre-empts the planned mobile-bundle review.

### Ask 11 (original) — Mobile sidebar adaptation

You have `Spine Mobile.html` in the bundle. We haven't reviewed
mobile yet — but for sidebar specifically: how does the desktop
4-section sidebar map to mobile?

- Bottom-tab + drawer pattern?
- Single hamburger drawer with all sections?
- Tab strip at top + section content swappable?

The data hierarchy is the same; the chrome must change.

### Ask 12 — Brand mark

The `[S]` glyph in the library header card — is that the official
Spine icon? You included `branding/spine-icon.svg` (16×16). Could you
deliver the icon at additional sizes (32, 64, 128, 256, favicon) +
a horizontal wordmark version (Spine logo with "Spine" set in serif)?
Useful for the splash, About dialog, future marketing.

---

## What to send the designer (rev 2)

**Bonus delivered (not asked)**:
- `SidebarSearchActive` — full search-results panel with grouped
  matches, highlight rendering, kbd hints. Defer to M3+ but the
  design is locked.
- `SidebarHoverActions` + `ActionMenu` — hover-reveal icon
  affordances + per-shelf actions menu (Open / Rename / Nest /
  Pin / Move / Copy share / Export catalog / Hide / Delete).

**Remaining for designer** (all Tier-2 except Ask 5):
1. Ask 5 (Inspector Shelves section) — only Tier-1 still open; pair
   with Tier-2 batch in next conversation.
2. Tier-2: Ask 7 (Authority Entity Overlay) + Ask 8 (Series detail) +
   Ask 9 (Loading/async) + Ask 10 (Light theme) + Ask 12 (Brand
   mark/icons).

Each conversation: paste the ask block verbatim, attach the relevant
existing screenshot, and reference the v2 bundle states for visual consistency.
