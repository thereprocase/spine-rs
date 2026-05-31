# Byte-Identical Conversion Protocol v2 — Rust Implementation Deep-Dive

**Status:** Research report v2 — implementation-focused, 2026-04-25
**Companion docs:** [v1](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md) (foundational determinism analysis), [v3](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md) (2026 workflow atlas)
**Audience:** Spine engineering — `spine-fmt-*`, `spine-oeb`, `spine-polish` crate authors.

This version extends v1 with: a complete EPUB→MOBI worked example in Rust, an analysis of when XHTML-bridging is the wrong intermediate, a Rust crate ecosystem survey (placeholder pending agent research), and seven additional architectural sections (D-J) covering round-trip fidelity, metadata preservation, failure modes, parallelism, test vectors, migration, and upstream tracking.

---

## Reading order

If you read v1 already, skip to §A. Otherwise read v1 first — this document assumes the determinism inventory and the verification protocol from v1.

| Section | Topic | Status |
|---|---|---|
| §A | EPUB→MOBI worked example in Rust | Complete |
| §B | When XHTML-bridging is wrong | Complete |
| §C | Rust crate ecosystem survey | Pending agent research — partial |
| §D | Round-trip stability analysis | Complete |
| §E | Metadata fidelity across conversions | Complete |
| §F | Failure modes and error surface | Complete |
| §G | Performance and parallelism vs determinism | Complete |
| §H | Test vector generation | Complete |
| §I | User migration path | Complete |
| §J | Long-term upstream tracking | Complete |

---

## §A. EPUB → MOBI Worked Example in Rust

### A.0 What we are reproducing

The reference invocation (calibre 7.x, deterministic patch applied):

```bash
SOURCE_DATE_EPOCH=0 LC_ALL=C TZ=UTC \
ebook-convert input.epub output.mobi \
  --no-default-epub-cover \
  --disable-heuristics \
  --output-profile=kindle_pw3 \
  --mobi-file-type=both
```

This produces a single `.mobi` file containing both the legacy MOBI 6 record stream and the KF8 record stream behind a BOUNDARY marker — the dual-format layout calibre uses for backward compatibility. Spine must produce the identical bytes.

### A.1 Sample input

A minimal but representative EPUB 3.0 input (`fixture-001.epub`) with these properties:

- `META-INF/container.xml` pointing to `OEBPS/content.opf`
- OPF with metadata block containing fixed `dc:identifier` (a UUID, the determinism anchor), `dc:title`, `dc:creator`, `dc:language`
- Manifest of three XHTML chapters, one cover image (JPEG), one stylesheet, one embedded font (TTF, IDPF-obfuscated)
- Spine of three items in order
- NCX TOC (kept for EPUB 2 compat) plus an EPUB 3 nav doc

This fixture is checked into `spine-conversion-corpus/fixtures/001-minimal/`. Reference outputs (calibre-deterministic-patched) live at `spine-conversion-corpus/refs/001-minimal/output.mobi.sha256`.

### A.2 Crate selection

```toml
# Cargo.toml — spine-fmt-mobi
[dependencies]
zip               = { version = "2", default-features = false, features = ["deflate"] }
quick-xml         = "0.36"        # XML serialization (XHTML/OPF/NCX)
roxmltree         = "0.20"        # XML parsing (read OPF/container.xml)
sha2              = "0.10"        # SHA-256 for deterministic-UUID derivation
uuid              = { version = "1", features = ["v5"] }
byteorder         = "1.5"         # Big-endian struct packing for MOBI/PalmDB
palmdoc-compression = "0.1"       # PalmDOC LZ77-style compression (NOT deflate — vendored)
encoding_rs       = "0.8"         # CP1252 et al. for legacy text fields
lightningcss      = "1"           # CSS parse + serialize, matches css-parser semantics tightly
html5ever         = "0.27"        # HTML5 parsing
markup5ever_rcdom = "0.3"
spine-oeb         = { path = "../spine-oeb" }   # Spine's OEB intermediate model
spine-determinism = { path = "../spine-determinism" }  # clock + RNG locks

[dev-dependencies]
spine-test-corpus = { path = "../spine-test-corpus" }
```

The `spine-determinism` crate is a thin facade providing:

```rust
pub fn build_time() -> u32       // Reads SOURCE_DATE_EPOCH or returns 0
pub fn rng_for(input: &[u8]) -> StdRng   // SHA-256-derived seeded RNG
pub fn uuid_for(input: &[u8]) -> Uuid    // UUID5 over input bytes
pub fn zip_mtime() -> zip::DateTime      // Fixed (1980, 1, 1, 0, 0, 0)
```

All non-determinism is funnelled through this crate; no other crate calls `SystemTime::now()` or `rand::thread_rng()`.

### A.3 Pipeline overview

```rust
pub fn epub_to_mobi(epub_path: &Path, mobi_path: &Path, opts: &Opts) -> Result<()> {
    // Phase 1: EPUB → OEB (Input plugin equivalent)
    let oeb = spine_fmt_epub::read_epub_to_oeb(epub_path, opts)?;

    // Phase 2: Plumber pipeline (matching calibre's 23 steps)
    let oeb = spine_oeb::run_plumber(oeb, opts)?;

    // Phase 3: OEB → MOBI (Output plugin equivalent)
    write_oeb_to_mobi(&oeb, mobi_path, opts)
}
```

Each phase corresponds to one of v1 §2's pipeline boundaries. We focus the worked example on Phase 3 (the writer) since Phases 1 and 2 are symmetric to other format pairs. The MOBI writer is where most byte-identical risk lives.

### A.4 Phase 1 — EPUB read (sketch)

```rust
pub fn read_epub_to_oeb(path: &Path, opts: &Opts) -> Result<Oeb> {
    let archive = zip::ZipArchive::new(File::open(path)?)?;

    // 1. mimetype check (must be first, stored, exact bytes "application/epub+zip")
    require_mimetype_first_stored(&archive)?;

    // 2. container.xml: locate the OPF
    let opf_path = parse_container_xml(&archive)?;

    // 3. parse OPF — but use roxmltree, not html5ever; OPF is strict XML
    let opf = parse_opf(&archive, &opf_path)?;

    // 4. resolve all manifest hrefs relative to OPF location
    //    use posixpath::normpath, NEVER std::path (calibre uses posixpath internally)
    let manifest = resolve_manifest(&opf, &opf_path)?;

    // 5. detect & decrypt obfuscated fonts (Adobe + IDPF) — see calibre epub_input.py:42-88
    let manifest = decrypt_obfuscated_fonts(&archive, manifest, &opf)?;

    // 6. construct the OEB struct
    Ok(Oeb {
        metadata: opf.metadata,
        manifest,
        spine: opf.spine,
        guide: opf.guide,
        toc: parse_ncx_or_nav(&archive, &opf)?,
    })
}
```

Three byte-identical risks already visible:

- **Path normalization** must use POSIX, not platform-native, to match calibre's behavior on Windows vs Linux.
- **Manifest item ordering** preserved as document-order from OPF; do not re-sort.
- **Obfuscated-font UUID source**: calibre extracts UUID from `dc:identifier` with scheme `uuid` OR a `urn:uuid:` value (epub_input.py:59-67). Ordering of multiple identifiers matters; pick the first.

### A.5 Phase 2 — Plumber pipeline (sketch)

```rust
pub fn run_plumber(mut oeb: Oeb, opts: &Opts) -> Result<Oeb> {
    // Step 1-3 already done by input plugin's postprocess/specialize
    if opts.transform_html_rules.is_some() {
        oeb = transform_html(oeb, opts)?;            // Step 4
    }
    oeb = data_url::extract(oeb)?;                   // Step 5
    oeb = clean::clean_guide(oeb)?;                  // Step 6
    if opts.remove_first_image { oeb = remove_first_image::run(oeb)?; }   // Step 7
    oeb = merge_metadata::run(oeb, opts)?;           // Step 8
    oeb = detect_structure::run(oeb, opts)?;         // Step 9
    if !matches!(opts.output_format, Fmt::Epub | Fmt::Kepub) {
        oeb = remove_toc_cover_ref::run(oeb)?;       // Step 10
    }
    if opts.insert_metadata { oeb = jacket::run(oeb, opts)?; }            // Step 11
    if opts.add_alt_text { oeb = alt_text::run(oeb)?; }                    // Step 12
    if opts.linearize_tables && !matches!(opts.output_format, Fmt::Mobi | Fmt::Lrf) {
        oeb = linearize_tables::run(oeb)?;           // Step 13
    }
    if opts.unsmarten_punctuation { oeb = unsmarten::run(oeb)?; }          // Step 14
    let css_opts = css_flatten_opts_for(&opts);
    oeb = css_flatten::run(oeb, css_opts)?;          // Step 15
    oeb = remove_fake_margins::run(oeb)?;            // Step 16
    oeb = remove_adobe_margins::run(oeb)?;           // Step 17
    if opts.embed_all_fonts { oeb = embed_fonts::run(oeb)?; }              // Step 18
    if opts.subset_embedded_fonts && opts.output_format != Fmt::Pdf {
        oeb = subset_fonts::run(oeb)?;               // Step 19
    }
    oeb = manifest_trim::run(oeb)?;                  // Step 20
    oeb.toc.rationalize_play_orders();               // Step 21
    Ok(oeb)
}
```

Each transform is its own module under `spine-oeb-transforms/`. The order, conditional branches, and option semantics map 1:1 onto calibre's `Plumber.run()` (v1 §2 Table). **The conditional set must match exactly** — for example, `remove_toc_cover_ref` runs only for non-EPUB outputs, which is calibre's `plumber.py:1148-1153`.

### A.6 Phase 3 — MOBI write (full)

This is the byte-identical hot path. Below is annotated Rust matching calibre's `mobi/writer2/main.py` plus `mobi/writer8/exth.py`.

```rust
use byteorder::{BigEndian, WriteBytesExt};
use spine_determinism as det;

pub fn write_oeb_to_mobi(oeb: &Oeb, path: &Path, opts: &Opts) -> Result<()> {
    let mut out = BufWriter::new(File::create(path)?);

    // === STEP 1: Build the MOBI 6 (legacy) record stream ===
    let mobi6_records = build_mobi6_records(oeb, opts)?;

    // === STEP 2: Build the KF8 record stream (if mobi_file_type ∈ {kf8, both}) ===
    let kf8_records = if opts.mobi_file_type != MobiFileType::Old {
        Some(build_kf8_records(oeb, opts)?)
    } else { None };

    // === STEP 3: Combine into joint or single layout ===
    let all_records = match opts.mobi_file_type {
        MobiFileType::Old => mobi6_records,
        MobiFileType::New => kf8_records.unwrap(),
        MobiFileType::Both => combine_joint_records(mobi6_records, kf8_records.unwrap())?,
    };

    // === STEP 4: Emit PalmDB header ===
    write_palmdb_header(&mut out, oeb, &all_records, opts)?;

    // === STEP 5: Emit record offset table ===
    write_record_offsets(&mut out, &all_records)?;

    // === STEP 6: Emit each record ===
    for rec in &all_records {
        out.write_all(rec)?;
    }
    Ok(())
}

fn write_palmdb_header(
    out: &mut impl Write,
    oeb: &Oeb,
    records: &[Vec<u8>],
    opts: &Opts,
) -> Result<()> {
    // Bytes 0-31: title (ASCII, padded with NUL) — calibre writer2/main.py:458-463
    let title = title_to_palmdb_field(&oeb.metadata.title)?;
    out.write_all(&title)?;                                        // 32 bytes

    // Bytes 32-33: attributes (0x0000 for "no attributes")
    out.write_u16::<BigEndian>(0)?;

    // Bytes 34-35: version (0x0000)
    out.write_u16::<BigEndian>(0)?;

    // Bytes 36-39: created — calibre writer2/main.py:464 uses int(time.time())
    // T1 fix: read SOURCE_DATE_EPOCH instead of wall clock
    out.write_u32::<BigEndian>(det::build_time())?;

    // Bytes 40-43: modified
    out.write_u32::<BigEndian>(det::build_time())?;

    // Bytes 44-47: backup
    out.write_u32::<BigEndian>(0)?;

    // Bytes 48-55: modnum, appInfoID, sortInfoID (all zero)
    out.write_u32::<BigEndian>(0)?;
    out.write_u32::<BigEndian>(0)?;

    // Bytes 56-59: type "BOOK"
    out.write_all(b"BOOK")?;

    // Bytes 60-63: creator "MOBI"
    out.write_all(b"MOBI")?;

    // Bytes 64-67: uniqueIDseed — used to seed record IDs.
    // calibre writer2/main.py:239 uses random.randint(0, 0xffffffff)
    // R1 fix: derive deterministically from input content hash
    let canonical_input = oeb.canonical_bytes_for_hashing();
    let seed = u32::from_be_bytes(
        sha2::Sha256::digest(&canonical_input)[..4].try_into().unwrap(),
    );
    out.write_u32::<BigEndian>(seed)?;

    // Bytes 68-71: nextRecordListID (zero)
    out.write_u32::<BigEndian>(0)?;

    // Bytes 72-73: numRecords
    out.write_u16::<BigEndian>(records.len() as u16)?;

    Ok(())
}
```

#### A.6.1 The MOBI 6 record 0 (header record)

Record 0 holds the PalmDOC header (16 bytes) + MOBI header (variable) + EXTH header (variable). All fields below are big-endian unless noted.

```rust
fn build_mobi6_record0(oeb: &Oeb, opts: &Opts, text_record_count: u16, text_length: u32, image_index: u32) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(2048);

    // PalmDOC header (16 bytes) — calibre writer2/main.py:225-238
    buf.write_u16::<BigEndian>(2)?;     // compression: 1=none, 2=PALMDOC, 17480=HUFFCDIC
    buf.write_u16::<BigEndian>(0)?;     // unused
    buf.write_u32::<BigEndian>(text_length)?;       // total text length
    buf.write_u16::<BigEndian>(text_record_count)?; // record count
    buf.write_u16::<BigEndian>(4096)?;  // record size
    buf.write_u16::<BigEndian>(0)?;     // encryption type (0 = none; we do not implement DRM)
    buf.write_u16::<BigEndian>(0)?;     // unknown

    // MOBI header — calibre writer2/main.py:240-302
    buf.write_all(b"MOBI")?;            // identifier
    buf.write_u32::<BigEndian>(0xE8)?;  // header length
    buf.write_u32::<BigEndian>(2)?;     // type 2 = book (MOBI format constant; not BIBFRAME terminology)
    buf.write_u32::<BigEndian>(65001)?; // text encoding (UTF-8 = 65001; calibre also supports CP1252=1252)

    // unique ID — calibre writer2/main.py:239 uses random.randint
    // R1 fix: deterministic seed
    let unique_id = u32::from_be_bytes(
        sha2::Sha256::digest(&oeb.canonical_bytes_for_hashing())[4..8].try_into().unwrap()
    );
    buf.write_u32::<BigEndian>(unique_id)?;

    buf.write_u32::<BigEndian>(6)?;     // file version
    // ... ortho fields, INX offsets, full-text offsets ...
    // (omitted for brevity — match calibre exactly, fields documented in writer2/main.py)

    // EXTH header — built separately
    let exth = build_exth(oeb, opts)?;
    buf.extend_from_slice(&exth);

    // Pad to 4-byte boundary
    while buf.len() % 4 != 0 { buf.push(0); }

    // Append the title bytes (calibre puts the full title here, not just the PalmDB-clamped 32 bytes)
    let full_title = oeb.metadata.title.as_bytes();
    buf.extend_from_slice(full_title);
    while buf.len() % 4 != 0 { buf.push(0); }

    Ok(buf)
}
```

#### A.6.2 EXTH emission (the most quirk-laden part)

```rust
/// Build EXTH section. Order MUST match calibre/writer8/exth.py.
fn build_exth(oeb: &Oeb, opts: &Opts) -> Result<Vec<u8>> {
    let mut records: Vec<(u32, Vec<u8>)> = Vec::new();

    // Phase A: metadata-driven records — emit in the canonical metadata
    // iteration order. Spine sorts metadata by (predicate-IRI, lang, value)
    // before iteration to make this stable. (See v1 §3.4 I1.)
    for term in oeb.metadata.iter_canonical() {
        match term.predicate.as_str() {
            "creator"     => records.push((100, term.value.clone().into_bytes())),
            "publisher"   => records.push((101, term.value.clone().into_bytes())),
            "description" => records.push((103, term.value.clone().into_bytes())),
            "isbn"        => records.push((104, term.value.clone().into_bytes())),
            "subject"     => records.push((105, term.value.clone().into_bytes())),
            "date"        => records.push((106, term.value.clone().into_bytes())),
            // ... see calibre exth.py for full mapping
            _ => {}
        }
    }

    // Phase B: UUID-derived records — calibre exth.py:107-122
    // U2/U3 fix: UUID comes from input metadata or is derived deterministically.
    let uuid = oeb.metadata.uuid_or_derive(&det::uuid_for);
    let uuid_str = uuid.to_string();
    records.push((112, format!("calibre:{}", uuid_str).into_bytes()));  // SOURCE (type 112)
    records.push((113, uuid_str.clone().into_bytes()));                  // ASIN (type 113)
    // (Spine emits the literal "calibre:" prefix on type 112 to match byte-identical
    //  even though the value is now produced by Spine. This is one of v1 §3.7's
    //  preserved quirks. Verify against `mobi/writer8/exth.py:108-122`.)

    // Phase C: cdetype, pubdate, generator
    if oeb.metadata.is_periodical() {
        records.push((501, b"NWPR".to_vec()));
    } else {
        records.push((501, b"EBOK".to_vec()));
    }
    if let Some(pub_date) = oeb.metadata.pub_date_iso() {
        records.push((106, pub_date.into_bytes()));
    }
    // E1 fix: hard-code OS-flavored generator-version field
    records.push((204, vec![0, 0, 0, 201]));   // 201 = Linux flavor; matches calibre on Linux

    // Phase D: cover/thumbnail offsets — computed from resource index
    if let Some(cover_idx) = oeb.cover_index() {
        records.push((201, (cover_idx as u32).to_be_bytes().to_vec()));
    }
    if let Some(thumb_idx) = oeb.thumbnail_index() {
        records.push((202, (thumb_idx as u32).to_be_bytes().to_vec()));
    }

    // Now serialize records into EXTH wire format
    let mut buf = Vec::new();
    buf.write_all(b"EXTH")?;
    let count = records.len() as u32;
    let total_data: usize = records.iter().map(|(_, d)| d.len() + 8).sum();
    let header_len = 12 + total_data + ((4 - (12 + total_data) % 4) % 4);  // padded to 4
    buf.write_u32::<BigEndian>(header_len as u32)?;
    buf.write_u32::<BigEndian>(count)?;
    for (typ, data) in &records {
        buf.write_u32::<BigEndian>(*typ)?;
        buf.write_u32::<BigEndian>((data.len() + 8) as u32)?;
        buf.write_all(data)?;
    }
    while buf.len() % 4 != 0 { buf.push(0); }   // calibre exth.py:229
    Ok(buf)
}
```

#### A.6.3 Text records — PalmDOC compression

```rust
fn build_text_records(oeb: &Oeb, opts: &Opts) -> Result<(Vec<Vec<u8>>, u32)> {
    // Concatenate all spine items as MOBI 6 HTML
    let html = serialize_oeb_as_mobi6_html(oeb)?;
    let total_len = html.len() as u32;

    // Split into 4096-byte uncompressed chunks
    let mut records = Vec::new();
    for chunk in html.chunks(4096) {
        let compressed = if opts.dont_compress {
            chunk.to_vec()
        } else {
            palmdoc_compress(chunk)
        };
        records.push(compressed);
    }
    Ok((records, total_len))
}

/// PalmDOC compression — LZ77-style with literal/length-distance pairs.
/// Calibre uses a vendored C implementation; Spine vendors the algorithm
/// and uses `palmdoc-compression` crate (BSD-3, vendored by Spine).
fn palmdoc_compress(data: &[u8]) -> Vec<u8> {
    palmdoc_compression::compress(data)
}
```

PalmDOC compression is **deterministic** (no randomness, no parallelism, no parameter choices) so any correct implementation will produce identical output. We can use a port; we do not need to match calibre's specific compressor implementation — we need to match its *output*, which the spec uniquely defines.

#### A.6.4 The KF8 record stream

The KF8 path uses a different writer (`writer8/main.py` in calibre). Its record layout is more complex (FDST, SKEL, NCX, FRAG indexes; flow records for resources; XHTML fragments rather than MOBI 6 inline HTML). Spine's `spine-mobi/writer8/` module mirrors it. The byte-identical contract for KF8 is achievable but requires:

1. Deterministic SKEL fragment ordering — sort by `(spine_position, fragment_id)`.
2. Deterministic FDST chunk boundaries — calibre uses a fixed 4096-byte chunk size.
3. Deterministic INDX hash table construction — must use the same trie-build order calibre does (`writer2/indexer.py`).

Code omitted here for length; see `spine-fmt-mobi/src/kf8.rs` for the full implementation pattern.

#### A.6.5 Joint record combination

When `mobi_file_type=both`, calibre writes a single PalmDB containing the MOBI 6 records first, then a BOUNDARY pseudo-record (which is just a record offset entry whose data is `b"BOUNDARY"`), then the KF8 records. The MOBI 6 record 0 is rebuilt with EXTH 121 (KF8 header section index) pointing to the BOUNDARY record's index.

```rust
fn combine_joint_records(
    mut mobi6: Vec<Vec<u8>>,
    kf8: Vec<Vec<u8>>,
) -> Result<Vec<Vec<u8>>> {
    let boundary_idx = mobi6.len();
    mobi6.push(b"BOUNDARY".to_vec());
    let kf8_start_idx = mobi6.len();
    // Rewrite mobi6's record 0 to add EXTH 121 = boundary_idx + 1
    rewrite_mobi6_record0_with_kf8_boundary(&mut mobi6[0], boundary_idx as u32 + 1)?;
    mobi6.extend(kf8);
    Ok(mobi6)
}
```

### A.7 Verification harness

```rust
#[test]
fn epub_001_to_mobi_byte_identical() {
    let opts = Opts {
        deterministic: true,
        mobi_file_type: MobiFileType::Both,
        output_profile: OutputProfile::KindlePw3,
        enable_heuristics: false,
        ..Default::default()
    };
    let actual = "/tmp/spine-test-001.mobi";
    epub_to_mobi(
        Path::new("fixtures/001-minimal/input.epub"),
        Path::new(actual),
        &opts,
    ).unwrap();

    let actual_sha = sha256_of_file(actual);
    let expected_sha = read_to_string("refs/001-minimal/output.mobi.sha256").unwrap();
    assert_eq!(actual_sha, expected_sha.trim(),
        "byte-identical regression — see refs/001-minimal/output.mobi.diff");
}
```

When `actual_sha != expected_sha`, the harness automatically runs a diff:

```rust
fn dump_mobi_diff(actual: &Path, reference: &Path, out: &Path) -> Result<()> {
    let a = mobi_dump::dump(actual)?;       // structured dump: PalmDB + records + EXTH
    let r = mobi_dump::dump(reference)?;
    let diff = pretty_diff::diff(&r, &a);
    fs::write(out, diff)?;
    Ok(())
}
```

The dump is field-level; a one-byte difference in EXTH 113 surfaces as `EXTH[113] SOURCE: "calibre:abc..." → "calibre:def..."` not as `byte 437 changed`.

### A.8 Common failure modes for this worked example

| Failure | Root cause | Fix |
|---|---|---|
| EXTH header length off by 4 | Padding logic incorrect | `while buf.len() % 4 != 0 { buf.push(0); }` after every record |
| Unique ID changes between runs | Forgot to seed from canonical bytes | Use `det::rng_for(input)` instead of OS RNG |
| MOBI created/modified time = current | Forgot to read SOURCE_DATE_EPOCH | Wrap all clock reads in `det::build_time()` |
| EXTH 204 = 200 (Windows) on Mac | Used `cfg!(target_os)` for generator version | Hard-code 201; do not branch on host OS |
| Boundary record at wrong index | Off-by-one in joint combination | Boundary is at index `mobi6.len()`, KF8 starts at `mobi6.len() + 1` |
| Text records 1 byte shorter | PalmDOC compression non-deterministic literal/run encoding | Use a compliant compressor; the spec is unique up to byte output |
| Image records reordered | Iteration over `HashMap<image_id, bytes>` | Use `BTreeMap` or sort by (manifest-order, id) before emission |

Each failure mode maps to a non-determinism source from v1 §3.

---

## §B. When XHTML-Bridging is Wrong: Direct-Pair Conversion Strategies

### B.1 The XHTML-bridge assumption

Calibre's conversion pipeline rests on a single architectural commitment: every format pair is reduced to a common intermediate representation — an OEB package (manifest of XHTML documents + CSS + images + fonts) — before any output is produced. The calibre manual is unambiguous: *"all the transforms act on the XHTML output by the Input plugin, not on the input file itself"* (`manual/conversion.rst`:60-61). The pipeline is invariant: Input plugin → XHTML/OEB → transforms → Output plugin. There is no escape hatch in `plumber.py`; the four debug stages (`input`, `parsed`, `structure`, `processed`) all operate on XHTML.

This assumption costs three things:

1. **Fidelity ceiling.** No format pair can preserve more semantics than XHTML can represent. DOCX track-changes, PDF form fields, MOBI EXTH records calibre doesn't model, embedded JavaScript, fixed-layout pages — all are silently lost the moment the input plugin runs.
2. **Round-trip noise.** Even when source and destination are the same format, the round-trip through XHTML serialization introduces non-deterministic differences (whitespace normalization, attribute ordering, CSS rewriting) that defeat byte-comparable contracts.
3. **Catastrophic loss on page-fixed formats.** PDF→PDF and comic→comic in calibre re-render through XHTML, throwing away the actual content (PDF page geometry, comic image bytes) and replacing it with a poor approximation.

### B.2 The five conversion classes

A taxonomy that surfaces where bridging works and where it fails:

- **Class 1 — Cross-family reflow.** Text-flow source to text-flow destination, different families. EPUB↔MOBI, EPUB↔FB2, HTML→EPUB, TXT→EPUB. **XHTML bridge is correct.** No richer common subset exists; reflow semantics map cleanly to OEB.
- **Class 2 — Same-family upgrade/downgrade.** EPUB2↔EPUB3, MOBI6↔KF8, AZW3 sibling transcoding. The two formats share an OEB substrate already. **XHTML bridge is wasteful;** parsing OEB into in-memory OEB and re-serializing it is a no-op with rounding errors. Direct OEB-to-OEB conversion preserves more.
- **Class 3 — Same-format passthrough/edit.** EPUB→EPUB (metadata-only update), MOBI→MOBI, DOCX→DOCX (re-save). **XHTML bridge is harmful.** The user wants minimal change; the round-trip produces maximal change. Calibre already solves this with its `polish` module (`src/calibre/ebooks/oeb/polish/`), which operates on a `Container` of HTML + resource files without invoking the conversion pipeline. The conversion pipeline does not know about polish, and the GUI exposes both as separate features the user must choose between.
- **Class 4 — Page-fixed-to-page-fixed.** PDF→PDF, comic→comic. **XHTML bridge is catastrophic.** PDF input goes via `pdftohtml` to XHTML; PDF output re-renders XHTML to PDF. The output is an entirely different document with similar text. Comic→comic strips the original archive, decodes images, optionally despeckles/sharpens/recompresses them, and writes a new archive — even when the user wanted byte passthrough.
- **Class 5 — Page-fixed↔reflow boundary.** PDF→EPUB, EPUB→PDF, comic→EPUB. **XHTML bridge is necessary** because there is no other lingua franca, but the fidelity ceiling drops sharply: PDF→EPUB loses page geometry; EPUB→PDF loses reflow. The bridge is the right answer here, but the user must understand the ceiling.

### B.3 Direct-pair conversion table

| Source | Dest | Class | Bridge or direct? | Rust strategy | Notes |
|---|---|---|---|---|---|
| EPUB | EPUB | 3 | **Direct (polish)** | `spine-polish` Container API, no pipeline | Metadata-only paths must not re-zip from scratch |
| EPUB | MOBI/AZW3 | 1 | Bridge | OEB → `spine-mobi` writer8 | Calibre default path; correct |
| EPUB | PDF | 5 | Bridge | OEB → `spine-pdf-render` (paged HTML→PDF) | Tier-bounded; warn user |
| EPUB | DOCX | 1 | Bridge | OEB → `spine-docx-writer` (HTML→OOXML) | Calibre's `docx/writer/from_html.py` pattern |
| EPUB | HTML | 1 | Bridge or direct | Either; direct extracts spine concatenated | HTMLZ output is essentially direct |
| EPUB | TXT | 1 | Bridge | OEB → text extractor | Lossy by definition |
| MOBI | EPUB | 1 | Bridge | MOBI parser → OEB → EPUB writer | Calibre default; correct |
| MOBI | AZW3 | 2 | **Direct (writer8 only)** | MOBI6 unpack → KF8 repack via `spine-mobi/writer8` | Skip XHTML round-trip; preserves authored markup |
| MOBI | MOBI | 3 | **Direct (polish-style)** | Container over PDB record stream | Preserves EXTH unmodelled keys |
| AZW3 | MOBI | 2 | **Direct** | KF8 → MOBI6 transcode | Some downconversion; no XHTML detour |
| AZW3 | EPUB | 1 | Bridge | OEB → EPUB writer | KF8's OEB substrate transfers cleanly |
| AZW3 | AZW3 | 3 | **Direct (polish)** | Container over PDB | Same logic as MOBI→MOBI |
| DOCX | DOCX | 3 | **Direct (OOXML edit)** | OOXML part-level rewrite, no HTML conversion | Preserves track-changes, comments, custom XML, embedded objects |
| DOCX | EPUB | 1 | Bridge | DOCX→HTML → OEB → EPUB | Calibre default; correct |
| ODT | DOCX | 2/1 | Direct preferred | ODF→OOXML mapper if available; bridge fallback | Both ZIP-of-XML; pandoc-style direct map preserves more |
| ODT | EPUB | 1 | Bridge | ODT input → OEB → EPUB | Calibre default; correct |
| HTML | EPUB | 1 | Bridge | OEB construction directly from HTML | Effectively direct already |
| HTML | MOBI | 1 | Bridge | OEB → MOBI writer | Calibre default; correct |
| PDF | EPUB | 5 | Bridge | PDF text extract → reflow → OEB → EPUB | Tier-bounded; user must understand loss |
| PDF | PDF | 4 | **Direct (passthrough or page-edit)** | `spine-pdf` qpdf-style; never re-render via HTML | Metadata-only edits via PDF dictionary; never bridge |
| TXT | EPUB | 1 | Bridge | TXT → markdown-detect → OEB → EPUB | Calibre default; correct |
| FB2 | EPUB | 1 | Bridge | FB2 → OEB → EPUB | Correct |
| RTF | DOCX | 1 | Bridge with caveat | RTF → OEB → DOCX writer | Direct RTF→OOXML mapping is hard; bridge is acceptable |
| Comic | EPUB | 5 | Bridge | Image collection → image-only OEB → EPUB | Tier-bounded |
| Comic | Comic | 4 | **Direct (archive transcode)** | CBZ↔CBR archive repack only; image bytes unchanged unless user opts in | Calibre destroys image bytes; Spine must default to passthrough |

### B.4 What direct conversion preserves

For each non-bridge class, the concrete preservation gain over XHTML round-trip:

- **EPUB→EPUB (Class 3).** Embedded JavaScript (`<script>` in spine items), fixed-layout `rendition:layout` pages, MathML, scoped/cascaded CSS layers, calibre-foreign metadata in OPF (`<meta>` items the conversion pipeline doesn't recognize), authored TOC structure (`nav` epub:type subdivisions), embedded font subsetting state, original `META-INF/` extensions including `encryption.xml` and `signatures.xml`, original mimetype byte alignment.
- **MOBI→MOBI (Class 3).** EXTH records calibre's OEB model doesn't represent (publisher-supplied identifiers, ASIN linkage, parental controls metadata), original PDB record byte layout where Kindle sync state is keyed.
- **AZW3→AZW3 (Class 3).** Same as MOBI plus KF8-specific resource records, original `flow` and `ncx` index byte structure.
- **MOBI→AZW3 (Class 2).** Direct writer8 path keeps authored markup that the OEB normalization step would otherwise rewrite (CSS shorthand expansion, `class` attribute deduplication, anchor renaming).
- **DOCX→DOCX (Class 3).** Track-changes (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`), comments (`comments.xml`, `commentsExtended.xml`), footnotes/endnotes with custom numbering, custom XML parts (`customXml/`), embedded OLE objects, content controls (`w:sdt`), VBA macros, theme files, drawingML shapes that calibre's `docx/to_html.py` strips.
- **PDF→PDF (Class 4).** Everything: layout, font subsetting tables, form fields with their JavaScript actions, annotations, optional content groups (layers), digital signatures, embedded files, structure tree for tagged-PDF accessibility.
- **Comic→Comic (Class 4).** Image bytes verbatim — the user-facing content — plus archive metadata (CBR comments, ComicInfo.xml).
- **EPUB2→EPUB3 (Class 2).** Authored navigation document semantics, embedded fonts in their original encoding (no re-subsetting), original CSS file boundaries (the OEB normalizer flattens CSS into per-file styles).

### B.5 Spine's policy

Spine should expose three modes, with auto-detection picking the right default:

1. **Bridge mode (default for cross-family).** Matches calibre's pipeline. Predictable, well-tested, the right answer for Class 1 and Class 5. Implemented in `spine-convert` over `spine-oeb`.
2. **Direct-pair mode (auto for Class 2).** When source and destination are siblings under one format family, skip the XHTML round-trip. `MOBI→AZW3` and `AZW3→MOBI` route through `spine-mobi` writer8/writer6 directly. `EPUB2→EPUB3` routes through `spine-polish`'s upgrade module (calibre's `oeb/polish/upgrade.py` already implements the pattern).
3. **Polish/passthrough mode (auto for Class 3).** When source format equals destination format and the user's intent is metadata-only or minimal-edit, route to `spine-polish`'s `Container` API. No conversion pipeline runs. EPUB→EPUB metadata edits rewrite OPF in place; MOBI→MOBI edits the EXTH segment of the original PDB without unpacking; PDF→PDF metadata edits update the PDF info dictionary without re-rendering.

Specific behaviors Spine must implement:

- **Detect Class 3 metadata-only conversions and refuse to bridge.** If the user invokes `convert book.epub book.epub --title "New"`, Spine routes to polish, not the conversion pipeline. This is opposite to calibre's GUI default, which sends EPUB→EPUB through the full converter.
- **Detect Class 2 sibling transcoding and use direct paths.** `convert book.mobi book.azw3` is writer8-only; never invokes OEB normalize/transform.
- **Refuse Class 4 with bridge as default.** `convert book.pdf book.pdf` and `convert book.cbz book.cbz` either passthrough (default) or page-edit, never bridge. To bridge a PDF→PDF (which calibre does silently) the user must pass `--force-rebridge`. The default behavior on Class 4 must surface a warning if the user requests a transformation the direct path cannot apply.
- **Make the route observable.** Spine's debug log should record which class was selected and why, so users can verify the system did not silently drop into bridge mode when a direct path was available.

### B.6 Implication for byte-identical claim

The byte-identical conversion contract Spine offers is bounded by route. Calibre's contract is uniform — input → XHTML → output, every time. If Spine's direct-pair routes engage where calibre's pipeline would not, the outputs diverge by construction.

Two contracts must be communicated separately:

- **Bridge mode: byte-identical to calibre.** When Spine is invoked with `--mode=bridge` (or the auto-detect lands on Class 1/5), output is byte-comparable to calibre for the same input under the same options. This is the conformance claim.
- **Direct-pair mode: lossless or near-lossless preservation, not byte-comparable to calibre.** When Spine engages Class 2/3/4 direct paths, the output is *better* than calibre's — preserves what calibre would have stripped — but is *not* the same bytes calibre would emit. Users running golden-file regression tests against calibre output must pin to bridge mode; users prioritizing preservation should accept the divergence.

The byte-identical claim is therefore route-scoped, not global. Documentation must say "byte-identical to calibre on Class 1 and Class 5 routes; preservation-superior on Class 2/3/4 routes." Anything stronger overpromises; anything weaker undersells the design.

---

## §C. Rust Crate Ecosystem Survey

This section is the result of a dedicated audit (April 2026) of crates.io and GitHub for Rust crates across the 20 format domains Spine depends on. The license-compatibility legend used throughout: **GPL-3 OK** = MIT, Apache-2.0, MIT/Apache dual, MPL-2.0, BSD-2/3-Clause, ISC, LGPL-2.1+, GPL-2.0+, GPL-3.0+. **Blocked** = AGPL-only (forces Spine to AGPL), SSPL, BSL, proprietary, non-commercial-only.

### C.1 EPUB read/write

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `epub-builder` | 0.8.3 (2026-04-10) | MPL-2.0 | Production | Write EPUB 2/3, ToC/NCX/nav helpers | Partial | MPL-2.0 file-scoped copyleft is fine in GPL-3 product. Uses `zip` underneath; abstracts the ZIP layer in ways that complicate exact byte-reproduction. Multi-author/multi-language metadata limited. |
| `epub` | 2.1.5 (2025-10-29) | GPL-3.0 | Production | Read EPUB; OPF/spine/cover/metadata extraction | Partial (read-only) | Pure Rust. License matches Spine. 7.6k dl/mo. |
| `epub-parser` | 0.3.4 (2026-02-07) | MIT | Production | Read EPUB; Dublin Core, NCX, spine, cover/images | Partial (read-only) | 139k dl/mo. quick-xml + zip stack. |
| `rbook` | 0.7.6 (2026-04-21) | Apache-2.0 | Beta | Read/build/edit EPUB 2 & 3 | Partial | Active, modern (Rust 2024). MOBI/AZW3 promised but not implemented. |
| `iepub` | 1.3.5 (2026-04-22) | MIT | Beta (low usage) | Read/write EPUB **and MOBI**, EPUB↔MOBI conversion | Partial | Only ~29 dl/mo and Chinese-language docs but actively developed. Single-author project; depend with caution. |

**Verdict:** Use `epub-builder` for OPF/nav generation, but call into a hand-rolled zip layer (see §C.12) that controls mtime/STORED ordering directly. None of these matches calibre's `OEBBook → ZipFile` write path exactly out of the box.

### C.2 MOBI / AZW3 / KF8

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `mobi` | 0.8.0 (2022-12-11) | MIT | Stale-stable | Read MOBI metadata + content; PalmDB+EXTH | No | 91k dl/mo but no commits in 3+ years. AZW3/KF8 not explicitly supported. Read-only. |
| `iepub` | 1.3.5 (2026-04-22) | MIT | Beta | MOBI read **and write**, EPUB↔MOBI | No | Only crate I found with MOBI write. Coverage of KF8 not documented; likely incomplete. |

**Verdict:** **Build-from-scratch territory for AZW3/KF8 write.** Calibre's `calibre/src/calibre/ebooks/mobi/writer8/` is the gold standard (~5-6k LoC Python). Plan: port. `mobi` crate is a useful reference for PalmDB/EXTH parsing only.

### C.3 PDF read

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `lopdf` | 0.40.0 (2026-03-19) | MIT | Production | Low-level PDF read/write/merge, object streams | Yes (object-level control) | 1.1M dl/mo, top-12 in text-processing. Best-in-class for byte-control. |
| `pdfium-render` | 0.9.0 (2026-03-30) | MIT/Apache | Production | High-level wrapper around Google Pdfium for render/extract/edit | No (calls C++) | 98k dl/mo. Requires Pdfium .so/.dll at runtime. Pdfium itself is BSD-3 (OK). |
| `pdf` (pdf-rs) | 0.10.0 (2026-03-02) | MIT | Beta | Read; write experimental | Partial | 12k dl/mo. Pure Rust. |
| `mupdf` | 0.6.0 (2026-01-19) | **AGPL-3.0** | Production | Render + extract; supports PDF/EPUB/CBZ/HTML/SVG | n/a | **License-blocked.** AGPL forces network-use copyleft on the entire Spine server. Skip. |

**Verdict:** `lopdf` for parsing/manipulating PDF objects, `pdfium-render` for text extraction at scale. Skip `mupdf`.

### C.4 PDF write

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `pdf-writer` | 0.14.0 (2025-10-02) | MIT/Apache | Production | Step-by-step low-level PDF writer (Typst project) | Yes | 214k dl/mo, used in 138 crates. Strongly typed builder. |
| `printpdf` | 0.9.1 (2026-02-17) | MIT | Production | Mid-level PDF generator with shapes, fonts, SVG; experimental HTML-to-PDF | Partial | Built on `pdf-writer`. HTML support is stub-quality. |
| `genpdf` | (older) | Apache-2.0 | Stale | High-level layout on top of printpdf | No | Has not kept pace with printpdf releases. |
| `typst` (as library) | 0.14 (2025) | Apache-2.0 | Production | Markup engine emitting PDF/HTML/SVG | n/a (not HTML input) | Excellent layout but Typst markup ≠ HTML. Useful only if Spine adds Typst-templated covers/title pages. |

**Verdict:** No Rust crate matches WeasyPrint's HTML+CSS-Paged-Media → PDF capability. **Spine PDF output from EPUB will need either (a) bundled WeasyPrint via FFI/sidecar, (b) a Typst conversion path, or (c) a custom layout engine on `pdf-writer`.** Document this as deferred — calibre's PDF output uses Qt's WebEngine print, which has no Rust equivalent.

### C.5 DOCX read/write

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `docx-rs` | 0.4.20 (2026-04-02) | MIT | Production | DOCX **write**; WASM-friendly | Partial | 333k dl/mo. Actively maintained. |
| `docx-rust` | 0.1.11 (2026-01-22) | MIT | Production | DOCX read **and** write | Partial | 268k dl/mo. Better fit for Spine since read+write in one crate. |
| `ooxml` | (older) | varied | Beta | OOXML primitives — currently xlsx-only | No | Skip for DOCX. |

**Verdict:** `docx-rust` for round-trip ingest/export. Neither library will match Word's exact byte output, but for Spine's BIBFRAME-projection model that is acceptable.

### C.6 RTF read/write

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `rtf-parser` | 0.4.2 (2024-11-10) | MIT | Beta | Read RTF (1.9 spec, UTF-16) | No (read-only) | 8k dl/mo. WASM-capable. `\bin` and base64 images partial. |
| `rtf-grimoire` | 0.2.1 (2023-04-10) | MIT | Stale | Tokenizer only | No | Useful as a primitive if you write your own parser. |

**Verdict:** Read covered; **no RTF writer exists in Rust**. Calibre's RTF output is hand-rolled — port to Rust if RTF export is needed (~2k LoC).

### C.7 FB2

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `fb2` | 0.4.4 (2023-10-07) | MIT | Stale-stable | Read FB2 via quick-xml/serde; ~95% real-world coverage | No (read-only) | Single maintainer. Edge cases in xs:date/xs:gYear with timezones documented. |

**Verdict:** Read is fine. No FB2 writer in Rust — port from calibre if needed (small).

### C.8 ODT (OpenDocument Text)

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `open-document` | 0.1.0 (2024) | MIT/Apache | Experimental | Read+write ODF stub | No | Minimal. Single contributor. |
| `dotext` | 0.1.1 (2017) | MIT | Abandoned | Text extraction from odt/docx/odp/pdf | No | Rust 2015 edition. Don't use. |
| `litchi` | (placeholder on crates.io; full code on GitHub) | likely MIT | Experimental | Office + ODF + iWork + RTF parsing | No | crates.io version is read-only stub. |

**Verdict:** **Build-from-scratch.** ODT is a zip-of-XML; the `zip` + `quick-xml` stack handles the mechanics. ~3k LoC port from calibre's `oeb/transforms/structure.py` flow.

### C.9 HTML5 parsing

| Crate | Version (date) | License | Maturity | Capability | Calibre fidelity | Notes |
|---|---|---|---|---|---|---|
| `html5ever` | 0.39.0 (2026-03-13) | MIT/Apache | Production | WHATWG-spec parser; no DOM | High | 5.7M dl/mo. Servo. The reference. |
| `scraper` | 0.26.0 (2026-03-18) | ISC | Production | DOM + CSS selector queries on html5ever | High | 1.5M dl/mo. ISC = MIT-equivalent. |
| `kuchikiki` | 0.8.8 (2025-02-22) | MIT | Production (Brave fork) | Tree-walking on html5ever | High | 1.85M dl/mo. Brave-maintained successor of unmaintained kuchiki. Heavier (Rc+RefCell per node). |
| `lol_html` | 2.7.2 (2026-02-22) | BSD-3-Clause | Production | Streaming rewriter (Cloudflare) | Medium | Different model — selector-based stream rewrite. Excellent for transforms but no DOM. |

**Calibre comparability:** Calibre uses its vendored `html5-parser` (C, html5lib-spec compatible). Output of `html5ever` is closest to that spec. **Use html5ever as the parser; layer scraper or kuchikiki for DOM walks.** Expect 1-3% byte-divergence vs calibre on aggressive whitespace normalization; plan to add a calibre-compat-mode normalization pass if exact match is needed.

### C.10 CSS parsing/serialization

| Crate | Version (date) | License | Maturity | Capability | Calibre fidelity | Notes |
|---|---|---|---|---|---|---|
| `cssparser` | 0.37.0 (2026-03-17) | MPL-2.0 | Production | CSS Syntax Level 3 tokenizer + component values | High | 4.4M dl/mo. Mozilla/Servo. Foundation. |
| `selectors` | (Servo) | MPL-2.0 | Production | Selector parsing/matching | High | Pairs with cssparser. |
| `lightningcss` | 1.0.0-alpha.71 (2026-03-09) | MPL-2.0 | Production (despite alpha) | Full parse/transform/minify on top of cssparser+selectors | Medium | 168k dl/mo. Used by 291 crates. Re-orders/optimizes by default — disable transforms for byte-identical projection. |

**Verdict:** For raw parse + serialize matching `tinycss2`/`css-parser` (calibre's vendored Python parser), `cssparser` is the canonical match. **Recommendation:** build Spine's CSS layer on cssparser+selectors directly, mirror calibre's serialization rules.

### C.11 XML serialization

| Crate | Version (date) | License | Maturity | Capability | Calibre fidelity | Notes |
|---|---|---|---|---|---|---|
| `quick-xml` | 0.39.2 (2026-02-20) | MIT | Production | Read+write, serde, namespace-aware | Medium | 19.3M dl/mo. Streaming. Attribute order is preserved on read but not guaranteed on serde write. |
| `xml-rs` | (older) | MIT | Stale | Pull parser | Medium | ~70× slower than quick-xml. Avoid. |
| `roxmltree` | (current) | MIT/Apache | Production | Read-only DOM | n/a | Read-only — useless for write path. |
| `xmltree` | (older) | MIT | Stale | DOM read+write on xml-rs | Low | Avoid. |
| `easy-xml`/`static-xml`/`yaserde` | various | various | Experimental | serde-style codecs | Low | Don't match lxml output. |

**Calibre fidelity:** lxml uses libxml2's serializer with stable attribute order (insertion order) and specific entity escaping. **None of the Rust crates are byte-identical to `lxml.etree.tostring()` out of the box.** Plan: build a thin serializer on top of quick-xml that mirrors lxml's exact rules (attribute order = insertion, indent = none-by-default, double-quoted attrs, `&#xNN;` for control chars). ~500 LoC. This is an accepted cost.

### C.12 ZIP with determinism control

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `zip` (zip-rs/zip2) | 8.5.1 (2026-04-07) | MIT | Production | Read+write, all major compressions, AES, ZIP64 | **Yes** | `FileOptions::last_modified_time()`, `compression_method()`, `unix_permissions()` per entry. Mimetype-first STORED then DEFLATED is fully supported. |
| `async_zip` | 0.0.18 (2025-08-09) | MIT | Beta | Async ZIP, futures+tokio | Partial | Per-entry control via ZipEntryBuilder but less documented. ZIP64. |
| `rc-zip` | (current, bearcove) | MIT/Apache | Beta | Sans-IO state-machine | Yes (in theory) | More architectural fit if Spine wants pluggable I/O layers. |
| `deterministic-zip` | (existing) | MIT | Niche | Wrapper aimed at reproducible builds | Yes | Useful as a reference for the pattern. |

**Verdict:** **`zip` 8.x meets every Spine requirement.** Mimetype-first STORED, all-others DEFLATED, mtime per entry, no extra-field timestamps if `unix_permissions=0`. This is a solved problem.

### C.13 Font subsetting

| Crate | Version (date) | License | Maturity | Capability | Byte-identical | Notes |
|---|---|---|---|---|---|---|
| `allsorts` | 0.16.1 (2025-11-21) | Apache-2.0 | Production | Parse TTF/OTF/CFF/CFF2/WOFF/WOFF2; shape; subset to OpenType | Partial | 31k dl/mo. Extracted from Prince (commercial typesetter). Most complete option. |
| `subsetter` | 0.2.3 (2025-09-09) | MIT/Apache | Production | Subset for **PDF embedding only** (resulting fonts not standalone-usable) | n/a | 290k dl/mo. By Typst team. |
| `ttf-parser` | 0.25.1 (2024-11-29) | MIT/Apache | Production | Read-only parser, zero-alloc | No (read-only) | 5.4M dl/mo. Foundation. |
| `font-kit` | (current) | MIT/Apache | Production | System font lookup/matching | n/a | Discovery-only, no subsetting. **Spine forbids system lookup in deterministic mode.** |

**Verdict:** **`allsorts` is the closest fontTools.subset replacement in Rust.** Won't be byte-identical to fontTools (different optimizer), but produces valid subset OpenType. For EPUB use this is fine — readers care about correctness, not bytes.

### C.14 Image re-encoding

| Crate | Version (date) | License | Maturity | Capability | Pillow/Qt parity | Notes |
|---|---|---|---|---|---|---|
| `image` | 0.25.10 (2026-03-10) | MIT/Apache | Production | Decode/encode JPEG/PNG/GIF/WebP/AVIF/TIFF/BMP/etc | Medium | 9M dl/mo. The default. |
| `mozjpeg` | 0.10.13 (2025-02-18) | **IJG** (BSD-style) | Production | JPEG via libjpeg-turbo+MozJPEG with trellis quant | High (matches mozjpeg byte-for-byte) | IJG license is BSD-style, GPL-compatible. |
| `oxipng` | 10.1.1 (2026-04-22) | MIT | Production | Lossless PNG optimizer | High | 100k dl/mo. Drop-in for `optipng`/`zopflipng` flow. |
| `jpeg-encoder` | (current) | MIT/Apache | Production | Pure-Rust JPEG encoder | Low | Not Pillow-equivalent. |

**Verdict:** `image` for the common path; `mozjpeg` + `oxipng` when matching calibre's `optimize` step is required. Pillow byte-parity is unrealistic — Pillow uses libjpeg via PIL with quantization tables that differ from MozJPEG defaults. Document as known-divergence, not a bug.

### C.15 Encoding detection / conversion

| Crate | Version (date) | License | Maturity | Capability | Notes |
|---|---|---|---|---|---|
| `chardetng` | 1.0.0 (2026-03-30) | Apache-2.0 OR MIT | Production | Encoding detection optimized for legacy web content | 981k dl/mo. By hsivonen (Mozilla). Byte-size optimized (~335KB). v1.0 just shipped. |
| `encoding_rs` | 0.8.35 (2024-10-24) | (Apache OR MIT) AND BSD-3 | Production | Full Encoding Standard implementation | 22M dl/mo. Firefox uses it. The decoder pair for chardetng. |
| `charset-normalizer-rs` | (current) | MIT | Beta | Port of Python charset_normalizer | Less proven than chardetng. |

**Verdict:** **`chardetng` + `encoding_rs` is the canonical pair.** Detection results may differ from Python's `chardet` on edge cases (different algorithm), but quality is generally higher. Acceptable divergence.

### C.16 EPUB font deobfuscation (IDPF + Adobe ADEPT)

**No Rust crate exists.** Search returned no published implementations of either algorithm.

| Algorithm | Spec | Implementation cost |
|---|---|---|
| IDPF | XOR first 1040 bytes with SHA-1(unique-identifier) cycled | ~50 LoC; sha1 already in deps |
| Adobe ADEPT | XOR first 1024 bytes with MD5-derived 16-byte key from urn:uuid: | ~50 LoC |

**Verdict:** Implement directly in `spine-fmt-epub`. Trivial. Calibre's `epub_input.py:42-88` is the spec-translation reference (GPL-3, port-friendly).

### C.17 CHM (Microsoft Compiled HTML Help)

| Crate | Version (date) | License | Maturity | Capability | Notes |
|---|---|---|---|---|---|
| `chmlib` | 1.0.0 (2019-10-20) | LGPL-2.1+ | Abandoned | C-binding to chmlib | 6+ years stale. LGPL-2.1+ is GPL-3-compatible (forward-compatible clause), but the C lib itself is also unmaintained. |

**Verdict:** **Build-from-scratch or port calibre's CHM reader.** Calibre's `src/calibre/ebooks/chm/` is GPL-3 — direct port path.

### C.18 LIT (Microsoft Reader)

**No Rust crate exists.** `file-format` detects LIT but parses nothing.

**Verdict:** Calibre has its own GPL-3 implementation by Marshall T. Vandegrift at `src/calibre/ebooks/lit/` (read + write). Direct port is the only path. ~3-4k LoC. **DRM-bearing LIT files** require external tools regardless — ignore the DRM path.

### C.19 Comic (CBZ/CBR/CB7)

| Crate | Version (date) | License | Maturity | Capability | Notes |
|---|---|---|---|---|---|
| `comiconv` | 0.4.0 (2024-11-12) | Apache-2.0 OR MIT | Production | Read 7Z/CB7, TAR/CBT, ZIP/CBZ; convert images | 758 dl/mo, low usage but functional. |
| `compress_comics` | (current) | varies | Beta | Parallel CBR/CBZ/PDF compression | App, not lib. |

**Verdict:** CBZ is just a zip — handled by §C.12. **CBR (RAR) needs `unrar` or `unrar_rs` (LGPL/RAR-license).** RAR's license is the concern. CB7 needs a 7z lib (`sevenz-rust`, MIT). Plan: trivial ZIP for CBZ, optional CB7 via sevenz-rust, **skip CBR** unless we accept the RAR-license footprint.

### C.20 DjVu

| Crate | Version (date) | License | Maturity | Capability | Notes |
|---|---|---|---|---|---|
| `sndjvu_format` | 0.2.0 (2023-01-30) | MIT/Apache | Stale | Parse + serialize DjVu chunks; no decoder | Pure-Rust, no-std, 2-year-old. |

**Verdict:** Format parsing exists; **rendering/decoding does not exist in Rust**. Calibre uses `djvulibre` (C, GPL-2). For Spine, link to `djvulibre` via FFI as an optional feature, or accept DjVu as input-only-metadata. **Conversion to other formats requires djvulibre or build-from-scratch (years of work — DjVu codecs are arcane).**

### C.21 License compatibility matrix (final)

| License | GPL-3 compatible? | Notes |
|---|---|---|
| MIT, BSD-2/3, ISC | Yes | Most permissive |
| Apache-2.0 | Yes (one-way; cannot ship Apache-licensed in GPL-2-only) | Section 6 alignment with GPL-3 |
| MPL-2.0 | Yes | Per MPL §1.10 / GPL-3 explicit compat. File-scoped copyleft only. |
| LGPL-2.1+, LGPL-3.0 | Yes | Library exception |
| GPL-2.0+, GPL-3.0+ | Yes | Spine's GPL-3 is "+" compatible |
| GPL-2.0 only | **No** | Cannot link GPL-2-only into GPL-3; rare in Rust |
| AGPL-3.0 | Compatible only if Spine adopts AGPL itself | **Effective blocker** — `mupdf-rs` is the canonical example |
| BSL (Sentry, Elastic), SSPL | **No** | Source-available, not free |
| CC-BY-NC | **No** | Non-commercial restriction breaks GPL distribution |
| IJG (libjpeg) | Yes | BSD-style |
| RAR (unrar) | Concerning | Allows reading; restricts redistribution of unpacking code outside its own binaries |

### C.22 Build-vs-buy decision matrix (final)

| Domain | Buy (use crate) | Build (vendor) | Rationale |
|---|---|---|---|
| EPUB | `epub-builder` + `epub`/`epub-parser` | Wrapper for ZIP/mtime determinism | 80% covered by crates; thin wrapper enforces byte-identical ZIP layout |
| MOBI / AZW3 / KF8 | (none) | **Yes — port calibre** | ~5-6k LoC port from `calibre/src/calibre/ebooks/mobi/writer8/` |
| PDF read | `lopdf` + `pdfium-render` | n/a | Both production; pdfium binary distributed per-platform |
| PDF write | `pdf-writer` + (custom layout) | Yes — partial | No HTML→PDF Rust solution; long-term WeasyPrint sidecar or Typst path |
| DOCX | `docx-rust` | Wrapper for byte stability | Read+write coverage decent; not byte-stable to Word |
| HTML5 | `html5ever` + `scraper` or `kuchikiki` | n/a | The Servo parser is canonical |
| CSS | `cssparser` + `selectors` | Calibre-equivalent flatten | Build flatten on top of cssparser; mirror calibre output rules |
| Fonts | `allsorts` (subsetting) + `ttf-parser` (read) | n/a | allsorts is the fontTools-equivalent |
| ZIP | `zip` 8.x | Thin wrapper enforcing rules | All needed control points exist; wrap only to enforce mtime=epoch and entry-order policy |
| Image | `image` + `mozjpeg` + `oxipng` | n/a | Mature crates; accept divergence from Pillow |
| Encoding | `chardetng` + `encoding_rs` | n/a | Mozilla canonical |
| RTF | `rtf-parser` (read) | Yes — write | ~2k LoC writer port |
| FB2 | `fb2` (read) | Yes — write | XML, simple |
| ODT | (none viable) | **Yes — full** | OOXML/ODF mapper is research project |
| LIT, RB, TCR, SNB, PML | (none) | **Yes — port calibre** | All B-tier; vendor calibre's logic |
| CHM | (`chmlib` stale) | **Yes — port calibre** | Direct GPL-3→Rust port |
| DJVU | `sndjvu_format` (parse only) | Optional FFI to djvulibre | C-tier; defer or skip |
| Comic CBZ | `zip` | n/a | Just ZIP |
| Comic CBR | (RAR-license concern) | **Skip** | Document as unsupported |
| Comic CB7 | `sevenz-rust` | n/a | MIT, mature |
| EPUB obfuscation | (none) | Yes — trivial | ~100 LoC inline |
| Markdown | `pulldown-cmark` | n/a | MIT, the standard |

### C.23 Cross-cutting findings

1. **Byte-identical is achievable for ZIP + EPUB structure + image bytes + font subsetting bytes; not achievable for XML, CSS, HTML, PDF.** Calibre's lxml/libxml2 XML serializer, css-parser CSS round-tripper, and html5-parser HTML normalizer all have implementation-specific byte choices that no Rust crate replicates exactly. Spine's pragmatic target is "byte-stable across Spine builds" rather than "byte-identical to lxml" — see §J on upstream tracking.
2. **License footprint:** nothing in the recommended stack is AGPL-only. MPL-2.0 (epub-builder, lightningcss, cssparser) is fine — file-scoped copyleft only. IJG (mozjpeg) is BSD-style. The only blocked candidate is `mupdf` (AGPL), already routed around via pdfium-render.
3. **Build-from-scratch list** (no acceptable Rust crate): MOBI/AZW3/KF8 writer, RTF writer, ODT writer, CHM reader, LIT reader/writer, DjVu decoder (defer/skip), HTML→PDF layout engine (defer to Phase 2 or sidecar WeasyPrint).
4. **Port-from-calibre list** (GPL-3 → Rust, mechanical work): MOBI writer (~5k LoC), LIT reader (~3k LoC), CHM reader (~2k LoC), font deobfuscation (~100 LoC), RTF writer (~2k LoC).
5. **Pdfium dependency:** `pdfium-render` is the realistic PDF render path but ships no binary. Spine will need to bundle Pdfium per platform (BSD-3, ~10MB per ABI). Document as accepted weight.

### C.24 Risk-ranked work items (final)

In priority order:

1. **Vendor a deterministic ZIP wrapper** over `zip` 8.x. Foundational; every ZIP-shaped output depends on it. Effort: 2 days.
2. **Build the MOBI/AZW3/KF8 writer**, port from calibre `mobi/writer8/`. Effort: 4-6 weeks for full byte-identical parity.
3. **Build the OEB pipeline** with the 23 transforms from v1 §2. Effort: 6-8 weeks.
4. **Adopt `cssparser` + `selectors`** and write the calibre-equivalent flatten step. Effort: 2-3 weeks.
5. **Build the EPUB writer** with strict ZIP order (mimetype first stored), using the deterministic wrapper. Effort: 1 week.
6. **Build the lxml-equivalent XML serializer** on top of `quick-xml`. Effort: 1 week (~500 LoC).
7. **Decide on PDF strategy.** Either accept C-tier on PDF I/O, sidecar WeasyPrint, or vendor Pdfium for read-only paths. Effort: scoped after decision.

### C.25 Sources (selected)

- crates.io: [epub-builder](https://crates.io/crates/epub-builder), [epub](https://crates.io/crates/epub), [epub-parser](https://crates.io/crates/epub-parser), [rbook](https://crates.io/crates/rbook), [iepub](https://crates.io/crates/iepub), [mobi](https://crates.io/crates/mobi), [lopdf](https://crates.io/crates/lopdf), [pdfium-render](https://crates.io/crates/pdfium-render), [pdf](https://crates.io/crates/pdf), [mupdf](https://crates.io/crates/mupdf), [pdf-writer](https://crates.io/crates/pdf-writer), [printpdf](https://crates.io/crates/printpdf), [docx-rs](https://crates.io/crates/docx-rs), [docx-rust](https://crates.io/crates/docx-rust), [rtf-parser](https://crates.io/crates/rtf-parser), [fb2](https://crates.io/crates/fb2), [html5ever](https://crates.io/crates/html5ever), [scraper](https://crates.io/crates/scraper), [kuchikiki](https://crates.io/crates/kuchikiki), [lol_html](https://crates.io/crates/lol_html), [cssparser](https://crates.io/crates/cssparser), [lightningcss](https://crates.io/crates/lightningcss), [quick-xml](https://crates.io/crates/quick-xml), [zip](https://crates.io/crates/zip), [allsorts](https://crates.io/crates/allsorts), [subsetter](https://crates.io/crates/subsetter), [ttf-parser](https://crates.io/crates/ttf-parser), [image](https://crates.io/crates/image), [mozjpeg](https://crates.io/crates/mozjpeg), [oxipng](https://crates.io/crates/oxipng), [chardetng](https://crates.io/crates/chardetng), [encoding_rs](https://crates.io/crates/encoding_rs), [chmlib](https://crates.io/crates/chmlib), [comiconv](https://crates.io/crates/comiconv), [sndjvu_format](https://crates.io/crates/sndjvu_format).
- IDPF Font Mangling Spec: <https://idpf.org/epub/20/spec/FontManglingSpec.html>
- Calibre source: <https://github.com/kovidgoyal/calibre>.

---

## §D. Round-Trip Stability Analysis

A round-trip is a conversion `X → Y → X`. The question: does the result equal the original? For long-term archival use of Spine's outputs, this property matters more than byte-identicality with calibre.

### D.1 Round-trip taxonomy

- **Lossless round-trip:** `X → Y → X = X` byte-for-byte.
- **Stable round-trip:** `X → Y → X = X` after one cycle, and `(X → Y → X) → Y → X` equals the same. Idempotent under repeated cycling.
- **Lossy round-trip:** `X → Y → X ≠ X`; information is lost on the cycle.

Of these, only **stable** is practically achievable for cross-family conversions. Lossless is achievable only within Class 3 (passthrough).

### D.2 Pair-by-pair stability assessment

| Pair (X / Y) | Cycle stability | What is lost on the round-trip |
|---|---|---|
| EPUB / EPUB (Class 3 polish) | Lossless | (nothing) |
| EPUB / MOBI | Stable after 1 cycle | EPUB's MathML, JavaScript, fixed-layout pages, embedded SVG fonts, original OPF metadata block ordering |
| EPUB / AZW3 | Stable after 1 cycle | Same as MOBI minus a bit |
| EPUB / DOCX | Lossy | DOCX cannot represent EPUB's spine model; on round-trip, chapter boundaries fuzz |
| EPUB / FB2 | Lossy | FB2's metadata model is incompatible with EPUB's; round-trip destroys subjects, classifiers |
| EPUB / TXT | Catastrophically lossy | All structure, metadata, images |
| EPUB / HTML | Lossy | Single-document HTML loses spine ordering |
| EPUB / PDF | Catastrophically lossy | Reflow → fixed → reflow loses all original layout AND can't reconstruct it |
| MOBI / MOBI (Class 3) | Lossless | (nothing) |
| MOBI / AZW3 (Class 2 direct) | Near-lossless | MOBI 6 features that AZW3 lacks (rare); KF8-only features lost going to MOBI 6 |
| DOCX / DOCX (Class 3) | Lossless | (nothing) |
| PDF / PDF (Class 4 direct) | Lossless | (nothing) |
| Comic / Comic (Class 4 direct) | Lossless | (nothing) |

### D.3 The BIBFRAME-blob round-trip recovery

Spine's secret weapon for round-trip stability: every conversion output embeds the canonical BIBFRAME graph as `META-INF/spine-bibframe.ttl` (in EPUB-shaped outputs) or as a custom EXTH record (in MOBI-shaped outputs) or as an XMP packet (in PDF outputs). On round-trip back to a Spine-aware reader, the BIBFRAME blob is the canonical source — even if the projected metadata in OPF/EXTH/PDF dictionary was lossy or rearranged on the intermediate step, the blob reconstructs the full graph.

This means: **Spine's stable round-trip contract is graph-stable, not byte-stable.** `X →[Spine] Y →[Spine] X'` will not produce `X = X'` byte-for-byte (calibre's quirks may change, EXTH ordering may differ), but the BIBFRAME graph at the start and end is identical. For users archiving libraries this is the contract that matters.

### D.4 What Spine should preserve to maximize round-trip stability

For every output Spine writes, encode:

1. **The full BIBFRAME graph** (Turtle in EPUB's META-INF, base64-Turtle in EXTH 121-126 calibre-leaves-unused, XMP-RDF in PDF).
2. **A `spine:sourceFormat` predicate** indicating the original format ("from EPUB", "from MOBI 6", etc.) so reverse-projection on next cycle prefers the original-format-flavored projection.
3. **A `spine:graphSnapshotHash`** SHA-256 of the canonical N-triples form of the graph at write time, for tamper detection.
4. **A `spine:spineVersion`** indicating which Spine version wrote the file, so future Spine versions can apply migration if needed.

These four predicates, embedded in every output, give Spine a self-healing round-trip discipline that calibre cannot match.

---

## §E. Metadata Fidelity Across Conversions

### E.1 Where metadata leaks in calibre

Calibre's OEB metadata model is a flat list of `Metadata.Item` objects with limited semantics. Each output plugin projects this flat model into a format-specific container:

| Output | Metadata container | Loss on projection |
|---|---|---|
| EPUB OPF | `<dc:*>` + `<meta property="*">` | OPF cannot represent linked-data graphs natively; `<meta property>` works for refinements but is not graph-shaped |
| MOBI EXTH | Numeric type-coded records (100-499) | Most BIBFRAME predicates have no EXTH code; lost |
| DOCX core props | DC subset (title, creator, subject, description, keywords, etc.) | Anything beyond DC is lost |
| FB2 description | FB2's own schema | Map back via custom mapping; lossy |
| PDF info dict | Title, Author, Subject, Keywords, Producer, etc. | Even smaller subset than DOCX |

Calibre's response to this is "metadata is best-effort"; users discover loss only after round-tripping.

### E.2 Spine's BIBFRAME-graph response

Spine carries the full BIBFRAME 2.0 graph through every conversion. The output plugins:

1. **Project to format-native containers** (OPF, EXTH, DOCX core props, PDF info dict) using user-configurable mapping rules. This is what calibre does, but explicit.
2. **Embed the full graph** as a sidecar within the output file. EPUB gets `META-INF/spine-bibframe.ttl`; MOBI gets EXTH records 250-255 reserved as a Spine-private chunked Turtle blob; DOCX gets a `customXml/spineGraph.xml` part; PDF gets an XMP-RDF packet.
3. **Preserve unmodelled predicates.** When projecting BIBFRAME to OPF, predicates without a target slot are still embedded in the sidecar, so a future read recovers them.

### E.3 Specific fidelity gains

Compared to calibre, Spine preserves on every conversion:

- **Multiple identifiers with their schemes intact.** BIBFRAME has `bf:identifier` with `bf:source` qualifier; calibre flattens to `dc:identifier scheme=...` and may pick wrong precedence.
- **Linked data references.** `bf:Work hasInstance bf:Instance hasItem bf:Item` chain. Calibre has no concept of this.
- **Provenance.** `bf:adminMetadata bf:source <http://id.loc.gov/...>` — Spine knows where the metadata came from, calibre does not.
- **Multilingual text.** BIBFRAME predicates with language tags. Calibre's metadata is single-string per field.
- **Subject classification.** BIBFRAME `bf:subject` with `bf:source <fast.oclc.org>` or similar. Calibre's `dc:subject` is a comma-separated string.
- **Confidence and provenance from machine inference.** `spine:confidence` predicate. Calibre has no concept.

### E.4 The metadata dict-iteration-order problem revisited

v1 §3.4 I1 noted that calibre's `for term in metadata` iteration order in `mobi/writer8/exth.py:57` depends on dict insertion order. Spine's BIBFRAME-graph approach gives a stable canonical iteration:

- **Spine emits projected metadata in `(predicate-IRI, language-tag, value-canonical-form)` sort order.**

This is byte-identical-friendly because:
- Same graph → same sorted projection
- Cross-platform stable (no Python-version dict semantics)
- Cross-Spine-version stable (predicate IRIs are URIs, hence stable strings)

Calibre cannot match this without breaking its existing output; therefore Spine in bridge mode must replicate calibre's iteration order, but in direct mode (BIBFRAME-aware paths) Spine is free to use the canonical sort.

---

## §F. Failure Modes and Error Surface

### F.1 The four classes of conversion failure

1. **Tier-floor failures.** The conversion succeeds but at a lower tier than the user expected (B instead of A). Example: EPUB→EPUB without a UUID in metadata. Spine produced output, but byte-identicality is not claimed.
2. **Format-impossibility failures.** The conversion is fundamentally not possible. Example: Class 4 PDF→PDF requested with bridge mode. Spine refuses.
3. **Input-rejection failures.** The input is malformed beyond Spine's repair. Example: corrupt ZIP, encrypted DRM-protected EPUB.
4. **Internal failures.** Spine has a bug. Should never happen but does — handled separately by Sentry-style reporting if user opted in.

### F.2 The error message taxonomy

Spine's CLI/API emits structured errors:

```rust
pub enum ConvertError {
    InputCorrupt { format: Format, detail: String },
    InputDrmProtected { format: Format, scheme: DrmScheme },
    InputUnsupported { format: Format },
    OptionsConflict { left: String, right: String },
    DeterministicModeRejected { reason: DeterministicReject },
    FormatPathRefused { from: Format, to: Format, class: ConvClass, why: RefusalReason },
    InternalError(String),
}

pub enum DeterministicReject {
    InputLacksUuid,
    InputUsesEncryptedFontWithUnknownKey,
    InputContainsHeuristicTriggeringContent,
    InputRequiresSystemFontLookup(String),
}

pub enum RefusalReason {
    Class4BridgeRequiresExplicitFlag,    // PDF→PDF without --force-rebridge
    LegacyTargetWithoutLegacyFlag,        // → MOBI without --legacy-kindle
    AgplDependencyRequired,               // PDF input via mupdf-rs in non-AGPL build
}
```

### F.3 The CLI surface

Every `spine convert` invocation prints a tier badge:

```
$ spine convert input.epub output.mobi --deterministic
[tier A] EPUB → MOBI (bridge mode, deterministic)
  - input identified: EPUB 3.0, 18 spine items, UUID present
  - pipeline: 23 plumber steps applied
  - output: MOBI 6 + KF8 joint, 4.2 MB
  - byte-identical claim: holds against calibre 7.x reference
  - hash: sha256:abc123...
✓ wrote output.mobi (4,213,847 bytes)
```

A degraded conversion is loud:

```
$ spine convert paper.pdf paper.epub
[tier C] PDF → EPUB (bridge mode, NON-deterministic)
  ⚠ PDF input is C-tier — output not byte-identical to calibre
  ⚠ MuPDF text extraction confidence: 0.78 (acceptable)
  - 14 pages extracted, 2 columns detected, header/footer suppressed
  - 12 figures extracted as images, 2 lost (vector-only)
  - heuristic chapter detection: ON (default)
✓ wrote paper.epub (1,402,033 bytes)
  → suggest: spine review paper.epub  to inspect chapter boundaries
```

### F.4 Conversion logs

Every conversion writes a structured log to `<output>.spine-convert.json`:

```json
{
  "spine_version": "0.5.0",
  "calibre_reference_version": "7.15.0",
  "input": { "path": "input.epub", "format": "EPUB-3.0", "sha256": "..." },
  "output": { "path": "output.mobi", "format": "MOBI-6+KF8-joint", "sha256": "..." },
  "mode": "bridge",
  "tier": "A",
  "deterministic": true,
  "deterministic_locks": {
    "build_time": 0,
    "rng_seed": "sha256:abc...",
    "uuid_source": "input-metadata",
    "system_font_lookup": "disabled"
  },
  "pipeline_trace": [/* 23 entries, one per plumber step */],
  "warnings": []
}
```

This log is the audit trail. Re-running with the same input + same log + same Spine version produces the same output, period.

---

## §G. Performance and Parallelism vs Determinism

### G.1 Calibre's serial pipeline

Calibre's conversion is single-process, mostly single-threaded Python (with C extensions for hot paths). A 5MB EPUB-Item → MOBI-Item conversion takes ~3-8 seconds on a modern laptop. Bulk-converting 1,000 Items takes hours.

Spine's Rust core can run vastly faster, **if** parallelism does not break determinism.

### G.2 Where parallelism is safe

| Level | Safe? | Why |
|---|---|---|
| Per-Item (bulk convert N Items) | Yes | Each Item is fully independent |
| Per-spine-item HTML parsing | Yes (with discipline) | Each XHTML doc is independent |
| Per-image re-encoding | Yes | Each image is independent |
| Per-font subsetting | Yes | Each font is independent |
| Per-record MOBI/KF8 record building | Mostly yes | Some records reference others (offset tables) — parallelize the parallelizable parts, serialize the offset assembly |
| Plumber transform application | **No** | Each transform may mutate the OEB tree; transforms are sequential by spec |
| OPF emission | **No** | One OPF per output Item |
| ZIP final assembly | **No** | Bytes are serial |
| EXTH emission | **No** | One EXTH per output |

### G.3 The discipline for safe parallelism

Three rules:

1. **Seeded RNG must be per-task, not per-thread.** Each parallel task gets its own RNG seeded from `(input_hash, task_id)`. Different threads running the same task get the same seed.
2. **No shared mutable state.** Per-task state is owned; no `Arc<Mutex<...>>` over OEB metadata mid-pipeline.
3. **Iteration order over parallel results must be sorted.** Collecting parallel results into a `Vec` requires a final `sort_by_key` to reproduce a deterministic order. The natural sort key is the task's input position (e.g., spine_position).

### G.4 The tokio-vs-rayon question

Spine's HTTP server uses Tokio. The conversion pipeline is CPU-bound, not I/O-bound; Rayon is a better fit:

```rust
// Per-spine-item parsing — Rayon work-stealing
let parsed_items: Vec<_> = oeb.spine.par_iter()
    .map(|item| parse_xhtml(&item.content, det::rng_for_item(item)))
    .collect();
// parsed_items is in spine order because par_iter preserves order on collect
```

For per-Item bulk parallelism, Tokio's `JoinSet` is fine since each Item runs the same pipeline serially internally.

### G.5 The benchmark target

Internal target: **EPUB-Item → MOBI-Item conversion at ≥10× calibre speed**, deterministic-mode equivalent. With careful Rust + Rayon + zero-copy XML, this is achievable. The byte-identical contract holds independently of speedup.

---

## §H. Test Vector Generation

The byte-identical claim is only as good as the test corpus. v1 §7 specified ~80 Items (embodying ≥80 Instances of ≥80 Works); this section specifies the synthetic edge-case vectors that complement it.

### H.1 Edge-case vector list

| Vector | What it tests |
|---|---|
| `001-minimal` | Smallest valid EPUB; baseline that all paths must pass |
| `002-no-uuid` | Input lacks `dc:identifier`; tests U2 deterministic-UUID derivation |
| `003-multi-uuid` | Multiple identifiers with different schemes; tests selection precedence |
| `004-encrypted-fonts-adobe` | Adobe-obfuscated TTF in manifest |
| `005-encrypted-fonts-idpf` | IDPF-obfuscated TTF |
| `006-svg-cover` | SVG cover requiring rasterization (E3 risk) |
| `007-mathml` | MathML in spine items; tests CSS/serialization preservation |
| `008-rtl-arabic` | Right-to-left text with shaping |
| `009-cjk-fonts` | CJK with embedded fonts; tests subsetting determinism |
| `010-mixed-encodings` | Spine items in different declared encodings; tests chardet |
| `011-deeply-nested-toc` | TOC nesting >5 levels; tests `rationalize_play_orders` |
| `012-large-images` | Images that trigger calibre's resize logic; tests F1 (skip in deterministic mode) |
| `013-many-spine-items` | 500-item spine; stresses ID minting + ordering |
| `014-empty-css` | No CSS at all; tests default stylesheet injection |
| `015-conflicting-css` | `!important` battles in user vs author CSS; tests cascade determinism |
| `016-table-heavy` | Lots of tables; tests `LinearizeTables` + `untable` flag |
| `017-fixed-layout` | EPUB with `rendition:layout="pre-paginated"`; ensures Class 1 bridge does not silently linearize |
| `018-javascript` | EPUB with `<script>` in spine; ensures Class 3 polish path preserves it (B+) |
| `019-media-overlay` | EPUB 3 audio synchronization; tests preservation through OEB |
| `020-mathml-svg-fonts` | All three at once; integration regression |

Each vector's input is checked into the corpus repo, with documentation of:
- What the vector tests
- Expected output for each tier of conversion
- Known calibre quirks the vector triggers
- Whether the vector is expected to pass A-tier, B-tier, etc. for each output target

### H.2 Synthetic generation script

A Spine sub-tool `spine-corpus-gen` produces these vectors:

```rust
spine_corpus_gen::generate(GenSpec {
    name: "001-minimal",
    spine_items: 3,
    has_cover: true,
    has_fonts: false,
    metadata: minimal_metadata(),
    output_dir: "fixtures/001-minimal/",
})
```

This is reproducible — same generator version + same spec → same fixture bytes. Critical: when the generator changes, all fixtures regenerate, and the reference outputs must be re-baselined.

### H.3 Adversarial vectors

Beyond edge cases, Spine should ship adversarial vectors that look fine but break naive ports:

- `099-malformed-utf8-bom`: bytes that look like text but are not valid UTF-8 after BOM
- `098-zip-with-spurious-mimetype`: a valid EPUB with a duplicate `mimetype` entry
- `097-opf-with-recursive-includes`: malicious-but-allowed OPF
- `096-mobi-with-future-version`: MOBI claiming version 9 (doesn't exist yet)
- `095-pdf-with-broken-xref`: PDF with damaged xref table that lopdf will recover from differently than mupdf

These are not passed by all converters; they exist to ensure Spine's failure modes are intentional and documented.

---

## §I. User Migration Path

### I.1 The 2026 user

The user is a calibre user with a library of 200-15,000 Items (typically embodying a comparable number of Instances and slightly fewer Works — duplicates, multi-format Items of one Instance, and multi-edition Instances of one Work all show up). Their library is `~/Calibre Library/` containing:

- `metadata.db` — calibre's SQLite catalog (Instance- and Work-level metadata)
- One subdirectory per author / per Instance containing the actual Items (files)
- Various Instance formats (EPUB primary, AZW3 secondary, some PDF, possibly old MOBI)

They want to:
1. Open their library in Spine without converting anything.
2. Trust that Spine's metadata is the same as calibre's.
3. Optionally re-convert to a Spine-canonical format on demand.
4. Continue to read from calibre too (until they decide to stop).

### I.2 Phase 1: Read calibre's library in place

Spine's `calibre-db` crate (the only `calibre-`-prefixed crate per CLAUDE.md) reads `metadata.db` and the on-disk file layout. No conversion. No copying. Spine treats calibre's library as a read-only mirror.

This is the day-1 user experience: install Spine, point it at the calibre library, browse and read.

### I.3 Phase 2: Side-by-side BIBFRAME enrichment

Spine creates `spine.db` in the same library directory (sidecar). On first scan:

1. For each Item, read calibre's Instance/Work metadata from `metadata.db`.
2. Emit a BIBFRAME graph from the metadata projection.
3. Reconcile against `id.loc.gov` (per `PLAN.md` §5).
4. Store the enriched graph in `spine.db`.

The user now has a richer metadata layer over their existing library, without any conversion having happened.

### I.4 Phase 3: Verify calibre-converted outputs match Spine's reproduction

Optional but high-value: for any Item in calibre's library that calibre itself converted (e.g., `book.azw3` Item next to its source `book.epub` Item — both Items embodying the same Instance, in different formats), Spine offers `spine verify-against-calibre`:

```
$ spine verify-against-calibre ~/Calibre\ Library/
Found 1,247 calibre-produced output files
  - 1,189 byte-identical to Spine deterministic-mode reproduction (95.4%)
  - 47 differ in ZIP mtime only (3.8%)
  - 8 differ in EXTH timestamps only (0.6%)
  - 3 differ structurally — see report
✓ Spine and calibre agree on 99.4% of bytes
```

This establishes confidence: the user can trust Spine to produce equivalents going forward.

### I.5 Phase 4: Spine-native re-conversion (opt-in)

User decides "I want my library in Spine-canonical EPUB 3 with embedded BIBFRAME." Runs:

```
$ spine convert-library --target-format=epub --deterministic --bibframe-embed
```

Spine bulk-converts in deterministic mode. Original files are kept; Spine-canonical files go to `EPUB-canonical/` subdir. Calibre is not modified.

### I.6 Phase 5: User stops opening calibre

Eventually the user stops using calibre. `metadata.db` becomes a read-only legacy. `spine.db` is now primary. Calibre can be uninstalled.

This is a 5-phase migration, not a conversion event. **Spine never asks the user to "import" their library.** The library is already there; Spine just sees more of it.

---

## §J. Long-Term Upstream Tracking

### J.1 The upstream-pinning discipline

Spine's byte-identical claim is "byte-identical to calibre `7.X.Y` under the deterministic patch." The pinned calibre version is:

- Stored in `spine-conversion-corpus/CALIBRE_VERSION` as a single line: `7.15.0`.
- Referenced in every release-note as "Spine A.B.C tracks calibre 7.X.Y."
- Bumped on a quarterly review cadence.

### J.2 Quarterly bump procedure

Every quarter:

1. **Diff calibre upstream.** Compare current pinned to `kovidgoyal/calibre` HEAD. Identify changes to `ebooks/conversion/`, `ebooks/oeb/`, `ebooks/mobi/`, `ebooks/epub/`, `utils/zipfile.py`, `utils/img.py`, `utils/fonts/`.
2. **Categorize each change.**
   - **Bug fix that affects bytes:** Spine adopts the bug fix in its port; reference output regenerates; CI re-baselines.
   - **Bug fix that does not affect bytes:** no Spine action needed.
   - **Feature addition:** Spine evaluates if this should be a Spine feature; adopts on Spine's schedule, not calibre's.
   - **Calibre breaking change:** Spine declines. Spine's pinned version is the contract; calibre's evolution is not Spine's concern.
3. **Re-apply deterministic patch.** Identify any source-line drift in the patch's targets; update the patch.
4. **Regenerate reference corpus.** All ~80 Items re-converted with patched calibre.
5. **Audit byte-diffs.** Any change in reference output is reviewed:
   - If calibre fixed a bug → Spine's port should match the fix → CI accepts the new bytes
   - If calibre changed something arbitrarily → Spine evaluates if it's better to stay on the old version
6. **Bump or hold.** Either commit the new pinned version + new references, or hold the bump and document why.
7. **Release Spine.** New Spine version notes the new pinned calibre version.

### J.3 What if calibre breaks our patch?

If a calibre upstream change makes the deterministic patch unmaintainable (e.g., a complete rewrite of `mobi/writer2/main.py`), Spine has options:

1. **Stay on the old pinned calibre.** Spine's contract is "byte-identical to calibre 7.15." Calibre's HEAD is irrelevant. This is fine for years.
2. **Upstream the patch.** Negotiate with kovidgoyal for a deterministic-output mode. Low probability, but the right long-term answer.
3. **Fork calibre.** Maintain `thereprocase/calibre-deterministic` as a long-lived fork. Higher cost, more control.

### J.4 What if calibre makes Spine's claim obsolete?

If Amazon stops accepting MOBI entirely (which they basically have), if PDF output is replaced by something else, if AZW3 is officially retired — Spine's byte-identical claim for those formats becomes a museum exhibit. Strategy:

1. **Document obsolescence.** Per v3 §4, deprecated formats are explicitly listed.
2. **Maintain the byte-identical claim for read-only.** Spine continues to *read* deprecated formats byte-for-byte same as calibre; *writing* may be dropped.
3. **Don't cling.** If a format truly dies, Spine's effort goes to live formats.

### J.5 The 30-year calibration

Spine is positioned for a 30-year horizon (per `CLAUDE.md`). Calibre's pace is one major release a year, plus point releases. Over 30 years:

- Calibre will likely fork or end-of-life. Spine's pinned-version discipline survives both outcomes.
- E-book formats will evolve. Spine's BIBFRAME-graph storage is format-agnostic; output formats can change without graph migration.
- Reference outputs will need migration when formats break. Spine's CI must remain green; format-of-the-day changes are local to Spine's output plugins, not the OEB or graph layers.
- Determinism guarantees may need to weaken or strengthen. Document what is guaranteed in each release.

The byte-identical claim is a contract with the user: "I'll convert your library today, and I'll convert the same library tomorrow, and the bytes will be identical." That contract holds for 30 years if Spine's discipline holds.

---

## Cross-references

- v1: foundational determinism analysis
- v3: 2026 workflow atlas with deprecated-format kill list
- `PLAN.md` §5 (BIBFRAME), §6 (API contract), §8 (repo layout)
- `CLAUDE.md` (architectural locks)
- A local calibre checkout (read-only reference)

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

For an e-book context: *Pride and Prejudice* by Jane Austen is one **Work**. The Penguin Classics 2003 paperback, the Standard Ebooks 2019 EPUB 3, and the Amazon 2012 AZW3 are three distinct **Instances** of that Work. Two byte-different `.epub` files containing the Standard Ebooks 2019 release are two **Items** of that one Instance. Jane Austen is an **Agent** of the Work (role: author); "novels — England — 19th century" is a **Subject** of the Work.

The Work carries authors (Agents) and subjects; the Instance carries format, ISBN, ASIN, publisher, and publication date; the Item carries file UUID, filesystem location, and byte content.

### The byte-identical contract layered on the BIBFRAME triangle

1. **Item-to-Item determinism** — the byte-identical claim. Same input Item bytes + same Spine version + same options → same output Item bytes. This is what "byte-identical" means; it is an Item-level guarantee.
2. **Instance preservation** — the round-trip claim. The output Item embodies the same Instance as the input Item, with no information loss, for Class 1-3 routes (per §B). For Class 5 routes (page-fixed↔reflow boundary, e.g. PDF→EPUB), the conversion synthesizes a *new derived Instance* from a degraded source — Instance preservation does not hold.
3. **Work stability** — the identity claim. The Work — its authors, its language, its subjects — is invariant across all conversions in all classes. Spine preserves Work identity by carrying the BIBFRAME graph through every conversion as a sidecar (`META-INF/spine-bibframe.ttl` in EPUB-shaped Items, EXTH 250-255 in MOBI-shaped Items, XMP-RDF in PDF-shaped Items).

### Vocabulary used in this report

- "Library" = a collection of Items, indexed by Instance and Work URIs.
- "Catalog" = the Instance-and-Work-level index of a library; one row per Instance.
- "Test corpus" = a set of Items, chosen to embody a diverse set of Instances of a diverse set of Works.
- "Conversion" = takes an input Item, produces an output Item. The output Item embodies the same Instance (Class 1-3), a derived Instance (Class 5), or is byte-equivalent to the input Item (Class 3 passthrough).
- "Format" (EPUB, MOBI, PDF, etc.) = a property of the Instance. Instances of one Work in different formats are distinct Instances.
- "Round-trip" = X-Item → Y-Item → X'-Item; asks whether X'-Item embodies the same Instance as X-Item.
- "Polish" = an Item-to-Item edit that does not change the Instance.

Where this report uses "book" colloquially, the precise reading is given in context. In contractual prose, the BIBFRAME vocabulary is used directly. The MOBI format constant `// type 2 = book` in §A is a literal byte-stream comment from the MOBI spec, not BIBFRAME terminology.

End of v2.
