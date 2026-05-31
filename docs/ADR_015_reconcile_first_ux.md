# ADR 015: Reconcile-first URI Pipeline UX

## Status

Draft — pending review and lock.
Drafted 2026-04-25 as Sprint 10 prep strawman.
Supersedes the "decision-needed" classification of `docs/TECH_DEBT.md §1.1`.

## Context

`CLAUDE.md` locks the invariant:

> *"Don't mint `urn:spine:work:...` URIs without running the reconcile-first pipeline against `id.loc.gov`. Local minting is only for entities LoC has no record of. Every URI gets `spine:uriSource` provenance."*

Today the code violates this invariant in three places:

- `core/spine-bf/src/lib.rs::to_triples` mints `urn:spine:work:{book.id}` (line 358) and `urn:spine:instance:{book.id}` (line 362) unconditionally.
- `core/spine-bf/src/lib.rs::bibliographic_graph_to_triples` falls back to the same scheme at lines 213 and 320 when the inbound `BibliographicGraph` has no Work/Instance URI set.
- `core/spine-srv/src/lib.rs::synthesize_golden_candidate` mints local URIs during candidate fusion.

Every book ingested under the current code carries a local-only URI. None carry `spine:uriSource` provenance. Every future LoC promotion is more expensive than it needs to be because we cannot tell which graphs were minted blindly versus minted after a documented LoC miss.

The blocker on closing this debt was never the implementation — it was the UX:

- **Pure blocking on import** stalls the user during a multi-book drag-drop while we hit `id.loc.gov` SRU at 500ms-per-request (ADR 005). A 50-book drop becomes a coffee break the user did not ask for.
- **Pure background reconcile** violates the invariant — URIs are minted before reconcile can prevent them.
- **Approval drawer first** blocks the very first drop with a modal that demands manual review before any book lands in the library, which is the worst possible first-run experience.

ADR 014 (spine-bf write API) chose synchronous-blocking-with-timeout for *post-import* mutations (add_instance, add_subject) but explicitly deferred the *import-time* UX to a follow-on decision. This ADR is that follow-on.

Prior art in this repo:

- `docs/ADR_005_LoC_Cache_Strategy.md` — 90-day TTL SQLite cache, 2-concurrent cap, 500ms inter-request gap, exponential backoff. Sets the latency budget for any reconcile call.
- `docs/ADR_006_Reconciliation_Semantics.md` — already locks `owl:sameAs` + query-time expansion + named-graph segregation for *promotion*. ADR 015 does not re-decide promotion mechanics; it just hooks them in.
- `docs/ADR_009_Confidence_Thresholds.md` — Global Promotion Threshold of 0.80 for inferred metadata. ADR 015 reuses 0.80 as the auto-accept floor for write-time LoC matches.
- `docs/ADR_014_spine_bf_write_api_shacl.md §2` — synchronous-blocking-with-8s-timeout posture for write-API reconcile. ADR 015 generalizes the same posture to import.
- Reconcile-first identity is one of four locked architectural invariants.

## Decision

### 1. Reconcile-first is mandatory at import; never bypassed

**Scope.** ADR 015 governs Work URI and Instance URI mint at import. Subject URI mint (LCSH reconcile path) is governed by ADR 014 §1 + the Sprint 8 LCSH adapter (`core/spine-meta/src/loc.rs::LocClient::search_lcsh_subject` + `BlockingLocReconciler::SubjectReconciler`); ADR 015 inherits that path, it does not redecide it.

Every Work URI and every Instance URI minted by `to_triples` or `bibliographic_graph_to_triples` (and every URI minted by `synthesize_golden_candidate`) is preceded by a reconcile call. There is no `mint_blindly()` fast path.

The reconcile call returns one of three outcomes (the shape ADR 014 §2 already established):

```rust
pub enum ReconcileOutcome {
    Matched { uri: String, confidence: f32 },
    Unmatched,
    TimedOut,
}
```

`Matched` requires `confidence >= 0.80` (ADR 009). Below 0.80, the LoC candidates are returned to the UI as suggestions but the outcome is treated as `Unmatched`.

### 2. Write-time outcome → URI mint rules

| Outcome | URI minted | `spine:uriSource` | Additional triple |
|---|---|---|---|
| `Matched` | LoC URI verbatim (e.g. `http://id.loc.gov/resources/works/14456236`) | `"locref"` | — |
| `Unmatched` | `urn:spine:work:<uuid_v4>` | `"spinemint"` | — |
| `TimedOut` | `urn:spine:work:<uuid_v4>` | `"spinemint"` | `spine:reconcileTimeoutAt` (epoch ms) |

The same mapping applies to Instance URIs (`Matched` → LoC `bf:Instance` URI; `Unmatched`/`TimedOut` → `urn:spine:instance:<uuid_v4>`).

`spine:uriSource` is recorded as a triple on the URI itself in the asserted graph for that book:

```turtle
<http://id.loc.gov/resources/works/14456236> spine:uriSource "locref" .
```

For `Unmatched` and `TimedOut`, additional candidate metadata (top three LoC suggestions, if any, and the rejection reason) is written to the asserted graph under `spine:reconcileCandidates` so the drawer can surface them later without re-fetching.

### 3. URI provenance vocabulary (locked)

`spine:uriSource` is locked to two values today:

- `"locref"` — verbatim LoC URI, reconciled at import.
- `"spinemint"` — local URI minted because LoC had no acceptable match (or the reconcile call timed out).

Forward compatibility: future ADRs may add values such as `"external-wikidata"`, `"external-viaf"`, etc. for URIs sourced from non-LoC authorities. **Additions are append-only**; consumer code MUST treat `spine:uriSource` as a not-yet-exhaustive enumeration and tolerate unknown values without failing. The two values defined today are stable and will not be renamed or removed.

**Implementation note (resolves review item C1, 2026-04-25).** The SHACL gate at `core/spine-bf/src/write.rs:633-662` (`validate_instance_shape`) currently uses a closed `matches!(o.as_str(), "locref" | "locmint" | "spinemint")` literal. To honor the append-only forward-compat clause above, the gate **MUST treat `spine:uriSource` as open-vocabulary in implementation**: the closed match is replaced with a non-empty-string check (any non-empty literal validates) plus a soft-warn when the value is outside the currently-known set. The Sprint 10 implementation commit lands this change. Without it, a future ADR adding `"external-wikidata"` would silently fail SHACL validation on every `add_instance` carrying that value, contradicting ADR 015's forward-compat doctrine.

This supersedes the inconsistent vocabularies in `docs/TECH_DEBT.md §1.1` (`locref|locmint|spinemint`) and an earlier metadata-representation draft (`loc|spine-local|user-promoted|external-other`). Specifically:

- `locmint` from TECH_DEBT §1.1 is **dropped**. The case it described ("Spine-minted URI later accepted by LoC") is better modelled as a transition: the original URI keeps `spine:uriSource = "spinemint"` (its true write-time provenance), and the promotion is recorded by an `owl:sameAs` edge to the LoC URI per ADR 006. There is no third source value — only a write-time mint and a later equivalence assertion.
- `user-promoted` from amicus v2 is **not a `spine:uriSource` value** in this ADR. Promotion is an `owl:sameAs` edge, not a vocabulary class. The user's role in the promotion is recorded separately in `bf:AdminMetadata` provenance triples on the `owl:sameAs` assertion itself, not on the URI.
- The TimedOut case is distinguished by the presence of `spine:reconcileTimeoutAt`, not by a separate `uriSource` value. A `spinemint` URI with `spine:reconcileTimeoutAt` is a candidate for the background sweep; a `spinemint` URI without it has been resolved and stays.

ADR 014 §2 is hereby aligned to this two-value import-time vocabulary (it already used `locref | spinemint` — ADR 015 confirms).

### 4. Reconcile-drawer UX

Users drag N EPUBs into the library. Each ingest job runs reconcile synchronously with an 8s budget (ADR 005). The result is one of:

- **Auto-resolved** (`Matched` or `Unmatched`-with-no-candidates): URI minted per §2, book lands in library, no UI prompt. The drawer is not opened.
- **Needs review** (`Unmatched` with ≥1 LoC candidate at confidence 0.50–0.79, OR `TimedOut`): book lands in library with `spinemint` URI as a provisional commitment, *and* a row appears in the **Reconcile Drawer**.

The drawer is a non-blocking right-rail panel scaffolded as `apps/desktop/src/ReconcileDrawer.tsx` (Sprint 10 step 2). Each row presents:

- Book title + cover.
- Top three LoC candidates (when present) with title / agent / pubDate / confidence score.
- Three action buttons:
  1. **Accept LoC suggestion** (primary, when ≥1 candidate ≥0.50). Promotes the provisional `spinemint` URI to the chosen LoC URI via `owl:sameAs` per ADR 006. The original URI's `spine:uriSource = "spinemint"` is **preserved** (it remains the truthful record of what Spine did at write time); the LoC URI on the other side of the `owl:sameAs` edge carries `spine:uriSource = "locref"`. The user's role in the promotion is recorded as `bf:AdminMetadata` triples on the `owl:sameAs` assertion (who promoted, when, against which candidate id).
  2. **Mint local** (secondary). Confirms the `spinemint` URI as final. Removes the row from the drawer. Adds a `spine:reconcileResolvedAt` triple.
  3. **Skip ingest** (destructive, with single-click undo for 5s). Rolls back the asserted graph for this book and removes the calibre row. The book is gone from the library; the original EPUB file is untouched.

     *Render-lifecycle directive (per amendment-3, post-verify on `sprint-10-reconcile-tests`)*: clicking **Skip ingest** MUST NOT remove the row from the drawer's row-list during the 5s undo window. The row stays in the rendered list and switches its body to a `SkipUndoRow` overlay carrying the inline **Undo** button. Only after the 5s timer elapses (or the destructive POST returns) does the row leave the list. Implementing as a list-mutation-on-click branches the undo affordance into a separate banner / toast / portal — every such variant adds DOM coupling, focus-management surface, and an extra place where the timer can desync from the visible state. The in-row overlay is the single locked path because it preserves the `rows.map(...)` render contract (one row of state ↔ one DOM li), keeps the timer / overlay / data lifetimes co-located, and makes the affordance reachable by definition. (See `apps/desktop/src/ReconcileDrawer.tsx:208` `handleSkip` for the canonical implementation; the inverse pattern is the regression the `it.fails` spec catches.)

Drawer-level affordances:

- **Apply same to all** — when N rows have semantically equivalent shapes (all `Unmatched`-no-candidates, all `TimedOut`, etc.), one click resolves the cohort identically. "Mint local for all 7 unmatched books" is the dominant case during bulk import of self-published / small-press material.
- **Minimize to Toolbar pill** — collapses the drawer to a `N pending reconciles` pill in the existing Toolbar JobsIndicator area. Re-clicking re-expands.
- **Auto-open on first arrival** — if the drawer is closed and a row arrives, it opens. Subsequent arrivals do not re-trigger an open if the user has explicitly minimized it.

The drawer is non-blocking: the user can open / close / interact with the rest of the library while rows are pending. Pending rows persist across app restarts (rows live in `spine.db` keyed by book UUID, not in React state).

### 5. URI promotion mechanics (defer to ADR 006)

When the user clicks **Accept LoC suggestion**, the local `urn:spine:work:<uuid>` URI is *not* rewritten. Per ADR 006:

```turtle
<urn:spine:work:ab12cd34> spine:uriSource "spinemint" .                           # unchanged — true write-time provenance
<urn:spine:work:ab12cd34> owl:sameAs <http://id.loc.gov/resources/works/14456236> .
<http://id.loc.gov/resources/works/14456236> spine:uriSource "locref" .
# bf:AdminMetadata on the sameAs edge records who/when/why (promotion provenance).
# Mechanism for attaching bf:AdminMetadata to the owl:sameAs assertion is per
# ADR 006 (named-graph segregation: the sameAs edge + its bf:AdminMetadata triples
# live in the LoC-sourced graph; see ADR 006 §4 "Graph Merging vs Segregation").
```

All triples attached to the local URI remain. New triples (e.g. LoC-sourced subjects from the matched record) attach to the LoC URI. SPARQL / `spine-db` query-time expansion follows `owl:sameAs` to produce the union view.

Rationale (already locked in ADR 006, summarized here for completeness):

- Preserves the provenance trail of what the user / EPUB / earlier reconcile pass committed before promotion.
- Cheap rollback: deleting the single `owl:sameAs` triple un-promotes cleanly.
- Avoids a pathological update storm on `triples` for libraries with many references to the local URI (annotations, reading-progress rows, user notes, future inferred-graph references).

The alternative — full subject rewrite within a single transaction — was considered and rejected for the reasons in ADR 006. ADR 015 reaffirms this choice; it does not relitigate it.

### 6. Background re-reconcile sweep

Books in `TimedOut` state (carrying `spine:reconcileTimeoutAt`) and books minted before ADR 015 (carrying no `spine:uriSource` at all) are re-reconciled by a background sweep:

- **Trigger**: hourly via `tokio::time::interval` while the desktop app is running, and once on every library open.
- **Scope**: all books with (`spine:reconcileTimeoutAt` present) OR (`spine:uriSource` absent). Walked in batches of 50.
- **Behavior on match (≥0.80)**: auto-promote via the same `owl:sameAs` path as §5, set `spine:uriSource = "locref"` (no user action required because the threshold is ≥0.80; below that, drop into the drawer).
- **Behavior on no-match**: leave URI unchanged, refresh `spine:reconcileTimeoutAt` to current time so the next sweep does not re-attempt for at least 24 hours.
- **Concurrency**: respects ADR 005 (max 2 concurrent SRU requests, 500ms inter-request gap).

Failure modes:

- Network down → sweep no-ops cleanly, no state change.
- LoC schema drift → caught by the existing reconcile error handling; sweep logs and continues.
- User mid-edit on a book the sweep is about to promote → sweep takes a row-level lock per book; user edit either lands before the sweep claims the book (no conflict) or is queued behind the promotion (user sees the LoC URI on next render, which is the intended outcome).

### 7. Migration backfill for pre-ADR-015 books

On library open, a one-time scan flags all books missing `spine:uriSource`. Two responses:

- **Lazy**: do not block library open. Mark these books as `spine:reconcileTimeoutAt = 0` (effectively "due immediately") and let the §6 sweep pick them up. Library opens at normal speed.
- **Visible**: surface the count in the Toolbar pill (`23 pending reconciles`) so the user understands the drawer is about to populate.

No data is destroyed. The pre-ADR URIs remain valid; only their provenance is filled in retroactively.

**Backfill cadence for large libraries.** The §6 sweep concurrency cap (max 2 concurrent SRU requests, 500ms inter-request gap, per ADR 005) bounds backfill rate at ~4 books/second under best conditions. For a 1,500-book library all flagged on first open, that is a *minimum* of ~750 seconds (~12.5 minutes) wall-clock; for a 10,000-book library, ~85 minutes. Cache-warm hits are near-instant (per ADR 005's 90-day TTL), but a fresh install hits the network for every book. Backfill is best-effort and runs concurrently with normal library use — the Toolbar pill (`N pending reconciles`) is the user-visible feedback; the library is fully usable during the backfill, and individual books promote opportunistically as the sweep reaches them. A 10,000-book library may take several hours to fully resolve. This is acceptable: the alternative is a multi-hour modal at first open, which violates the non-blocking commitment of §8 Alt A.

### 8. Three rejected alternatives

**Alt A: Pure blocking on import.** Reconcile every book synchronously, no skip. Modal progress dialog during drag-drop.

- Rejected: 50-book drop at 500ms-per-request worst case = 25s of mandatory waiting before any book is visible. Bulk import is the dominant cold-start workflow; this is hostile.
- Rejected: violates Spine's general "library work is non-blocking" UX commitment.

**Alt B: Pure background reconcile.** Mint `spinemint` URIs at import, reconcile in a background sweep, never prompt.

- Rejected: violates the `CLAUDE.md` invariant *"Local minting is only for entities LoC has no record of."* If we always mint locally first, we are minting without checking — the very thing the invariant forbids.
- Rejected: degenerates to today's broken state plus a sweep. Users who never restart the app never get reconciled URIs.

**Alt C: Approval drawer first, no import until resolved.** Open a drawer pre-ingest; no book lands in the library until each one is resolved.

- Rejected: catastrophic first-run experience. New user drags their entire calibre library expecting it to "just work"; instead they see a drawer with hundreds of rows demanding case-by-case review.
- Rejected: the user has no way to *use* the library while they triage. Drawer-as-mandatory-modal is the same UX failure mode as Alt A in different clothing.

The chosen design (blocking-with-skip-to-drawer) is the only point in the design space that satisfies all four constraints: reconcile-first invariant honored, no mandatory blocking, no surprise local-mints, library usable during triage.

## Consequences

### Closes

- `docs/TECH_DEBT.md §1.1` flips from `decision-needed` to `fixed` once Sprint 10 ships.
- ADR 014 §2's "deferred to a follow-on UX decision" is satisfied; ADR 014 may be updated to point at ADR 015.

### Imposes

- Every ingest now carries an 8s worst-case latency tail (the timeout). For users on cellular / poor WiFi this is felt; the timeout is bounded so the library never stalls indefinitely.
- `spine.db` schema gains: `spine:uriSource` triple per book, optional `spine:reconcileTimeoutAt`, optional `spine:reconcileCandidates` payload, optional `spine:reconcileResolvedAt` for drawer-resolved books. No new SQL tables; new predicates only.
- The asserted graph now contains rows that the user has not personally vetted (the LoC candidates payload, the timeout flag). These remain in the asserted graph because they are facts about the reconcile attempt, not inferred metadata about the book itself. The asserted-vs-inferred split (TECH_DEBT §1.2, ADR 016 forthcoming) is unaffected.
- `core/spine-bf/src/lib.rs::to_triples` and `bibliographic_graph_to_triples` change shape: they take a reconcile callback or a pre-resolved `ReconcileOutcome` rather than minting blindly. The implementation footprint is bounded (the four mint sites identified in Context); call sites are limited to the ingest path and a small number of tests.
- `synthesize_golden_candidate` in `core/spine-srv/src/lib.rs` migrates to the same callback pattern. This is part of the §3.1 architectural-debt cleanup (move domain logic out of the transport layer) — the move can land in the same Sprint 10 commit cluster or be deferred to Sprint 11 without blocking ADR 015.
- **`UriSource::Locmint` Rust variant is dropped** (formal directive, resolves review item W1, 2026-04-25). The variant at `core/spine-bf/src/write.rs:138-141` (and its `as_str()` arm emitting `"locmint"`) is removed in the Sprint 10 implementation commit. The `UriSource` enum becomes a 2-variant `{ Locref, Spinemint }`. Pattern-match call sites are exhaustive after the drop; no fallback arm is required. Search and remove with `git grep -n "UriSource::Locmint\|\"locmint\"" core/`. ~30L mechanical change. The case `locmint` previously described — "Spine-minted URI later accepted by LoC" — is now expressed as a transition (`spinemint` URI + later `owl:sameAs` edge to a LoC URI per ADR 006), not as a third source value. Without this directive in §"Imposes" the Sprint 10 implementer would leave a dead code path that future readers mistake for an active value, contradicting the §3 vocabulary lock.

### Foregoes

- **Per-call streaming reconcile feedback** (e.g. "matching book 3 of 50…") is intentionally not specified. The drawer is the user's feedback surface; per-call progress would compete with it for attention and add UI surface area for marginal benefit.
- **User-tunable confidence threshold for auto-accept**. Sticks with 0.80 from ADR 009. A future ADR may expose this as a per-library setting if real-world false-positive rates demand it.
- **Re-reconcile of `locref` URIs**. Once a Work has a LoC URI committed, the sweep does not re-query LoC for it. Promotion is one-way; unpromotion requires the user to delete the `owl:sameAs` triple manually (or use a future "Forget LoC promotion" affordance).

## Open questions

1. **Drawer scope across libraries**: do pending reconciles from Library A persist while the user has Library B open? Recommendation: no — drawer state is per-library, attached to the library's `spine.db`. Library swap (TECH_DEBT §2.1) closes the drawer for A and opens fresh for B. Confirm.

2. **Inferred-graph interaction**: when ADR 016 (Sprint 11) lands the inferred-graph write path, LLM-suggested LoC matches will arrive in the inferred graph at `confidence < 0.80`. The drawer will surface these alongside SRU candidates. Should the drawer treat them visually distinctly (e.g. badge: "AI suggestion"), and should the drawer's "Accept" action promote the asserted URI directly or first promote the inferred suggestion to asserted (ADR 016's "user-approved" path)? Recommendation: defer to ADR 016 — Sprint 10 ships drawer with SRU-only candidates, Sprint 11 extends.

3. **Sweep cadence under power-saving**: hourly `tokio::time::interval` on the desktop is fine; the mobile (ADR 011, Compose) target needs a different scheduling primitive (Android `WorkManager` or equivalent). Recommendation: out of scope for ADR 015; mobile sweep is an ADR-011 follow-on. Confirm the mobile parity gap is acceptable for the desktop-first Sprint 10 ship.

4. **Calibre-side projection**: when a book gets `spinemint` → `locref` promoted, does anything in `metadata.db` need to update? Spine deliberately does not project URIs into calibre's schema (calibre doesn't have a column for them), so the answer should be "no — `metadata.db` is unaffected by promotion." Confirm.

## References

- `docs/TECH_DEBT.md §1.1` — the debt this ADR closes.
- `docs/ADR_005_LoC_Cache_Strategy.md` — latency budget.
- `docs/ADR_006_Reconciliation_Semantics.md` — `owl:sameAs` + query-time expansion (ADR 015 hooks into; does not redecide).
- `docs/ADR_009_Confidence_Thresholds.md` — 0.80 auto-accept floor.
- `docs/ADR_014_spine_bf_write_api_shacl.md §2` — write-API reconcile posture (ADR 015 generalizes to import).
- An earlier metadata-representation draft — reconcile-first invariant.
- Internal design notes — Sprint 10 implementation steps and file:line touch-list. Carries §1 the five mint sites, §2 the new `spine-meta` entry-points, §3 the SHACL gate flip recipe, §4 the `UriSource::Locmint` Rust drop walk-through, §5 provenance triples additions, §6 migration backfill scaffolding, §7 background sweep wire, §8 test fixture additions, §9 acceptance gates, §10 explicit out-of-scope, §11 implementer open questions. Read this before opening a Sprint 10 worktree; it answers most "where do I start" questions before they arise.
- `core/spine-bf/src/lib.rs:213, 320, 358, 362` — URI-mint sites the implementation must intercept.
- `core/spine-srv/src/lib.rs::synthesize_golden_candidate` — additional mint site.
- `core/spine-meta/src/loc.rs::LocClient` — the SRU client the reconcile callback dispatches to.

## Revision history

- 2026-04-25 — Initial draft (Sprint 8 prep for Sprint 10). Status: Draft.
- 2026-04-25 — Vocabulary revision (post-review). Locked `spine:uriSource` to two values `{locref, spinemint}` with append-only forward-compat clause. Promotion expressed via `owl:sameAs` + `bf:AdminMetadata` rather than a third `uriSource` value; original URI's write-time provenance preserved through promotion. Open question §1 (vocabulary alignment) resolved and removed.
- 2026-04-25 — Amendment 1 (post-code-review). §1 gains scope clarification (Work + Instance only; Subject path governed by ADR 014 + LCSH adapter — closes review item W2). §3 gains implementation note that the SHACL gate at `core/spine-bf/src/write.rs:633-662` MUST treat `spine:uriSource` as open-vocabulary; closed `matches!()` literal replaced with non-empty-string + soft-warn at Sprint 10 implementation (closes review item C1; the Sprint 10 commit also drops `UriSource::Locmint` Rust variant per review item W1, ~30L mechanical). §5 Turtle example gains cross-reference to ADR 006 §4 for the named-graph mechanism that attaches `bf:AdminMetadata` to the `owl:sameAs` assertion (closes review item N2). §7 gains a backfill-cadence paragraph explaining wall-clock expectations for 1,500-book and 10,000-book libraries under the ADR 005 concurrency cap (closes review item N3).
- 2026-04-25 — Amendment 2 (post-Sprint-10-pull-forward). §"Imposes" gains a formal directive bullet promoting review item W1 (`UriSource::Locmint` Rust variant drop) from a parenthetical in §3's amendment-1 implementation note to a load-bearing line — the Sprint 10 implementer cannot land the SHACL gate flip without also dropping the Rust variant in the same commit cluster. §"References" gains a pointer to internal design notes so the implementer has a single touch-list before opening a worktree.
- 2026-04-25 — Amendment 3 (post-verify on `sprint-10-reconcile-tests`). §4 action 3 (**Skip ingest**) gains a render-lifecycle directive locking the SkipUndoRow as an in-row overlay during the 5s undo window — the row MUST NOT leave the drawer's row-list on skip-click; only after the timer elapses or the POST returns. The original spec said "single-click undo for 5s" but didn't lock the render path, and the first ReconcileDrawer implementation (`efb807f`) interpreted that as immediate `setRows(prev.filter(...))` followed by an unreachable SkipUndoRow inside `rows.map(...)`. The vitest scaffold (`5158759`) caught it via an `it.fails` spec; the implementation was corrected in `8478b02`, and this amendment makes the spec match what's now in the code so future re-implementations can't regress.
