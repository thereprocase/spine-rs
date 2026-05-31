# ADR 008: Hub Semantics for Local Translations

## Status
Proposed

## Context
In BIBFRAME, a `bf:Hub` is an abstract entity that groups related Works. For example, "The Iliad" (Hub) groups the English Translation Work and the French Translation Work.
The Library of Congress mints Hubs, but not all books in a user's library will have LoC coverage, particularly niche or personal translations.

If a user imports a translation of a book that does not exist in the LoC database, should Spine mint a local `urn:spine:hub:v1:...` to group it?

## Decision
**Yes, Spine will deterministically mint local Hub URIs for translations.**

### The Mechanism
If an EPUB is identified as a translation (via `dc:language` differing from the original language, or explicit `bf:translationOf` tags):
1. **Identify Original Work**: Attempt to resolve the original work's URI.
2. **Mint Local Hub (if necessary)**: If the original work is known, but no `bf:Hub` exists grouping them, Spine will mint a local Hub URI using `urn:spine:hub:v1:{hash}` where the hash is derived from the original Work's URI.
3. **Link**: Emit `<Original_Work> bf:hasExpression <Translation_Work>` and group both under the local Hub.

## Consequences
- Maintains a consistent 3-tier hierarchy (Hub -> Work -> Instance) even for purely local data.
- Allows the UI to cleanly group translations of the same book under a single "Super-Work" card, avoiding library clutter.
- When an LoC Hub is later discovered, the local Hub can be reconciled using the exact same `owl:sameAs` semantics defined in ADR 006.
