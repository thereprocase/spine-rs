# ADR 009: Confidence Thresholds

## Status
Proposed

## Context
Our `spine.db` architecture supports storing a `confidence` value (0.0 to 1.0) on the `graphs` table. This is because Spine operates in an environment where metadata comes from multiple, often conflicting sources:
- Asserted metadata (entered by the user manually: confidence = 1.0)
- Authoritative metadata (fetched from LoC via SRU: confidence = 0.95)
- Fallback metadata (extracted from OPF / Calibre: confidence = 0.80)
- Inferred metadata (LLM extraction from text, fuzzy matching: confidence = 0.50 - 0.75)

We need to define a threshold for when an inferred triple is "promoted" to be visible by default in the UI and exported in the back-matter.

## Decision
We define the **Global Promotion Threshold at `0.80`**.

1. **Visibility**: Any graph with a confidence `< 0.80` is hidden from the primary UI views and is *not* included in EPUB exports by default.
2. **Review Queue**: Graphs with confidence between `0.50` and `0.79` are placed in a "Reconciliation/Review Queue". The user must manually approve them, which bumps their confidence to `1.0`.
3. **Discard**: Any inference resulting in a confidence `< 0.50` is immediately discarded and not written to `spine.db`.
4. **Resolution Logic**: If two graphs assert the *same* triple (e.g., `Title = "Dune"`), the system implicitly uses the highest confidence graph. If two graphs assert *conflicting* functional properties (e.g., Graph A says `PublicationYear = 1965` at `0.95` and Graph B says `PublicationYear = 1966` at `0.85`), the UI resolves to the higher confidence.

## Consequences
- Protects the library from being poisoned by bad LLM hallucinations or aggressive fuzzy matches.
- Requires building a "Needs Review" UI in the frontend.
- Standardizes the implicit trust hierarchy: User > Library of Congress > Publisher EPUB metadata > Automated Inference.
