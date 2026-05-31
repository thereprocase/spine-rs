# ADR 005: Library of Congress (LoC) SRU Cache Strategy

## Status
Proposed

## Context
When performing bulk imports of EPUBs, the `spine-meta` crate relies heavily on the LoC SRU endpoint to fetch authoritative MARC XML and resolve ISBNs. The SRU endpoint is public, unauthenticated, and prone to throttling if hit concurrently at high volume. Additionally, re-importing libraries should not spam the endpoint for data we've already resolved.

We need a caching strategy for these remote responses.

## Decision

### 1. Cache Format & Storage
We will cache the **raw MARC XML** responses inside a dedicated local SQLite database: `loc_cache.db`.
- **Why SQLite?**: Fast, transactional, no thousands-of-tiny-files problem on disk, and allows for TTL-based pruning queries.
- **Why Raw XML?**: Caching raw XML ensures that if our MARC-to-BIBFRAME mappings improve, we can re-process the cached data without needing to re-fetch from the LoC. We do *not* cache Turtle/RDF.

### 2. Schema
```sql
CREATE TABLE sru_cache (
    query_hash TEXT PRIMARY KEY,
    query_string TEXT NOT NULL,
    response_xml BLOB NOT NULL,
    status_code INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL -- UNIX epoch
);
```

### 3. Eviction Policy
- **TTL**: 90 Days. Bibliographic data does not change rapidly. 90 days provides a balance between freshness and respecting the SRU servers.
- **Pruning**: A background job (using the Mobile Tokio Lifecycle `JobQueue`) will run weekly to delete rows where `fetched_at < (NOW - 90 days)`.

### 4. Concurrency Limits
- **Max Concurrent Requests**: 2. We will strictly enforce a maximum of 2 concurrent outbound HTTP requests to `id.loc.gov` across the entire application using a `tokio::sync::Semaphore`.
- **Rate Limiting**: We will insert a mandatory 500ms sleep between sequential requests on a given worker.
- **Backoff**: If a 429 (Too Many Requests) or 503 is received, the worker will back off exponentially (1s, 2s, 4s, 8s, up to 64s).

## Consequences
- Import speeds for 1,000 previously un-cached books will be slow (minimum 500 seconds / ~8.3 minutes). This is a necessary tradeoff to avoid being IP banned by the LoC.
- Subsequent imports of the same books (or books sharing the same queries) will be virtually instantaneous.
