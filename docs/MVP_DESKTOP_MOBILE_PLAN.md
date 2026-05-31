# MVP Desktop and Mobile Plan

**Date:** 2026-04-23 (updated 2026-04-23 to reflect completed D1-D3 and extend with D4-D5 picked from `docs/CALIBRE_INVENTORY.md`)
**Goal:** Ship a trustworthy local-first Spine MVP on desktop first, then mobile, with native-feeling packaged readers and a stable plugin/integration boundary for future reader engines.

## Product Shape

Spine is a local bibliographic library with an embedded Rust core. Desktop and mobile apps use the same HTTP-shaped API contract even when dispatch is in-process. BIBFRAME in `spine.db` is the source of truth; calibre `metadata.db` remains the compatibility bridge.

## Philosophy Anchors

Every milestone below is bound by the project's core philosophy. Summarized for this plan:

- **BIBFRAME is internal truth.** Every metadata write goes through `spine-bf`; calibre fields are a projection, not a second source of truth.
- **Vertical slice discipline.** The `metadata.db → calibre-db → spine-db → /api/v1/book → UI → reader → writeback` loop deepens before new features fan out.
- **No silent data loss.** Cross-DB writes are transactional. Partial success rolls back both sides.
- **UI must tell the truth.** Surfaces bound to empty crates or stubbed routes are hidden, not greyed-out-with-tooltip.
- **Transport discipline.** Embedded/mobile use in-process dispatch; local sidecars use UDS/Named Pipe; TCP is remote-only and opt-in.
- **Definition of Done.** One canonical API path, automated or documented manual test, calibre fallback preserved, no partial writes, UI reflects code, docs match code.

## Engine Choices For Now

- **Core:** Rust crates in `core/`; `spine-srv` owns API, jobs, ingestion, reader resources, and graph hydration.
- **Desktop shell:** Tauri + React/TypeScript.
- **Desktop packaged reader:** Foliate JS through the Tauri `read_book_resource` bridge.
- **Mobile shell:** native iOS/Android app using the Rust core through the generic `call_api(method, path, body)` bridge (one native module per platform, not per-function UniFFI).
- **Mobile packaged reader:** **v1 ships foliate-js in a Compose
  `WebView` via `WebViewAssetLoader`** (sharing the desktop reader
  bundle — same JS, same CFI semantics, per-spine-item streaming
  closes the big-book class of bugs). Readium Mobile is reserved
  as a future `ReaderEngine` plugin (ADR 023) once mobile plugin
  loading lights up. Full rationale + 9-slice plan in internal design notes
  ("Architectural pin #1").
- **Reader integrations:** optional plugins later; all must use Spine resource, progress, and annotation contracts.

## MVP Desktop

Milestones D1-D3 land the vertical slice end-to-end. D4-D5 extend parity with calibre's front-of-GUI surface (see `docs/CALIBRE_INVENTORY.md` §2) — the muscle-memory layer a migrating calibre user expects without any clicks.

### D1 — Library MVP — complete

- Select existing calibre library via native dialog (`tauri-plugin-dialog`).
- Create or attach `spine.db` beside `metadata.db`.
- List books through `/api/v1/book`.
- Show covers through the canonical book-cover route.
- Persist recent library paths in local storage.

### D2 — Read MVP — complete

- Foliate JS packaged; resources routed through `read_book_resource` (no loopback TCP).
- Drag/drop EPUB ingest via durable jobs (multi-job-safe).
- Add-EPUBs dialog + `Ctrl/Cmd+O` keyboard path.
- Reading progress capture via EPUB CFI, debounced 400 ms, flushed on unmount and `visibilitychange`.
- Reader surfaces errors for missing / unsupported / corrupt resources.

### D3 — Metadata MVP — complete for accept path; reconcile-first deferred

- LoC SRU candidate lookup.
- Accept graph writes to `spine.db`; survive refresh and reopen without field loss.
- **Deferred to D3.1:** reconcile-first URI pipeline against `id.loc.gov` before any local URI minting (see `docs/TECH_DEBT.md` §1.1 — highest-priority decision point; currently violated on every ingest).

### D4 — Library Manage MVP — next

Picked from calibre front-of-GUI (`docs/CALIBRE_INVENTORY.md` §2) as table-stakes parity. Ordered by rising architectural risk, so the first one lands confidence and the hardest one comes when the scaffolding is warm.

1. **Search bar.**
   - Scope: substring match on title + author(s) + tags, case-insensitive, diacritics-folded. No regex, no date predicates, no saved searches, no field-prefix DSL in MVP.
   - API: `GET /api/v1/book?q=<query>`; projection SQL against calibre `metadata.db` joins. No graph round-trip required in MVP.
   - Truth rule: unparseable or empty `q` returns the full list with a silent no-op; never drop results on bad input.
   - Stretch (optional, if backend parser trivial): field-prefix (`author:foo`) once the core path is stable.

2. **Book details pane.**
   - Promote from prototype to load-bearing. Right rail renders the selected book's cover, title, author(s), tags, series + index, identifiers, languages, formats.
   - Fields are links. Clicking an author filters the book list by that author (reuses search or the tag browser once D5.1 lands).
   - Reads the same graph used for edit — no divergence between view and edit surfaces.

3. **Remove book.**
   - Confirm dialog with explicit "also delete files from disk" checkbox (off by default, matching calibre's safer-ish default).
   - Backend: one endpoint deletes the `books` row + its `data` rows + its `spine.db` named graph + its on-disk format files in a single transaction. No orphans in either DB on failure.

4. **Edit metadata (single).** *Highest architectural risk in D4 — the first user-driven write path that exercises the full vertical slice.*
   - Scope: title, author(s), tags, series + index, published date, publisher, language. No custom columns (see Non-Goals).
   - Write path:
     - Goes through `spine-bf::set_fields` — never ad-hoc triple insert, never direct calibre-db write.
     - Emits one transactional projection to calibre `metadata.db` via `calibre-db`.
     - Rolls back both DBs on any failure (never one-sided success).
     - Preserves trigger-maintained calibre fields (`authors.sort`, `books.sort`, `series_index`, FTS rowid).
     - Records provenance on every mutation: `bf:AdminMetadata` with user-assertion, `spine:assertedBy`, `spine:assertedAt`.
   - Definition of Done applies strictly: one canonical API path, automated test covering the round-trip, calibre fallback preserved, no partial writes, UI truth.

### D5 — Browse & Export MVP — after D4

5. **Tag / author browser.**
   - Left sidebar tree. Top-level nodes: Authors, Tags, Series, Publishers, Languages.
   - Cheap for Spine because authors/tags/series are first-class entities in the BIBFRAME graph — the tree is a facet query over the asserted graph, not a column scrape.
   - Click to filter the book list. No drag-drop assign, no hierarchy editor, no user categories in MVP (see Non-Goals).

6. **Jobs indicator.**
   - Status bar region showing running + queued jobs (ingest, reconcile, future export).
   - Click to open a log panel. Backend already emits `JobStatus` over `/api/v1/jobs`; this is UI surfacing, not new state.

7. **Save to disk (export single).**
   - Copy a book's formats + OPF projection to a user-picked folder.
   - Fixed one-level template (`<Author>/<Title>/`). No custom templates in MVP.
   - Uses the same OPF projection planned for EPUB export (`docs/TECH_DEBT.md` §3.8). Exercising it here de-risks the export-on-close path later.

## MVP Mobile

1. **Embedded core bridge.**
   - Compile the Rust core for iOS and Android.
   - Expose the generic `call_api(method, path, body)` module on each platform, plus resource read, job status, library selection/import.
   - Use platform storage rules (iOS app sandbox, Android scoped storage) rather than hardcoded paths.

2. **Local mobile libraries.**
   - App-private libraries first.
   - Import EPUB from document picker / share sheet.
   - Store `metadata.db` + `spine.db` locally.
   - External-folder support later, where platform APIs allow it (Android SAF, iOS Files).

3. **Reader packaging.** v1 ships **foliate-js in Compose WebView**
   (sharing the desktop bundle); Readium Mobile reserved as a future
   `ReaderEngine` plugin (ADR 023). See internal design notes "Architectural pin #1".
   - Resources stream per spine item via `WebViewAssetLoader` from
     app-private storage at `https://appassets.androidplatform.net/book/<filename>/`.
   - Persist EPUB CFI as Spine reading progress, wrapped per the
     plan's pin #2 as `{engine, schema, locator}` so a future
     Readium plugin can coexist without schema churn.
   - Map highlights/annotations into Spine-owned records via
     `callApi` to the in-process `spine-srv` axum router (the
     Android app embeds its own `spine-srv` via `libspine_jni.so` —
     fully standalone, no network required).

4. **Mobile MVP UI.**
   - Library list/grid.
   - Book detail.
   - Read EPUB.
   - Import EPUB.
   - Read-only graph summary (full edit deferred).

## Reader Plugin Boundary

Reader frontends are replaceable integrations. A plugin declares:

- supported platforms;
- supported formats;
- resource transport mode (in-process, UDS, TCP);
- progress locator format;
- annotation support;
- license and redistribution constraints.

Only one packaged reader per platform for MVP: Foliate JS on desktop, **foliate-js in Compose WebView on Android v1** (Readium Mobile reserved as a future `ReaderEngine` plugin per ADR 023; iOS not yet on roadmap).

## Milestones

1. **D1 Library MVP** — complete.
2. **D2 Read MVP** — complete.
3. **D3 Metadata MVP** — accept path complete; **D3.1 reconcile-first URI pipeline** deferred (TECH_DEBT §1.1).
4. **D4 Library Manage MVP** — next: search, book details pane load-bearing, remove, edit metadata single.
5. **D5 Browse & Export MVP:** tag/author browser, jobs indicator, save to disk.
6. **M1 Mobile Core Spike:** Rust core initializes on iOS/Android and answers `/api/v1/ping`.
7. **M2 Mobile Library MVP:** import EPUB, list local library, open detail.
8. **M3 Mobile Read MVP:** foliate-js in Compose WebView opens imported EPUB through Spine's `WebViewAssetLoader` resource path handler (per-spine-item streaming, no whole-archive load) and saves CFI progress through the in-process embedded `spine-srv`.
   Execution plan in internal design notes.

## Non-Goals For MVP

The original non-goals, plus explicit calibre-feature exclusions mapped against `docs/CALIBRE_INVENTORY.md`. Every entry here is a *known calibre feature* that is deliberately out of scope for Spine MVP. Per the truth-in-UI rule, these surfaces are hidden until their backing code exists — never rendered disabled-with-tooltip.

Original non-goals:
- MOBI/PDF/DOCX conversion.
- Cloud sync.
- OPDS server/client (surfaced to LAN).
- Full RDF graph editor.
- Multi-reader plugin marketplace.
- Bidirectional calibre sync beyond safe local projection.

Calibre features explicitly deferred past MVP:
- **Format conversion** (`spine-fmt-*` crates are stubs — TECH_DEBT §3.6). MOBI / PDF / DOCX / FB2 / RTF / HTML / TXT all covered here.
- **E-book editor** — calibre's EPUB IDE; phase 3+.
- **Polish books / Check Book / Compare Books** — container-level transforms; no `spine-polish` crate planned for MVP.
- **Full-text search** — FTS5 sidecar + indexer + query UI; large surface, revisit post-MVP.
- **Store search / Get Books** — 20+ calibre store plugins, mostly stale; not porting.
- **News recipes** — 1,500+ recipes is a maintenance burden; optional post-MVP or cut entirely.
- **Device sync (USB/MTP)** — Kindle / Kobo / Sony / Pocketbook drivers; post-MVP.
- **Custom columns** — BIBFRAME graph is the extensibility story; custom-column projection is a separate architectural decision.
- **Template language** — calibre's formatter DSL (filenames, composite columns, send-to-device); defer.
- **Email / Send-to-Kindle** — SMTP subsystem; post-MVP.
- **Content server exposure** — `spine-srv` exists but MVP does not expose it to LAN. OPDS feed likewise deferred.
- **Saved searches / virtual library tabs / user categories** — belong in a post-D5 sprint once basic search is stable.
- **AI / LLM integration** — calibre's recent addition; decision pending (`docs/CALIBRE_INVENTORY.md` §3 note).
- **Heuristic processing / structure detection** — conversion-adjacent, high support-burden; skip.
- **Catalog generation** (emit an e-book that indexes the library) — niche, defer.
- **Cover generation from metadata** — Pillow-style composite cover; nice-to-have, defer.
- **Auto-add from folder** — watch-folder ingest; post-MVP.

## Verification Gates

Every MVP milestone passes these before it is marked complete:

- `pnpm test` (vitest + cargo).
- `pnpm --filter appsdesktop build`.
- `cargo test --manifest-path core/Cargo.toml`.
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Per-milestone manual smoke:

- **D1–D3:** select library, ingest EPUB, read EPUB, accept LoC graph, close and reopen, reading progress resumes, field values preserved.
- **D4:** search returns filtered rows; book details pane reflects current selection and updates on edit; edit metadata round-trips through close/reopen and preserves `authors.sort` / `books.sort`; remove-with-files clears both DBs and disk atomically.
- **D5:** tag/author browser filters the book list; jobs indicator reflects live ingest; save-to-disk emits an OPF that re-ingests without field loss.
- **M1–M3:** import EPUB, read EPUB, close/reopen, resume progress.

Any failure in the manual smoke blocks the milestone — Definition of Done is load-bearing.

## Post-Alpha Portability Items

Not MVP-blocking, but must ship before a v1 / beta claim of "works on mobile with external storage." All surfaced during the cross-DB atomicity decision; the ATTACH-based design chosen for MVP is correct for desktop and app-private mobile, and these four items are the known gaps when scope expands.

Tracked in `docs/TECH_DEBT.md`:

- **§4.4 Android SAF / user-selected external-folder libraries** — SAF returns URIs, not paths; `rusqlite` needs paths. Breaks on the first Android user who points Spine at `/sdcard/Books/`. Fix options: app-private-only (restrict), copy-on-open (doubles disk), or JNI fd bridge (real fix). Trigger: mobile scope expands past app-private libraries.

- **§4.5 Bundled SQLite audit** — confirm every `rusqlite` consumer in the workspace has `features = ["bundled"]`. Cheap — 5-minute grep. Do this before any mobile target ships.

- **§7.4 ATTACH master-journal overhead at bulk-ingest scale** — invisible at human-scale edits; accumulates on 10k-book imports. Fix via bulk-mode (batch spine.db writes, project calibre afterward). Trigger: a profile shows bulk-ingest bottlenecked on commit overhead.

- **§8 SQLite on network filesystems** — NFS / SMB / cloud-sync folders break SQLite locking. Both DBs can corrupt under concurrent access. MVP has no guard. Fix: probe filesystem type on `open_library`, reject or warn. Trigger: first report of corruption from a user with a networked library.
