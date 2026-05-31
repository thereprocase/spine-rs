# ADR 013: Book DTO Multi-Instance Exposure

## Status
Proposed (2026-04-24, Session 6 design-fidelity sweep)

## Context

Design handoff (Multi-Instance Work deep-dive) and the Inspector spec require the desktop frontend to render a Work / Instance / Item tree with **N ≥ 1** Instances per Work. Single-instance books collapse to a one-row tree; multi-instance Works (e.g. Divine Comedy with four translations) expand the Instance list inline with per-Instance metadata.

Internal design notes originally proposed three options for surfacing the W/I/I graph:

- (a) Flatten W/I/I arrays into the existing `Book` DTO.
- (b) Nest a `graph` sub-object on `Book`, opt-in via `?include=graph` query param.
- (c) A separate `GET /api/v1/book/:uuid/graph` endpoint.

**Discovery during ADR scoping**: `core/spine-api/src/lib.rs:11-62` already defines:

```rust
pub struct Book {
    pub id: Uuid,
    pub title: String,
    pub authors: Vec<String>,
    pub legacy_metadata: LegacyMetadata,
    pub bibliographic_graph: Option<BibliographicGraph>,  // ← already present
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct BibliographicGraph {
    pub work_uri: String,
    pub instance_uri: String,           // ← primary instance, singular
    pub work: Work,
    pub instances: Vec<Instance>,       // ← already a Vec
}
```

`core/spine-srv/src/api_v1.rs::list_books_v1` and `get_book_v1` both unconditionally call `crate::list_enriched_books` / `crate::get_enriched_book`, which hydrate `bibliographic_graph` from spine.db triples on every list/get. The frontend already consumes `bibliographicGraph.instances?.[0]` in App.tsx lines 538-572, 962-980, 1012-1013.

**The DTO already supports multi-instance.** The remaining questions are (1) inclusion semantics and (2) primary-instance semantics.

## Decision

### 1. Inclusion semantics — keep always-included, no opt-in flag

`bibliographic_graph` remains unconditionally hydrated on `GET /api/v1/book` and `GET /api/v1/book/:id`. We do **not** introduce `?include=graph` opt-in.

**Rationale:**

- Hydration is already on the hot path; adding an opt-in flag is a no-op for performance and adds frontend conditional logic plus per-call decision overhead.
- The existing batch hydration via `store.get_triples_batch(&uri_refs)` is already the optimized path; per-call opt-in would only let a caller skip work that is already cheap.
- If profiling at 10k+ books reveals the hydration is a real bottleneck, the right fix is a `?fields=` projection mechanism (FIQL or sparse fieldsets, RFC 6906-style), not a binary include/exclude flag.

This decision **rejects** all three originally-proposed options. The DTO doesn't change shape, no new endpoint is added, no opt-in flag is introduced.

### 2. Primary-instance semantics — formalize `instance_uri` as the primary

`BibliographicGraph.instance_uri: String` (singular) is retained. Defined as the URI of the **primary Instance** for the Work, where:

- For single-instance Works: `instance_uri == instances[0].uri`.
- For multi-instance Works: `instance_uri == primary_instance_uri` if a user-designated primary exists in spine.db, otherwise the first Instance by `publication_date` ASC (oldest first; with `None` publication_date sorting last).

`instances: Vec<Instance>` is the **complete** list of all Instances for the Work. Frontend Inspector WIITree iterates `instances[]` for the multi-instance tree per Artboard D. Single-instance UI may continue to read `instance_uri` for shorthand access.

The "primary" concept is informal in the spine.db today (one Instance per Work universally); formalization lands when ADR 014's spine-bf write API gains `add_instance(work_uuid, instance_data)`. At that point, an explicit `primary_instance_uri` triple lands in the named graph and the projection rule above keys off it.

### 3. Frontend consumption pattern

For the Inspector WIITree per `spine-inspector.jsx` lines 154-181:

- Iterate `book.bibliographicGraph.instances` for the Instance children of the Work node.
- For each Instance, render Instance metadata (publisher · pubDate · format) plus a single Item child (the file).
- Single-instance books render as a collapsed tree (existing behavior).
- Multi-instance books render the Artboard D expansion (per-Instance row with reconciliation scent dot, "+ add another edition" affordance gated on ADR 014).

Frontend type definitions in `apps/desktop/src/App.tsx:55-90` are already aligned; the inline TS interface mirrors the typeshare-generated types. No type-side changes required.

### 4. ADR scope explicitly out

This ADR governs **read-side DTO semantics only**. Out of scope:

- Adding new Instances (gated on ADR 014 spine-bf write API + SHACL cardinality).
- Adding/removing Subjects via the Inspector chip "+ add" (ADR 014).
- Reconciling individual Instances against id.loc.gov (existing `/api/v1/book/:id/candidates` covers Work-level; per-Instance reconciliation is a future sprint).
- Promoting an Instance to "primary" (ADR 014, write path).

## Consequences

### Implementation impact

**Backend**: None. `spine-api`, `spine-srv`, and `spine-bf` already produce the wire shape. `triples_to_bibliographic_graph` in spine-bf populates `instances: Vec<Instance>` correctly when multiple Instance triples exist in the named graph (currently always one; multi-instance landing with ADR 014).

**Frontend**: Inspector WIITree extraction (punch-list T2) wires against `instances[]` directly. Mock multi-instance for visual development by shimming an extra entry into `instances` in `projections.ts` until ADR 014 lands a real write path.

### Migration / compatibility

No breaking changes. `instance_uri` semantics formalized but unchanged in the single-instance case (which is 100% of current data). Multi-instance Works don't exist in the data store yet; the projection rule for `instance_uri` activates when ADR 014's write path produces them.

### Operational

- Hydration cost of `Vec<Instance>` per book scales linearly with instance count. At observed N=1, the cost is unchanged from today. At N=4-10 (a power user with several editions of the same Work), the cost is still well under 1ms per book per the spine-db dictionary-encoded triple-store benchmarks.
- No new endpoints means no new OpenAPI YAML entries, no new typeshare types, no expansion of the three-contract drift surface (TECH_DEBT §3.3).

### Future evolution

- If sparse fieldsets become necessary at scale, that's a new ADR (proposed: ADR XXX, "Sparse fieldset projections via `?fields=`"). Don't pre-pessimize.
- If the "primary Instance" concept needs first-class storage (vs derived from sort order), that's part of ADR 014 — an explicit `bf:primaryInstance` triple in the Work's named graph.
- If per-Instance read endpoints become useful (`GET /api/v1/book/:uuid/instance/:instance_uuid`), that's a future addition; the current `Vec<Instance>` payload is sufficient until proven otherwise.

## References

- `core/spine-api/src/lib.rs` — DTO definitions (load-bearing)
- `core/spine-srv/src/api_v1.rs:75-140` — list/get hydration paths
- `apps/desktop/src/App.tsx:55-90, 538-572` — current frontend consumption
- Design deliverable — Inspector WIITree spec and Artboard D multi-instance deep-dive
- ADR 014 (forthcoming) — spine-bf write API + SHACL cardinality for adding Instances
- TECH_DEBT §3.3 — three-contract drift policy for sprint endpoints
