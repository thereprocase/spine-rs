# Bench fixtures for `spine-fmt-epub`

These EPUBs are committed bytes used by `core/spine-fmt-epub/benches/read_paths.rs`. They must be:

- **Small enough to commit** — single-digit KB to low-hundreds-KB.
- **Byte-identical across runs** — no wall-clock metadata, no random IDs.
- **Real-world representative** — taken from or modelled on actual archive sources, not lorem-ipsum synth.

## Current fixtures

| File | Size | Source | Shape |
|---|---:|---|---|
| `small.epub` | 2.3 KB | `artifacts/S3_Reference.epub` (Spine reference EPUB 3.3 from §3 EPUB writer-spec work) | 7 zip entries: mimetype + container.xml + metadata.xml + content.opf + nav.xhtml + 2 chapter xhtml. EPUB 3, no NCX, no images, no fixers needed. The minimum-viable read path. |

## Slots reserved (not yet filled)

The following entries exist in `baseline.json` as `informational: true` placeholders. CI's step summary will render them as `_missing_` until a fixture lands.

### `typical.epub` — Standard Ebooks gold-standard

**Target**: 50-200 KB, 10-30 chapters, NCX + nav.xhtml, cover image, metadata-rich (`dc:title`, `dc:creator`, `dc:description`, `dc:identifier`, `dc:source`, BIBFRAME refinements). Should exercise the full happy-path read without engaging any fixers.

**Where to source**: `https://standardebooks.org/` ships gold-standard EPUBs under CC-0 / Public Domain. Pick a small public-domain title (e.g., a short story collection, ~50-100 KB compressed).

**Steps to add**:
1. Download a small SE title.
2. Verify size is committable (< 200 KB ideal).
3. Drop as `typical.epub`. Confirm it round-trips through `cargo run -p spine-cli` (or whatever the canonical sanity-check is at the time).
4. Add `bench_read_epub_typical_se` to `read_paths.rs` following the existing pattern.
5. Re-measure baselines on dev hardware; update `baseline.json` (drop `informational: true`, set real `baseline_us` + `ceiling_us`).

### `pathological.epub` — PG auto-EPUB requires fixers

**Target**: ~100-500 KB, malformed in ways the `ProjectGutenberg` profile's fixer chain is designed to repair: manifest items pointing at missing hrefs (`manifest_prune_invalid`), duplicate hrefs under different ids (`manifest_dedupe`), encoding inconsistencies, and ideally a missing or wrong `dc:identifier`.

**Where to source**: `https://www.gutenberg.org/` auto-generates EPUBs from their plain-text canonical. Many of these fail Strict-profile validation. Pick a public-domain title that's known to require fixer work (the test corpus from Sprint 14 milestone work may already have candidates).

**Steps to add**: same as typical.epub, but: (a) verify Strict-profile read returns an error, (b) verify ProjectGutenberg-profile read returns Ok, (c) add a bench function that exercises the fixer-engaged path specifically.

## Why no synthesis?

We could build an EPUB in the bench setup via `zip::ZipWriter` + handcrafted XML. We don't, because:

1. The bench would measure the synthesizer + reader together, polluting the read-path measurement.
2. Synthesized EPUBs don't capture real-world deficiency shape (wrong-in-the-way-PG-is-wrong, polished-in-the-way-SE-is-polished). The point of profile-tagged benches is to measure the profile-tagged-fixer-chain cost, which only emerges on real-shaped input.
3. Committed bytes are byte-identical across runs without further machinery; synthesizers depend on the synthesizer's stability across crate updates.
