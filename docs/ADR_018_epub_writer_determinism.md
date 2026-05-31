# ADR 018: EPUB Writer Determinism — ZIP / OPF / Serialization Contract

## Status
Draft (2026-04-25, Sprint 15 prep — locks the byte-stability contract before code lands.)

## Context

ADR 017 locked the IR — `OebBook` is the canonical intermediate representation, `Manifest::iter_sorted` is the determinism invariant on its iteration path. ADR 018 is the parallel lock for the *output* path: a writer that walks an `OebBook` deterministically can still produce non-deterministic ZIPs if it inherits the host filesystem's mtimes, the standard library's hash-randomized iteration order, or ad-hoc XML serializer behavior. ADR 017 closes the IR side; ADR 018 closes the writer side.

Sprint 15's `spine-fmt-epub::write_epub` is the first target. Sprint 16's AZW3 writer (locked separately by ADR 019) and any future plugin `OutputFormat::write` implementation reuse the patterns this ADR locks. The EPUB-specific concerns (mimetype-first STORED entry, OPF XML stability) are EPUB-shaped, but the underlying determinism patterns (epoch-locked timestamps, sorted iteration, no-`HashMap` rule) generalize across writers — every future ADR that locks a writer scope MAY reference back here for those primitives.

`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3` is the authoritative non-determinism inventory; ADR 018 ratifies the writer-side remediations from rows T2, I1-I7, and the EPUB-specific quirks in §3.7 rows 3, 5-7, 12-14. This ADR doesn't relitigate the table — it points at it.

## Decision

### 1. ZIP entry order

EPUB ZIP entries are written in this exact order:

1. **`mimetype`** — first entry, always. STORED method (compression-method = 0, no deflation). No extra fields, no padding. The 30-byte local file header carries `version-needed-to-extract = 10`, `general-purpose-bit-flag = 0`. The literal bytes `application/epub+zip` (20 bytes) are the entry's payload. Per EPUB 3.3 §C "OCF Abstract Container §2.1.5 (Container ZIP)" and `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1 §3.7 row 3` — calibre `epub_output.py:402-414` matches this discipline; Spine reproduces it exactly.

2. **`META-INF/` entries**, sorted lexicographically by entry name. Always at minimum `META-INF/container.xml`. May include `META-INF/encryption.xml`, `META-INF/manifest.xml`, `META-INF/signatures.xml` — each entry's order is its byte-sorted name within the `META-INF/` prefix.

3. **OPF directory** — typically `OEBPS/` (calibre default) but can be any single segment per OCF spec. Single OPF (`content.opf`, `package.opf`, etc.) at the root of this dir. Per EPUB 3.3 §C, the OPF location is registered in `META-INF/container.xml/<rootfiles>/<rootfile full-path=…/>`. Spine writes ONE rootfile element per output (multi-rendition is out of Sprint 15 scope; ADR 017 §3 deferral lands here).

4. **Content entries**, sorted by `Manifest::iter_sorted` (per ADR 017 §2, key = `(spine_position, media_type, href, id)`). Spine items first (lowest `spine_position` first), then non-spine items collated by `(media_type, href, id)`. The writer MUST iterate via `Manifest::iter_sorted()`; a writer that walks `manifest.items: Vec` directly violates the determinism contract and is a defect.

### 2. Timestamp policy

Every ZIP entry's `last-mod-file-time` and `last-mod-file-date` fields encode **`1980-01-01 00:00:00 UTC`** (the ZIP-format minimum representable mtime — DOS time 0x0000, DOS date 0x0021). Per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1 §3.1 T2`.

`SOURCE_DATE_EPOCH` environment variable, if set, overrides the default. The override timestamp is converted to local-time-tuple `(year, month, day, hour, minute, second)` per ZIP convention — note ZIP's `last-mod-file-time/date` fields are UNDEFINED-TIMEZONE per APPNOTE.TXT §4.4.6, so Spine writes them as-if-UTC. The override pathway exists for reproducible-build pipelines that want a project-source-revision-derived stamp.

**No other timestamp source enters the writer.** Spine MUST NOT call `std::time::SystemTime::now()`, `chrono::Utc::now()`, `time::OffsetDateTime::now_utc()`, or any equivalent in the write path. This is a code-review-audit invariant, not a runtime check (a runtime check is paradoxical — we'd need a clock to measure clock use).

### 3. `mimetype` entry — uncompressed, no padding

The OCF spec (EPUB 3.3 §C.4 "OCF ZIP Container") requires `mimetype` to be the first entry, STORED, without extra fields, with no encryption, with no `general-purpose-bit-flag` bits set. Many EPUB writers in the wild violate one or more of these (Adobe DE writes `mimetype` STORED but includes a Unicode-path extra field; some Sigil older versions deflate `mimetype`). Spine must match calibre's strict OCF compliance:

- Compression method = 0 (STORED).
- General-purpose bit flag = 0x0000 (no UTF-8 name flag, no encryption, no streaming).
- Extra-field length = 0 (zero bytes after the local file header's fixed-length section).
- Filename = literal `mimetype` (8 bytes, ASCII).
- Filename length = 8.
- CRC-32 = 0x4d7a35a8 (CRC-32 of the literal `application/epub+zip` payload).
- Uncompressed size = 20.
- Compressed size = 20 (STORED; no deflation).
- Local file header total = 30 bytes + 8 (filename) = 38 bytes.

The central directory entry for `mimetype` mirrors these fields with the same zero-extra-field discipline.

### 4. OPF byte stability

The OPF `<package>` document is written via Spine's deterministic XML serializer with these rules:

- **Element attribute order** is sorted lexicographically by attribute local-name. Calibre relies on lxml's `etree.tostring()` which preserves insertion order (`oeb/base.py:404-416` per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1 §3.7 row 12`); Spine's writer MUST sort attributes instead. This is a *deviation* from calibre's exact byte output for OPFs whose internal attribute order is unstable — Spine's choice trades one specific byte-pattern divergence (attribute-shuffled OPFs that were already non-canonical in calibre) for fully cross-input-stable Spine output. Documented as a known A-tier delta against calibre baselines that have non-sorted attributes; the corpus tests calibrate against Spine-canonical, not calibre-byte.
- **Element child order** follows OPF 3.3 §3.4 element ordering rules (metadata → manifest → spine → guide for OPF 2 compat; bindings deferred). Within `<manifest>`, items are emitted in `Manifest::iter_sorted` order (§1 #4).
- **Whitespace** is fixed: 2-space indent, LF line endings (no CRLF), no trailing whitespace, single LF at file end. No XML pretty-print "smart" wrapping.
- **Self-closing tag form** per EPUB 3.3 §1.2.1 (XML 1.0 §3.1) — Spine emits empty elements as `<elem ... />` with a space before `/>`. Calibre's `close_self_closing_tags()` (`oeb/base.py:440`) converts `<tag/>` to `<tag></tag>` for XHTML; that affects content documents only, NOT the OPF. Spine matches calibre's choice: OPF empty elements are `/>`-shaped; XHTML empty elements are `<tag></tag>`-shaped (per row 12).
- **Entity escaping** uses named form (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) not numeric (`&#38;`). Per row 12.
- **CDATA escaping** for embedded `<style>` / `<script>` content matches calibre's `]]>`-replacement rule (`oeb/base.py:423-427` per row 13).

The XML serializer lives in `core/spine-oeb-xml/` (new crate, Sprint 15) so future writers (NCX, nav.xhtml, container.xml, encryption.xml, OPF) share one canonical implementation. Calibre's `OPFCreator` (`oeb/base.py::OPFCreator`) is the reference; Spine's `core/spine-oeb-xml::OpfBuilder` matches its observable output where calibre is itself canonical (i.e. with attributes already sorted at calibre's input).

### 5. Tie-back to ADR 017 invariants

Two invariants from ADR 017 carry into ADR 018 unchanged:

- **`Manifest::iter_sorted` is the iteration path** for ZIP content entries (§1 #4). A writer that walks `OebBook.manifest.items: Vec` directly is broken; the lint, when added, fires at the writer's iteration callsite.
- **`BTreeMap`-not-`HashMap`** for any map-shaped state in the writer's intermediate buffers. The OPF's `<metadata>` block has multiple `dc:*` and `<meta>` elements; the writer collects them in a `BTreeMap<PredicateIri, Vec<MetadataValue>>` (or similar) and emits in sorted-key order. Per ADR 017 §2 #3 (extended to writer-side state, not just the IR itself).

### 6. Plugin extensibility — `OutputFormat` trait shape

The `OutputFormat` trait from ADR 023 §2:

```rust
pub trait OutputFormat: Send + Sync {
    fn name(&self) -> &str;
    fn extensions(&self) -> &[&str];
    fn write(&self, oeb: &OebBook, w: &mut dyn Write, opts: &WriteOpts) -> Result<(), WriteError>;
}
```

Spine's first-party `spine-fmt-epub::write_epub` matches this shape. `WriteOpts` is the opt-bag where `SOURCE_DATE_EPOCH`-equivalent overrides surface (`build_time: Option<UnixTimestamp>`, `compression_level: u8`, etc.). Plugins implementing `OutputFormat` for niche formats (FB2, OEB 1.x, plugin-shipped MOBI 6 readers) consume the same `&OebBook` first-party readers produce — no plugin-side IR transformation, no plugin-only options surface.

**Two non-negotiable plugin-author rules** (mirroring ADR 017 §4):

1. **No private writer state** that callers can't construct. The `WriteOpts` struct is `pub`-fields-end-to-end; plugins build options the same way first-party `write_epub` callers do.
2. **Plugins MUST NOT call wall-clock APIs.** `WriteOpts::build_time` is the only timestamp surface; if a plugin needs a "now" stamp, the caller threads it through `WriteOpts`. The plugin loader (Sprint 17+) verifies this via tracing-span audit — a plugin that calls `SystemTime::now()` directly emits a span attribute that surfaces in dev-build logs. Belt-and-suspenders for the compile-time discipline.

### 7. Out-of-scope items explicitly named

(So nobody re-asks them.)

- **`Container` IR / `PolishOp` mechanics** — same-format edits (calibre's "polish" path: cover update, metadata refresh, manifest prune-without-conversion). These don't lift to `OebBook`; they edit the ZIP container directly. Locked by a future ADR (provisionally ADR 020). ADR 018 is the *cross-family-conversion writer* lock; same-format polish is a different code path.
- **Transforms tree** (style flatten / font embed / cover rationalize / image re-encode). These are mutators that take `&mut OebBook` and produce a new `OebBook` that the writer then serializes. Their structure, ordering, and dependency-graph live in a future ADR. ADR 018 stops at the writer's input boundary — what comes IN to `write_epub` is already-transformed.
- **NCX / nav.xhtml byte stability**. The OPF discipline in §4 generalizes to these formats, but their per-element rules (NCX `playOrder` numbering, nav.xhtml `<ol><li><a>` nesting) are EPUB-format-detail. The Sprint 15 implementer adheres to the same XML serializer discipline; if format-specific quirks emerge, they amend this ADR.
- **Encryption / signature support**. EPUB 3.3 §6 permits `META-INF/encryption.xml` and `META-INF/signatures.xml`; Spine writes neither at Sprint 15. If/when added, they slot into §1 step 2 byte-sorted alongside `container.xml`.
- **MOBI / AZW3 writer determinism**. Locked separately by ADR 019 (AZW3 writer scope). ADR 018 is EPUB-specific.

## Rejected Alternatives

**Alt A — Use the host filesystem's mtimes for ZIP entry timestamps.** Trivially non-deterministic; produces different bytes on different machines / different times. Rejected at first principles.

**Alt B — Use the input file's mtimes (passed through from the source EPUB).** Considered for "round-trip preserves the original timestamps" intuition. Rejected because (a) the input may not be a ZIP (HTML → EPUB conversions have no inherited mtimes), (b) the contract is *byte-identical from same input + same options*, not *preserves-source-timestamps*; if the user wants timestamp preservation that's a future opt-in `WriteOpts::preserve_input_mtimes: bool` flag, not the default. The 1980-01-01 default keeps the contract honest.

**Alt C — Pretty-print the OPF for human-readability with `xmllint --format`-style output.** Considered for debug builds. Rejected: even pretty-printed XML is byte-deterministic *if* the pretty-printer is deterministic; the win is small, and shipping two writer paths (compact + pretty) doubles the test-corpus surface. Single-canonical-form per output. Pretty-printing is a separate concern (a `xmllint` or `xmlstarlet` post-process for inspection), not a writer mode.

**Alt D — Sort element-child order (not just attribute order) in OPF.** Considered for "go further than calibre". Rejected because OPF §3.4 mandates a specific child-element order (`metadata → manifest → spine → guide`); sorting all children would violate the spec. Within each child block, the writer's per-block emission order (manifest items via `iter_sorted`, metadata items via `BTreeMap` sort) handles the canonical-order requirement at the right granularity.

**Alt E — Skip the `mimetype`-first discipline; let the ZIP library default to whatever order it chooses.** Many ZIP libraries (`zip-rs` included) write entries in `Vec`-insertion order, so technically Spine could just `.add("mimetype")` first and trust it. Rejected because the OCF compliance is also "STORED with zero extra fields" — most ZIP libraries default to DEFLATE for any entry larger than a few bytes, and most write a Unicode-path extra field. Spine's `core/spine-oeb-zip` (or vendored / forked `zip-rs`) carries the explicit STORED + zero-extra-field discipline; relying on library defaults is the trap calibre's `epub_output.py:402-414` documents the workaround for.

## Cross-references

- **ADR 017 §1, §2** — IR shape + `Manifest::iter_sorted` invariant. Writer side of ADR 018 carries the iteration discipline through.
- **ADR 017 §4** — plugin IR symmetry. ADR 018 §6 carries the symmetry through to `OutputFormat::write`.
- **ADR 019** — AZW3 writer scope (sibling to this ADR, EPUB-side; AZW3 has its own ZIP-shape-irrelevant determinism rules locked there).
- **ADR 023 §2** — `OutputFormat` trait declaration. ADR 018 ratifies the contract Sprint 17+ plugin loader will lookup against.
- **`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3.1 T2`** — ZIP timestamp remediation (1980-01-01).
- **`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3.7 rows 3, 5-7, 12-14`** — EPUB-specific calibre quirks the writer must reproduce (mimetype STORED, Nook/Pocketbook cover bug workarounds, NCX whitespace, HTML serialization rules, CDATA escaping).
- **`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §6`** — deterministic-mode specification; ADR 018 implements the EPUB writer side of §6.2 #1, #11.
- **EPUB 3.3 §C** — OCF Abstract Container; the spec ADR 018 §1 #1 + §3 enforce.
- **`core/spine-fmt-epub/src/lib.rs::write_epub`** (Sprint 15) — the producer this ADR contracts.
- **`core/spine-oeb-xml/`** (Sprint 15) — the deterministic XML serializer §4 mandates.

## Revision history

- 2026-04-25 — Initial draft (Sprint 15 prep). Locks ZIP entry order (mimetype-first STORED + META-INF + OPF dir + content via `iter_sorted`), 1980-01-01 timestamp default with `SOURCE_DATE_EPOCH` override, OPF XML serializer rules (sorted attributes, LF endings, named entities), ADR 017 invariants carrying into writer-side state, `OutputFormat` trait surface from ADR 023. Status: Draft.
