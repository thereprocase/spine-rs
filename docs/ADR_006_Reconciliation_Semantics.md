# ADR 006: Promotion-on-Reconciliation Semantics

## Status
Proposed

## Context
When a book is initially imported into Spine, we mint local URIs (e.g., `urn:spine:work:v1:...`) per ADR 004. 
Later, a background process (or manual user action) queries the Library of Congress and finds the authoritative URI (e.g., `http://id.loc.gov/resources/works/1234`).
We need to define how the system records this mapping and how queries behave once the mapping is established.

## Decision

### 1. Alias Mechanism: `owl:sameAs`
We will use `owl:sameAs` to map the local URI to the authoritative URI.
```turtle
<urn:spine:work:v1:a1b2c3d4> owl:sameAs <http://id.loc.gov/resources/works/1234> .
```
- **Why not `skos:exactMatch`?** `skos:exactMatch` is typically used for mapping concepts between vocabularies (e.g., LCSH to RAMEAU), not for identifying that two URIs refer to the exact same real-world entity in an operational database. `owl:sameAs` carries the formal semantic weight of identity, which is what we want for merging Works.

### 2. Query Expansion (The "Promotion" Step)
We will **NOT** aggressively rewrite all triples in `spine.db` to replace the local URI with the LoC URI. Doing so destroys the provenance of the local data and causes massive I/O churn.

Instead, we will use **Query-Time Expansion**:
Whenever a query asks for properties of `http://id.loc.gov/resources/works/1234`, the SPARQL execution engine (or our Rust data access layer) will automatically rewrite the query to look for triples attached to *either* the LoC URI *or* any URI linked via `owl:sameAs`.

### 3. Subject Identity Precedence
When the backend API serializes a Work to JSON for the frontend (`/api/v1/book/{id}`), the `id` field will *always* return the LoC URI if one exists. The local `urn:spine` URI is suppressed in the frontend and treated as a purely internal implementation detail once reconciliation happens.

### 4. Graph Merging vs Segregation
When reconciling, the new triples fetched from LoC will be placed in a separate named graph (e.g. `urn:spine:graph:loc`). The local triples extracted from the EPUB stay in the asserted graph (`urn:spine:graph:local`).
This prevents LoC data from clobbering local corrections.

## Consequences
- No destructive updates to the triples table upon reconciliation.
- Query logic in `spine-db` becomes slightly more complex, as it must traverse `owl:sameAs` edges implicitly.
- Easy un-reconciliation: If a match is incorrect, deleting the single `owl:sameAs` triple cleanly breaks the merge.
