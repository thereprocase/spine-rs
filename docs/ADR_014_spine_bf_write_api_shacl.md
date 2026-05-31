# ADR 014: spine-bf Write API + SHACL Cardinality Shapes for Multi-Instance W/I/I

## Status
Proposed (2026-04-24, Session 6 design-fidelity sweep)

## Context

The design handoff exposes a "+ add another edition" affordance on the Inspector multi-instance W/I/I tree. The Inspector spec shows "+ instance" on the W/I/I section header for single-instance Works, and a "+ add" affordance on the Subjects · LCSH section. Both imply user-driven mutations to the BIBFRAME graph in spine.db.

ADR 013 formalized the read-side semantics. The write side has no API today: `core/spine-bf/src/lib.rs` exposes `to_triples`, `triples_to_bibliographic_graph`, `graph_scope_token`, and the round-trip path through ingest, but no per-entity mutation surface for adding Instances or Subjects to an existing Work.

CLAUDE.md locks several invariants the write API must respect:

- *"Don't bypass `spine-bf` and write directly to the triples table. Every graph mutation goes through `spine-bf`'s validated API so SHACL shapes stay enforced and provenance (`bf:AdminMetadata`) stays consistent."*
- *"Don't mint `urn:spine:work:...` URIs without running the reconcile-first pipeline against `id.loc.gov`. Local minting is only for entities LoC has no record of. Every URI gets `spine:uriSource` provenance."*
- *"Don't let LLM-inferred triples land directly in the asserted graph."* (This ADR governs the user-asserted path; the inferred path is TECH_DEBT §1.2.)

TECH_DEBT §1.1 (reconcile-first URI pipeline) is the largest decision-point gating this ADR — it specifies *what* must happen before mutation but not *how* the UX surfaces it (blocking-at-mutation vs background-queue vs approval-drawer). This ADR adopts a **synchronous-blocking-with-timeout** posture for write-time reconciliation; the deeper UX question is deferred to a follow-on UX decision.

## Decision

### 1. spine-bf write API surface

Add the following functions to `core/spine-bf/src/lib.rs`. Each takes a `&mut SpineStore` (or equivalent — actual binding TBD by the implementer based on existing handle conventions) and returns `Result<Uri, SpineWriteError>`:

```rust
pub fn add_instance(
    store: &mut SpineStore,
    work_uuid: &Uuid,
    candidate: InstanceCandidate,
) -> Result<String, SpineWriteError>;

pub fn add_item(
    store: &mut SpineStore,
    instance_uri: &str,
    item: ItemDescriptor,
) -> Result<String, SpineWriteError>;

pub fn add_subject(
    store: &mut SpineStore,
    work_uuid: &Uuid,
    subject_term: &str,
    source: SubjectSource,  // Lcsh | LocalTag | Inferred
) -> Result<String, SpineWriteError>;

pub fn remove_subject(
    store: &mut SpineStore,
    work_uuid: &Uuid,
    subject_uri: &str,
) -> Result<(), SpineWriteError>;

pub fn set_primary_instance(
    store: &mut SpineStore,
    work_uuid: &Uuid,
    instance_uri: &str,
) -> Result<(), SpineWriteError>;
```

`InstanceCandidate` carries the user's input (ISBN, title, publisher, pubDate, format, etc.) plus a `reconcile_against_loc: bool` flag (default `true`). `ItemDescriptor` describes the file (path, format, size, sha256). `SubjectSource` distinguishes LCSH-reconcileable terms from free-form local tags from LLM-inferred (which the API rejects with `SpineWriteError::AssertedRejectInferred` — inferred triples must use the inferred-graph write path, which is TECH_DEBT §1.2 and not this ADR).

Each write function is a transaction: SHACL validation + reconcile + triple-store insertion all commit or all roll back via the existing dictionary-encoded triple-store atomicity (`SpineStore` already wraps writes in transactions per spine-db conventions).

### 2. Reconcile-first invariants

Every `add_instance` call runs reconcile-first against id.loc.gov **synchronously** before minting any URI:

1. If the candidate has an ISBN, query id.loc.gov SRU by ISBN.
2. If matched: use the LoC `bf:Instance` URI; add `spine:uriSource = "locref"`.
3. If unmatched (or no ISBN provided): query by title + author. If matched with confidence ≥ ADR 009 threshold: use the LoC URI; `spine:uriSource = "locref"`.
4. If still unmatched: mint `urn:spine:instance:<uuid_v4>`; add `spine:uriSource = "spinemint"`.

The synchronous reconcile blocks the HTTP write for up to **8 seconds** (per ADR 005 worker latency budget; one ISBN query and one fallback title query each at the rate-limited cap). On timeout, the write proceeds with `urn:spine:instance:<uuid_v4>` + `spine:uriSource = "spinemint"` + a `spine:reconcileTimeoutAt = <ms>` triple flagging it for background re-reconciliation. The frontend receives a `partial: true` field on the response so it can surface "added locally; LoC reconciliation pending."

The same flow applies to `add_subject` against id.loc.gov authorities/subjects (LCSH service).

`add_item` does **not** reconcile (Items are file descriptors, not bibliographic entities; URI minted as `urn:spine:item:<uuid_v4>` with `spine:uriSource = "spinemint"` always).

### 3. SHACL cardinality shapes

Add the following shapes to a new file `core/spine-bf/src/shapes.rs` (or `assets/shapes.ttl` if Turtle is preferred — implementer's call):

```turtle
spine:WorkShape a sh:NodeShape ;
    sh:targetClass bf:Work ;
    sh:property [
        sh:path bf:hasInstance ;
        sh:minCount 1 ;       # every Work has at least one Instance
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path spine:primaryInstance ;
        sh:minCount 0 ;
        sh:maxCount 1 ;       # at most one primary Instance per Work
        sh:nodeKind sh:IRI ;
    ] .

spine:InstanceShape a sh:NodeShape ;
    sh:targetClass bf:Instance ;
    sh:property [
        sh:path bf:itemOf ;
        sh:minCount 1 ;       # every Instance is an Item-of exactly one Work
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
    ] ;
    sh:property [
        sh:path spine:uriSource ;
        sh:minCount 1 ;       # provenance is non-optional
        sh:in ( "locref" "locmint" "spinemint" ) ;
    ] .

spine:ItemShape a sh:NodeShape ;
    sh:targetClass bf:Item ;
    sh:property [
        sh:path bf:itemOf ;
        sh:minCount 1 ;
        sh:maxCount 1 ;       # every Item belongs to exactly one Instance
        sh:nodeKind sh:IRI ;
    ] .
```

Shapes are loaded once at `SpineStore` initialization; validation is an in-memory check against the staging triples before commit. SHACL validation failure returns `SpineWriteError::ShapeViolation { path, message }`.

The `bf:hasInstance min 1` constraint means **the very first ingest of a brand-new Work** (which today writes one Instance per Work atomically) is well-formed. Removing the last Instance from a Work via a future delete-instance API would require either deleting the Work too or falling back to a "stub" placeholder — that's a future ADR; this ADR does not introduce a delete-instance path.

### 4. Provenance triples

Every successful `add_instance` / `add_item` / `add_subject` call writes the following provenance triples alongside the entity:

- `<entity_uri> spine:uriSource <"locref"|"locmint"|"spinemint">`
- `<entity_uri> spine:addedBy <user_uri>` (defaults to `urn:spine:user:local` until multi-user lands)
- `<entity_uri> spine:addedAt <xsd:dateTime>`
- `<entity_uri> spine:addedBySession <session_uri>` (optional, for audit trail)

For LoC-reconciled entities (`spine:uriSource = "locref"`), additionally:

- `<entity_uri> spine:reconciledAgainst <loc_authority_uri>`
- `<entity_uri> spine:reconciledAt <xsd:dateTime>`
- `<entity_uri> spine:reconcileConfidence <xsd:decimal>` (per ADR 009)

These provenance triples are part of the asserted graph (not the inferred graph — inferred is TECH_DEBT §1.2). Frontend may surface them in a future "history" sub-pane on the Inspector; out of scope for this ADR.

### 5. HTTP endpoint surface (consumers of the spine-bf write API)

`spine-srv` adds the following routes (gated on this ADR; T4 backend lane Phase C):

- `POST /api/v1/book/:id/instance` → calls `spine-bf::add_instance(work_uuid_for(book_id), candidate)`. Body: `InstanceCandidate` JSON. Response: `201 Created` with `{ instance_uri, partial: bool, reconcile_status }`.
- `POST /api/v1/book/:id/subject` → calls `spine-bf::add_subject(work_uuid_for(book_id), term, source)`. Body: `{ term, source }`. Response: `201 Created` with `{ subject_uri, partial, reconcile_status }`.
- `DELETE /api/v1/book/:id/subject?uri=<uri>` → calls `spine-bf::remove_subject`. Response: `204 No Content`.
- `PATCH /api/v1/book/:id/instance/:instance_uuid/primary` → calls `spine-bf::set_primary_instance`. Response: `204 No Content`.

`add_item` is not exposed as its own endpoint; it's called internally during EPUB ingest as part of the existing `POST /api/v1/book/ingest` flow. Future "import a second file under an existing Instance" UI can promote it to its own endpoint when the use case lands.

### 6. Explicitly out of scope

This ADR does **not** cover:

- **Inferred-graph write path**: TECH_DEBT §1.2. LLM-inferred triples must land in `urn:spine:inferred:<uuid>` named graph with confidence/provenance; this is a separate write path Spine-bf will gain in a future ADR.
- **Delete-instance / delete-work**: removing the last Instance from a Work or removing a Work entirely. Future ADR.
- **Bulk multi-instance reconciliation sweep**: the background re-reconcile of `spine:reconcileTimeoutAt`-flagged entities. Implementer-discretion in `spine-meta`'s background queue.
- **Per-entity edit (vs add)**: changing the publisher of an existing Instance, fixing a typo in the title. Existing `PUT /api/v1/book/:id/metadata/fields` covers Work-level metadata edits via spine-bf; per-Instance edit is a follow-on ADR.
- **Conflict resolution between concurrent writers**: two Spine instances both adding an Instance to the same Work. Cross-instance federation is ADR 010 territory; single-instance concurrency is handled by SQLite transaction isolation within the existing `SpineStore` write paths.
- **Multi-user `<user_uri>` resolution**: provenance triples reference `urn:spine:user:local` until a multi-user model lands. Future ADR.
- **Asserted vs inferred graph partition migration for existing data**: TECH_DEBT §1.2.

## Consequences

### Implementation impact

**spine-bf** gains ~400-600 lines of new code: write API surface (5 functions), SHACL validation harness, reconcile-first invocation paths to spine-meta, error type. Rust unit tests for each function with mocked `SpineStore`. Integration tests with a real spine.db roundtripping single-Work, multi-Instance, multi-Subject scenarios.

**spine-srv** gains 4 new HTTP endpoints (~150 lines of handler code). Wire types in `spine-api/src/v1.rs` (`InstanceCandidate`, `AddSubjectRequest`, `WriteResponse`).

**spine-meta** gains a `reconcile_instance_synchronous(candidate, timeout) -> Result<ReconcileOutcome, _>` entry point (~80 lines) that wraps the existing async candidate-fetch path with a tokio `timeout`.

**Frontend (Inspector WIITree + SubjectsBlock)** wires the new affordances per design spec. Out of this ADR's scope.

### Migration / compatibility

No data-model migration. Existing single-Instance Works remain valid under the new SHACL shapes (one Instance ≥ 1 minCount). The `bf:hasInstance` predicate is already implicit in the current ingest path's triples (Work → has-Instance → Instance edge); the SHACL shape just formalizes the cardinality.

`spine:primaryInstance` is a new triple. Backfill rule: for every existing Work with exactly one Instance, write `<work_uri> spine:primaryInstance <instance_uri>` on next library open. For Works with multiple Instances (none today), prompt the user to designate a primary the first time the Inspector renders the Work.

Provenance triples backfill: existing Works/Instances ingested before this ADR have no `spine:addedBy` / `spine:addedAt`. Backfill rule: write `spine:addedBy = urn:spine:user:local` and `spine:addedAt = <book.created_at>` from the calibre projection. `spine:uriSource` backfills to `spinemint` for all existing entities (since none went through reconcile-first).

### Operational

- Synchronous reconcile blocks HTTP writes by up to 8s. Frontend must show a spinner on add-instance / add-subject. Acceptable for one-off user-driven mutations; would be unacceptable for bulk import (which uses the existing async ingest pipeline, not this ADR's sync write path).
- Reconcile cache (ADR 005) absorbs the cost on repeat-ISBN scenarios. Cold-cache add-instance on a brand-new ISBN: ~1-2s. Warm-cache: <100ms.
- SHACL validation overhead per write: <1ms (in-memory, ≤10 shapes against a single entity's triples). Negligible.
- Write API is `&mut SpineStore` — serializes per-library writes. No multi-writer concurrency within a single library; multiple libraries can write in parallel via separate `SpineStore` handles. Matches the existing Spine concurrency posture.

### Future evolution

- Bulk multi-instance reconciliation sweep (TECH_DEBT §1.1) lands in spine-meta's background queue; reuses the same `reconcile_instance_synchronous` entry point with timeout=infinity.
- Per-Instance edit gains its own ADR when the UI lands.
- Inferred-graph write path (TECH_DEBT §1.2) gains its own ADR; this ADR's `SpineWriteError::AssertedRejectInferred` is the explicit guard against accidental cross-graph contamination.
- SHACL shapes will grow as we discover more invariants worth enforcing (e.g. EDTF-validity on `bf:originDate`, language-tag well-formedness). Add to `shapes.ttl`/`shapes.rs` incrementally; no ADR required for shape additions that strengthen existing constraints.

## References

- ADR 005 — LoC Cache Strategy (latency budget for sync reconcile)
- ADR 009 — Confidence Thresholds (reconcile match acceptance)
- ADR 013 — Book DTO Multi-Instance Exposure (read-side companion)
- CLAUDE.md — locked invariants (spine-bf as sole write path, reconcile-first, asserted-vs-inferred separation)
- TECH_DEBT §1.1 — reconcile-first URI pipeline (UX decision still open; this ADR adopts sync-blocking pending)
- TECH_DEBT §1.2 — asserted vs inferred graph partition (out of scope here)
- Design deliverable — Inspector "+ instance" + "+ add" affordances and Artboard D "+ add another edition"
- `core/spine-bf/src/lib.rs` — current read-only API surface (extension point)
- Future: `core/spine-bf/src/shapes.{rs,ttl}` — SHACL shape definitions
- Future: `core/spine-srv/src/api_v1.rs` Phase C handlers (T4 backend lane)
