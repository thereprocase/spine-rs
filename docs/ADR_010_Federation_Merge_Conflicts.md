# ADR 010: Federation Merge Conflicts

## Status
Proposed

## Context
A future goal of Spine is "Federation", where multiple users can share and merge their libraries (or specific books) over a P2P network or a shared sync folder.
Because we mint local URIs deterministically using the SpineNormv1 algorithm (ADR 004), two users who import the exact same EPUB will independently mint the exact same `urn:spine:work:v1:{hash}` URI.
If User A fixes a typo in the title, and User B adds a new subject heading, and they subsequently federate their libraries, the system will encounter two different graphs asserting properties for the exact same URI.

We must define a deterministic merge algorithm to resolve these conflicts without data loss and without requiring immediate manual intervention.

## Decision

### 1. Graph Provenance
Every triple in `spine.db` belongs to a named graph.
When User A syncs with User B, User B's triples are inserted into a named graph specific to User B (e.g., `urn:spine:graph:peer:{peer_id}`).

### 2. Additive Merge by Default (Non-Functional Properties)
For properties that can have multiple values (e.g., `bf:subject`, `bf:genreForm`, `bf:hasInstance`), the system performs a pure set union.
If User A added "Science Fiction" and User B added "Cyberpunk", the federated view will simply show both.

### 3. Timestamped LWW (Last-Writer-Wins) for Functional Properties
For functional properties that logically should only have one value (e.g., `bf:mainTitle`, `bf:publicationYear`), the UI must choose one to display.
We resolve this using a Last-Writer-Wins (LWW) algorithm based on graph modification timestamps.
- Each named graph maintains a `last_modified` timestamp.
- The UI projects the value from the graph with the highest `last_modified` timestamp.
- **Crucially**: The "losing" value is *not deleted*. It remains in the database attached to its respective peer graph. If the winning peer later retracts their assertion, the system falls back to the next most recent assertion.

### 4. Explicit Overrides
A user can explicitly "Pin" a value in their local UI. This writes a new triple into a special `urn:spine:graph:override` graph, which always carries a confidence of `1.0` (per ADR 009) and trumps all peer data, regardless of timestamps.

## Consequences
- Federation sync is non-destructive and mathematically commutative. `Sync(A, B)` results in the exact same database state as `Sync(B, A)`.
- The database size will grow as competing assertions are accumulated, but textual metadata is small enough that this is acceptable.
- Requires robust schema support for tracking `last_modified` at the graph level (which we handle via our `graphs` table in `spine.db`).
