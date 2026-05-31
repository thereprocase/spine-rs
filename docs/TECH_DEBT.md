# Spine — Technical Debt Register

**Source:** code review round 1 and round 2, both 2026-04-23.
**Status legend:** `fixed` | `in-flight` | `deferred` | `decision-needed`.

This document tracks items not patched during the remediation sprints — either because they require product decisions, cross-cutting refactors, or new features rather than patches. Items marked `fixed` are retained here as history.

## Decision-points that gate everything else

These five items need product input before the rest can finish converging:

1. **§1.1** — reconcile-first URI pipeline. Blocks every future ingest from violating a locked invariant. UX decision (blocking / background / drawer).
2. **§1.2** — asserted vs. inferred graph partition. Design-level; currently a write-path doesn't exist.
3. **§2.1** — session swap during in-flight jobs. Three valid implementations; needs a UX call.
4. **§3.6** — twelve stub format crates. Delete or implement.
5. **§3.7** — legacy API alias sunset date.

Until these land, the rest of the debt is mostly mechanical.

---

## 1. Locked-invariant violations (decision-needed)

### 1.1 `urn:spine:*` URI minting bypasses reconcile-first pipeline
**Severity:** critical. **Status:** in-flight — Sprint 10 landed the drawer + 3 reconcile endpoints + amendments 1/2; Sprint 10.5 lands the ingest-path hook + background sweep + pre-ADR backfill (`sprint-10.5-ingest-hook`).

**Sprint 10.5 follow-up (deferred): Work-URI vs Instance-URI LCCN distinction.** The current `BlockingLocReconciler::reconcile_work` impl in `core/spine-meta/src/reconcile.rs` constructs `http://id.loc.gov/resources/works/{lccn}` using the LCCN parsed from MARCXML controlfield 001 — but field 001 is the LCCN of the *bibliographic record* (instance-level), not the Work-level uniform-title LCCN (typically MARC field 240/100 or a separate id.loc.gov BIBFRAME RDF lookup). The architectural shape (reconcile-first hook + 3-way `ReconcileResolution` + `spine:uriSource` provenance) is correct and ADR-conformant; the Work URI extraction algorithm is approximate and a future ADR should refine via either a second SRU call (240+100 lookup) or a `bf:instanceOf` follow against id.loc.gov.

**Sprint 10 cluster landed (2026-04-25, `9d030b8` / `c7372a8` / `e062f48`)**:
- ADR 015 amendment-1: open-vocab `UriSource` SHACL gate with `tracing::warn!` for unknown variants (was: closed `matches!()` rejection).
- ADR 015 amendment-2: dropped `UriSource::Locmint` enum variant (zero callers across spine-bf/spine-srv/spine-meta).
- 3 reconcile endpoints in `spine-srv`: `GET /api/v1/reconcile/queue`, `POST /api/v1/reconcile/{book_id}/promote {locUri}`, `POST /api/v1/reconcile/{book_id}/skip`.
- `spine-db::list_reconcile_pending_graphs()` enumeration helper.
- `apps/desktop/src/ReconcileDrawer.tsx` rewired onto endpoint contract; vitest `ReconcileDrawerWired.test.tsx` 7/7 passing; `cargo test --test reconcile_endpoints_test -p spine-srv` 7/7 passing.

**Still pending (Sprint 10.5)** — these flip §1.1 to `fixed`:
- `to_triples` reconcile-first hook in `core/spine-bf/src/lib.rs` (calls `reconcile_work_synchronous` before minting, emits `spine:uriSource` provenance per outcome).
- Background re-reconcile sweep `spine_meta::background_reconcile_sweep` (hourly + on library open; promotes `spinemint` → `locref`; emits `<old> owl:sameAs <new>` per ADR 015 §step-5 pick (a)).
- Pre-ADR backfill for books minted before ADR 015 (no `spine:uriSource` triple → flag for reconcile on library open).
- StatusBar `N reconciles pending` count (~20L).
- `bf:AdminMetadata` provenance reification on the `owl:sameAs` assertion in `promote` endpoint (deferred — see §2.8).

### 1.2 Asserted-vs-inferred graph separation not implemented
**Severity:** critical. **Status:** deferred.

`PLAN.md` mandates LLM-inferred triples live in a separate graph with `spine:confidence`, `spine:inferredBy`, `spine:inferredAt`. The current `spine-db` has one graph table and no inferred-graph partition.

**What's needed:** second named graph per book (`urn:spine:inferred:{uuid}`); write path in `spine-bf` for inferred triples; promotion API for user-approved inferred → asserted. No LLM inference runs yet, so this is a forward-looking guardrail.

---

## 2. Session & data-lifecycle

### 2.1 Session swap orphans in-flight jobs
**Severity:** critical. **Status:** decision-needed.

`apps/desktop/src-tauri/src/lib.rs:158-174` `open_library` replaces `state.session` with a new `DesktopSession`. Spawned ingest tasks hold `Arc<SrvAppState>` on the *old* state. Old jobs finish into the old `spine.db`; new UI sees 404 on `/api/v1/jobs/:id`; reopening the old library later reveals ghost books. Also, `job_status` is in-memory `HashMap` with no persistence.

**Decision:** on `open_library`,
- (a) reject with "N jobs running" until idle, or
- (b) await/drain outstanding jobs (blocks UI for N seconds), or
- (c) persist `job_status` to `spine.db` + reconcile on reopen.

Default recommendation: **(c) + (a)** — persist completion, reject switch while jobs running. Needs UX mockup.

### 2.2 Dictionary term leak after rollback
**Severity:** warning. **Status:** deferred (slow leak, not a crash).

`core/spine-db/src/lib.rs` `delete_graph` removes rows from `triples` and `mv_book_subjects` but leaves orphaned rows in `terms`. Over many rollbacks or replace_graph calls, `terms` grows unboundedly.

**Fix:** periodic sweep SQL (`DELETE FROM terms WHERE id NOT IN (SELECT subject_id FROM triples UNION SELECT predicate_id ... UNION SELECT object_id ...)`) run at library-open or under a maintenance command. Low urgency.

### 2.3 Ingest crash between spine.db and calibre.db leaves orphan triples
**Severity:** warning. **Status:** deferred.

Process kill after spine.db insert, before calibre.db projection, leaves triples with no calibre row. Graph URI is keyed on a UUID that never reaches calibre, so the orphan is invisible but inert. Reconcile sweep at `open_library` would repair.

**Fix:** add "pending-projection" flag in `spine.db`; clear once calibre insert commits; sweep orphans at library open. Requires design of the pending table.

### 2.4 Retire `updated_at_unix` seconds column on `reading_progress`
**Severity:** note. **Status:** deferred (staged migration — HTTP projection now ms-precise, column retirement still outstanding).

Round-1 added `updated_at_ms` additively while keeping `updated_at_unix` populated so downstream consumers kept working unchanged. Round-2 migrated the HTTP projection: `spine-srv::api_v1::to_api_reading_progress` now calls `DateTime::from_timestamp_millis(progress.updated_at_ms)`, so clients see millisecond-precise timestamps. Two timestamp columns still mean two writes per upsert.

**Path:**
1. ~~Migrate `spine-srv/src/api_v1.rs` to read `updated_at_ms` and return ms in the HTTP response.~~ Done 2026-04-23 (round 2).
2. Migration: `ALTER TABLE reading_progress DROP COLUMN updated_at_unix` (SQLite 3.35+).
3. Remove `StoredReadingProgress::updated_at_unix` and the dual-write in `upsert_reading_progress`.

Do steps 2 and 3 together; do not leave a trailing seconds-column for long.

### 2.6 Non-atomic read-modify-write on monotonic ms upsert — **fixed** (round 2)
`upsert_reading_progress` now wraps the `SELECT MAX(updated_at_ms)` + compute + `INSERT ... ON CONFLICT` sequence in an explicit `BEGIN IMMEDIATE` transaction so SQLite takes a reserved lock before the read. `clamp_ms_monotonic` extracted as a pure helper. Concurrent-writer test with two `SpineStore` handles on a shared file proves distinct `updated_at_ms` values per upsert. See commit `ddc98e8`.

### 2.7 Bearer compare length-leak — **fixed** (round 2)
Hand-rolled `constant_time_eq` returned `false` on length mismatch before comparing any bytes, giving an attacker a timing oracle on token length. Replaced with `subtle::ConstantTimeEq::ct_eq`. Also case-insensitive Bearer prefix handling per RFC 6750. Eight unit tests + eight integration tests via `tower::ServiceExt::oneshot` (`tests/bearer_auth_test.rs`). See commits `eaeb701`, `e6f71b7`.

### 2.8 Reconcile promote omits `bf:AdminMetadata` provenance — **deferred** (Sprint 10)
`POST /api/v1/reconcile/{book_id}/promote` writes the `(work, owl:sameAs, locUri)` edge per ADR 015 §5 but does not yet attach `bf:AdminMetadata` triples (who promoted, when, against which candidate id) to the assertion. ADR 015 §5 specifies the provenance, ADR 006 §4 specifies the named-graph reification mechanism, and the Sprint 10 cluster ships the `owl:sameAs` edge alone — the spec deliberately doesn't pin admin-metadata so the heavier reification doesn't gate the drawer's first end-to-end pass.

**Fix:** when the next consumer of named-graph reification arrives (e.g. background sweep auto-promote, audit query, or user "who promoted this?" affordance), wire `bf:AdminMetadata` triples on the `owl:sameAs` assertion per ADR 006 §4. Bump the promote handler at `core/spine-srv/src/reconcile.rs::promote` accordingly. Until then, the asserted graph carries write-time provenance (`spine:uriSource`) but not promotion-time provenance.

### 2.5 Blank-node scope hash strength
**Severity:** note. **Status:** deferred.

`spine-bf::graph_scope_token` uses `DefaultHasher` truncated to 32 bits for contribution blank-node labels. Collision probability ~N²/2³³ — tolerable at sub-100k books, marginal at 1M+. Also: `DefaultHasher` output is **not stable across Rust versions or processes** — current code only needs per-call stability, which holds, but any future feature that persists blank-node labels and expects them to match across restarts will silently break.

**Fix:** swap to SHA-256 truncated to 8 hex chars once a crypto hash crate lands in the workspace. Add a comment at any call site that persists these labels (there are none today).

---

## 3. Architecture & abstraction boundaries

### 3.1 `spine-srv` contains domain logic that belongs in `spine-meta`
**Severity:** warning. **Status:** deferred (large refactor).

`core/spine-srv/src/lib.rs:145-385` `fetch_candidates`, `score_candidate`, `synthesize_golden_candidate`, `clean_name` implement LoC candidate ranking and metadata fusion — agentic synthesis logic — in the HTTP transport layer.

**Fix:** extract to `spine-meta::reconcile::{score, synthesize, clean_name}`; handler becomes a two-line dispatch. Do together with §1.1 reconcile pipeline.

### 3.2 oxrdf types leak across spine-bf boundary
**Severity:** warning. **Status:** deferred.

`spine-bf` exposes two disjoint triple APIs: `to_triples` returns `(Subject, NamedNode, Term)` (oxrdf types); `bibliographic_graph_to_triples` returns `(String, String, String)`. `spine-srv/src/ingest.rs:39-57` hand-destructures oxrdf `Subject`/`Term` variants, leaking internal representation.

**Fix:** unify `spine-bf` boundary on `GraphTriple` (strings); keep oxrdf internal.

### 3.3 Three parallel API contracts
**Severity:** warning. **Status:** deferred.

`core/spine-api/src/v1.rs` defines `ApiBook`/`ApiContributor`/`ApiInstance` with typeshare bindings — **never referenced by any handler**. Handlers return `spine_api::Book` (legacy shape with `legacy_metadata` + nested `BibliographicGraph`). `docs/openapi_book_resource.yaml` describes the `ApiBook` shape.

Three contracts, no alignment. First external frontend author will pick whichever one looks real.

**Fix:** adopt one, delete the other two. Recommend `ApiBook` (OpenAPI-aligned, typeshare-ready) since that's the documented contract. Requires handler rewrite and frontend migration.

### 3.4 App.tsx is 1,355 lines, one component, 42 hooks
**Severity:** warning. **Status:** deferred (pre-mobile refactor).

`apps/desktop/src/App.tsx` holds grid state, inspector state, reconciliation state, reader state, ingest state, and LoC candidate state in one function. `normalizeName` duplicates Rust's `clean_name` — two sources of truth.

**Fix:** split into `features/Library/`, `features/Inspector/`, `features/Reader/`, `features/Reconciliation/`, `features/Ingest/`. Move the typed API client into `apps/desktop/src/api/client.ts`. Do before mobile work starts — otherwise the whole tangle gets copied into React Native.

### 3.5 Blank-node contribution scoping violates RDF semantics
**Severity:** warning. **Status:** deferred (RDF redesign).

`core/spine-bf/src/lib.rs:62-85` emits positionally stable blank-node contribution URIs `_:contrib_{index}` that land in a workspace-wide `terms` dictionary. Blank nodes must be graph-scoped; the current flattening means `_:contrib_0` across two books shares a `term_id`, and any cross-graph SPARQL BGP query would union contributions across unrelated books.

**Partial fix applied:** graph-URI-hash-prefixed blank node labels when serializing. Full fix (separate blank-node table scoped to graph) deferred.

### 3.6 Stub format crates
**Severity:** note. **Status:** decision-needed.

Twelve crates are `cargo new` defaults containing only `fn add(left, right)`:
`spine-fmt-epub`, `spine-fmt-mobi`, `spine-fmt-pdf`, `spine-fmt-docx`, `spine-fmt-txt`, `spine-fmt-html`, `spine-fmt-fb2`, `spine-fmt-rtf`, `spine-dc`, `spine-oeb`, `spine-onix`, `spine-epub-meta`.

They compile, occupy the namespace, and create the illusion of structure.

**Decision:** delete and re-add when each gets its first real function, or add `//! STUB — see PLAN.md §X` and keep. `spine-fmt-epub` is arguably real (ingest EPUBs exists — but in spine-srv, not the crate). Either move EPUB logic into `spine-fmt-epub` or delete the crate.

### 3.9 Two independent job pollers for the same job set
**Severity:** note. **Status:** deferred (code review W9).

`apps/desktop/src/App.tsx` has two distinct poller paths that both hit `/api/v1/jobs`:
1. The `JobsIndicator` component's own interval-based poll for the badge count.
2. The per-book `pollJobStatus` in `pendingJobIdsRef` that tracks ingest completion.

These share no state and both fire on their own timers. On a slow connection with several books ingesting, that is 2× the request rate with no benefit. Consolidate into a single polling hook that fans out results to both consumers via a shared context or Zustand slice. Fix during §3.4 App.tsx refactor.

### 3.8 OPF export / Dublin Core projection not implemented
**Severity:** warning. **Status:** deferred.

Track D (D1: OPF Exporter, D2: Export Action) was never built. No path exists to project a `spine.db` BIBFRAME graph back into a standard `metadata.opf` Dublin Core file. Users cannot round-trip their library back to a calibre-compatible form outside of the existing byte-compatible `metadata.db` projection.

**Fix:** implement `spine-dc` (currently stub) with a function that takes a `BibliographicGraph` and emits OPF 3.3 + DC elements. Add a Tauri command and UI hook to save `{book}.epub` + `{book}.opf` pair to a user-chosen directory. Blocked by §3.6 stub-crate decision.

### 3.7 Legacy API aliases have no sunset
**Severity:** note. **Status:** deferred.

`/api/v1/library/books/*` routes remain as compatibility aliases with no `Sunset:` header and no removal date. Will still be here in 2031 unless tagged.

**Fix:** add `Sunset: Wed, 31 Dec 2026 00:00:00 GMT` header and delete in v1.0.0 milestone.

### 3.10 AddSubjectDialog autocomplete silently swallows non-404/non-200 responses
**Severity:** note. **Status:** deferred (gated on telemetry surface). **Source:** code review N5, 2026-04-25.

`apps/desktop/src/AddSubjectDialog.tsx:81-83` catches the autocomplete fetch's `Promise.catch` arm and silently keeps last results when the response is anything other than a clean 200 or a 404:

```ts
} else {
  // Network blip / 5xx — keep last results, don't surface noise.
}
```

The 404 path correctly degrades to free-text mode for the dialog lifetime (`setAutocompleteAvailable(false)`). The 5xx path is invisible: if the suggest endpoint is consistently returning 500 (LoC outage, backend bug, expired token), the user types, expects a dropdown, gets nothing, and infers "no LCSH match for this term" — which is the wrong inference and corrupts the user's mental model of what's being reconciled.

**Fix options:**
- **(a) consecutive-failure counter.** Track non-200/non-404 responses; after 3 in a row, set a soft flag and render a small `⚠ suggest unavailable` hint below the input. Self-resets on next 200. ~15L.
- **(b) one-time toast.** First 5xx in a session shows a one-time toast `"LCSH suggest service unavailable — type freely; subjects will mint locally with reconciliation pending."` Subsequent 5xx in the same session are silenced (already remembered). ~10L.

**Recommended:** (a). The visible-but-quiet hint matches Spine's general "ambient signal, never modal noise" UX commitment.

**Trigger:** defer until there is real telemetry on suggest endpoint reliability. Pre-ship, the 404 fallback is the dominant case (endpoint not deployed); 5xx is hypothetical.

### 3.11 `callApiJson` lacks `AbortSignal` surface
**Severity:** note. **Status:** deferred (small surface change). **Source:** code review N6, 2026-04-25.

`apps/desktop/src/api/client.ts::callApiJson` does not accept an `AbortSignal`. The AddSubjectDialog autocomplete (lines 58-87 of `AddSubjectDialog.tsx`) clears its 200ms debounce timer on dialog close, but a fetch that has already started is not aborted — the response lands post-unmount and React 18 logs `Can't perform a state update on an unmounted component` to the console. The same shape applies to any future debounced-search component (LCSH dialog, library quick-filter, calibre tag picker, etc.).

**Fix:** add an optional `signal?: AbortSignal` parameter to `callApiJson` (and `callApi` for symmetry); thread it into the underlying `fetch` call. Each consumer that wants to honor cancellation creates an `AbortController` in its `useEffect` cleanup:

```ts
useEffect(() => {
  const ctrl = new AbortController();
  callApiJson(..., { signal: ctrl.signal });
  return () => ctrl.abort();
}, [...]);
```

~10L on the api/client surface plus 1-3L per consumer.

**Why warning-not-noted:** functional impact today is just a console warning + brief GC retention. The pattern matters more as the codebase accumulates debounced/long-running fetches; fixing the api surface now means future consumers don't repeat the workaround.

**Trigger:** fold into Sprint 9 / Sprint 10's frontend work alongside any other api/client.ts touch.

---

## 4. Mobile cross-compile prep

### 4.1 Desktop-only concerns baked into `create_router` — **fixed** (Sprint 1, Android)
`create_router` is now pure axum wiring (routes + the universal 64 MB body-size limit); the CORS allow-list moved to `create_desktop_router`, gated behind the default `desktop` feature. Mobile embedders build `spine-srv` with `--no-default-features --features mobile`; `tower-http/fs` was dropped from the workspace pin (was never actually used) and `tower-http/cors` is pulled in only by the `desktop` feature. The `spine-srv` bin has `required-features = ["desktop"]` so the standalone TCP sidecar doesn't try to build on a mobile target. Desktop Tauri (`apps/desktop/src-tauri/src/lib.rs`) and the standalone server (`core/spine-srv/src/main.rs`) migrated to `create_desktop_router`. Tests and internal helpers keep calling `create_router` — they don't depend on CORS.

### 4.2 Cargo feature flags missing for TLS backend
**Severity:** note. **Status:** partially fixed — `rustls-tls` set explicitly on `reqwest`. Android cross-compile still untested.

### 4.3 `image` crate full codec set pulled by `spine-kindle`
**Severity:** note. **Status:** deferred.

`core/spine-kindle/Cargo.toml:8` — `image = "0.25"` with default features pulls every codec. Binary size concern on mobile ABIs. Feature-flag to `["jpeg", "png"]` when `spine-kindle` is actually built for mobile.

### 4.4 Android SAF / user-selected external-folder libraries
**Severity:** warning. **Status:** deferred (post-alpha).

Android's Storage Access Framework hands back content URIs, not filesystem paths. `rusqlite` — and every SQLite binding we'd plausibly use — needs a real path to `open()`. The moment the mobile MVP lets a user point Spine at a library on an SD card, cloud-sync folder, or shared-storage `Documents/Books/`, both `metadata.db` and `spine.db` become unopenable and ATTACH DATABASE goes with them.

**Scope:** this is not just an ATTACH problem — it breaks every SQLite operation on external storage. Called out here because the cross-DB write path makes it more visible.

**Fix options:**
- (a) **App-private only** — permanent restriction; document as a limitation. Loses "bring your own calibre library on SD card" story.
- (b) **Copy-on-open** — mirror the selected library into app-private storage, write-back on close. Doubles disk use, risks divergence, bad for large libraries.
- (c) **JNI fd bridge** — open DB from a file descriptor obtained via SAF, using Android's `ParcelFileDescriptor` and a custom VFS. Real fix; non-trivial work; there's prior art in `sqlite-android` and `AnkiDroid`.

**Trigger to act:** when mobile scope expands past app-private libraries (MVP plan step M2.4). Not before.

### 4.5 Confirm bundled SQLite across all crates using rusqlite
**Severity:** note. **Status:** verify-required (cheap).

Cross-platform consistency requires `rusqlite` built with the `bundled` feature so we ship a known-good SQLite rather than linking the system one (Android's system SQLite has historically lagged several years behind upstream). Quick audit: grep every `Cargo.toml` that depends on `rusqlite` and confirm `features = ["bundled"]` is set. If missing anywhere, add it.

**Fix:** 5-minute audit + possible one-line edit per crate. Do this before the ATTACH-based cross-DB atomic helper lands in production use on any mobile target.

### 4.6 Dev-ring identifier collides with future stable
**Severity:** warning. **Status:** deferred (before first stable release).

`apps/desktop/src-tauri/tauri.conf.json` uses identifier `com.thereprocase.spine` for both `pnpm dev` (development) and the eventual stable ring. Dev-mode Tauri writes AppData to `%AppData%\com.thereprocase.spine\`. When a stable build ever ships, first launch inherits whatever dev runs left there — partial migrations, stale recent-library lists, experimental flags.

**Fix:** add a `tauri.dev.json` override (analogous to `tauri.alpha.json`) that pins identifier `com.thereprocase.spine-dev` for `pnpm dev` runs. Wire `dev:desktop` to pass `--config src-tauri/tauri.dev.json`. Mint a third pinned WiX UpgradeCode — dev MSIs are unlikely but the principle is the same as alpha.

**Trigger:** before the first stable release. Not urgent while the ring is "dev + alpha only".

### 4.7 DB schema-skew guard across rings missing
**Severity:** warning. **Status:** deferred.

Alpha and stable share `metadata.db` + `spine.db` (per-library data, not per-install). If alpha ring N+1 runs a schema migration that stable doesn't understand, a user who launches stable on a library alpha touched hits corruption or a migration error with no guardrail.

**Fix:** on DB open, read `PRAGMA user_version` / `schema_upgrades` max row and compare against the binary's max known migration. Refuse to open a library that is ahead of the running binary. Pair with a user-visible "this library is from a newer version of Spine — upgrade or use the newer alpha" message.

**Trigger:** before any schema-altering migration lands on alpha while stable is also in circulation. Until first stable ships, alpha users are mono-ring and this is dormant.

### 4.8 Alpha-build concurrency hazards
**Severity:** note. **Status:** partially mitigated (mutex), rest deferred.

The alpha workflow has several small concurrency hazards surfaced during review of commits `b3b6b1e` / `7fbd23f`:
- Parallel `pnpm alpha` invocations both read the same on-disk SEQ and produce the same filename. Mitigated by a stale-config mutex (`tauri.alpha.json` existence check).
- `pnpm dev` + `pnpm alpha` race for `apps/desktop/src-tauri/target/.cargo-lock`. Second invocation blocks; not corrupting but confusing. Documented in `docs/DEV_WORKFLOW.md`.
- `GIT_SHA` is captured at script start; a commit landed mid-build tags the output with the pre-commit SHA. Not fixed; low real-world impact.
- `-dirty` tag only flags tracked modifications, not untracked files. Deliberate — test assets shouldn't flip the tag. Documented in-script.
- MSI Windows ProductVersion version scheme `0.<YY>.<DOY*10+seq>` wraps when `YY` reaches `00` in 2100 — escape hatch is to bump major from 0.

### 4.9 UTF-8 lossy conversion corrupts binary response bodies in `callApi`
**Severity:** warning. **Status:** deferred. **Source:** code review W4 (Sprint 1).

`core/spine-jni/src/lib.rs` `callApi` converts response bytes to a Kotlin string via `String::from_utf8_lossy(&bytes).into_owned()`. For JSON API responses this is safe. For any route that returns binary data (cover JPEG, EPUB resource asset, export zip), the lossy conversion replaces every byte sequence that is not valid UTF-8 with the Unicode replacement character (U+FFFD), silently corrupting the body.

**Three fix options:**
- **(a) Refuse binary routes** — at the JNI bridge level, inspect `Content-Type` before converting; return a 415-shaped error envelope if the route returns non-text. Does not help if Kotlin needs the binary.
- **(b) Base64-encode non-text responses** — detect non-text `Content-Type` and return a base64-encoded string with a `{"encoding":"base64","data":"..."}` wrapper. Kotlin unwraps before use. Adds ~33% overhead on every binary response.
- **(c) Add `callApiBytes` JNI entrypoint** — a second JNI function that returns `jbyteArray` instead of `jstring`. Kotlin calls `callApi` for text, `callApiBytes` for binary. Cleanest; requires Kotlin wrapper update.

**Trigger:** when any Android feature needs to display covers or serve EPUB resources. The in-memory /api/v1/ping path today is pure JSON and is not affected.

### 4.10 `callApi` hardcodes `Content-Type: application/json` for non-empty bodies
**Severity:** note. **Status:** deferred. **Source:** code review W5 (Sprint 1).

`core/spine-jni/src/lib.rs` `callApi` adds `Content-Type: application/json` whenever `body_str` is non-empty. There is currently no way to send `multipart/form-data` (EPUB ingest), `application/x-www-form-urlencoded`, or any other content type from the Kotlin side.

**Fix:** add a `content_type: JString` argument to `callApi` (or a separate `callApiWithHeaders` entrypoint); use that value instead of the hardcoded header. Deferred until the first non-JSON POST route is needed from Android (EPUB ingest, Sprint M2+).

**Note:** if `callApi`'s signature grows arguments, the idempotent-reentry concern in §4.11 must be checked first.

### 4.11 `initCore` silent idempotent re-entry will drop future arguments
**Severity:** note. **Status:** deferred. **Source:** code review W6 (Sprint 1).

`initCore` is intentionally idempotent: a second call (e.g., from a recreated Activity) is a no-op that returns `{"status":"ok","already_initialised":true}`. If `initCore` ever grows arguments (library path, auth token, server config), the no-op path will silently ignore the new arguments on re-entry. A caller passing a new library path on second call will get the first call's state with no error.

**Fix options:**
- Compare new args against stored args; if they differ, return an error or reinit.
- Change the contract: if already-initialised and args differ, require `shutdownCore` + `initCore`.

**Trigger:** before the second argument to `initCore` ships. Not urgent while the signature is `()`.

### 4.12 Kotlin wrapper `callApi` can return `null` on JVM OOM
**Severity:** note. **Status:** deferred. **Source:** code review N5 (Sprint 1).

`to_jstring` in `core/spine-jni/src/lib.rs` returns `std::ptr::null_mut()` when `JNIEnv::new_string` fails (JVM OOM or string too large). On the Kotlin side, `callApi` is declared as returning `String` (non-null in Kotlin's type system), but the JNI declaration `external fun callApi(...): String` will receive a `null` pointer that Kotlin will treat as a non-null `String`, causing a `NullPointerException` at the first field access.

Sprint 2 (Kotlin wrapper) MUST declare the return type as `String?` (nullable) and handle `null` explicitly. Leaving it as `String` is a latent NPE in any path where the Rust side runs out of JVM string space.

**File in Sprint 2's Kotlin wrapper task as a blocking requirement.**

---

## 5. Test coverage gaps (Ent's report)

| Sprint | Grade | Gap |
|---|---|---|
| A1 | thin | Fake perf test (`core/spine-srv/tests/perf.rs` asserts string literals, never times anything), zero-assertion `pnpm test` via `ui-shared` echo. |
| A2 | thin | No HTTP-layer detail test with real UUID + hydrated graph shape. |
| A3 | thin | Rollback failure tested; happy path untested at integration level. |
| A4 | thin | Path-traversal unit-tested only; not exercised through the live `/api/v1/reader/book/:id/resource/*path` route. |
| A5 | **missing** | No round-trip test for accept-LoC → refresh → reopen preserves fields. The locked acceptance criterion that triggered the sprint has zero automated coverage. |
| D1 | adequate | — |
| D2 | thin | Empty-locator reject + no-calibre-book UUID paths untested. |

**Rate limit gap (code review W6):** `GET /api/v1/library/search` has no per-client rate limit. A busy client (or a bug) can issue dozens of search calls per second; each holds the `Mutex<CalibreLibrary>` for the full SQLite query. Add `tower_governor` or a lightweight `leaky_bucket` middleware on the search route. Tier: post-MVP (acceptable on loopback with a single desktop client; necessary before TCP mode is used by third-party clients).

**Deferred tests:**
- **`spine-marc` regression corpus:** removed `test_loc_test_xml` during the remediation sprint — it read a repo-root scratch file and contained no assertions (only `println!`). Replace with a tests/fixtures/ directory containing a small curated MARCXML sample and real assertions on leader bytes, control-field count, and data-field presence. Track alongside §5 A5 work.
- **A5 round-trip:** needs a test EPUB fixture and a mocked LoC response (mockito already available in `spine-meta`).
- **Ingest happy path:** needs in-memory calibre schema set up end-to-end with a real EPUB.
- **Frontend test infra:** no Vitest/Jest wired in `apps/desktop`. `pnpm test` runs zero frontend assertions.
- **`fetch_bibframe_json` 4xx/5xx/parse-error tests:** pattern already exists via mockito in `spine-meta`.
- **`calibredb`-dependent test:** `core/calibre-db/src/lib.rs:519-554` silently panics-not-skips on CI without `calibredb` installed. Add `#[ignore]` or feature-gate.

---

## 6. CI / release engineering

### 6.1 No CI configuration — **fixed** (2026-04-24)
Two workflows landed under `.github/workflows/`:

- **`ci.yml`** — PR gate + main push. Four jobs: `fmt` (rustfmt on core), `test-linux` (pnpm test + cargo test via `pnpm test` + `pnpm --filter appsdesktop build`), `test-windows` (same + `cargo check` on `apps/desktop/src-tauri/Cargo.toml`), `android-jni` (cross-compile `spine-jni` for `aarch64-linux-android` via `cargo-ndk` + `nttld/setup-ndk@v1` with NDK r27c, verify the output is a valid ARM aarch64 ELF). Uses `Swatinem/rust-cache@v2` per workspace. Honors `rust-toolchain.toml` via `rustup show`.
- **`release.yml`** — `workflow_dispatch` + `v*` tag triggers. Two jobs: `msi` (windows-latest; runs `bash scripts/build-alpha.sh`; uploads `artifacts/alpha/*.msi` + `BUILDS.md` as artifacts, 30-day retention) and `apk` (ubuntu-latest; parses `compileSdk` from `apps/mobile/android/app/build.gradle.kts` dynamically via `grep -oE`, installs matching `platforms;android-<N>` + `build-tools;<N>.0.0` via `android-actions/setup-android@v3`, installs NDK r27c, runs `bash scripts/build-apk.sh`, uploads the APK + BUILDS.md; also uploads the staged `libspine_jni.so` as a diagnostic artifact if the gradle step fails).

Until Sprint 2 Android Kotlin lands, the `apk` release job goes honest-red at `:app:assembleDebug` — that IS the validation signal per the Sprint 3 ruling. The `android-jni` CI job stays green throughout because it only cross-compiles the Rust `.so`.

Sprint gates (`pnpm test`, `pnpm --filter appsdesktop build`, cargo checks) are now machine-enforced on every PR instead of convention.

### 6.2 Release/bundle metadata placeholders
**Severity:** warning. **Status:** partially fixed (sets real `productName` and `identifier`). Code signing / notarization config for macOS+Windows bundles still absent; defer until first public release.

### 6.3 Dep-version unification — **fixed** (2026-04-23)
Previously `tower`, `tower-http`, `thiserror`, and `zip` each had two versions in the dependency graph due to stale workspace pins.

- `tower 0.4` → `0.5` in workspace; `apps/desktop/src-tauri/Cargo.toml` inline pin also updated to `0.5`.
- `tower-http 0.5` → `0.6` in workspace; `fs` and `cors` features confirmed present in `0.6`.
- `thiserror 1.0` → `2.0` in workspace; all `#[error(...)]` derives compiled unchanged.
- `zip 2.1` → `2.4` in workspace to match the `2.4.2` version already in Cargo.lock.
- `oxrdf` inline `"0.1"` in `core/spine-srv/Cargo.toml` → `{ workspace = true }`.
- `axum` inline `"0.7"` in `apps/desktop/src-tauri/Cargo.toml` → explicit version with matching features (no longer potentially diverging from workspace).

**Remaining dual-version crates (transitive — not fixable from workspace):**
- `thiserror 1.0.69`: pulled by Tauri's own internal deps (`tauri`, `tauri-utils`, etc.) which pin 1.x. Our workspace crates use 2.0. Cannot consolidate without Tauri upstream bump.
- `getrandom 0.2 / 0.3 / 0.4`: oxrdf pulls rand 0.8 → getrandom 0.2; mockito pulls rand 0.9 → getrandom 0.3; tempfile/uuid pull getrandom 0.4. All transitive; no workspace fix.
- `windows-sys 0.59 / 0.60 / 0.61`: multiple Tauri and system crates pin different patch ranges. Transitive; leave.

### 4.13 `windows-sys` multi-version churn from `jni 0.21`
**Severity:** note. **Status:** tracked-but-unactionable until `jni 0.22` ships.
**Source:** code review N3 (Sprint 1).

`jni 0.21` pulls `windows-sys 0.45` as a transitive dependency, adding a fourth copy of `windows-sys` to the resolution graph alongside the three already present from Tauri's transitive tree. This adds noise to `cargo tree` output and marginally increases Windows binary size, but does not affect correctness.

**Fix:** upgrade to `jni 0.22` when it ships (the `jni` maintainers have indicated they will bump `windows-sys` then). No workspace fix is available in the interim. Retrigger this investigation after any `jni` minor bump.

### 4.14 ProGuard `-keep` rule for SpineCore native methods
**Severity:** low. **Status:** guarded. **Source:** Sprint 2, 2026-04-24.

`apps/mobile/android/app/proguard-rules.pro` now includes:

```
-keep class com.thereprocase.spine.SpineCore { *; }
-keepclasseswithmembernames class * { native <methods>; }
```

These rules are inert today because `isMinifyEnabled = false` in both `debug` and `release` build types. The moment R8 is turned on — likely Sprint 4 or first stable release ring — R8 will scan for unreferenced symbols and strip every `external fun` binding *silently*, because no Java/Kotlin caller ever uses the generated JNI signature name directly; the only "caller" is the native `libspine_jni.so` on the other side of the JNI boundary, which R8 cannot see.

The symptom of this failure is `java.lang.UnsatisfiedLinkError: No implementation found for ...` at runtime, only in R8-enabled builds, with no warning at build time. Time-bomb class: "everything works in dev, breaks on release builds."

The `-keep` rules defuse this ahead of time. Self-documenting comment in `proguard-rules.pro` points back to this TECH_DEBT entry so anyone who touches the ProGuard rules later doesn't wonder why they exist when minification is off.

**Revisit when:** `isMinifyEnabled = true` is turned on — at which point confirm the release build still boots (run-through-Reader smoke test) and the APK loses no JNI symbols via `aapt2 dump strings` on the built APK.

### 4.15 Calibre template.db schema-bump migration path
**Severity:** note. **Status:** deferred. **Source:** Sprint C UX, 2026-04-24.

`apps/desktop/src-tauri/resources/calibre-template.db` is a pristine empty calibre library captured from calibre 9.7 at `PRAGMA user_version = 27`. Libraries created from this template inherit that schema_version. When upstream calibre bumps schema (27 → 28+), two concerns arise:

1. **Template regeneration** — covered by `docs/CALIBRE_TEMPLATE_DB.md`'s regeneration procedure. One-command swap when we update our bundled template.
2. **Already-created Spine libraries carrying the old schema_version** — once a user creates a library with Spine vN (template at schema 27), then upgrades to Spine vN+1 that bundles a template at schema 28, their existing library is *behind* the new template. Calibre's own open path auto-migrates forward when it sees an older schema (that's how upstream calibre handles its own schema evolution), so opening such a library in either calibre or a new Spine should self-heal — but we have not verified this across real version bumps, and we have no first-class "check for calibre schema_version mismatch on open" flow in Spine.

**Risks of doing nothing:** minimal today (schema 27 has been stable for ~a year). Real concern when we cross a schema bump in the wild — a user's reported "library won't open after Spine update" could trace here, and we'd need to diagnose after the fact rather than detect at open.

**Fix (deferred):**
- On `open_library`, read `PRAGMA user_version` on the calibre db.
- If lower than the version encoded in our bundled template (record it alongside the binary, or probe the bundled template at startup), either (a) let calibre's own migration run via `CalibreLibrary::open` and verify it succeeded, or (b) surface a one-time "your library will be upgraded to the latest calibre schema" banner with a no-op confirmation.
- Add an integration test that opens an old-schema library.

Cross-reference: `docs/CALIBRE_TEMPLATE_DB.md` for regeneration; `core/calibre-db/src/lib.rs` `CalibreLibrary::open` for the open path that would host the migration check.

### 4.16 Reader font-size floor diverges from proto312 (12 vs 8)
**Severity:** note. **Status:** deferred (deliberate; revisit on user feedback). **Source:** design review, anvil sweep 2026-04-28.

`ThemePrefs.MIN_FONT_PX = 12` (`apps/mobile/android/app/src/main/java/com/thereprocase/spine/ThemePrefs.kt:55`) versus proto312's `FONT_MIN = 8` in `apps/mobile-reader/src/reader/ReaderSettingsSheet.tsx:35`. The ranges don't even overlap meaningfully (12..28 px vs 8..24 pt — different units AND different magnitudes).

**Why deferred:** the design review judged 8pt body text effectively unreadable on phone-class displays — pixel density makes anything below ~12 px a vanity choice. proto312's 8 was a holdover from a desktop-tab-resized design. Native deliberately raises the floor.

**When to revisit:** if multiple alpha users ask for tinier text, drop the floor to 10 (compromise) or 8 (full proto312 parity).

### 4.17 Reader brightness floor diverges from proto312 (0.50 vs 0.15)
**Severity:** note. **Status:** deferred (deliberate; revisit on user feedback). **Source:** design review, anvil sweep 2026-04-28.

`ThemePrefs.MIN_BRIGHTNESS = 0.50f` (`ThemePrefs.kt:70`) versus proto312's hardcoded `Math.max(0.15, ...)` in `useTheme.ts`. Below 0.50 the page becomes unreadable on every theme — Sepia mid-sun, Stark contrast, all of them.

**Why deferred:** same as §4.16; the design review judged sub-50% brightness an unreadability cliff masquerading as user choice.

**When to revisit:** same — alpha-user feedback. Lowering the floor is a one-constant change in `ThemePrefs.kt`.

### 4.18 Reader-app theme split not preserved (single `themeKey`)
**Severity:** note. **Status:** deferred (deliberate; alpha-cheap to reverse). **Source:** design review, anvil sweep 2026-04-28.

proto312 persisted two independent theme keys (`appTheme` defaulting to `dark`, `reader.theme` defaulting to `sepia`) so users could have a dark library shell and a sepia reading surface out of the box. Native uses one `themeKey` covering both surfaces.

**Why deferred:** an external model review judged the simplification worth the visual-contract divergence — a smaller alpha population means the migration risk is low if user feedback contradicts, and a single key makes the eventual per-book theme override (BIBFRAME-driven) much easier to reason about.

**When to revisit:** if multiple alpha users explicitly request a split. Migration would be (a) read existing `themeKey` into `appTheme` *and* `readerTheme`, (b) bump `Snapshot.SCHEMA_VERSION`, (c) add the second picker to ReaderSettingsSheet/SettingsScreen. ~1 day.

### 4.19 Foliate locator format compatibility (epubcfi — no migration needed)
**Severity:** note. **Status:** documented (no action). **Source:** anvil sweep 2026-04-28 §6-q35 (incorrectly flagged as a migration concern; ground-truth confirmed otherwise).

The proto312 → native pivot review flagged a concern that proto312's `lastCfi` (epub.js CFI) and native's `lastLocator` (foliate) might be incompatible string formats. Verified in code: spine-host.mjs:90 emits `{ engine: 'foliate', schema: 'epubcfi', locator: cfi }`. Foliate's `relocate.detail.cfi` is an EPUB CFI string (`epubcfi(/...)`) — same canonical format epub.js produces. Round-tripping a proto312-era `lastCfi` through native's `LibraryStore.lastLocator` is a no-op transformation.

**No fix needed.** This entry exists so the next time someone reads the anvil sweep and worries about a translation layer, they find the answer pre-stamped.

### 4.20 LibraryStore JSON full-rewrite-on-update (SQLite migration filed)
**Severity:** note. **Status:** deferred. **Source:** Sprint N3.5, anvil sweep 2026-04-28 §6-q35.

`LibraryStore` rewrites the entire `library.json` on every `update {}` — that's one disk write per `touchLastLocator`, `touchActiveReadMs`, `touchProgress`, `touchTotalChars`, `setTags`, etc. At realistic alpha library sizes (10–100 books) this is below the noise floor; at 1000+ books with a per-page-turn locator update plus a 10-second session-timer flush plus a per-relocate progress update, the total write rate becomes notable. The plan all along has been to move to SQLite inside `spine.db` once the JSON store starts breathing hard.

**Fix (deferred):** SQLite migration of `LibraryStore` and `Annotations` (sister concern, same shape). Read `BookEntry`/`Highlight`/`Bookmark` rows from rows-on-disk; write per-id with `INSERT OR REPLACE`. Schema lives in a new `core/spine-db/migrations/` entry. Migration of existing JSON happens once on cold-launch.

**Trigger:** first sustained complaint about library-open latency at large library size, or a profiler line in Logcat. Not before.

### 6.4 Rust toolchain pin — **fixed** (round 2, 2026-04-23)
`rust-toolchain.toml` created at repo root. Channel pinned to `1.88` (the minimum satisfying transitive MSRV requirements: `icu_*` crates require ≥1.86, `image 0.25.10` requires ≥1.88; edition 2024 requires ≥1.85). Profile `minimal` with `rustfmt` and `clippy` components.

**Note:** `1.85` was originally specified in the task but is rejected by the resolver at dep-resolution time due to `image 0.25.10`'s MSRV of 1.88. Pinned at 1.88 which is the true floor.

### 6.5 `packages/ui-shared` phantom package — **fixed** (round 2, 2026-04-23)
`packages/ui-shared/` declared `"main": "index.js"` in `package.json` but `index.js` did not exist. Nothing in the monorepo imported this package. Directory deleted.

### 6.6 APK `versionName` hardcoded in `app/build.gradle.kts`
**Severity:** note. **Status:** deferred (cosmetic; filename is authoritative for now).
**Source:** Sprint 3, 2026-04-24.

`apps/mobile/android/app/build.gradle.kts` pins `versionName = "0.1.0-alpha"` and `versionCode = 1`. `scripts/build-apk.sh` encodes the real version into the APK *filename* (`spine-alpha-<date>-<sha>-<seq>.apk`) but the APK's internal manifest still shows `0.1.0-alpha` for every build. Android's Settings → Apps view displays the internal versionName; the filename scheme is only visible in the BUILDS.md ledger.

**Fix:** add `-PappVersionName=…` property plumbing to `app/build.gradle.kts`:

```kotlin
versionName = project.findProperty("appVersionName") as String? ?: "0.1.0-alpha"
versionCode = (project.findProperty("appVersionCode") as String?)?.toInt() ?: 1
```

Then `build-apk.sh`'s gradle invocation becomes `./gradlew :app:assembleDebug -PappVersionName=${APK_VERSION} -PappVersionCode=<derived>`. Sprint 2 left this as-is intentionally; picking it up post-merge is ~20 lines of diff.

### 6.7 Release artifacts are unsigned
**Severity:** warning. **Status:** deferred (tracked under §6.2 for the desktop side; filing Android-specific note here).
**Source:** Sprint 3, 2026-04-24.

The APK that `release.yml` produces has no `signingConfig` — it's an unsigned debug APK. For distribution beyond the alpha ring (F-Droid, direct sideload), an Android keystore needs to be provisioned and the APK signed. Related concerns: key storage (GitHub Secrets? self-hosted?), key rotation policy, and whether to move to an `.aab` (Android App Bundle) for any future Play listing. Defer until first non-alpha distribution decision; debug APK is correct for between-session testing.

### 6.8 WSL-side Rust toolchain provisioned for local Android builds (2026-04-24)
**Severity:** note. **Status:** documented. **Source:** Sprint 3, 2026-04-24.

Before 2026-04-24, the WSL environment had only the Windows-side Rust toolchain at `C:\Users\<user>\.cargo\bin\*.exe`. Running `pnpm apk` from WSL would fail at the `cargo-ndk` cross-compile step because Windows `cargo.exe` cannot drive the Linux NDK driver. Provisioned so the full `pnpm apk` pipeline runs locally end-to-end without a GitHub Actions round-trip.

Installed (reversible with `rm -rf ~/.cargo ~/.rustup`; no sudo used):
- `rustup 1.29.0` → `~/.cargo/bin/rustup`
- `rustc 1.88` + `cargo 1.88` (auto-installed on first workspace cargo call via the repo's `rust-toolchain.toml`)
- rustup target `aarch64-linux-android`
- `cargo-ndk 4.1.2`

Verification: `cargo ndk -t arm64-v8a check -p spine-jni` returned clean across 8 workspace crates (~60s first-time resolve on the `dev` profile).

**Reproducibility for a fresh WSL checkout:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
. "$HOME/.cargo/env"
rustup target add aarch64-linux-android
cargo install cargo-ndk
```

NDK path is at `~/android-sdk/ndk/27.1.12297006`; `cargo-ndk` autodetects when `$ANDROID_NDK_HOME` is exported, otherwise `scripts/build-apk.sh`'s preflight resolves it.

Filed as provenance so a future contributor's "why is my pnpm apk failing?" lookup finds the known-good toolchain state instead of having to bisect their machine.

### 6.9 `scripts/build-alpha.sh` cannot run under WSL2 — honest-fail (2026-04-24)
**Severity:** note. **Status:** documented (honest-fail landed). **Source:** Sprint 3, 2026-04-24; subsequent diagnostic recon.

The Windows MSI build path (`pnpm alpha` → `scripts/build-alpha.sh` → `pnpm tauri build`) does not work from WSL2. Multiple failure modes stack:

1. **Bare-name `cargo` vs `cargo.exe` resolution**: WSL's binfmt_misc executes `/mnt/<win>/**/cargo.exe` when invoked by full name, but bash's `command -v cargo` does NOT find `cargo.exe` by bare name (no PATHEXT equivalent on Linux). Preflight fails fast at the `for bin in git cargo pnpm` loop.

2. **tauri-cli's internal `spawn("cargo")`**: even with a `cargo → cargo.exe` shim on PATH, tauri-cli is a Node-on-Linux process that spawns cargo as a child. Node's `spawn("cargo")` cannot bridge the `.exe` suffix gap on Linux.

3. **Manifest path translation**: Windows `cargo.exe` cannot parse a `/mnt/<win>/...` POSIX path as a manifest path. Explicit `--manifest-path` args can be translated via `wslpath -w`, but tauri-cli passes manifest paths internally across many call sites with no shim interception — empirically verified via a `/tmp/cargo-shim` experiment.

4. **Linux cargo fallback fails gio-sys**: if `~/.cargo/env` auto-sources Linux cargo (as `3413183` did), `pnpm tauri build` compiles but fails deep in `gio-sys` because WSL lacks GTK dev libs — a worse failure class than preflight-fail.

**Resolution shipped**: `scripts/build-alpha.sh` detects WSL via `grep -qi microsoft /proc/version` and exits with a clear hand-off message naming three Windows-side alternatives (Git Bash, PowerShell, cmd.exe) before attempting any build. `scripts/build-apk.sh` is unaffected — cargo-ndk is Linux-cargo-preferred by design.

**CI impact**: zero. `release.yml`'s MSI job runs on `windows-latest` GitHub runners (non-WSL), so `bash scripts/build-alpha.sh` on that runner bypasses the honest-fail guard and executes normally.

**Why not bridge WSL→Windows**: each layer of translation (bare-name shim, per-arg wslpath -w, pnpm-on-Windows for cmd.exe pivot) introduces multiplicative failure modes across tauri-cli's opaque internal call graph. Git Bash on Windows is a first-class native alternative; no evidence the bridge would pay off.

**Reversibility**: if a future contributor wants to crack the WSL bridge, the honest-fail message and this entry capture the failure chain. Candidate approaches not tried: (a) `cmd.exe /c pushd <win-path> && pnpm tauri build ...` (requires Windows pnpm installed and functional); (b) distroless WSL image with real Windows cargo-cross toolchain (heavy); (c) Tauri's experimental container-based build mode (if/when available).

---

## 7. Performance items that didn't make the fix cut

### 7.6 Export zip buffered fully in heap
**Severity:** warning. **Status:** deferred (code review W8).

`core/spine-srv/src/api_v1.rs` `export_book_v1` builds the entire export zip in a `Vec<u8>` buffer before sending. For a large EPUB with embedded fonts and images this can easily reach 50-100 MB of heap allocation per export request, and the zip is not streamed to the client until it is complete.

**Fix:** use a `tokio::io::AsyncWrite` pipe or `axum::body::Body::from_stream` with a `zip::ZipWriter` that writes to a channel-backed async writer. Moderate refactor. Do when export is a hot path (i.e., batch export feature or Android background sync lands).

### 7.1 EPUB zip archive opens per-resource
**Severity:** warning. **Status:** deferred.

`load_book_resource` opens the zip fresh on every fetch (50-200 fetches per book open). Cache `Arc<Mutex<ZipArchive<File>>>` keyed on book path in `AppState`.

**Fix:** `DashMap<PathBuf, Arc<Mutex<ZipArchive<File>>>>` with LRU eviction. Moderate change, touches `load_book_resource` signature. One-hour task.

### 7.2 Base64 resource transport over IPC
**Severity:** warning. **Status:** deferred.

`apps/desktop/src-tauri/src/lib.rs` `read_book_resource` base64-encodes every resource. 2 MB image → ~2.7 MB ASCII → JSON serialize = 3× copy. Tauri 2 `http::Response<Vec<u8>>` supports raw byte return via custom protocol; cuts CPU and memory roughly in thirds.

**Fix:** register a `spine://` custom protocol in Tauri that serves book resources directly. Larger refactor of Reader.tsx and the bridge; deferred pending performance measurement on target hardware.

### 7.3.A N+1 list hydration — **fixed** (round 1, re-hardened round 2)
`list_enriched_books` issues one `get_triples_batch` query across every book's graph URI. Round-2 added chunking at 500 to survive SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (999 on pre-3.32). A 1001-URI test exercises the chunk path. Index on `reading_progress.updated_at_ms` also landed — `list_reading_progress` and the monotonic `MAX()` query now seek instead of scan. See commits `15b87a6`, `21ed670`.

### 7.3.B Migration runs on every open — **fixed** (round 2)
`migrate_reading_progress_ms` gated on `PRAGMA user_version`; migrated DBs now cost one PRAGMA read on open instead of a table scan + conditional UPDATE. `prepare_cached` added to `get_triples_batch`, `get_reading_progress`, `list_reading_progress`. `list_reading_progress_v1` drops the store lock before the UUID-parse / timestamp-build loop. See commit `21ed670`.

### 7.3.C N+1 hydration in the search path
**Severity:** warning. **Status:** deferred (code review W6).

`core/spine-srv/src/api_v1.rs` `search_books_v1` calls `list_enriched_books` after getting the page of matching IDs from calibre. `list_enriched_books` issues one `get_triples_batch` call (fixed §7.3.A), but the caller retrieves all matching books by UUID, computes the graph hydration, then filters back to the page. For a library of 10k books where 5k match the query, this means hydrating 5k graphs to return 20 results.

**Fix:** push publisher/series/subject filters into `search_books` (calibre side returns only page-sized IDs), then batch-hydrate only that page. Requires extending the calibre-side SQL further. Do with §3.1 domain-logic extraction.

### 7.5 ATTACH DATABASE requires DELETE journal mode — **fixed** (remediation batch 1)

`journal_mode` is a **per-file** SQLite setting (stored in the database header), not merely a per-connection hint. Prior code set DELETE only on the LibrarySession connection, which was incorrect: SQLite's own documentation states that `journal_mode` is file-level, and switching it on one connection changes it for all connections to that file.

**Fix applied:**
- `CalibreLibrary::open` now sets `PRAGMA journal_mode = DELETE` and reads it back, erroring if the mode is not `"delete"`. In-memory (`:memory:`) connections are exempted.
- `SpineStore::open` does the same.
- `LibrarySession::open` re-asserts DELETE on both schemas after ATTACH and verifies both with `PRAGMA main.journal_mode` / `PRAGMA spine.journal_mode`. Mismatch → error, not silent continuation.
- Module-level docstring in `session.rs` corrected: no longer claims "per-connection"; documents the per-file semantics.

**Performance consequence (now broader):** all connections to both database files operate in rollback-journal mode. Previously only the write session paid this cost; now every read connection does too. This matters more at bulk-ingest scale than at human-click scale.

**Trigger for revisit:** bulk-ingest profiling. Option A (detect external mode flip and return an error) is now implemented. Options B and C still remain as escalation paths if profiling shows unacceptable overhead.

**Residual risk:** an external tool that opens `spine.db` directly (e.g., DB Browser for SQLite with WAL enabled) will flip the file back to WAL. Spine's next open will detect this and return an error rather than silently proceeding with broken atomicity.

### 7.3 `Mutex<CalibreLibrary>` + `Mutex<SpineStore>` at app scope
**Severity:** note. **Status:** deferred.

Serializes every request. Fine at MVP scale; bottleneck at Phase 2 concurrent-ingest. Move to `r2d2`/`deadpool` pools before concurrent ingest lands.

### 7.7 Grid hover-zoom triggers without debounce
**Severity:** note. **Status:** deferred (gated on real-library scroll measurement). **Source:** code review N10, 2026-04-25.

`apps/desktop/src/grids/HybridList.tsx:217-220` and `apps/desktop/src/grids/CoverGrid.tsx:139-145` trigger the cover-zoom popup on `onMouseEnter` with no hover-delay. Mouse-tracking quickly through 50 cells in a dense CoverGrid fires 50 `setState` calls and 50 popup re-renders before the cursor settles. Probably not measurable at typical library size (≤500 books); flagged for the eventual large-library perf pass.

**Fix:** introduce a `~200ms` hover-delay timer that resets on each `onMouseEnter`:

```ts
const hoverTimer = useRef<number | null>(null);
const scheduleZoom = (book, x, y) => {
  if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  hoverTimer.current = window.setTimeout(() => setZoomedBook({book, x, y}), 200);
};
const cancelZoom = () => {
  if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  setZoomedBook(null);
};
```

~10L per grid. Matches AddSubjectDialog autocomplete debounce (200ms) for consistency.

**Trigger to act:** if the Sprint 19 perf-baseline follow-on shows a real-library scroll FPS impact attributable to hover-zoom popup re-renders, OR if a user reports hover-zoom flicker during fast cursor movement. Don't fix preemptively — at typical library sizes the cost is invisible.

### 7.4 ATTACH DATABASE master-journal overhead at bulk-ingest scale
**Severity:** note. **Status:** deferred (post-alpha).

SQLite's cross-DB `ATTACH` + `BEGIN` commit uses a master journal file — a tiny write on every commit that coordinates the two attached files. Overhead is invisible at human-scale edit cadence (click Save, one txn), but accumulates when a user imports 10k books and every book's graph+calibre write pair takes one master-journal cycle.

**Fix options:**
- (a) **Bulk mode**: write all spine.db graphs in one spine-only transaction, then run one big calibre projection afterward. Accepts a short window of divergence during import, which is fine because the import itself is divergence. Best fit.
- (b) **Disable master-journal** via `PRAGMA journal_mode = MEMORY` on the attach — loses durability on power loss, not acceptable.

**Trigger to act:** when a profile shows bulk-ingest spending meaningful wall-clock on commit overhead. Not before.

---

## 8. Small correctness items deferred

- **`pubDate` timezone display in edit mode** (code review W7, `apps/desktop/src/App.tsx` `EditInspector`): the pubdate field renders the raw ISO string from the backend into a `<input type="date">` value. If the backend returns `1984-01-01T00:00:00Z`, a browser in UTC-5 will display 1983-12-31. Use `toISOString().slice(0, 10)` only after confirming UTC, or strip to a plain `YYYY-MM-DD` at the API boundary. Fix with §3.4 App.tsx refactor.
- **`new Date("1984")` timezone quirk** (`apps/desktop/src/TimelineView.tsx:14`, `App.tsx:740,1117`): year can return 1983 in GMT-. Parse leading 4-digit year with regex before falling through to Date. Low-effort, do with App.tsx refactor (§3.4).
- **N11 — `search_books_v1` returns first 100 results without pagination metadata** (`core/spine-srv/src/api_v1.rs`): the `?q=` handler returns up to 100 books but the response body has no `total_count` or `next_cursor` field. A client displaying "showing 100 of 847 results" has no data to construct that message. Fix when §3.3 API contract unification lands — add `total` and `offset` to the search response envelope.
- **N12 — `export_book_v1` zip entry names are not normalized to NFC** (`core/spine-srv/src/api_v1.rs`): `sanitize_zip_entry_name` strips unsafe characters but does not Unicode-normalize filenames. A book titled `Café.epub` and one titled `Café.epub` both pass sanitization and produce different zip entry names that are visually identical on HFS+. Low-impact; fix with any EPUB export hardening pass.
- **N13 — `list_jobs` returns all in-memory jobs with no page limit** (`core/spine-srv/src/api_v1.rs`): if a process runs long enough, `job_status` can hold hundreds of terminal (now TTL-evicted) and running entries and a single GET serializes the whole map. Add `?limit=` and `?since=` query params when job list becomes a real UI feature.
- **N14 — `ingest_epub` always generates a new UUID** (`core/spine-srv/src/ingest.rs`): re-ingesting the same file a second time creates a second book with a new UUID instead of deduplicating. Dedup requires a content fingerprint (SHA-256 of the EPUB zip) stored in `spine.db`; check on ingest. Deferred pending the reconcile-first pipeline (§1.1) which must run before any URI is minted.
- **`clean_name` / `normalizeName` divergence:** two sources of truth for author formatting. Fix together with §3.1 extraction to `spine-meta`.
- **`pollJobStatus` no max-timeout:** fixed (cleared on unmount). Adding a wall-clock max retry count deferred.
- **Year extraction first-4-digits** (`core/spine-srv/src/lib.rs:301-313`): breaks on `[18]51`, `ca. 1851`. Move to `spine-meta::dates` with tests.
- **SQLite on network filesystems** (post-alpha, deferred): NFS / SMB / cloud-sync folders break SQLite's locking. If a user points Spine at a library on `\\server\share\books`, both `metadata.db` and `spine.db` can corrupt under concurrent access. MVP has no guard. Fix: on `open_library`, stat the path and reject (or warn + open read-only) if the filesystem type indicates network mount. Platform-specific probe: `GetDriveTypeW` on Windows, `statfs(.f_type)` on Linux, `getmntinfo` on macOS. Deferred until someone reports it.

---

## 9. Repository hygiene items deferred

- **Stub crates** (see §3.6) — decision needed.
- **Scratch files scrubbed in remediation phase:** `fix*.py`, `diff*.patch`, `loc_bf_output.rdf`, `schema*.sql`, `loc_test.xml`, `sru_test.xml`, `out.json`, `work.json`, `test_record.json`, and siblings — removed from tracking.
- **Committed live `metadata.db` and `spine.db` under `apps/desktop/src-tauri/`** — untracked in remediation phase. Seed test state via fixture script.

### 9.1 Stale `.git/index.lock` on concurrent WSL/NTFS commits — investigation-stage (2026-04-24)
**Severity:** note. **Status:** deferred (investigation-stage). **Source:** code review session, 2026-04-24.

**Phenomenon.** During rapid concurrent commit cadence on WSL2 with the repo on an NTFS mount (`/mnt/<win>/…`), 0-byte `.git/index.lock` files are left behind after successful commits. Mtime matches the commit-completion timestamp within the same second. `fuser $LOCK` and `pgrep -af 'git (commit|add|…)'` confirm no live git writer holds the file. Next git invocation in the repo fails with `fatal: Unable to create '.../index.lock': File exists.` until the stale file is removed.

**Frequency this session.** Observed ≥4 times across commits `3413183`, `fb69dc9` / `031ebfa`, and `0fe7d4d`. Reproducible across multiple contributors.

**Current workaround:**
1. Acquire a coordination lock before touching the file.
2. Verify: `ls -la .git/index.lock` (expect 0 bytes), `fuser .git/index.lock` (no holder), `pgrep -af 'git ' | grep -vE 'status|rev-parse'` (no live writer).
3. `rm -f .git/index.lock`.
4. `git add <path>; git commit <path> -m "..."` with explicit pathspec (never `-A`, never `.`).
5. Release the coordination lock.

**Candidate root causes to investigate:**
- **Shell-prompt statusline `git status` pollers** racing active commits on NTFS. Running `pgrep -af git` consistently finds a background `git status --porcelain` from the prompt integration; these don't hold `.git/index.lock`, but may interact with git's atomic rename through a shared open directory handle, and NTFS directory-entry updates are not atomic the way ext4's are.
- **WSL2 9P file-system redirector** between Linux VFS and NTFS: git's lock-release path does `close(fd)` + `rename(tmp, index)` + `unlink(lock)` — any of these crossing the 9P boundary atypically can leave a visible-but-orphaned file.
- **Antivirus / Defender real-time scanning** on `.git/index.lock` after close-before-unlink. Not verified but a known NTFS git-on-Windows pattern.

**Mitigation that empirically works:** every git op runs as `git -c core.fsmonitor=false -c core.preloadindex=false ...` plus `sync` + `rm -f .git/index.lock` immediately before, plus a 2s settle after `merge --abort`. Most ops succeed on attempt 1; merges sometimes need 2-3 attempts. The `-c core.preloadindex=false` addition noticeably reduced retry counts vs the `-c core.fsmonitor=false`-only formulation. Adopt as the standing mitigation pending root-cause fix.

**Prevention candidates** (ordered by pain vs impact):
1. **Suppress shell-prompt git polling in this workdir** (starship / tmux / powerlevel config). Quickest to try; cheapest to unwind.
2. **Probe for git `core.fsmonitor` or `core.untrackedCache`** — may change the code-path that drops the lock.
3. **Tighten the commit-discipline protocol further** — e.g. a `scripts/claude-commit` wrapper that serializes behind a file-local lock agents always use.
4. **Move the repo onto ext4 inside the WSL filesystem** (`~/spine`). Breaks Windows cargo.exe reads for the MSI build path (§6.9), so not viable for this project on its own.
5. **Two-tree workflow via remote round-trip** (raised 2026-04-24 evening). Canonical repo on WSL ext4 (`~/spine`), Windows-side build clone (`C:\spine-build`) fetches from `origin` before each MSI build. Pros: clean filesystem boundary, no 9P, mirrors what `release.yml` already does on `windows-latest`. Cons: every MSI smoke-test requires a push of WIP/dirty work, burns the `+dirty` suffix discipline, kills the inner-loop latency (commit → push → fetch → build), encourages junk commits or force-pushes to a smoke-test branch. Right answer if MSI builds become release-only; wrong answer during the current design-sprint cadence of multiple MSIs per session.
6. **Two-tree workflow via local rsync mirror** (raised 2026-04-24 evening). Canonical repo on WSL ext4, pre-build hook does `rsync -a --delete --exclude target --exclude node_modules ~/spine/ /mnt/c/spine-build/` before `pnpm alpha`. Pros: dev stays on ext4 (kills the index-lock race entirely), builds get native Windows-path source, no GitHub round-trip. Cons & traps: (a) `target/` and `node_modules/` cannot cross — each side compiles for its own triple, so first build on the Windows side is cold (~15-20 min full Tauri+WiX) unless its `target/` is kept warm separately; (b) `.git` handling is a fork — either rsync `.git` too (Windows-side commits/tags don't flow back without manual care, easy to lose work) or `git clone --shared` from WSL ext4 (Windows side's `.git/objects/info/alternates` points into `\\wsl$\...`, reintroduces cross-fs read for every git op); (c) concurrent contributors on the Windows mirror is undefined — the whole point of moving to ext4 was to eliminate the race, so any Windows-side commit (tag, version bump) re-introduces multi-fs coordination; (d) drift detection — forgetting to rsync before a build = shipping stale code, same failure class as the empty-merge incident relocated. Sound option but adds rsync-drift risk and cold-build cost.
7. **`git worktree add` across filesystems** (raised 2026-04-24 evening). Single canonical `.git` dir on WSL ext4 at `~/spine`, working tree for builds added at `/mnt/c/spine-build-wt` via `git worktree add`. Pros: avoids rsync drift (worktree is git-managed, not a copy), commits remain atomic on ext4, single source of truth. Cons: every git operation in the build worktree reads the canonical `.git` across the 9P boundary (`/mnt/c/...` ↔ `~/...`), reintroducing the lock-race surface in the worktree's index file (worktrees have their own `index` but share `objects/`). Smaller blast radius than an NTFS-mount setup but not zero. Worth a controlled experiment once the §9.1 closing gate is in sight.

**Closing gate:** three consecutive sessions with zero `rm -f .git/index.lock` invocations. Until then, leave this entry and the workaround in place. If the race keeps biting, escalate to candidate 6 (rsync mirror) — it has the best ratio of fixes-the-real-problem vs. doesn't-break-the-build-path, at the cost of two-tree discipline.

**Cross-references:** `docs/TECH_DEBT.md` §6.9 (WSL / NTFS build-infrastructure boundary).

---

## Round-2 deferred items (new)

These surfaced in the round-2 code review and were deliberately not patched this session:

- **§2.1 session-swap UI guardrail** (round-2 C2). Switch Library mid-ingest still loses the toast chain; 409 guard on `sync_calibre` is a related but different protection. The UI needs to disable the switch button while `pendingJobIdsRef.current.length > 0`.
- **`useEffectEvent` is experimental** (round-2 N18, `Reader.tsx`). React 19's stable surface does not include this hook. If the project's React is pinned to stable, the current code is a potential build error; if on canary, the API may change. Confirm React version + consider fallback to a ref-wrapped callback.
- **Log file for release users** (round-2 W4 + N20). `tracing_subscriber::fmt().init()` writes to stderr; packaged Windows Tauri builds have no console. Users hitting a real error have no evidence to file a bug with. Add `tracing-appender` to `%APPDATA%\Spine\logs\spine-YYYY-MM-DD.log` with rotation. Maybe 40 lines of code, deferred because it crosses Tauri / Rust boundary.
- **Apps↔core Cargo.toml dep drift** (round-2 N7). `apps/desktop/src-tauri/Cargo.toml` still declares `serde`, `serde_json`, `tokio`, `tracing`, `tracing-subscriber`, `rusqlite` inline. The Tauri crate is a separate workspace; `workspace = true` won't reach it. Either flatten to a single root workspace (structural change) or add a human-maintained comment header naming the versions to track.
- **Base64 data_base64 / decoded_length split** (round-2, partial — shape-fix landed but base64 IPC overhead unchanged; §7.2 unchanged). The rename-and-encoded-length fix landed; the deeper perf issue (raw-bytes IPC via `spine://` custom protocol) remains deferred.
- **CSP + reader isolation design review** (round-2 W3). If EPUB HTML ever renders in the same WebView origin as the React shell, `connect-src ipc:` gives book content full `call_api` access. Needs a design call on whether the reader lives in an isolated `<iframe sandbox>` or a separate window.
- **SSRF via LCCN — mitigated, not audited** (round-2 W1). `is_valid_lccn` regex is strict (1-3 alpha + 8-10 digits); if LoC ever publishes out-of-format LCCNs, the validator will reject valid inputs. Not a security gap; an operational one. Monitor for LCCN format changes.
- **Multipart upload outer limit** (round-2 N10, partial — streaming landed with 256 MB per-field cap, but `RequestBodyLimitLayer` is 64 MB outer). The outer layer rejects first in practice; the 256 MB guard is belt-and-suspenders for direct handler calls that bypass the router layer. Intentional; comment in `ingest_epub_v1` documents.
- **MIN_TCP_TOKEN_LEN not unit-tested** (round-2 gap). The minimum token length check is in `main()` startup; test requires process-level exercise or helper extraction. Low risk.
- **React component tests** (round-2 gap). Vitest + happy-dom landed for pure utility functions; component-level tests need `@testing-library/react` + additional config. Deferred.

See round-2 commits `f286915`..`e6f71b7` for every fix.

## Session 6 (2026-04-24 design-fidelity sweep) deferred items

These surfaced during the Session 6 design-fidelity sweep and were deliberately deferred at the consensus triage:

- **§5.X LoC cache layer not implemented.** `core/spine-meta` has no on-disk or in-memory cache for SRU responses today (`LocClient` is point-of-call SRU only). `GET /api/v1/loc/cache_status` was landed as an Option-2 stub returning `{ present: false, entries: 0, lastRefreshedAtMs: null }` (`ed822a8`); frontend StatusBar renders "loc cache · not enabled" gracefully. When cache lands, the endpoint payload changes shape (no contract churn). Owner: spine-meta lane, future sprint. Estimated scope: SQLite cache file (mirror `loc_cache.db` per ADR 005) + populate in `fetch_candidates` + freshness query for the endpoint, ~150-200L Rust.
- **§5.X spine-bf write API per ADR 014 not implemented.** Inspector "+ add subject" / "+ add edition" affordances are visible but disabled with tooltip. ADR 014 specs the surface (5 functions: `add_instance`, `add_item`, `add_subject`, `remove_subject`, `set_primary_instance`) + SHACL cardinality shapes + sync reconcile-first invariants + provenance triples. ~400-600L Rust + tests. Owner: TBD next session. Phase C HTTP endpoints (`POST /book/:id/subject`, `POST /book/:id/instance`, etc.) are gated on this implementation.
- **§5.X calibre-binary-dependent test (re-flagged Session 6).** `core/calibre-db/src/lib.rs:1328` `test_insert_book_trigger_collations` shells out to upstream `calibredb` binary. Existing entry at §5 ("calibredb-dependent test") refers to a different test at line 519-554; both should be `#[ignore]`'d or feature-gated as a single fix-pass. Pre-existing, not Session-6 introduced.
- **§3.3 OpenAPI YAML drift** (partial close). Session 6 backfilled the 5 new endpoints (`/storage`, `/jobs/summary`, `/loc/cache_status`, `/library/recent`, `/library/list`) under a `paths_session6:` staging key in `docs/openapi_book_resource.yaml` and bumped to OpenAPI 3.1. The original `Book / Contributor / Instance / Item` schemas at the top of the file remain aspirational and drift from `spine_api::Book`. Full alignment is a future-sprint item.
- **§7 storage endpoint scales O(N) per request.** `sum_cover_bytes` walks every `<library>/<author>/<title>/cover.jpg` on every Footer poll. ~30L TTL cache fix in `AppState` deferred.
- **Inspector legacy edit-mode "Done → design" UX nit.** Originally flagged as a missing back-button; on re-verification the design Inspector's "SUMMARY" tab serves the same purpose (App.tsx:1686). Marked done as not-needed.
- **Deferred frontend items.** Multi-select / batch ops; right-click context menus; query syntax in search (`author:Shelley`); EPUB page counts (spine-fmt-epub work); light theme; cover hover-zoom; F1/? shortcuts panel; EPUB-edit-roundtrip-to-OPF; DRM detection at ingest; library stats. All flagged in Session 6 daily-driver gap analysis; deferred to future sprints. **Big-library perf (virtualization) gated on real-world measurement** with the maintainer's library — may be a non-issue at <500 books, massive scope creep if needed.
- **Phase C subject endpoints** (re-deferred). Initially scoped into Session 6 but cut at consensus triage; subjects ship next session as a clean cluster with the spine-bf write API impl above.

These are tracked in internal design notes ("Deferred to next session").

## Fixed in the 2026-04-23 remediation sprints

(Retained here for history; see commit range below for diffs.)

- **Unbounded body reads** — `to_bytes(_, usize::MAX)` in `call_api`, `reqwest` `.json()/.text()` in LoC client, `read_to_end` on zip entries. All capped at sane limits.
- **SRU query injection** — title and author now CQL-escaped before interpolation in `search_by_title_author`.
- **TCP fallback on Windows with no auth** — removed; server binds only the Named Pipe or UDS, never TCP by default.
- **CSP disabled** — `apps/desktop/src-tauri/tauri.conf.json` now sets a restrictive CSP.
- **`LocClient::new()` panics** — constructor now returns `Result<Self, LocError>`; callers propagate.
- **`sync_calibre` lock across await** — library lock released before the loop; no re-entrant deadlock window.
- **N+1 graph hydration on list** — `get_triples_batch` added; `list_enriched_books` issues one query.
- **HEAD reads full body** — `probe_book_resource` uses `ZipFile::size` metadata without decompression.
- **Silent drag-drop non-EPUB** — toast now enumerates rejected paths.
- **Raw backend errors surfaced verbatim** — common rusqlite codes mapped to English in `build_session`; `call_api` errors summarized.
- **Reader `resourceCache` reject-poisoning** — rejected Promises evicted from cache on first failure.
- **`pollJobStatus` setInterval leak** — cleared on unmount via ref.
- **`window.prompt()` for Switch Library** — replaced with `@tauri-apps/plugin-dialog` `open`.
- **Folder-path rejection** — `canonical_metadata_db_path` auto-appends `metadata.db` when path is a directory; strips surrounding quotes.
- **`Cargo.lock` gitignored** — unignored and committed at workspace root.
- **Live `.db` files committed** — untracked.
- **Two `zip` versions** — unified via `workspace.dependencies`.
- **`println!` leakage** — routed through `tracing` at debug level.
- **Dead UI buttons** — Needs-Review and ExternalLink removed.
- **Reader header missing book title** — title displayed.
- **Blank-node contribution scoping** — labels prefixed with graph URI hash.
- **Three divergent URIs in `synthesize_golden_candidate`** — unified to one UUID.
- **`reading_progress` second-resolution ties** — bumped to milliseconds.
- **`SystemTime` clock-adjust fallback** — guarded with `max(previous, now)`.

Round-2 additions:

- **`constant_time_eq` length-leak** — replaced with `subtle::ConstantTimeEq::ct_eq`; no early return on length mismatch.
- **Bearer scheme case sensitivity** — `extract_bearer_token` accepts `Bearer`, `bearer`, `BEARER` per RFC 6750.
- **`get_triples_batch` SQLITE_MAX_VARIABLE_NUMBER** — chunked at 500; survives on pre-3.32 SQLite (Linux distros, iOS, Android system SQLite).
- **Missing index on `reading_progress(updated_at_ms)`** — added; MAX/ORDER-BY queries now seek.
- **Migration runs on every open** — gated on `PRAGMA user_version`; migrated DB costs one PRAGMA read.
- **`prepare_cached` on hot-path statements** — `get_reading_progress`, `list_reading_progress`, and `get_triples_batch` inner query all cache their compiled plans.
- **Bearer token heap alloc per request** — `Arc<str>` replaces `String::clone`.
- **`list_reading_progress_v1` lock held across parse** — store lock now drops before UUID parse + timestamp build.
- **Non-atomic monotonic ms upsert** — `upsert_reading_progress` wrapped in `BEGIN IMMEDIATE`; `clamp_ms_monotonic` extracted.
- **`axum::serve().unwrap()` startup panic** — `async fn main` returns `Result`; startup errors propagate via `?`.
- **`to_api_reading_progress` still seconds** — now uses `from_timestamp_millis`; ms precision visible to clients.
- **`synthesize_golden_candidate` four divergent UUIDs** — unified to one work UUID + one instance UUID.
- **`sync_calibre` double-dispatch TOCTOU** — `Arc<AtomicBool>` single-flight guard; 409 Conflict on re-entry.
- **`let _ = delete_graph` silencing rollback errors** — now logged via `tracing::error!`.
- **`unwrap_or_default` masking `get_triples_batch` errors** — logged at `tracing::error` before defaulting.
- **`graph_uri_for` helper** — extracted from five duplicated `format!` sites.
- **`BookResourceResponse.content_length` mismatch** — renamed to `decoded_length`; `encoded_length` added.
- **`EPUB_RESOURCE_MAX_BYTES` duplicated const** — hoisted to module-level `pub(crate) const`.
- **Folder-without-metadata.db error message** — now names the folder explicitly.
- **Multi-job `pollJobStatus`** — `pendingJobIdsRef` array under one shared interval.
- **`humanizeBackendError` regex gaps** — added `timeout` (no 'd'), `connection refused`, `tls`, `certificate`, `getaddrinfo`, `dns`, `unreachable`, `econn`, `proxy`, `database is locked`; 200-char truncate.
- **Reader unmount drops pending save** — cleanup + `visibilitychange` both flush the last debounced save.
- **Drag-drop event.payload shape brittleness** — explicit Array.isArray guard with `console.warn`.
- **Skipped-files toast unbounded** — caps at 3 names + "and N more"; CSS max-height.
- **`setLibraryError` bypassed humanize** — now routed through at both call sites.
- **No keyboard path to add books** — "Add EPUBs" footer button + Ctrl/Cmd+O.
- **Icon-only buttons missing aria-label** — aria-label + aria-pressed + aria-expanded.
- **No double-click to open reader** — grid cards and list rows now open on dblclick; inspector-pulse flash on selection.
- **Windows `\\?\` UNC prefix in recent-library display** — `displayPath` strips for display; stored path unchanged.
- **`promptSwitchLibrary` unhandled exception** — try/catch through humanize.
- **`alert()` in candidate lookup** — replaced with `setIngestStatus` toasts.
- **LCCN SSRF** — `is_valid_lccn` allow-list regex before URL format; `Error::InvalidLccn` variant.
- **CQL query logged at INFO with title/author** — downgraded to DEBUG with byte-length only.
- **`call_api` forwarded arbitrary method/path** — `ALLOWED_METHODS` allow-list.
- **`locator` column unbounded** — 4 KB cap with 413 PAYLOAD_TOO_LARGE response.
- **`RequestBodyLimitLayer` at 64 MB** on all routes.
- **Multipart ingest buffered full body** — streams via `field.chunk()` with 256 MB per-field cap.
- **rusqlite error paths leaked filesystem path** — basename in user-facing message; full path at tracing::error.
- **`eprintln!` in startup past tracing init** — routed through tracing; remaining round-1 miss closed.
- **`tower 0.4/0.5` dual tree** — unified at 0.5.
- **`tower-http 0.5/0.6` dual tree** — unified at 0.6.
- **`thiserror 1/2` in our crates** — unified at 2.0; Tauri upstream still pins 1 transitively (documented).
- **`zip` workspace pin lag** — bumped 2.1 → 2.4 to match lock.
- **`oxrdf` inline in `spine-srv`** — routed through `{ workspace = true }`.
- **`rust-toolchain.toml`** — created; pinned at 1.88 (true MSRV floor).
- **Phantom `packages/ui-shared`** — deleted.
- **Fake `test_loc_test_xml`** — deleted (read scratch file scrubbed).
- **Fake `core/spine-srv/tests/perf.rs`** — deleted (asserted substrings on literals).
- **Vitest scaffold for desktop** — `vitest 4` + `happy-dom 20`; `extractYear`, `humanizeBackendError`, `displayPath` covered (19 assertions).
- **Bearer middleware integration tests** — 8 cases via `tower::oneshot` including layer stacked on real `create_router`.

Cleanup sweep (2026-04-23, post-round-2):

- **Deleted** scratch / wrong-project docs — `temp_schema.sql`, `core/srv_debug.log`, `apps/desktop/README.md` (unedited Tauri template), two `docs/refs-other/AI_RESEARCH_DUMP_*.md` files (one was research for a different product entirely), `docs/DESKTOP_MVP_REVIEW_AND_SPRINT_REPORT_2026-04-23.md`, `docs/instance-core-and-target-thoughts.md`.
- **Archived** — early planning snapshots, peer reviews, and historical sprint/format-fidelity notes were moved to an internal archive (not part of this repo).
- **Merged** — `docs/FEATURE_BRAINSTORM.md` folded into `docs/UI_UX_STRATEGY.md` as Appendix A. `docs/Jules-UI-Recs.md` Mermaid nav graph folded into `UI_UX_STRATEGY.md` §11. `docs/api-reference/sample-frankenstein-bf.md` folded into `loc-id-service.md` §6.
- **Stub crates marked** — 12 `spine-fmt-*` + `spine-dc` + `spine-oeb` + `spine-onix` + `spine-epub-meta` got `//! STUB` doc headers pointing here.
- **`spine-cli`** broken-binary fixed — was reading deleted `../loc_test.xml`; replaced with `not yet implemented` exit-2 stub. Clap + tokio deps retained for future CLI work.
- **Removed redundant `use tracing;`** in `core/spine-srv/src/lib.rs`.
- **Empty directories scrubbed** — `packages/`, `core/spine-db/tests/`, `core/spine-test-corpus/data/{bibframe,onix,opf}/`. `pnpm-workspace.yaml` glob `packages/*` dropped.
- **`.claude/` gitignored**.
- **Repository state document updated** — was six commits behind; now reflects round-1 + round-2 outcomes, the OPF export gap (§3.8), and the decision-points at the top of this doc.
- **UI inventory corrected** — reading progress is working (not "not tracked").
- **openapi_book_resource.yaml** gains a disclaimer header pointing at §3.3.
- **CLAUDE.md** adds reading-order pointers to `AGENTS.md` and `TECH_DEBT.md`.
- **Tool-specific guidance consolidated** — engineering mandates and PR workflow merged into `AGENTS.md` as the single source of truth.
- **Phase plan (before archiving)** — B1 + B2 marked done with commit pointers; D1 + D2 surfaced as §3.8 above.

Remediation sprint (2026-04-23, commits `59d712f`..`d2462f4`):

- **Cross-DB atomicity gap** — `PRAGMA main.journal_mode = DELETE; PRAGMA spine.journal_mode = DELETE;` added to write-only session after ATTACH; SQLite master-journal now coordinates both files in one atomic commit.
- **Null-byte injection in DB paths** — explicit `\0` check via `rusqlite::Error::InvalidParameterName` before `Connection::open`.
- **Symlink escape on delete** — `delete_book_with_graph` now canonicalizes the book path via the parent directory and rejects anything outside the library root before touching the filesystem.
- **Per-file delete tracking** — replaced `remove_dir_all` with `delete_files_individually`; partial-delete failures collected in `DeletedBook::failed_file_deletes` rather than silently swallowed or aborted.
- **LIKE wildcard injection** — `search_books` escapes `%`, `_`, `\` via `escape_like()` and appends `ESCAPE '\\'` to every LIKE clause.
- **Publisher / series JOIN in search** — `search_books` now JOINs `publishers` and `custom_column_1` so `?q=` matches against publisher name and series name, not just title/author.
- **work_uri fragment injection** — `validate_work_uri()` rejects `#` fragments, `?` query strings, unknown schemes; `urn:` scheme requires UUID suffix match; `http://`/`https://` accepted as LoC URI shape. Frontend fragment-append hack removed.
- **Error string path / username scrubbing** — `scrub_job_status()` replaces absolute paths with `[path]` and OS username with `[user]` before job status reaches the wire.
- **Zip entry filename sanitization** — `sanitize_zip_entry_name()` strips null bytes, separators, rejects `.`/`..`, prefixes Windows reserved device names; used in `export_book_v1`.
- **Bounded job HashMap** — `job_terminal_at` parallel timestamp map + `JOB_TTL_SECS` (15 min) + `evict_expired_jobs()` sweep on every `/api/v1/jobs` call prevents unbounded growth.
- **`describeStatus` missing default case** — `JobsIndicator.tsx` switch now returns `"Unknown"` on unrecognized status; function exported; 5 Vitest tests cover all cases.
- **Tauri export command input validation** — `export_book_to_disk` validates UUID format, null bytes in dest_path, and `.zip` extension before touching session state.
- **`diffProjection` trim semantics** — publisher, series, pubDate clear-to-null when value is whitespace-only, not only when it is the empty string.

New TECH_DEBT entries filed this wave: §3.9, §5 rate-limit note, §7.3.C, §7.5, §7.6, §8 pubdate timezone / N11-N14.
