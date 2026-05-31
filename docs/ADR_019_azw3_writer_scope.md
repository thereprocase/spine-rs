# ADR 019: AZW3 Writer Scope

## Status

Draft — pending review and lock.

Drafted 2026-04-25 as a Sprint 16 deliverable strawman. Locks the framing of `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2` (AZW3 reframed first-class per installed-base data, not "opt-in legacy").

## Context

Sprint 16 ships `spine-fmt-mobi` — Spine's first-party AZW3 writer. The format choice + writer scope is locked at this ADR; the byte-identical implementation work follows in Sprint 16 against `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md §A` (the EPUB→MOBI worked example) and the calibre conversion recon.

The framing question from `CLAUDE.md` and `PLAN.md §454`:

> *"Older formats (EPUB 2, MOBI) get lossy projections via user-configurable mappings."*

> *"MOBI / AZW3 — Heavy data loss; what survives: Title, author, publisher, date, ISBN, language, description."*

So Spine writes AZW3 as a **lossy projection target**, not a canonical-graph carrier. This ADR locks:

1. AZW3 (KF8) is the only Mobipocket-family target Spine writes first-party.
2. PalmDOC-RLE is the only compression Spine implements first-port.
3. The byte-identical bar is calibre's `ebook-convert` for a fixed input set.
4. The canonical BIBFRAME graph stays in `spine.db` (user-library truth) and travels via an opt-in sidecar `.spine-bf.ttl` when the user explicitly exports for graph-preserving Spine-to-Spine transfer. **The AZW3 itself carries only the rigid EXTH keyed-map projection** — it is *not* a canonical-graph carrier.
5. The writer surfaces a plugin-extensibility hook per `docs/ADR_023_plugin_architecture.md` so third-party MOBI-family writers (legacy MOBI 6, KFX, etc.) can plug in without forking `spine-fmt-mobi`.

Source data on the AZW3 installed-base reasoning lives in `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.1-§4.2` — quoted in §1 below for permanent ADR record because the v3 doc is research, not contract.

## Decision

### 1. Target: AZW3 (KF8) only — NOT legacy MOBI 6

Spine ships `spine-fmt-mobi` as an **AZW3 writer**, not a MOBI 6 writer. The ADR formalizes the v3 §4.2 reframe:

- **AZW3 / KF8** is critical-path for the W3 send-to-device workflow for **~60-70% of users** (40-50% own a pre-2022 Kindle that cannot side-load EPUB; another 20-30% occasionally need AZW3 for household lending across mixed-firmware device generations). E-paper hardware lasts 10+ years; Spine serves the installed base, not just new Kindle buyers.
- **MOBI 6 (legacy PalmDOC)** is **read-only museum**. The pre-2010 K1/K2/K3 fleet is mostly dead; users with that hardware get a third-party plugin path or the calibre fallback. Spine's writer does not produce MOBI 6 records, period.
- The "Amazon now accepts EPUB" trend matters for new author-side uploads, not for the millions of working pre-2022 Kindles users own. AZW3 is **default-listed output**, not an opt-in flag.

The `--mobi-file-type` knob (calibre's "old, new, both") is **NOT** exposed by Spine; Spine writes KF8 records only. A user's "old Kindle that needs MOBI 6" path is `cargo install spine-fmt-mobi6-legacy-plugin` (community plugin slot per ADR 023), not a flag on the first-party writer.

### 2. Compression: PalmDOC-RLE only first port

The MOBI/AZW3 record stream supports three compression schemes (calibre `mobi/writer8/main.py` line 117-122):

- **PalmDOC-RLE** (LZ77-style) — universal, all firmware versions.
- **HUFF/CDIC** (Mobipocket's Huffman variant) — supported only on a subset of devices; calibre defaults to PalmDOC-RLE per the same module.
- **None** (uncompressed) — debugging only.

Spine implements **PalmDOC-RLE only** in Sprint 16. HUFF/CDIC is **out of scope** — its byte-identical reproduction would require porting calibre's `mobi/utils.py:huff_cdic_encode` plus its dictionary-construction passes, none of which produces meaningful user-visible benefit on modern firmwares (file size delta is <5% on representative fixtures per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md §A.7`). A future ADR may revisit if data shows otherwise.

The PalmDOC-RLE port crate is `palmdoc-compression = "0.1"` per v2 §A.2. License-audited MIT (see v2 §C ecosystem survey).

### 3. Byte-identical bar against calibre's `ebook-convert`

The acceptance test for Spine's AZW3 writer is byte-identical match to calibre 7.x's `ebook-convert` for a fixed input set:

```bash
SOURCE_DATE_EPOCH=0 LC_ALL=C TZ=UTC \
ebook-convert input.epub output.mobi \
  --no-default-epub-cover \
  --disable-heuristics \
  --output-profile=kindle_pw3 \
  --mobi-file-type=both
```

Determinism contract per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3` (no wall-clock reads, no random UUID minting, sorted-iteration over every map per `OebBook::Manifest::iter_sorted` / BYTE_IDENTICAL §3.4 I6 — the canonical sort landed at `fed975b`).

The Sprint 16 fixture set lives under `spine-conversion-corpus/fixtures/` per v2 §A.1. Reference outputs live under `spine-conversion-corpus/refs/` (calibre-deterministic-patched). Failure surface: structured `mobi_dump::dump` field-level diff per v2 §A.10.

**Note on `--mobi-file-type=both`**: Spine writes KF8 records only (per §1). The calibre invocation above produces a dual-format file (MOBI 6 + KF8 behind a BOUNDARY pseudo-record); Spine's byte-identical bar applies to the **KF8 portion** only, with the MOBI 6 portion's absence documented as the deliberate v3 §4.2 reframe. The canonical fixture set's reference outputs are regenerated with `--mobi-file-type=new` (KF8-only) for the byte-identical test; the dual-format reference exists separately for diff-investigation use only.

### 4. BIBFRAME canonical-form storage — the librarian-judgement call

This is the question the architecture review put to the librarian-judgement call explicitly. The answer:

**The canonical BIBFRAME graph DOES NOT live in the AZW3 file or in EXTH headers. It lives in `spine.db` (user-library truth) and optionally travels as a sidecar `.spine-bf.ttl` for graph-preserving Spine-to-Spine transfer.**

Three reasons:

#### 4.1 EXTH is structurally wrong for RDF graphs

EXTH is a flat keyed-map (`HashMap<u32, Vec<u8>>`) per calibre `mobi/writer8/exth.py`. BIBFRAME is a graph of typed nodes with class membership, reified statements, named-graph segregation, and provenance triples (`spine:uriSource`, `bf:AdminMetadata`, `spine:reconciledAt`). Embedding the graph as base64+gzip JSON-LD into a custom EXTH key:

- Loses the structural advantage that makes Spine BIBFRAME-native (`spine.db` SPARQL queries, SHACL gates, `owl:sameAs` promotion mechanics) — none of which work on an opaque blob.
- Breaks on round-trip through any third-party tool that strips unknown EXTH (calibre, Kindle's own pipeline). **Spine can only guarantee survival of EXTH keys that calibre and Amazon's pipeline both preserve** — which is the rigid keyed-map subset.
- May exceed the maximum EXTH value length some Kindle firmwares accept (anecdotal reports of corruption above ~64KB; not formally documented but observed by calibre's reverse engineering). A typical Spine BIBFRAME graph for a single Item is 4-15KB compressed, near the warning band.

#### 4.2 EPUB 3.3 has `META-INF/`; AZW3 has nothing equivalent

PLAN.md §385 mandates `META-INF/spine-bibframe.ttl` as the canonical-form layer for EPUB 3.3 because the OCF zip directory has a reserved area (META-INF/) where reading systems are spec-bound to ignore unknown entries. AZW3 has no such reserved area: the PalmDB record-stream layout has no "ignored bytes" surface, and the EXTH keyed-map is fully consumed by Kindle's reader pipeline (unknown keys MAY be preserved on round-trip but are not contractually required to be).

The structural difference is the format's fault, not Spine's. The right response is to ship the canonical graph **outside the file** when graph-preservation matters.

#### 4.3 Sidecar `.spine-bf.ttl` is opt-in and explicit

Spine's default AZW3 export path:

1. Writes the AZW3 with rigid EXTH projection (see §4.4).
2. **Does not** write a sidecar `.spine-bf.ttl`. Pure projection mode.

When the user opts into "preserve canonical graph" on export (Settings checkbox or `--include-bibframe-graph` CLI flag):

3. Additionally writes `<basename>.spine-bf.ttl` adjacent to the AZW3, identical content to what would land in `META-INF/spine-bibframe.ttl` for an EPUB export of the same Item.
4. Includes the `spine-loc-cache.ttl` companion (per PLAN.md §387) as `<basename>.spine-loc-cache.ttl` so an offline Spine instance receiving the pair can render labels and types without dereferencing.

Three opt-in semantics:

- **Opt-in is per-export**, not per-Item: the same Item exported twice (once for Kindle device, once for Spine-to-Spine transfer) gets the AZW3 only the first time and the AZW3+sidecar pair the second time.
- **Sidecar separation risk** is the user's choice: explicitly opting into "preserve graph" means Spine tells the user "ship these two files together"; if the user emails only the AZW3 and the recipient sideloads it to Kindle, that's the same outcome as not having the sidecar at all (rigid EXTH projection survives).
- **Reimport priority** for an AZW3 + sidecar pair landing in another Spine instance: sidecar takes priority over EXTH (matches the EPUB Layer 1 / Layer 2 reimport priority in PLAN.md §444). If sidecar is absent, EXTH projection runs through the standard ingest reconciliation pipeline (id.loc.gov etc.).

#### 4.4 Rigid EXTH projection — what survives

Per PLAN.md §454 + calibre `mobi/writer8/exth.py:107-122`, the EXTH fields Spine populates on every AZW3 export:

| EXTH type | Field | Source predicate (BIBFRAME) | Notes |
|---|---|---|---|
| 100 | Author | `bf:contribution → bf:Person → rdfs:label` | First creator, OPF `dc:creator` literal form |
| 101 | Publisher | `bf:provisionActivity → bf:Publisher → rdfs:label` | Literal; reconciliation drops on projection |
| 103 | Description | `bf:summary` or `dc:description` | First description if multiple |
| 104 | ISBN | `bf:identifiedBy [a bf:Isbn]` | Single literal, hyphens stripped |
| 105 | Subject | `bf:subject → rdfs:label` | First subject literal; LoC URI dropped |
| 106 | Publication date | `bf:provisionActivity → bf:date` | EDTF Level 1 → ISO 8601 simplification (lossy: `1924?` → `1924`) |
| 108 | Source | Spine generator-string per v2 §A.6.2 | `"spine:0.x.y"` — NOT calibre-derived |
| 112 | Source URI | `spine:itemSourceUri` | Optional; opaque to Kindle |
| 113 | ASIN | `bf:identifiedBy [a bf:OclcNumber]` or empty | Spine does not mint ASINs; field empty unless Item has authoritative ASIN |
| 503 | Title | `bf:title` (main title only) | Single literal |
| 524 | Language | `dc:language` | Single BCP-47 tag |

**Lossy projections**:

- Multi-creator → first creator only (one EXTH 100 slot).
- Multi-subject → first subject only.
- EDTF qualifiers (`?`, `~`, `%`, intervals) → stripped to plain ISO 8601.
- Authority URIs → all dropped (EXTH carries literals only).
- Series/series-position → not in core EXTH; stored in custom EXTH 503 sub-fields by Mobipocket convention; Spine writes them per calibre's pattern but documents that round-trip survival is firmware-dependent.
- LoC reconcile provenance, asserted/inferred-graph segregation, SHACL admin metadata — all absent. These travel via the sidecar (§4.3) or stay in `spine.db`.

**The rigid EXTH projection is enough for Kindle and for the W3 send-to-device workflow.** It is not enough for Spine-to-Spine portability. That gap is what the opt-in sidecar covers.

### 5. Plugin-extensibility hook per ADR 023

Per ADR 023's `FormatOutputPlugin` slot (locked in amendment-1 `bf6b8be`), `spine-fmt-mobi` exposes the following:

- The crate's public surface includes the rigid EXTH projection table (§4.4) as `spine_fmt_mobi::exth::PROJECTION_TABLE: &[ExthProjection]`. Plugin authors implementing a MOBI 6 legacy writer or a KFX writer reuse the same projection logic; the table is data, not buried in private functions.
- The byte-identical fixture set (§3) is exposed as `spine-conversion-corpus`'s public test API, so plugin authors can run the same byte-identical bar against their own writer.
- The `Manifest::iter_sorted` invariant (per `fed975b`) is the documented expectation for plugin writers; plugins that don't honour it get non-deterministic output per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3.4 I6`.
- Sidecar `.spine-bf.ttl` writing logic lives in a shared `spine-bibframe-export` crate (Sprint 16 spinoff), so plugin authors implementing other lossy formats (FB2, LIT, etc.) get sidecar opt-in for free.

The first community plugin in this slot will likely be `spine-fmt-mobi6-legacy` for the K1/K2/K3 fleet (per §1's "user truly needs MOBI 6" path). Spine does not ship it; the ADR documents the contract a plugin author would target.

## Rejected alternatives

1. **Embed canonical BIBFRAME graph in a custom EXTH key with compressed JSON-LD.** Rejected per §4.1 — round-trip fragility through Kindle/calibre, EXTH size limits, structural mismatch with RDF graph shape.
2. **Mandatory sidecar (always write `.spine-bf.ttl` alongside).** Rejected — adds unexpected file-pair shipping burden for the W3 send-to-device case where the user just wants a Kindle-readable file. Opt-in is friendlier.
3. **Spine writes MOBI 6 records as default.** Rejected per §1 — pre-2010 device fleet too small to justify the byte-identical port surface.
4. **Spine writes both KF8 + MOBI 6 records (calibre `--mobi-file-type=both`).** Rejected per §1 — user-facing decision is "what device does this Item ship to" (KF8 covers all post-2010 firmwares); the dual-format compatibility blob is calibre's defensive default for users who don't know their device generation. Spine's UX surfaces device-generation explicitly via export profile and writes the right format.
5. **Implement HUFF/CDIC compression.** Rejected per §2 — port surface large, user-visible benefit minimal.

## Open questions

- **Series-index round-trip survival.** Mobipocket's series-index convention (EXTH 503 sub-fields) is firmware-dependent. Sprint 16 implementation should test against current Kindle Paperwhite + Oasis firmwares; document survival empirically rather than spec-from-calibre. Not a blocker for the ADR; flag for the implementer.
- **Sidecar discovery on Kindle device sideload.** A user who sideloads `book.azw3 + book.spine-bf.ttl` to a Kindle will find the device shows only the AZW3 (as expected); the .ttl is dead weight in the device's filesystem. Whether to suppress the sidecar on the "send-to-device" export profile vs. always include it on opt-in is a UX call for Sprint 16+ — recommend suppress on send-to-device, include on Spine-to-Spine.

## References

- `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md` §3 (determinism contract)
- `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md` §A (EPUB→MOBI worked example with annotated PalmDB header + EXTH emission)
- `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md` §4.1–§4.2 (AZW3 first-class reframe + installed-base data)
- `PLAN.md` §385 (EPUB 3.3 canonical-form layering — the EPUB sibling to this AZW3 ADR)
- `PLAN.md` §454 (projection-table to lossy formats)
- `CLAUDE.md` ("Older formats (EPUB 2, MOBI) get lossy projections" + "Don't let the EPUB 3.3 export write canonical BIBFRAME only to OPF `<meta>`")
- `docs/ADR_023_plugin_architecture.md` (FormatOutputPlugin slot + amendment-1 MetadataImporter slot)
- `core/spine-oeb/src/oeb.rs` `Manifest::iter_sorted` (`fed975b`) — determinism invariant for byte-identical writers
- calibre `mobi/writer8/exth.py:107-122` (EXTH type-code mapping reference)
- calibre `mobi/writer8/main.py:117-122` (compression-scheme defaults reference)
