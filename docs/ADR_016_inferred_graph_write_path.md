# ADR 016: Inferred-Graph Write Path + Promotion API

## Status
Draft (2026-04-25, Sprint 11 prep)

## Context

`PLAN.md` §5 and CLAUDE.md both lock the asserted-vs-inferred separation as a non-negotiable invariant:

> *"Don't let LLM-inferred triples land directly in the asserted graph. Inferred triples live in the inferred graph with `spine:confidence`, `spine:inferredBy`, `spine:inferredAt`. Promotion to asserted requires explicit user action. LLM fabrication is the single most corrosive failure mode for a 30-year data store."*

TECH_DEBT §1.2 records the gap: `spine-db` today has a single graph table, `spine-bf` has no inferred-write surface, and no promotion path exists. ADR 014 §1 explicitly bounces inferred candidates with `SpineWriteError::AssertedRejectInferred`, deferring the inferred path to "TECH_DEBT §1.2 and not this ADR." This ADR is that follow-on.

ADR 015 established the *user-asserted* reconcile-first UX (locref / spinemint vocabulary, drawer + apply-to-all, owl:sameAs promotion edge). ADR 016 is its mirror image for the *machine-asserted* path: same separation discipline, same promotion-via-edge pattern, but with a confidence-gated trust model and a different UI surface (Inspector "Inferred Suggestions" tab, not the reconcile drawer).

ADR 023 §3 added the **plugin** partition as a third graph slot (`urn:spine:graph:plugin:<plugin-id>:<book-uuid>`) on top of the two ADR 016 introduces. The two ADRs share their Inspector promotion-pattern with ADR 023 (separate "Plugin Assertions" tab; this ADR's "Inferred Suggestions" tab; both mirror this ADR's promotion semantics).

No LLM inference runs in Spine today. This ADR is forward-looking guardrail — it locks the shape of the inferred path *before* any inferrer ships, so the first one (likely a Sprint 12+ subject-suggester or relator-disambiguator) lands into a graph that already enforces the right invariants.

## Decision

### 1. Named-graph URI scheme

Inferred triples live in a per-book named graph distinct from both the asserted graph (`urn:spine:graph:asserted:<book-uuid>`, used implicitly by ADR 014) and the plugin graphs (`urn:spine:graph:plugin:<plugin-id>:<book-uuid>`, ADR 023):

```
urn:spine:graph:inferred:<book-uuid>
```

Stored in the same `triples` table as the asserted graph; the `graph` column discriminates. Read APIs that should see inferred (Inspector "Inferred" tab, debug dumps) join across both; read APIs that must NOT (export pipeline, EPUB OPF projection, calibre `metadata.db` projection, SHACL validation of asserted shapes) filter to asserted only.

**Rationale for separate URI prefix vs. embedded predicate flag**: predicate-side annotation (`spine:assertedBy ex:llm`) was rejected — it requires every read query to remember to filter, and a missed filter leaks fabricated triples into a 30-year data store silently. Named-graph partition makes leakage a query-time error (wrong graph URI = no rows) rather than a forgotten WHERE clause.

### 2. Required provenance predicates

Every triple in the inferred graph carries reified provenance via a `spine:Inference` blank-node-equivalent reification node, shaped:

```turtle
_:inf1 a spine:Inference ;
       rdf:subject    <urn:spine:work:abc> ;
       rdf:predicate  bf:subject ;
       rdf:object     <http://id.loc.gov/authorities/subjects/sh85076671> ;
       spine:confidence    "0.87"^^xsd:decimal ;
       spine:inferredBy    "spine-inferrer-lcsh-suggest@0.1.0" ;
       spine:inferredAt    "2026-05-12T14:30:00Z"^^xsd:dateTime ;
       spine:inferenceBasis "title+publisher exact match in LCSH-tagged corpus" .
```

Plus the projected triple itself (`<urn:spine:work:abc> bf:subject <…sh85076671>`) lives in the inferred graph alongside the reification. Queries that want "all inferred subjects" join via the reification; queries that just want "the suggested triples" read the inferred graph directly.

The four lock-required predicates (other inferrers may add more):

| Predicate | Type | Required? | Notes |
|---|---|---|---|
| `spine:confidence` | `xsd:decimal` ∈ [0.0, 1.0] | yes | SHACL-shaped at write time. |
| `spine:inferredBy` | `xsd:string` | yes | Inferrer `name@version` per Inferrer trait §3. |
| `spine:inferredAt` | `xsd:dateTime` (UTC) | yes | Server-side stamp; not user-supplied. |
| `spine:inferenceBasis` | `xsd:string` | optional | Free-text human-auditable rationale. |

Open-vocabulary clause: future inferrers MAY append predicates (e.g. `spine:modelArchitecture`, `spine:trainingCutoff`) without ADR amendment, mirroring ADR 015 amendment-1's open-vocabulary pattern for `spine:uriSource`. Lock applies to the four-tuple core.

### 3. Inferrer trait

```rust
// core/spine-bf-inferrer/src/lib.rs (new crate, re-exported by spine-bf)

pub trait Inferrer: Send + Sync {
    /// Stable inferrer identity, written verbatim to spine:inferredBy.
    /// Must be `name@semver` (e.g. "spine-inferrer-lcsh-suggest@0.1.0").
    fn id(&self) -> &str;

    /// Human-readable label for Inspector UI.
    fn label(&self) -> &str;

    /// What predicates this inferrer is allowed to populate.
    /// SHACL-equivalent allow-list enforced by spine-bf at write time —
    /// an inferrer that emits triples outside its declared scope is rejected.
    fn predicates(&self) -> &[&str];

    /// Run inference on the asserted graph for this book.
    /// Returns proposed triples + per-triple confidence + basis.
    fn infer(
        &self,
        ctx: &InferenceContext,
        book_uuid: &Uuid,
        asserted: &BibliographicGraph,
    ) -> Result<Vec<InferredTriple>, InferenceError>;
}

pub struct InferredTriple {
    pub subject: String,        // URI
    pub predicate: String,      // URI
    pub object: RdfTerm,        // URI / literal / typed-literal
    pub confidence: f32,        // [0.0, 1.0]
    pub basis: Option<String>,
}

pub struct InferenceContext<'a> {
    /// Read-only snapshot. Inferrers MUST NOT mutate the store directly —
    /// the only path back into spine.db is via the InferenceResult returned
    /// to spine-bf, which writes through the validated inferred-graph path.
    pub read: &'a SpineStore,
    /// Per-book reconcile-cache + LCSH cache surfaces (ADR 005).
    pub loc_cache: &'a LocCache,
    /// Soft deadline; inferrer should bail and return partial results if hit.
    pub deadline: Instant,
}
```

Compile-time isolation: the trait lives in `spine-bf-inferrer`, re-exported by `spine-bf`. Inferrer implementations depend on `spine-bf-inferrer` only — they cannot reach the asserted-write surface in `spine-bf::write` because that module isn't re-exported through the inferrer crate. Mirrors ADR 023's `spine-bf-plugin` pattern.

### 4. spine-bf write API additions

Three new functions, all on `&mut SpineStore`:

```rust
/// Run a registered Inferrer over a book and stage its results in
/// the inferred graph. Idempotent on (inferrer_id, book_uuid):
/// re-running replaces the inferrer's prior output for that book.
pub fn run_inferrer(
    store: &mut SpineStore,
    inferrer: &dyn Inferrer,
    book_uuid: &Uuid,
) -> Result<InferenceReport, SpineWriteError>;

/// Promote a single inferred triple to asserted. Removes the reification
/// from the inferred graph, writes the bare triple to the asserted graph
/// with `spine:uriSource = "user-promoted"`-shaped provenance carrying
/// `spine:promotedFrom` linking back to the original `spine:Inference`
/// node identity (so audit history survives even after the inferred-graph
/// row is deleted). Requires explicit user action via the HTTP endpoint —
/// no inferrer can promote its own output.
pub fn promote_inferred(
    store: &mut SpineStore,
    inference_id: &str,
) -> Result<(), SpineWriteError>;

/// Reject an inferred triple. Deletes the reification + projected triple
/// from the inferred graph and records the rejection in
/// `urn:spine:graph:inference-audit:<book-uuid>` (separate audit graph
/// retained so re-running the same inferrer doesn't re-suggest a
/// previously-rejected triple — it's "I already said no" memory).
pub fn reject_inferred(
    store: &mut SpineStore,
    inference_id: &str,
    reason: Option<&str>,
) -> Result<(), SpineWriteError>;
```

`SpineWriteError` gains:
- `InferrerScopeViolation { id, predicate }` — inferrer emitted a predicate outside its declared `predicates()` allow-list.
- `InferenceNotFound { id }` — promote/reject called on a nonexistent or already-resolved inference.
- `PromotionWouldDuplicate { triple }` — the triple already exists in the asserted graph; promotion is rejected as a no-op-with-warning so the user can dismiss instead.

ADR 014 `SpineWriteError::AssertedRejectInferred` stays — that error path remains the asserted-write rejection for callers who try to write inferred-shaped data through the wrong surface.

### 5. HTTP endpoints

Three endpoints under `/api/v1/inference/`:

| Method | Path | Body / Response | Notes |
|---|---|---|---|
| `POST` | `/api/v1/inference/run` | `{ inferrer_id, book_uuid }` → `InferenceReport { added, deadline_hit, errors[] }` | 8s server-side timeout (ADR 005 budget). 202 if backgrounded for long-running inferrers. |
| `GET` | `/api/v1/inference/book/{uuid}` | → `[InferredCandidate]` | Lists pending inferred triples for a book, joined with reification provenance. |
| `POST` | `/api/v1/inference/{inference_id}/decide` | `{ action: "promote" \| "reject", reason?: string }` → 204 | Single endpoint for both decisions; matches Inspector tab UX (one action per row). |

No bulk-promote endpoint in this ADR. Inferred triples are promoted one-by-one through user review — a "promote all" affordance would re-introduce the LLM-fabrication blast radius this whole separation is designed to prevent. Future ADR may revisit if a high-confidence-threshold auto-promote workflow is justified, but the bar is high.

### 6. Inspector UI surface

A new "Inferred Suggestions" tab on the book Inspector, peer to the existing tabs (Overview, W/I/I, Subjects, etc.). When the inferred graph for a book has zero rows, the tab renders empty-state with explanation text + a "Run inferrer" affordance per registered inferrer. When it has rows, each row shows: triple in human form, confidence bar, inferrer id+version, basis text, and Promote / Reject / Ignore (defer) buttons. Promote and Reject both call `POST /decide`; Ignore is a client-side filter that hides the row until the next page load.

This is a *separate tab from the ADR 015 reconcile drawer*. Reconcile drawer = "user is asserting metadata; system is offering a LoC URI for it" (asserted graph, locref/spinemint vocabulary). Inferred tab = "machine is suggesting metadata the user hasn't asserted" (inferred graph, confidence/inferredBy vocabulary). Conflating them would produce a UI that reads as "the system is auto-asserting things on my behalf" — exactly the failure mode CLAUDE.md's lock prohibits.

### 7. Promotion semantics + audit history

When an inferred triple is promoted:

1. The reification node and projected triple are deleted from the inferred graph.
2. The triple is rewritten in the asserted graph with `spine:uriSource = "user-promoted"` (vocabulary append per ADR 015 amendment-1's open clause).
3. A `spine:promotedFrom` link references the original `spine:Inference` node's ID (kept as a frozen string identity even though the node row itself is gone). Asserted-graph admin metadata also carries `spine:promotedAt`, `spine:promotedBy` (user identity if known, else `"unknown"`), and a copy of the original `spine:inferredBy` so the lineage survives indefinitely.
4. The audit graph (`urn:spine:graph:inference-audit:<book-uuid>`) records `(inference_id, "promoted", timestamp)`. Same graph also records rejections — see §4.

Rejection semantics symmetric: removes from inferred graph, writes `(inference_id, "rejected", timestamp, reason)` to audit graph. A future re-run of the same inferrer SHALL skip any (subject, predicate, object) tuple already in the audit graph as rejected — "user said no" persists across inferrer runs.

The audit graph is intentionally never projected to EPUB / calibre / Dublin Core export. It exists solely for inferrer self-suppression and for user-visible "history of suggestions" debugging.

## Rejected Alternatives

**Alt A — single graph with `spine:assertedBy` predicate flag.** Simpler storage, but every read query must remember to filter, and a missed filter silently leaks fabricated triples into the asserted view. Named-graph partition makes leakage a query-time error rather than a code-review failure. Rejected.

**Alt B — confidence-threshold auto-promotion (e.g. ≥0.95 → asserted).** Tempting for high-precision inferrers, but a 95%-confidence model that's wrong on 1 book in 20 across a 5,000-book library auto-asserts ~250 wrong triples — exactly the corrosion vector CLAUDE.md prohibits. Rejected. Future ADR may revisit with mandatory-review-queue + bounded-blast-radius constraints.

**Alt C — store inferred triples in a separate SQLite database (`spine.db.inferred`) rather than a separate named graph.** Adds a second file to back up + a second connection to manage; no read-path benefit over the named-graph approach since both use the same SQL engine; cross-graph joins (e.g. "this asserted triple was promoted from this inference") become two-database dances. Rejected.

**Alt D — no audit graph; rejection is a hard delete.** Then re-running the same inferrer re-suggests the same rejected triples forever. User fatigue defeats the review surface. Rejected.

## Cross-references

- **ADR 014 §1** — asserted-write API; this ADR is its inferred-write mirror. The `SpineWriteError::AssertedRejectInferred` rejection in ADR 014 is the boundary marker.
- **ADR 015** — user-asserted reconcile-first UX; the *vocabulary* and *promotion-via-edge* patterns mirror across the two. ADR 015's open-vocabulary clause for `spine:uriSource` is what permits §7's `"user-promoted"` value here.
- **ADR 016 (this)** — inferred graph partition + Inferrer trait + promotion API.
- **ADR 023 §3** — plugin graph partition; the third slot in the asserted/inferred/plugin triad. ADR 023's separate "Plugin Assertions" Inspector tab is patterned on §6 of this ADR.
- **TECH_DEBT §1.2** — gap this ADR closes. On lock, §1.2 moves from "decision-needed" to "decided, awaiting Sprint 11 implementation."
- **PLAN.md §5** — BIBFRAME storage model; this ADR concretizes the "separate inferred graph" line item.
- **CLAUDE.md don'ts** — *"Don't let LLM-inferred triples land directly in the asserted graph"* is the lock this ADR enforces operationally.

## Implementation Notes (Sprint 11)

- Schema migration adds an `inference_audit` table (or named graph rows) keyed `(book_uuid, inference_id)`.
- `spine-bf` write functions hold the `git-index`-equivalent SQLite write transaction for the duration of run/promote/reject so concurrent inferrers don't race.
- The Inspector "Inferred Suggestions" tab is gated behind a feature flag (`spine.inference.enabled`, default `false`) until the first inferrer ships — empty surface is worse than no surface.
- No inferrer is shipped by this ADR. First implementer (likely Sprint 12 LCSH subject-suggester) will reference back here.
