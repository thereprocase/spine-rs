# Byte-Identical Conversion Protocol — Spine vs. calibre

**Status:** Research report v1 — foundational determinism analysis, 2026-04-25
**Companion docs:** [v2](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md) (Rust implementation deep-dive — EPUB→MOBI worked example, XHTML-bridge analysis, Rust crate ecosystem survey, plus seven additional architectural sections), [v3](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md) (2026 workflow atlas with deprecated-format kill list).
**Authors:** Synthesized from four parallel investigations of the calibre source tree (read-only) cross-checked against [calibre's official conversion docs](https://manual.calibre-ebook.com/conversion.html).
**Reference calibre tree:** a read-only calibre source checkout — line numbers below refer to this clone.
**Audience:** Future Spine implementers planning the `spine-fmt-*` crates and the conversion-test harness.

---

## 0. TL;DR

A naive promise of "Spine produces a byte-identical output Item to calibre for the same input Item" is **not achievable**. Calibre's conversion pipeline embeds three classes of non-determinism by design (BIBFRAME-tagged here — see [Appendix: BIBFRAME Vocabulary](#appendix--bibframe-vocabulary-used-in-this-report) at the end of this document):

1. **Wall-clock time** baked into MOBI PalmDB headers (Item-level), ZIP entry mtimes (Item-level), and DOCX core-properties XML (Item-level). All three identify *when this particular file was manufactured*, not the Work or Instance.
2. **Random/UUID minting** for MOBI UID (Item-level Whispersync key), EXTH 113 ASIN (**Instance-level** — Amazon's identifier for the published edition), EXTH 112 SOURCE (Item-level provenance pointing back to an Instance/Work URI), EPUB `dc:identifier` used for font-obfuscation keys (**Instance-level** per EPUB spec), and OPF/NCX `id` element attributes (Item-internal XML cross-reference handles only).
3. **Environment-dependent values** — OS detection in EXTH `generator-version` (Item provenance), system font discovery (Item resource embedding), Qt-rasterized PDF output (Item manufacturing), external `pdftohtml` binary version (**Instance-derived** — the binary's text-extraction quality determines what the synthesized Instance contains), ImageMagick for comics (**Instance-derived** — image normalization changes content, not just packaging).

A *useful* contract is, restated in BIBFRAME-precise terms:

> **Spine MUST produce an output Item that is byte-identical to calibre's output Item when both are run in a frozen "deterministic mode" with a fixed clock, fixed RNG seed, fixed dependency versions, fixed environment, and an input Item that already carries the Instance-level identifiers (`dc:identifier`/ASIN/etc.) calibre would otherwise mint.**

The contract is therefore an **Item-to-Item determinism guarantee**, layered over a **graph-stable Instance preservation** for non-lossy routes (Classes 1-3), layered over an **always-stable Work identity** preserved by Spine's BIBFRAME graph carry-through.

This document specifies exactly what "deterministic mode" must freeze, where every non-determinism source lives in calibre's source tree, what dependencies must be version-pinned, what byte-identicality is impossible *even under the lock* (PDF output, JPEG re-encoding), and the verification protocol that proves the claim on each Spine release.

---

## 1. Calibre's Documented Pipeline (Authoritative)

From the [official conversion docs](https://manual.calibre-ebook.com/conversion.html), the pipeline is a four-stage process:

> "The input format is first converted to XHTML by the appropriate Input plugin. This HTML is then transformed. In the last step, the processed XHTML is converted to the specified output format by the appropriate Output plugin."

The debug-pipeline feature exposes four intermediate folders, which double as the canonical synchronization points for any "did Spine match calibre at this stage?" diff:

| Stage | Folder | What it contains |
|---|---|---|
| 1 | `input/` | Raw HTML emitted by the Input plugin (post-decompression, pre-cleanup) |
| 2 | `parsed/` | Post-preprocessing XHTML (encoding normalized, entities decoded, `html5-parser` repaired) |
| 3 | `structure/` | Post structure-detection (chapters identified, TOC built, page breaks inserted) — pre-CSS-flatten |
| 4 | `processed/` | Final OEB tree before Output plugin emits bytes |

The docs explicitly state: *"all the transforms act on the XHTML output by the Input plugin, not on the input file itself."* This means the byte-identical contract decomposes naturally:

- **Stage 1 reproducibility** ≡ same input bytes → same `input/` folder ⇒ Spine's `spine-fmt-*` Input plugins must match.
- **Stage 2-4 reproducibility** ≡ same `input/` → same `processed/` ⇒ Spine's transform stack and OEB model must match.
- **Stage final reproducibility** ≡ same `processed/` → same output bytes ⇒ Spine's Output plugins must match.

Calibre's docs make **no claims about reproducibility or determinism**. There is no `--deterministic` flag, no `SOURCE_DATE_EPOCH` honoring, no CI for byte-identical output. Spine is therefore choosing to honor a contract calibre never advertised. This is fine — and arguably the right move for a 30-year data store — but it means we are *not* matching a guarantee, we are reverse-engineering one.

---

## 2. The Plumber Pipeline at Source-Code Level

Calibre's `Plumber.run()` (in `src/calibre/ebooks/conversion/plumber.py`) executes a fixed sequence of transforms between the Input and Output plugin calls. Spine's `spine-oeb` crate must execute the exact same sequence, in the exact same order, with the exact same conditional branches. The sequence (consolidated from Agent A's reading of `plumber.py:1087-1265`):

| # | Step | File | Conditional? |
|---|---|---|---|
| 1 | Input plugin `convert()` produces `OEBBook` | `plumber.py:1087` | always |
| 2 | Input plugin `postprocess_book(oeb, opts)` | `plumber.py:1103` | always |
| 3 | Input plugin `specialize(oeb, opts)` | `plumber.py:1111` | always |
| 4 | `transform_conversion_book()` (HTML rules) | `plumber.py:1118-1123` | only if `opts.transform_html_rules` |
| 5 | `DataURL()` — extract `data:` URLs to manifest | `plumber.py:1126` | always |
| 6 | `Clean()` — guide cleanup | `plumber.py:1128` | always |
| 7 | `RemoveFirstImage()` | `plumber.py:1136` | only if option set |
| 8 | `MergeMetadata()` — user metadata wins | `plumber.py:1138` | always |
| 9 | `DetectStructure()` — chapter/TOC detect | `plumber.py:1144` | always |
| 10 | Remove TOC reference to cover | `plumber.py:1148-1153` | only if output ∉ {epub, kepub} |
| 11 | `Jacket()` — synth metadata page | `plumber.py:1170` | only if `insert_metadata` |
| 12 | `AddAltText()` | `plumber.py:1176` | only if `add_alt_text_to_img` |
| 13 | `LinearizeTables()` | `plumber.py:1201` | only if option ∧ output ∉ {mobi, lrf} |
| 14 | `UnsmartenPunctuation()` | `plumber.py:1205` | only if option |
| 15 | `CSSFlattener()` | `plumber.py:1224` | always — params depend on output (lines 1207-1223) |
| 16 | `RemoveFakeMargins()` | `plumber.py:1231` | always |
| 17 | `RemoveAdobeMargins()` | `plumber.py:1232` | always |
| 18 | `EmbedFonts()` | `plumber.py:1236` | only if `embed_all_fonts` |
| 19 | `SubsetFonts()` | `plumber.py:1240` | only if `subset_embedded_fonts` ∧ output ≠ pdf |
| 20 | `ManifestTrimmer()` | `plumber.py:1249` | always |
| 21 | `oeb.toc.rationalize_play_orders()` | `plumber.py:1251` | always |
| 22 | Output plugin `convert()` | `plumber.py:1265` | always |
| 23 | Post-process plugin hooks | `plumber.py:1269` | only if registered |

**`CSSFlattener` parameters depend on output format** (`plumber.py:1207-1223`):
- `untable = True` if output ∈ {lit, mobi (mobi6 only)}
- `unfloat = True` if output ∈ {lit, mobi (mobi6 only)}
- `page_break_on_body = True` if output ∈ {mobi, lit}

For LRF output, `insert_blank_line` and `remove_paragraph_spacing` are temporarily disabled around the CSS flatten (`plumber.py:1189-1228`) — Spine must reproduce this temporal toggling exactly.

**Defaults are part of the contract.** Calibre's CLI (`src/calibre/ebooks/conversion/cli.py`) sets defaults that are not commonly overridden — `smarten_punctuation=False`, `enable_heuristics=False`, `unsmarten_punctuation=False`, etc. Spine's `spine convert` must default-match these byte-for-byte even when running in deterministic mode, otherwise outputs diverge silently.

---

## 3. Non-Determinism Inventory (Authoritative)

This is the heart of the report. Every entry below was located by an agent reading the calibre source. File:line references are exact. The "Spine remediation" column is the concrete contract Spine's code must enforce in deterministic mode.

### 3.1 Wall-clock time

| # | Source | File:Line | Affects | Spine remediation |
|---|---|---|---|---|
| T1 | `int(time.time())` → PalmDB created/modified | `mobi/writer2/main.py:464` | MOBI 6, AZW3 (header offsets 0x4-0x7, 0x8-0xB) | Accept `--build-time <unix-ts>` (default: 0); use that exact value in PalmDB header; never call wall-clock |
| T2 | `time.localtime(time.time())[:6]` → ZIP entry mtime | `utils/zipfile.py:1369` | EPUB, DOCX, HTMLZ, TXTZ, every ZIP-shaped output | All ZIP entries must use a fixed `(year, month, day, hour, min, sec)` tuple. Default to `(1980, 1, 1, 0, 0, 0)` (the ZIP-format minimum representable mtime). Honor `SOURCE_DATE_EPOCH` env var as override. |
| T3 | `utcnow().isoformat('T').rpartition('.')[0]+'Z'` → DOCX `<dcterms:created>`, `<dcterms:modified>` | `docx/writer/container.py:245` | DOCX `docProps/core.xml` | Same fixed timestamp as T1; format as ISO 8601 with `Z` suffix, no fractional seconds |
| T4 | `datetime.now()` for FB2 `<date>` field | `fb2/fb2ml.py:118` (.day, .month, .year) | FB2 output Item | Use the Instance `pubdate` (Instance-level metadata) if present; else fixed epoch |

**Cross-check note:** Agent D claimed "0 hits" for `time.time()` in the ebooks module. Agent C contradicted this with the explicit `mobi/writer2/main.py:464` finding. Agent C's finding is correct — Agent D's grep was scoped too narrowly (likely `ebooks/oeb/` only). The PalmDB timestamp is a critical byte-identical concern and is canonically documented here.

### 3.2 UUID minting

| # | Source | File:Line | Affects | Spine remediation |
|---|---|---|---|---|
| U1 | `uuid_id()` = `'u' + uuid4()` | `oeb/base.py:165-166` | OPF/NCX element IDs whenever an item has no explicit ID; called from base.py:1633 (TOC), base.py:1739 (PageList), structure.py:124 (start_reading_at anchor) | Replace with deterministic ID minting based on monotonic counter seeded from input content hash, OR require all items to carry explicit IDs from the Input plugin |
| U2 | `uuid.uuid4()` for EPUB font-obfuscation key | `conversion/plugins/epub_output.py:254` | Font key when input metadata has no `dc:identifier` of scheme `uuid` | Refuse in deterministic mode if input lacks UUID; OR derive UUID5 from input-content SHA-256 |
| U3 | `uuid.uuid4()` for MOBI EXTH 112 (SOURCE) and 113 (ASIN) | `mobi/writer8/exth.py:108-109` | All MOBI/AZW3 output | Same as U2 |
| U4 | `uuid.uuid4().hex` for KF8 anchor suffixes | `mobi/reader/mobi8.py:88` | MOBI input → OEB conversion of KF8 books | Replace with content-derived deterministic anchor naming |
| U5 | `uuid.uuid4()` for HTML input bookid | `conversion/plugins/html_input.py:157` (some agents say 164) | HTML input → OEB | Derive from input directory hash |
| U6 | `uuid.uuid4()` SNB input identifier | `conversion/plugins/snb_input.py:168` | SNB input | Same as U5 |
| U7 | `uuid.uuid4()` smartypants markers | `conversion/preprocess.py:69-70` | All formats with `--smarten-punctuation` | **Safe by construction** — UUIDs are temporary CDATA boundary markers, substituted back to real text by line 75-76. Output is deterministic. Document but do not remediate. |
| U8 | `uuid.uuid4()` DOCX anchor generation | `docx/to_html.py:49,274` | DOCX input → HTML | Replace with content-hash-derived IDs |

### 3.3 Random number generation

| # | Source | File:Line | Affects | Spine remediation |
|---|---|---|---|---|
| R1 | `random.randint(0, 0xffffffff)` → MOBI header UID | `mobi/writer2/main.py:239` | MOBI 6 header offset 0x10-0x13 | Seed Spine's RNG from a function of input content hash; OR derive UID = CRC32(canonical-content-bytes) |
| R2 | `random.choice()` in covers.py | `covers.py:82-83` | Auto-generated covers (NOT in normal conversion path) | Out of scope — not a conversion path |

### 3.4 Iteration order

| # | Source | File:Line | Spine remediation |
|---|---|---|---|
| I1 | `for term in metadata` → EXTH field emission order | `mobi/writer8/exth.py:57` | Python 3.7+ dicts are insertion-ordered, but Spine must verify the metadata container is built in canonical order at every entry point. Recommend: sort metadata items by `(predicate-IRI, language-tag, value-canonical-form)` before emitting. |
| I2 | `os.walk(base)` in `DirContainer.namelist()` | `oeb/base.py:629` | Sort `names` list before return: `sorted(names)` |
| I3 | `os.listdir('.')` in HTMLZ input | `conversion/plugins/htmlz_input.py:38` | Replace with `sorted(os.listdir('.'))` |
| I4 | `os.listdir` in PML input | `conversion/plugins/pml_input.py` (process_pml) | Same |
| I5 | `os.path.walk()` for OPF discovery | `conversion/plugins/epub_input.py:281` | Same |
| I6 | `Manifest.to_opf2()` sort | `oeb/base.py:1265` (`sorted(self.items, key=attrgetter('sort_key'))`) | **Already deterministic** — kept here as documentation. Spine must implement the same `sort_key` tuple: `(spine_position, media_type, href-numeric-tail-or-href, id)`. |
| I7 | LRF `char_button_map`, `plot_map` dicts | `conversion/plugins/lrf_input.py:39-48` | Use OrderedDict or sort keys before iteration |

### 3.5 Environment / system state

| # | Source | File:Line | Spine remediation |
|---|---|---|---|
| E1 | EXTH 204 generator-version differs by OS: `mv = 200 if iswindows else 202 if ismacos else 201` | `mobi/writer8/exth.py:156` | Hard-code to `201` (Linux/general value) regardless of host platform |
| E2 | `font_scanner.fonts_for_family()` system font discovery | `oeb/transforms/embed_fonts.py` and `flatcss.py:229` | Require explicit `--font-dir` or list of font file paths; never call system font scanner |
| E3 | Adobe SVG cover rendering (PyQt or external) | `conversion/plugins/epub_input.py:225-234` (`render_html_svg_workaround`) | Decide between (a) refusing SVG covers in deterministic mode, (b) rendering with a pinned, vendored renderer (e.g., `resvg`), (c) emitting the SVG as-is |
| E4 | External `pdftohtml` binary version | `pdf/pdftohtml.py:29` (PDFTOHTML constant) | **Cannot be made byte-identical without pinning the exact binary.** Distribute Spine with vendored, pinned `pdftohtml` (poppler 24.x) OR replace with vendored MuPDF / `lopdf` Rust extraction OR refuse PDF input in deterministic mode |
| E5 | ImageMagick for comic images | `conversion/plugins/comic_input.py` | Pin ImageMagick version; OR replace with pinned image library (e.g., `image-rs` + `imageproc`) |
| E6 | `tempfile.NamedTemporaryFile`, `mktemp()` (paths leak into output) | `epub_input.py:434`, `chm_input.py:37`, `snb_input.py:83`, `htmlz_input.py:88-92` | Always use a deterministic temp-dir name derived from input hash; OR strip the temp-path from any output reference before serialization |
| E7 | `os.path.relpath()` Windows-vs-Unix path separator | `epub_input.py:436` | Always `posixpath.relpath()` on internal manifest hrefs |
| E8 | EPUB ZIP unpacking fallback path (`localunzip.extractall` if `ZipFile.extractall` fails) | `epub_input.py:272-277` | Reproduce exactly OR refuse the fallback in deterministic mode |
| E9 | Heuristic preprocessing | `conversion/utils.py:HeuristicProcessor`, `conversion/preprocess.py` | **NOT deterministic by content** — regex order and overlapping matches are sequence-dependent. Spine deterministic mode must `enable_heuristics=False`. |

### 3.6 Image / font re-encoding

| # | Source | File:Line | Spine remediation |
|---|---|---|---|
| F1 | JPEG re-encoding via Qt `QImageWriter` (calibre `utils/img.py:179-217`) | `utils/img.py:205-208` | Qt's libjpeg is unpinned at calibre level. **Spine cannot reproduce JPEG re-encoding byte-identically.** Mitigation: deterministic mode must avoid re-encoding (pass JPEGs through unchanged). For new compression, use libjpeg-turbo at a Spine-pinned version and accept that Spine vs calibre will diverge on compressed JPEGs. |
| F2 | PNG re-encoding via Qt | `utils/img.py:210-212` | PNG is byte-identical-friendly *if* compression level + filter strategy are pinned. Use `image-rs` PNG encoder with explicit settings. |
| F3 | GIF re-encoding via Pillow | `utils/img.py:67-86` | Pillow 12.2.0 pinned in calibre's `pyproject.toml`. Spine must vendor an equivalent GIF encoder or pass through. |
| F4 | Font subsetting via fontTools 4.61.0 | `utils/fonts/subset.py:10-37` (modern), `utils/fonts/sfnt/subset.py:21-68` (legacy) | Glyph order is sorted (line 21 of legacy: `OrderedDict(sorted(resolved_glyphs.items(), key=itemgetter(0)))`). Subsetting *should* be deterministic but SFNT internal table layout has minor freedom. Recommend Rust `subsetter` crate with pinned version; treat font subsetting as a "structural-identical" rather than "byte-identical" target. |

### 3.7 Calibre-specific quirks Spine MUST preserve

These are not bugs to be fixed — they are calibre's actual emitted bytes that any byte-identical port must reproduce:

1. **EXTH record padding to 4-byte boundary** — `mobi/writer8/exth.py:229`. Length field is `len(data) + 8`.
2. **EXTH SOURCE prefix** — `'calibre:'` is prepended to UUID for record 112 (`exth.py:119-122`).
3. **Manifest `sort_key`** — `(spine_position, media_type, href, id)` as tuple. Items in spine appear before items not in spine; within each, sorted by media-type string then href.
4. **Manifest item ID minting prefix** — generated IDs start with `'u'` (`oeb/base.py:165`).
5. **Nook cover bug workaround** — cover image manifest item is renamed to `id="cover"` and moved to first position (`oeb_output.py:80-112`).
6. **Pocketbook cover bug workaround** — cover item moved to first manifest position (`oeb_output.py:114-122`).
7. **NCX condensing when not pretty-print** — whitespace stripped from NCX (`epub_output.py:402-414`).
8. **DOCX app version format** — `{major:02d}.{minor:04d}` from `calibre.constants.numeric_version` (`docx/writer/container.py:211`). Spine must emit a fixed Spine-version string of the same format.
9. **DOCX rId numbering** — `rId1`, `rId2`, ... in insertion order (`docx/writer/container.py:136`).
10. **MOBI compression default** — `PALMDOC` for compressed text; `HUFFCDIC` is *not* exercised in current calibre code despite being in the format spec (`mobi/writer2/main.py:45`).
11. **Periodical EXTH type codes** — hard-coded `0x101` (News-Hierarchical), `0x102` (News-Feed), `0x103` (News-Magazine) (`writer2/main.py:196-201`).
12. **HTML serialization via lxml `etree.tostring()`** — `oeb/base.py:404-416`. Self-closing tags converted to `<tag></tag>` for XHTML (`close_self_closing_tags()` line 440). Attributes in document/insertion order, not alphabetical. Entities use named form (`&amp;`) not numeric.
13. **CDATA escape for `<style>` and `<script>`** — `]]>` inside content is replaced with `\]\]\>` (`oeb/base.py:423-427`).
14. **Default HTML stylesheet injected** from `resources/templates/html.css` and cached (`stylizer.py:42`). Spine must vendor the exact bytes of this stylesheet.

---

## 4. Format-by-Format Tier Assignment

Not every format is equally amenable to byte-identical output. Spine should publish the contract per-format:

| Format (in/out) | Tier | Rationale |
|---|---|---|
| **EPUB → EPUB** | **A** (full byte-identical achievable) | Deterministic given fixed UUID, fixed timestamps, fixed font subsetting. The cleanest case. |
| **EPUB → MOBI/AZW3** | **A** with caveat | Achievable once T1 (PalmDB time), R1 (random UID), U3 (EXTH UUID), and E1 (OS-dependent generator) are all locked. |
| **HTML → EPUB** | **A** | Subject to U5 (bookid UUID) lock |
| **TXT → EPUB** | **A** with caveat | Heuristics MUST be disabled; otherwise B-tier. |
| **MOBI → EPUB** | **B** (structural-identical achievable, byte-identical risky) | KF8 anchor UUIDs (U4) leak into XHTML id attributes; HTML cleanup regex order in mobi6.py:173-181 has overlap concerns. |
| **DOCX → EPUB** | **B** | DOCX input has UUID anchor minting (U8) and image extraction order subtleties. |
| **EPUB → PDF** | **C** (content-equivalent only) | Qt rasterization is unpinnable; Spine cannot match calibre's PDF bytes. |
| **PDF → \*** | **C** (content-equivalent only) | External `pdftohtml` binary version (E4) plus magic-constant-driven reflow engine (`pdf/reflow.py`) make this fundamentally non-portable. |
| **Comic (CBZ/CBR) → EPUB** | **C** | ImageMagick version dependence (E5) for image normalization. |
| **News recipes → EPUB** | **N/A** | Live network input — out of scope for deterministic mode. |
| **FB2/RTF/LIT/CHM/ODT → \*** | **B** | Each delegates to a vendored sub-parser whose determinism varies. Per-format work needed. |
| **Anything → PDF** | **C** | Same as EPUB→PDF. |
| **Anything → DOCX** | **B** | T3 (utcnow) lock plus DOCX namespace ordering yields A-tier in principle; demote to B until verified. |

**A-tier contract:** Spine output equals calibre output byte-for-byte under deterministic mode.
**B-tier contract:** Spine output is structurally identical to calibre's after XML canonicalization, ZIP-entry unwrap, and image-bytes-equal comparison.
**C-tier contract:** Spine output preserves content (text, images, structure) but bytes will differ.

Spine documentation MUST publish this tier table so users have correct expectations.

---

## 5. Pinned Dependencies (calibre's, Spine must match where possible)

From calibre's `pyproject.toml`:

| Library | Version (calibre) | Spine equivalent / risk |
|---|---|---|
| `css-parser` | 1.0.10 | Use Rust `lightningcss` or vendor a port of css-parser; CSS serialization identity is a high-risk area |
| `lxml` | 6.0.2 | Use Rust `quick-xml` or `roxmltree` BUT lxml's exact serialization (attribute order, entity choice, self-closing-tag behavior) must be matched. This is the single hardest dependency to replicate. |
| `html5-parser` | 0.4.12 | Rust `html5ever` is the closest analog, but emits a different DOM. Spine may need to vendor calibre's `html5-parser` or accept B-tier on HTML input. |
| `html5lib` | 1.1 | Fallback parser; rare path |
| `beautifulsoup4` | 4.14.3 | Used by CHM/LRF input; Rust analog exists but parser semantics differ |
| `chardet` | 5.2.0 | Use `chardetng` Rust port; for ambiguous inputs, semantics may diverge between minor versions even within calibre. |
| `pillow` | 12.2.0 | Use `image-rs`; JPEG/PNG/GIF re-encoding is fragile (see F1-F3). |
| `fontTools` | 4.61.0 | Use Rust `subsetter`; treat font subsetting as B-tier. |
| `regex` | 2025.11.3 | Use Rust `regex`; flag any preprocessing path that depends on POSIX-vs-PCRE-vs-Python regex semantics. |
| `lxml_html_clean` | 0.4.4 | Vendor or port. |
| `pycryptodome` | 3.23.0 | For Adobe-obfuscated EPUB fonts only; not in normal conversion path. |

**Implication:** Spine must publish a `spine-conversion-deps.lock` file pinning the exact versions of every Rust crate that affects conversion output, and CI must guard against unintended bumps.

---

## 6. The Deterministic-Mode Specification

### 6.1 Activation

Three equivalent ways to engage deterministic mode:

```
spine convert input.epub output.epub --deterministic
SPINE_DETERMINISTIC=1 spine convert input.epub output.epub
SOURCE_DATE_EPOCH=0 spine convert input.epub output.epub        # implicit
```

### 6.2 What deterministic mode freezes

When `--deterministic` is engaged:

1. **Clock:** all `time.time()` / `datetime.now()` / `utcnow()` equivalents read from `SOURCE_DATE_EPOCH` (default: 0). Affects PalmDB header (T1), ZIP mtimes (T2), DOCX core props (T3), FB2 date (T4).
2. **RNG:** Spine's RNG is seeded from SHA-256 of the canonical input bytes, truncated to 64 bits. Affects MOBI UID (R1) only.
3. **UUID source:** UUIDs come from input metadata if present. If absent and required (U2, U3), Spine derives `uuid5(namespace=spine-deterministic-ns, name=input-sha256)`. If `--strict-deterministic`, refuse with error instead.
4. **Heuristics:** `--enable-heuristics=false` is forced.
5. **Jacket:** `--insert-metadata=false` is forced (jacket date field is technically safe via metadata, but suppressing simplifies the contract).
6. **Cover generation:** synthetic cover generation disabled.
7. **System fonts:** font discovery via system scanner disabled; only fonts at explicit `--font-dir` paths are considered.
8. **External binaries:** PDF input refuses with `error: deterministic mode does not support PDF input; convert to HTML/EPUB first`. Comic input refuses without a vendored ImageMagick build.
9. **OS-dependent generator-version:** EXTH 204 hard-coded to `201`.
10. **Path separators:** all internal hrefs use `posixpath`; `os.path.relpath()` calls replaced with `posixpath.relpath()`.
11. **Iteration order:** all `os.walk`, `os.listdir`, `Path::read_dir` results are sorted before consumption.
12. **Image re-encoding:** disabled by default; images pass through. User opt-in via `--reencode-images` accepts B-tier output.
13. **Smartypants:** allowed (the UUID markers are temporary, U7 is safe).

### 6.3 What deterministic mode does NOT freeze

- Spine's own code version (different Spine versions may produce different output — that is normal).
- Input semantics (a malformed input may still trigger different parser repair paths in Spine vs calibre — see B-tier formats).
- The OS, CPU, libc version of the host (these should not affect output but cannot be 100% guaranteed in the absence of a reproducible-build pipeline).

---

## 7. Verification Protocol

This is what Spine's CI must run on every release to certify the byte-identical claim.

### 7.1 Test corpus

A versioned, public git repository `thereprocase/spine-conversion-corpus` containing:

- **A-tier corpus (~50 Items):** Diverse EPUB Items embodying Instances that cover fiction, non-fiction, technical (with code blocks), illustrated children's literature, RTL (Arabic/Hebrew) Works, CJK (Chinese/Japanese/Korean) Works, Instances with embedded fonts, Instances with SVG. All Works public-domain (Project Gutenberg, Standard Ebooks, Internet Archive). Each Item carries a fixed UUID in `dc:identifier` (Instance-level identifier).
- **B-tier corpus (~30 Items):** One or two Items per non-A-tier input format (MOBI, DOCX, HTML, RTF, FB2, ODT, TXT, LIT, CHM).
- **C-tier corpus (~10 Items):** PDFs and comics, expected to fail byte-identical but verified for content-equivalence.

For each Item:
- Source file bytes
- Calibre reference output (one EPUB output Item per A-tier input Item; one of each major output format for verification spread)
- SHA-256 of each reference output
- Plumber debug-pipeline folders captured (`input/`, `parsed/`, `structure/`, `processed/`)

### 7.2 Calibre reference baseline

Reference outputs are produced by running calibre `7.x` (a specific version pinned in the corpus README) under controlled conditions:

```
SOURCE_DATE_EPOCH=0 \
LC_ALL=C \
TZ=UTC \
ebook-convert input.epub /tmp/output.epub \
  --no-default-epub-cover \
  --disable-heuristics \
  --no-svg-cover-fallback \
  [other normalization flags]
```

Calibre does NOT honor `SOURCE_DATE_EPOCH` natively, so the corpus generation script must:

1. Patch calibre's `mobi/writer2/main.py:464` and `utils/zipfile.py:1369` to read from `SOURCE_DATE_EPOCH` instead of `time.time()`.
2. Patch calibre's UUID-mint sites (epub_output.py:254, exth.py:108-109) to use a deterministic UUID5 derived from input.
3. Patch `random.randint` at `writer2/main.py:239` to use a seeded RNG.

These patches are checked into the corpus repo as `calibre-deterministic.patch`. They are reviewed once and re-applied to each pinned calibre version. **This is the calibration step that makes the byte-identical claim tractable** — we are not matching calibre-as-shipped, we are matching calibre-with-deterministic-patch, which is a reproducible, controlled artifact.

### 7.3 Diff strategy

For each Item in the corpus:

1. **Byte-level comparison:** `cmp spine-output.epub reference-output.epub`. If equal → PASS.
2. **ZIP-aware comparison** (for ZIP-shaped formats):
   - Unzip both into `spine.d/` and `reference.d/`.
   - For each entry, check entry-list equality (file paths + order in central directory).
   - For each XML entry, run XML canonicalization (C14N or equivalent) and `diff`.
   - For each binary entry, check SHA-256 equality.
3. **Format-specific tools:**
   - For EPUB: also run `epubcheck` on Spine output and verify no new warnings vs. reference.
   - For MOBI: extract EXTH headers and diff field-by-field.
   - For DOCX: also run via `python-docx` to verify document.xml structure.

### 7.4 Acceptance gates

| Result | Tier | CI action |
|---|---|---|
| Bytes identical | A | PASS |
| Bytes differ but ZIP entries identical and all XML files identical after C14N and binaries SHA-equal | "structural A" | PASS with warning |
| Bytes differ, ZIP/XML diff localized to one file | localized regression | FAIL with diff in CI artifact |
| Bytes differ, structural diff scattered | broad regression | FAIL hard |
| Test exercises a known C-tier format | C | run content-equivalence check (text extracted equal, image count equal, TOC structure equal); log only |

### 7.5 Continuous regression

Calibre upstream is unpinned and evolves. Spine's contract is "byte-identical to a pinned calibre version under the deterministic patch." The pinned version is bumped quarterly via:

1. PR that updates the calibre version in the corpus repo.
2. Re-applies the deterministic patch (with manual review of any diff).
3. Regenerates all reference outputs.
4. Reviews any byte-diffs in references; new differences become Spine's new target.

This is exactly the model Debian uses for reproducible-builds.

---

## 8. Implementation Roadmap for Spine

Given the above, the prioritized work in `spine-fmt-*` and `spine-oeb`:

### 8.1 Phase 0 (before any Spine code is written)

- [ ] Stand up `thereprocase/spine-conversion-corpus` with 5 A-tier EPUB Items and the calibre-deterministic.patch.
- [ ] Run patched calibre on those 5 Items; commit reference output Items + SHA-256s.
- [ ] Verify the patch produces stable outputs across two consecutive runs on the same machine. (If not, find the additional non-determinism source and add to §3.)

### 8.2 Phase 1 — `spine-oeb` skeleton

- [ ] Implement the OEB data model with deterministic ID minting (U1).
- [ ] Implement the 23-step Plumber pipeline as a trait-based composition.
- [ ] Implement deterministic ZIP writer (T2) — vendor or port a ZIP library that accepts an `mtime` parameter for every entry, plus pass-through of compression method (CRITICAL: `mimetype` must be uncompressed).
- [ ] Implement deterministic XML serializer matching lxml's behavior (attribute-insertion-order, named-entity preference, self-closing-tag XHTML conversion).
- [ ] Vendor `resources/templates/html.css` byte-for-byte.

### 8.3 Phase 2 — `spine-fmt-epub` (A-tier)

- [ ] EPUB Input plugin matching `epub_input.py` quirks: container.xml discovery, OPF rationalization, encryption.xml font deobfuscation (Adobe + IDPF), cover-rationalize for EPUB 2 vs 3.
- [ ] EPUB Output plugin matching `epub_output.py`: ZIP order with mimetype first stored, OPF with `to_opf2()` semantics, NCX/nav-doc, Nook/Pocketbook cover bug workarounds.
- [ ] CI gate: 50-Item A-tier corpus passes byte-identical.

### 8.4 Phase 3 — `spine-fmt-mobi` (A-tier)

- [ ] MOBI/AZW3 writer matching `writer2/main.py` and `writer8/exth.py`:
  - PalmDB header with T1 lock
  - MOBI header with R1 lock (seeded RNG)
  - EXTH with U3 lock and E1 hard-coded `mv=201`
  - INDX records via deterministic indexer
  - Joint MOBI6+KF8 emit when requested
- [ ] CI gate: A-tier corpus EPUB-Item → MOBI-Item passes byte-identical.

### 8.5 Phase 4 — B-tier formats

- [ ] DOCX in/out, HTML in/out, RTF in/out, FB2 in/out, etc. Each at structural-identical contract.

### 8.6 Phase 5 — C-tier formats

- [ ] PDF input via vendored MuPDF (Rust bindings); document divergence from calibre's `pdftohtml`.
- [ ] PDF output via headless Chromium or `printpdf`; document non-portability.
- [ ] Comics via vendored image-rs; document non-portability.

---

## 9. Pragmatic Ceiling — What Spine Should NOT Promise

Be public and explicit about these limits:

1. **PDF output is never byte-identical to calibre.** Calibre uses Qt's WebEngine; Spine will use a different PDF writer. Promise content-equivalence only.
2. **JPEG re-encoding is fragile.** If a user's input contains JPEGs that calibre would re-encode (e.g., resizing for Kindle), Spine matching the bytes is infeasible. Either skip re-encoding (default) or accept B-tier.
3. **PDF input is never byte-identical to calibre.** External `pdftohtml` binary version dominates. Spine will produce semantically similar but byte-different OEB.
4. **News recipes are not deterministic.** Live network input. Out of scope.
5. **Heuristic preprocessing is content-dependent.** Disabled in deterministic mode. If users want heuristics, they accept B-tier.
6. **OS-locale-driven text shaping** (CJK breaking, Arabic shaping) may differ between Spine and calibre even in A-tier formats if the input contains text whose shaping affects byte-level output (rare, but flagged for future investigation).

---

## 10. Open Questions

These are not blockers but should be resolved before Spine commits to the byte-identical claim publicly:

- **Q1.** Will Spine ever ship a `--exact-calibre-bytes` flag that disables Spine's improvements (e.g., better Unicode normalization, fixed font-fallback)? If yes, calibre-bug-compatibility becomes a permanent test harness. If no, Spine's "improved" outputs naturally diverge — which is fine, but should be communicated to users.
- **Q2.** Is the calibre-deterministic patch maintainable across calibre releases? If a patch breaks at calibre v7.20, Spine is effectively decoupled from upstream. Acceptable? Most likely yes.
- **Q3.** Does Spine's BIBFRAME-native graph affect any output bytes? In principle, no — the OEB intermediate is the conversion contract — but jacket page generation, EPUB OPF metadata block ordering, and EXTH metadata field selection all read from the metadata graph. Spine's metadata canonicalization MUST match calibre's metadata-dict iteration order at the OEB boundary.
- **Q4.** What is the minimum-viable A-tier corpus size to claim "byte-identical for the 80% case"? Calibre has ~30 input formats and ~15 output formats. A full Cartesian product is infeasible; we will sample.
- **Q5.** Should the calibre-deterministic patch be upstreamed? Calibre would benefit from reproducible builds. Worth a discussion with kovidgoyal, but not a Spine blocker.

---

## 11. Appendix — Cross-reference: Agent Findings vs. Calibre Manual

To confirm the source-code research aligns with calibre's documented architecture:

| Manual stage | Source-code anchor | Agent A finding | Agent B/C finding |
|---|---|---|---|
| "Input plugin" | `plumber.py:1087` | Step 1 of 23 | Per-format Input plugins inventoried (B) |
| "Transforms" | `plumber.py:1118-1251` | Steps 4-21 | — |
| "parsed/" debug folder | (post-postprocess) | Steps 1-6 | — |
| "structure/" debug folder | post-`DetectStructure` | Step 9 | — |
| "processed/" debug folder | post-`ManifestTrimmer` | Step 20 | — |
| "Output plugin" | `plumber.py:1265` | Step 22 | Per-format Output plugins inventoried (C) |
| Heuristic options | `conversion/utils.py` | (D) flagged non-deterministic | (D) recommended disable in det mode |
| Structure detection XPath | `oeb/transforms/structure.py` | Detected; UUID risk at line 124 | — |
| Search & replace | `conversion/search_replace.py` | Not exercised in default pipeline | — |

**No discrepancies between manual-described pipeline and source-code-observed pipeline.** The four-stage manual description maps cleanly onto the 23-step Plumber sequence (the manual collapses transforms 4-21 into "transforms").

---

## 12. References

- Calibre source tree (read-only): a local checkout of github.com/kovidgoyal/calibre.
- Calibre conversion docs: <https://manual.calibre-ebook.com/conversion.html>
- Calibre `pyproject.toml`: dependency pins.
- Spine `PLAN.md` §5, §6, §8 (BIBFRAME data model, API contract, repo layout).
- Spine `CLAUDE.md` (architectural locks).
- This report aggregates four parallel investigations:
  - Investigation A: `Plumber.run()` + OEB intermediate model
  - Investigation B: Input format plugins (EPUB, MOBI, PDF, + 20 others)
  - Investigation C: Output format writers (EPUB, MOBI, AZW3, DOCX, PDF, + others)
  - Investigation D: Cross-cutting determinism + verification protocol design

---

## Appendix — BIBFRAME Vocabulary Used in This Report

This report uses BIBFRAME 2.0 terminology to make the byte-identical contract precise. The vocabulary is anchored in the [Library of Congress BIBFRAME 2.0 Model](https://www.loc.gov/bibframe/docs/bibframe2-model.html) overview (April 21, 2016), quoted verbatim:

> **BIBFRAME 2.0 organizes this information into three core levels of abstraction: Work, Instance, and Item.**
>
> **Work.** The highest level of abstraction, a Work, in the BIBFRAME context, reflects the conceptual essence of the cataloged resource: authors, languages, and what it is about (subjects).
>
> **Instance.** A Work may have one or more individual, material embodiments, for example, a particular published form. These are Instances of the Work. An Instance reflects information such as its publisher, place and date of publication, and format.
>
> **Item.** An item is an actual copy (physical or electronic) of an Instance. It reflects information such as its location (physical or virtual), shelf mark, and barcode.
>
> BIBFRAME 2.0 further defines additional key concepts that have relationships to the core classes:
>
> - **Agents:** Agents are people, organizations, jurisdictions, etc., associated with a Work or Instance through roles such as author, editor, artist, photographer, composer, illustrator, etc.
> - **Subjects:** A Work might be "about" one or more concepts. Such a concept is said to be a "subject" of the Work. Concepts that may be subjects include topics, places, temporal expressions, events, works, instances, items, agents, etc.
> - **Events:** Occurrences, the recording of which may be the content of a Work.

For an e-book context: *Pride and Prejudice* by Jane Austen is one **Work**. The Penguin Classics 2003 paperback, the Standard Ebooks 2019 EPUB 3, and the Amazon 2012 AZW3 are three distinct **Instances** of that Work. Two byte-different `.epub` files containing the Standard Ebooks 2019 release are two **Items** of that one Instance. Jane Austen is an **Agent** of the Work (role: author); "novels — England — 19th century" is a **Subject** of the Work; the Work carries no Events but a memoir Work might.

The Work carries authors (Agents) and subjects; the Instance carries format, ISBN, ASIN, publisher, and publication date; the Item carries file UUID, filesystem location, and byte content.

### The byte-identical contract layered on the BIBFRAME triangle

1. **Item-to-Item determinism** — the byte-identical claim. Same input Item bytes + same Spine version + same options → same output Item bytes. This is what "byte-identical" means; it is an Item-level guarantee.
2. **Instance preservation** — the round-trip claim. The output Item embodies the same Instance as the input Item, with no information loss, for Class 1-3 routes (per v2 §B). For Class 5 routes (page-fixed↔reflow boundary, e.g. PDF→EPUB), the conversion synthesizes a *new derived Instance* from a degraded source — Instance preservation does not hold.
3. **Work stability** — the identity claim. The Work — its authors, its language, its subjects — is invariant across all conversions in all classes. Spine preserves Work identity by carrying the BIBFRAME graph through every conversion as a sidecar (`META-INF/spine-bibframe.ttl` in EPUB-shaped Items, EXTH 250-255 in MOBI-shaped Items, XMP-RDF in PDF-shaped Items).

### Where each non-determinism source sits in the BIBFRAME triangle

| Field | Level | Why it matters at that level |
|---|---|---|
| MOBI PalmDB created/modified | Item | When *this file* was manufactured; not a property of the Instance |
| ZIP entry mtimes | Item | Filesystem hint about the file copy |
| DOCX `dcterms:created` / `dcterms:modified` | Item | *This file's* editor-session lifecycle |
| MOBI UID at offset 0x10 | Item | Kindle's per-Item Whispersync key (each Item must be unique to avoid sync collision) |
| EXTH 113 ASIN | **Instance** | Amazon's identifier for the published edition; one ASIN per Instance |
| EXTH 112 SOURCE (`calibre:UUID`) | Item provenance pointing to an Instance/Work URI | "this Item was made by calibre from a source identified by this UUID" |
| EPUB `dc:identifier` (font-obfuscation key) | **Instance** | The canonical Instance identifier per EPUB spec |
| OPF/NCX `id="..."` attributes | Item-internal | XML cross-reference handles within one Item; no BIBFRAME meaning |
| EXTH 204 generator-version (OS-flavored) | Item provenance | Like a colophon noting which press printed a book |
| System font discovery | Item resource | Embedded font *resource* becomes part of Item bytes; the Work's typography requirement is unchanged |
| Qt-rasterized PDF output | Item | Manufacturing environment leaves traces in the Item bytes |
| `pdftohtml` binary version | **Instance-derived** | Different binary versions produce different *Instances* during PDF→EPUB because text-extraction quality changes what the Instance contains |
| ImageMagick comic processing | **Instance-derived** | Image normalization changes the content, not just the packaging |

### Vocabulary used in this report

- "Library" = a collection of Items, indexed by Instance and Work URIs.
- "Catalog" = the Instance-and-Work-level index of a library; one row per Instance.
- "Test corpus" = a set of Items, chosen to embody a diverse set of Instances of a diverse set of Works.
- "Conversion" = takes an input Item, produces an output Item. The output Item embodies the same Instance (Class 1-3), a derived Instance (Class 5), or is byte-equivalent to the input Item (Class 3 passthrough).
- "Format" (EPUB, MOBI, PDF, etc.) = a property of the Instance. Instances of one Work in different formats are distinct Instances.
- "Round-trip" = X-Item → Y-Item → X'-Item; asks whether X'-Item embodies the same Instance as X-Item.
- "Polish" = an Item-to-Item edit that does not change the Instance.

Where this report uses "book" colloquially, the precise reading is given in context. In contractual prose, the BIBFRAME vocabulary is used directly.

End of report.
