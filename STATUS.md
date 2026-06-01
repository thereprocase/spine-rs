# Status

A candid snapshot of where each part of Spine stands. This project was developed
intensively, then parked mid-stream; this file is the honest "what works / what's
broken" so nobody is surprised. The latest of everything is at the **HEAD of
`main`**.

Legend: ✅ works · 🟡 partial / rough · 🔴 known-broken / not done

---

## Library engine — `core/` ✅ (most mature)

The Rust core is the strongest part of the project.

- ✅ Opens an existing on-disk **library**; the `metadata.db` catalog stays
  interoperable (the custom `calibre_collation` SQLite collation is registered
  on write, so existing libraries open without conversion).
- ✅ **BIBFRAME 2.0** metadata stored as RDF triples in a `spine.db` sidecar, one
  named graph per book.
- ✅ **Reconcile-first identity** against id.loc.gov, with local minting only for
  gaps; asserted vs. inferred triples kept strictly separate.
- ✅ Metadata mapping in/out of MARC21, ONIX, EPUB OPF, Dublin Core (`spine-bf`,
  `spine-marc`, `spine-onix`, `spine-dc`, `spine-epub-meta`).
- 🟡 Per-format read/write crates (`spine-fmt-epub`, `-mobi`, `-pdf`, `-docx`,
  `-txt`, `-html`, `-fb2`, `-rtf`) — maturity varies by format; EPUB is furthest
  along (deterministic writer work in progress).

## Backend service — `core/spine-srv` 🟡 (exists, partial)

The single HTTP interface every frontend uses.

- ✅ Library endpoints: browse, search, facets, recent, list.
- ✅ Metadata inspector/editor endpoints; reconcile drawer + reconcile-first
  ingest hook; library backup.
- ✅ Inferred-graph read/decide endpoints (asserted vs. inferred promotion).
- 🟡 Format-**conversion** pipeline (a general `ebook-convert`-style any-format
  path) is designed (`docs/ADR_017`, `docs/ADR_018`) and partially built — not
  yet a general convert-anything-to-anything path.
- 🟡 OpenAPI spec drifts from the live handlers in places (`docs/TECH_DEBT.md`).

## Desktop app — `apps/desktop` 🟡 (exists, partial)

Tauri 2 + React. A real shell you can drive, not a mockup.

- ✅ Cover-wall library browse, search, sort, tag/author browser.
- ✅ Metadata inspector with BIBFRAME graph view and a Dublin-Core-style editor;
  edit-metadata drawer (multi-field write).
- ✅ Reconcile drawer wired to the backend; library backup; settings drawer
  (theme / library / backup / reconcile / about); save-to-disk export.
- 🟡 Missing daily-driver niceties: richer batch ops, some context menus, query
  syntax in search, EPUB page counts, big-library virtualization (gated on
  real-world measurement).
- Tests: Vitest happy-path coverage on key surfaces; not comprehensive.

## Native Android app — `apps/mobile/android` 🟡🔴 (coming together — buggy)

Kotlin + Jetpack Compose. This is the **intended mobile future**, and it's the
most actively-churning, least-stable part.

- ✅ Import EPUBs via the system share/open flow into app-private storage.
- ✅ Native EPUB reader that renders **without loading the whole archive into
  JavaScript** (windowed spine-item rendering, no `file://` origin, no
  whole-book JS bridge).
- ✅ Library/home screens, themes, reader chrome, settings, session timer.
- 🔴 Expect bugs. Recent history is a long string of reader/layout/paging fix
  passes (tap zones, page-turn serialization, cutout/overlay chrome, null-deref
  hardening). Pre-alpha: things break.
- Build needs `libspine_jni.so` staged — see `apps/mobile/android/README.md`.

## RN / Expo reader — `apps/mobile-reader` 🔴 (retired proof-of-concept)

React Native + Expo. The **first** mobile attempt; kept for reference.

- ✅ Did several things well: branding, share/import flow, a fully themed reader
  (dark/sepia/light, fonts, justify/hyphenate, paginated/scroll), cover-grid
  library that survives relaunch — pure-TS EPUB parsing.
- 🔴 Has JavaScript bugs.
- 🔴 **Runs out of memory on a large book** — it renders via epub.js inside a
  WebView and effectively loads the whole EPUB in JS, so big books OOM. This
  limitation is exactly why the native app exists.
- **Retired**: no new features land here; it's a UI sandbox only.

---

## Known sharp edges (whole project)

- It's **pre-alpha**: APIs, schemas, and UI move; nothing here is stability-pinned.
- The **conversion pipeline** is the biggest not-yet-finished core capability.
- The **native Android reader** is the most bug-prone surface today.
- The **Expo reader** OOMs on large books by design limitation — use the native
  app (or small books) for real reading.

See `TODO.md` for the near-term list and `docs/TECH_DEBT.md` for the long tail.
