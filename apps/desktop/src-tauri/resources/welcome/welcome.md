# Welcome to Spine

A library manager for people who own their books.

---

## What this is

Spine is a cross-platform e-book manager. You own your books; you own the
database that describes them. The files live in folders you can open in a
file manager, named and organized the way you'd name and organize them.
Nothing gets locked into a cloud service or a subscription. Nothing phones
home by default.

This book is a short tour of what Spine does, what's under the hood, and
where to look when you want to go deeper. You're reading it inside Spine
right now — so the first thing has already worked.

---

## The 3-way start

When you first opened Spine, you saw three ways to get going:

1. **Start a new library.** You picked a folder, and Spine seeded it with
   an empty library database. That's what's happened if you got this book.
   From here, you drag EPUBs in (or use the "Add EPUBs" button) and they
   land in this library.

2. **Add a folder of EPUBs.** Point Spine at an existing folder of books.
   Spine creates a library in that folder and ingests every `*.epub` at
   the top level.

3. **Open an existing calibre library.** If you've been using calibre,
   point Spine at your existing `metadata.db` file. Spine reads and writes
   the same database calibre does — there is no migration step, no
   copying, no duplication. Your calibre install and your Spine install
   can both run against the same library folder.

That last point is Spine's most important property: **we are byte-compatible
with calibre.** We treat calibre's database as a first-class surface, not
as something to migrate away from. You can quit Spine, open calibre, edit
metadata, quit calibre, open Spine, and everything just works.

---

## What's in a library folder

Open the folder where this book lives. You'll see two files and a
subfolder:

- `metadata.db` — calibre's library database. Titles, authors, tags,
  series, ratings, reading positions, custom columns. If you have calibre
  installed, this file is identical in shape to what calibre writes.
- `spine.db` — Spine's own sidecar. This is where Spine stores things
  calibre doesn't model: BIBFRAME 2.0 RDF triples, library-of-congress
  reconciliation state, inferred vs. asserted metadata separation,
  reading progress at CFI precision.
- A per-author / per-book folder tree with the EPUB files themselves,
  plus covers and any other format files.

You can back up the folder with any tool that copies files. You can move
it to a different drive. You can share it between machines. The folder is
the library — there is no central service holding state.

---

## BIBFRAME 2.0

Spine models metadata in BIBFRAME 2.0 internally — the Library of
Congress's RDF-based successor to MARC21. If that sentence means
nothing to you, ignore it. For most books, most of the time, you'll
interact with titles, authors, tags, and publish dates — the familiar
surface.

If it *does* mean something to you: every book is a `bf:Work` with one
or more `bf:Instance` children (the editions) and `bf:Item` grandchildren
(the physical file). Reconciliation happens against `id.loc.gov` where
we can get a hit; `urn:spine:*` URIs fill in the rest with full
provenance.

You can export any book as EPUB 3.3 with the full BIBFRAME graph
embedded in the OPF `<metadata>` block plus a JSON-LD blob for lossless
round-trip. No other consumer e-book manager does this.

---

## What works today

The short list of things that already work end-to-end:

- Opening calibre libraries
- Dragging EPUBs in to ingest them
- Browsing, searching, and filtering your books
- Reading books inline (foliate-js under the hood)
- Reading-position sync at CFI precision, so you never lose your place
- Library-of-congress metadata reconciliation
- Multiple views: grid, list, timeline, knowledge graph

The roadmap covers more: MOBI/PDF/AZW3 conversion, mobile apps for
Android and iOS, a library-sharing server so multiple people can read
from the same library without stepping on each other. Watch the repo.

---

## When you want to leave

Spine's data is your data. If you ever decide to leave:

- calibre can read the same `metadata.db` directly. Uninstall Spine and
  point calibre at the folder. You lose the `spine.db` sidecar
  (BIBFRAME graph, LoC reconciliation, precision reading positions) but
  you keep everything calibre itself tracks.
- Export any book as EPUB 3.3 with embedded BIBFRAME and it's
  self-describing. Future tools that read EPUB 3.3 metadata will
  understand what Spine wrote.

No lock-in is the whole point.

---

## Where to look next

- The library view is on your left. Click **Library** in the nav to see
  what's here. This welcome book is a `bf:Work` like any other; you can
  read it, edit its metadata, or delete it without consequence.
- Drop EPUBs onto the main pane to ingest them, or press **Ctrl+O**.
- Click a book to inspect its BIBFRAME graph in the right panel; click
  the pencil to edit.

Welcome. Thanks for owning your books.

— the Spine project
