# ADR 004: URI Normalization Rules for Local Minting

## Status
Proposed

## Context
When a book is imported into Spine without a known authoritative URI (e.g. from the Library of Congress), Spine must deterministically mint a local `urn:spine:work:...` or `urn:spine:instance:...` URI. 
If two users import the same EPUB independently, or if the same user imports a book, deletes it, and imports it again, the system should ideally generate the same URI to facilitate federation and deduplication.

To achieve this, we rely on core bibliographic properties (Title, Author, Date). However, strings are notoriously messy (casing, punctuation, transliteration).

## Decision
We will establish a versioned normalization algorithm, currently **SpineNormv1**.

### The SpineNormv1 Algorithm

1. **Base Extraction**: Extract Title (`bf:mainTitle`), Primary Author (`bf:agent` with relator `aut`), and Year of Publication.
2. **NFKC Normalization**: Convert all Unicode strings to NFKC (Normalization Form Compatibility Composition).
3. **Case Folding**: Convert the entire string to lowercase.
4. **Diacritic Stripping**: Remove all combining diacritical marks (Unicode Category `Mn`).
5. **Punctuation Stripping**: Remove all non-alphanumeric characters (keep only `a-z`, `0-9`, and non-Latin letters). Do *not* transliterate (e.g. Cyrillic "войнаимир" remains Cyrillic, it is not converted to "voinaimir").
6. **Concatenation**: Join the normalized strings with a colon delimiter: `{title}:{author}:{year}`.
7. **Hashing**: SHA-256 hash the resulting string.
8. **Minting**: Format as `urn:spine:work:v1:{hash[:12]}`.

### Example
- Title: "The Lord of the Rings: The Fellowship of the Ring!"
- Author: "Tolkien, J.R.R."
- Year: 1954
- Normalized: `thelordoftheringsthefellowshipofthering:tolkienjrr:1954`
- Hash/URN: `urn:spine:work:v1:a1b2c3d4e5f6`

## Consequences
- **Positive**: High determinism. Two clean EPUBs of the same book will get the same URI.
- **Negative**: Transliterated titles (e.g. an English edition using "Voina i mir" vs a Russian edition using "Война и мир") will mint *different* URIs. This is acceptable, as they represent different instances or works, and will rely on the Reconciler (Track D3) to merge them via `owl:sameAs` later.
- **Versioned**: By including `v1` in the URN, we can safely upgrade the algorithm in the future without invalidating existing URIs.
