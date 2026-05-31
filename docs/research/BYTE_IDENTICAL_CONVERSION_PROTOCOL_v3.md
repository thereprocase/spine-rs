# Byte-Identical Conversion Protocol v3 — 2026 Workflow Atlas

**Status:** Research report v3 — workflow-focused, 2026-04-25
**Companion docs:** [v1](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md) (foundational determinism analysis), [v2](BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md) (Rust implementation deep-dive)
**Audience:** Product / DX / spec authors deciding which workflows Spine ships first.

---

## 0. Why this version exists

v1 specifies the calibre→Spine byte-identical contract at the source-code level. v2 specifies the Rust implementation. Neither answers the question: **what do Spine users actually do, today and forward, and what should we ship to make those workflows excellent?**

The e-book format landscape in 2026 is bimodal: a handful of formats (EPUB 3, AZW3/KF8, PDF) dominate ≥95% of real conversion volume, and a long tail of historical formats accounts for the rest. Calibre treats them all uniformly — every supported format is a peer plugin. Spine should not. **A workflow-aware tool is one where the common cases are excellent and the rare cases are merely correct.**

This document maps the actual 2026 conversion workflows, makes per-workflow recommendations grounded in the v1/v2 analyses, and explicitly lists formats Spine should de-prioritize, sunset, or refuse outright.

---

## 1. The 2026 Workflow Atlas

### 1.1 Workflow taxonomy

Real conversion volume splits into seven workflow families:

| # | Family | What it is | 2026 frequency |
|---|---|---|---|
| W1 | **Library normalization** | "Convert my whole library to a single canonical format" | Very high |
| W2 | **Author publishing** | Author writes in tool X (Word, Markdown, Pages), exports to EPUB for distribution | Very high |
| W3 | **Send to device** | Pick an Item (or an Instance — Spine picks the device-appropriate Item), push to e-reader (Kindle, Kobo, ReMarkable, Boox) | Very high |
| W4 | **Reformat for reader** | Adjust formatting (font size, margins) for personal preference | High |
| W5 | **Archive ingest** | Pull from PG, Standard Ebooks, Internet Archive, OAPEN, Sci-Hub-likes | Medium-high |
| W6 | **PDF rescue** | Extract reflowable text from a fixed-layout PDF | Medium-high |
| W7 | **Format museum** | Read or migrate an old MOBI/LIT/PDB/LRF | Low and falling |

The workflow each user spends most time in determines what Spine they want.

### 1.2 Format share (2026 estimate)

Based on public data from Standard Ebooks, Project Gutenberg, IDPF/W3C surveys, and platform announcements (Amazon's August 2022 deprecation of MOBI uploads, Apple's 2020 retirement of iBooks Author, Sony Reader's 2014 retirement, Microsoft Reader's 2012 retirement), the **format share for new conversion volume in 2026** is approximately:

| Format | % of new conversions (rough) | Trajectory |
|---|---|---|
| EPUB 3.x (in or out) | ~70% | Growing — universal target |
| AZW3 / KF8 | ~12% | Stable for Kindle. Note: this is *forward-looking conversion volume*, not user-base share — the installed-base picture (~60-70% of users with at least one pre-2022 Kindle) is in §4.1's AZW3 row. The two metrics describe different things and both are relevant. |
| PDF (in) | ~8% | Stable; academic/archive workflow |
| PDF (out) | ~3% | Declining (browsers do this now) |
| DOCX (in) | ~3% | Stable; author-publishing |
| HTML/HTMLZ | ~2% | Stable; web-content ingest |
| MOBI (legacy MOBI 6) | ~1% | Falling — read-only museum |
| TXT/Markdown | ~1% | Stable; technical authoring |
| All other (RTF, ODT, FB2, LIT, PDB, LRF, PML, TCR, SNB, RB, CHM, DJVU, comic) | <1% combined | Falling |

**The implication for Spine: 90% of perceived quality comes from doing EPUB↔EPUB, EPUB↔AZW3, PDF→EPUB, DOCX→EPUB, and HTML→EPUB excellently.** Everything else is a hygiene matter.

---

## 2. Workflow-by-Workflow Recommendations

### W1 — Library Normalization

**What it looks like:** A user has a library of 500-15,000 Items in mixed Instance formats (largely EPUB-Instances and AZW3-Instances with a tail of older formats). They want one canonical format for every Instance, primarily for reading-app consistency and metadata sanity.

**The 2026 canonical target:** **EPUB 3.x.** No exceptions. EPUB 3 is the only format that:
- Is supported as input by every major reader (including Kindle since 2022)
- Has a public, evolving standard (W3C)
- Carries arbitrary metadata via `<meta property>` (which Spine exploits for its BIBFRAME graph)
- Round-trips losslessly via the BIBFRAME-in-`META-INF/spine-bibframe.ttl` carrier

**Spine recommendation for W1:**
1. Default the bulk-convert action to "→ EPUB 3.3, embed BIBFRAME graph."
2. Use **Class 3 passthrough** (see v2 §B if landed) for source files already in EPUB 3 — only edit metadata, do not re-emit content.
3. Use **byte-identical mode** for all conversions so re-running tomorrow produces the same library.
4. Ship a **dry-run / preview** mode that reports which Items will degrade tier (e.g., "300 Items pass A-tier, 20 pass B-tier, 4 are fixed-layout PDF Items that must be excluded or accepted at C-tier").
5. Refuse to overwrite source files; emit to a parallel `EPUB-canonical/` directory.

**Spine non-goal for W1:** Do not promise "byte-identical to calibre" for W1 — promise "byte-identical to itself across reruns of the same Spine version." That is the contract users actually want for a 30-year library.

### W2 — Author Publishing

**What it looks like:** An author writes in DOCX, Markdown, Scrivener-export, or Google Docs export, and wants a clean EPUB for KDP, Kobo Writing Life, Apple Books, Smashwords/Draft2Digital, or self-hosting.

**The 2026 reality:** All major distribution platforms accept EPUB 3 directly. Amazon stopped requiring KindleGen / ebook-convert MOBI in August 2022; Kobo, Apple, and Google have always accepted EPUB.

**Spine recommendation for W2:**
1. **DOCX → EPUB 3** is the highest-value author flow. Spine must do this excellently — match the styling of Microsoft Word's "Save as Web Page, Filtered" export then promote to EPUB, plus preserve track-changes acknowledgement, comments-as-notes, and footnote/endnote round-trip.
2. **Markdown → EPUB** ships with Pandoc-grammar parity (CommonMark + footnotes + tables + math). Vendor `pulldown-cmark` (MIT) plus a math renderer.
3. **Scrivener → EPUB**: support `.scriv` package format directly (it's a directory with RTF + metadata XML). Calibre does not — this is a Spine differentiator.
4. **Google Docs export (DOCX or HTML) → EPUB**: parity with DOCX path; auto-detect Google Docs DOCX exports and apply known clean-ups (Google injects `<span style>` everywhere; calibre's CSSFlattener handles this; Spine's port must too).
5. **Refuse:** AZW3/MOBI as primary author target. Recommend EPUB then let Amazon do the AZW3 conversion server-side. Document the rationale: Amazon has better information than us about what Kindle reader version their customer is using.

### W3 — Send to Device

**What it looks like:** User selects an Instance in their catalog (or, equivalently, an Item that embodies an Instance), presses "send," and an Item — the Instance's matching format Item, possibly converted from another Item in deterministic mode — lands on their reader.

**The 2026 device matrix:**

| Device | Native format | Recommended Spine action |
|---|---|---|
| Kindle (any from 2022+) | EPUB 3 | Send EPUB unchanged. AZW3 conversion is *not needed*. |
| Kindle (pre-2022 firmware) | AZW3 / MOBI | Convert EPUB→AZW3 in byte-identical mode |
| Kobo | EPUB 3, KEPUB | Send EPUB; offer KEPUB-ification (calibre's `unkepubify` / `kepubify` flow) for performance |
| ReMarkable 2 / Pro | EPUB, PDF | Send EPUB; offer PDF render for fixed-layout content |
| Boox (Onyx) | EPUB, PDF, AZW3, FB2 | Send EPUB always |
| Pocketbook | EPUB, FB2, PDF | Send EPUB; legacy library may want FB2 |
| Daylight DC-1 | EPUB | Send EPUB |
| iBooks / Apple Books | EPUB | Send EPUB |
| Generic e-reader | EPUB | Send EPUB |

**Spine recommendation for W3:**
1. **Default: send EPUB 3 unchanged via Class 3 passthrough.** Do not convert if not needed.
2. **AZW3 conversion is W3 critical-path** for users with pre-2022 Kindle firmware (~40-50% of the user base, plus another ~20-30% who occasionally need AZW3 for household lending across mixed-firmware devices) — see §4.1's AZW3 row for installed-base reasoning. Trigger: old Kindle firmware detection or user override. The conversion writer ships first-class per Sprint 16 ADR 019; this is not an opt-in legacy flag.
3. **KEPUB optimization for Kobo** is the main per-device transform Spine should ship — a small 3-step polish (force-render TOC nav, apply Kobo-specific CSS overrides, repackage with Kobo's ZIP layout).
4. **PDF for ReMarkable** is a fixed-layout export, not a reflow conversion — different code path.
5. **Refuse:** silently re-converting an already-good EPUB. The default "send" action should be a copy plus optional KEPUB polish, never a full Plumber pipeline run.

### W4 — Reformat for Reader

**What it looks like:** User wants larger margins, dyslexia-friendly font, line spacing tweaked, embedded fonts subset removed.

**Spine recommendation for W4:**
1. This is the **classic calibre `polish` use case** — operates on a `Container` not via the Plumber pipeline. It is Class 3 (passthrough), explicitly NOT Class 1.
2. Spine's `spine-polish` crate should expose: change-font-size, change-line-height, change-margins, embed-or-remove-fonts, smarten-or-unsmarten-punctuation, fix-cover, clean-up-css, recompress-images.
3. **Determinism is doubly important here** because users polish-and-republish; the same input + same options must produce the same output every time, otherwise diffs accumulate noise.
4. **Don't bridge through XHTML.** Direct OEB-to-OEB.

### W5 — Archive Ingest

**What it looks like:** User pulls EPUBs from Project Gutenberg, Standard Ebooks, Internet Archive, OAPEN, DOAB, etc. Frequently does so in bulk via OPDS feeds or RSS.

**Spine recommendation for W5:**
1. Spine ships **OPDS 1.2 + 2.0 client** that downloads ZIP-of-EPUBs and ingests them with metadata preservation.
2. **Per-source profiles:** Standard Ebooks emits gold-standard EPUBs; pass through with no transformation. Project Gutenberg's EPUBs have known deficiencies (no covers on some, inconsistent metadata); apply a known-corrections profile.
3. **Internet Archive:** offers EPUB, PDF, DJVU, and DAISY. Prefer EPUB if available. PDF→EPUB may be acceptable; DJVU is C-tier (no good Rust path).
4. Spine should track an **archive-profile registry** (community-maintained) of "for source X, prefer format Y, apply transformation Z." This is a differentiator over calibre's one-size-fits-all news recipes.

### W6 — PDF Rescue

**What it looks like:** User has a PDF (academic paper, scanned book, archive scan) and wants reflowable text on their reader.

**The 2026 reality:** PDF rescue is a hard problem. Calibre uses external `pdftohtml` (Poppler) plus a heuristic reflow engine. Quality is poor for anything but text-PDFs that already have a logical reading order.

**Spine recommendation for W6:**
1. **Honest tier C** — no byte-identical claim. Different from calibre by construction.
2. **Multi-backend pipeline:** try MuPDF text extraction first (Rust bindings), fall back to Tesseract OCR if MuPDF returns suspiciously little text (signal: scanned book).
3. **Layout reconstruction:** column detection, header/footer suppression, footnote-vs-body separation. This is a research-grade ML problem; ship a heuristic baseline and integrate `marker` (Apache-2.0, by VikParuchuri) or `nougat` (CC-BY-NC, OCR'd academic papers — no, NC license blocks us).
4. **Output target:** EPUB 3 with `<aside epub:type="footnote">` for footnotes, proper hierarchy from PDF outline.
5. **Refuse silently-bad output:** if the PDF text extraction has < N% confidence, surface a clear "this PDF is image-based; OCR would help" message rather than producing garbage.

### W7 — Format Museum

**What it looks like:** User has a 2008-era MOBI, a 2002-era LIT, an old Palm PDB, an LRF from a Sony Reader. They want to read it on a 2026 device.

**Spine recommendation for W7:**
1. **Read-only support** for legacy formats. Convert into EPUB 3, never write the legacy format back.
2. **B-tier acceptance** — structural fidelity, not byte-identical, is the contract. The legacy formats have parsing quirks that calibre handles in C extensions; Spine's Rust ports may diverge.
3. **No new tooling investment** — vendor or port calibre's existing parsers, do not innovate.
4. **Telemetry-flag**: if Spine sees a format that has been deprecated for >5 years, log it (locally) so the user knows their library will need migration eventually.

---

## 3. Cross-Workflow Concerns

### 3.1 Metadata-edit-only workflow (very high frequency)

A user opens an Item, fixes the author name (a Work-level field), saves. **This must not invoke the conversion pipeline.** It is an OPF edit + ZIP repack — an Item-to-Item polish that updates the Work-level metadata projection without changing the Instance.

**Spine recommendation:**
- `spine-polish edit-metadata` is a Class 3 in-place edit using deterministic ZIP rewrite.
- The BIBFRAME graph in `META-INF/spine-bibframe.ttl` is the source of truth; the OPF `<metadata>` block is a projection generated from the graph at save time.
- Determinism contract: same graph + same Spine version → same OPF bytes.

### 3.2 Cover-update workflow (high frequency)

User downloads a better cover image, applies it. Must not re-convert content.

**Spine recommendation:** Class 3 polish that:
1. Inserts/replaces `cover.jpg` (or named per OPF) in manifest.
2. Updates `<meta name="cover">` and `<item properties="cover-image">`.
3. Repacks ZIP deterministically.
4. Image bytes pass through; no re-encoding.

### 3.3 Bulk metadata fetch + apply

User runs "fetch metadata" against an external service (id.loc.gov, OpenLibrary, Google Books), then applies the result to N Instances (each Instance may have multiple Items that all get the projected metadata).

**Spine recommendation:**
- Fetch is the existing `spine-meta` workflow (operates on Work and Instance URIs).
- Apply is a per-Item Class 3 polish (one polish per Item; all Items of one Instance receive the same projected metadata).
- The byte-identical contract holds *modulo the fetched metadata change*: same input + same fetched metadata → same output.

### 3.4 Bulk format conversion (W1 sub-workflow)

User selects 500 Items (or 500 Instances, choosing the best Item per Instance), converts all to EPUB.

**Spine recommendation:**
- Parallelize at the per-Item level (each Item is independent).
- Within an Item, parallelize at the per-spine-item level (each XHTML document inside the Item is independent — caveat: ID minting must be globally seeded, see v2 §G).
- Show per-Item progress + tier achieved + any degradations.
- Default to "skip if the Item is already in the target Instance format and Class 3 passthrough is available."

---

## 4. Deprecated / Sunset Formats and Flows

This section is a Spine-internal kill list. These formats Spine acknowledges, supports read-only at most, and will not invest in beyond keeping the parsers compiling.

### 4.1 Formats Amazon, Apple, Microsoft, Sony, or Palm have killed

| Format | Killed when | Killed by | Spine policy |
|---|---|---|---|
| **MOBI 6 (PalmDOC-compressed legacy)** | Aug 2022 | Amazon (stopped accepting MOBI uploads) | Read-only B-tier; convert to EPUB on first open. Pre-2010 K1/K2/K3 devices needed it; that hardware is mostly dead. |
| **AZW3 / KF8** | NOT deprecated for the installed base | n/a — read carefully | **First-class output writer.** AZW3 is critical-path for the W3 send-to-device workflow for ~60-70% of users (40-50% own a pre-2022 Kindle that cannot side-load EPUB; another 20-30% occasionally need AZW3 for household lending across mixed-firmware device generations). E-paper hardware lasts 10+ years; Spine serves the installed base, not just new Kindle buyers. The "Amazon now accepts EPUB" trend matters for new uploads, not for the millions of working pre-2022 Kindles. ADR 019 (Sprint 16) ships AZW3 writer as default-listed output, byte-identical to calibre's `ebook-convert` per v1 §3. |
| **MOBI / AZW (very old, pre-KF8)** | 2010 | Amazon (replaced by AZW3) | Read-only B-tier. The thin slice of 2007-2010 Kindle owners who still use those devices is an edge case; recommended path is "user upgrades the file to AZW3 via Spine's AZW3 writer, sideloads that, accepts that the K1/K2 device may not render KF8 features." |
| **Topaz (.azw1)** | 2014 | Amazon (deprecated) | Read-only C-tier; minimal effort |
| **Kindle Format X (KFX)** | n/a — Amazon-only, no public spec | n/a | **Refuse**. KFX has no public spec and changes per Kindle firmware. Spine cannot support it without reverse engineering that has legal exposure. |
| **LIT (Microsoft Reader)** | 2012 | Microsoft (discontinued reader) | Read-only B-tier |
| **iBA (iBooks Author)** | 2020 | Apple (discontinued author tool) | **Refuse**. iBA-format never had broad adoption; users should re-export from Pages or use Apple Books for Authors. |
| **LRF (Sony BBeB)** | 2014 | Sony (Reader EOL) | Read-only B-tier |
| **PalmDOC / .pdb (text)** | 2010 | Palm (company death) | Read-only B-tier; tail of old Palm libraries |
| **eReader (.pdb / Fictionwise)** | 2012 | B&N shut down Fictionwise | Read-only B-tier |
| **PML (Peanut Press)** | 2009 | Defunct | Read-only B-tier |
| **TCR (Psion)** | 2001 | Psion EOL | Read-only C-tier; minimal effort |
| **RB (Rocket eBook / NuvoMedia)** | 2003 | Defunct | Read-only C-tier |
| **SNB (Shanda Bambook)** | ~2014 | Shanda exited Chinese e-reader market | Read-only C-tier |
| **CHM (Microsoft Compiled HTML Help)** | 2014 | Microsoft (still ships, but new use is rare) | Read-only B-tier; mostly seen in old technical books |
| **DJVU** | Stable but niche | Internet Archive primary user | Read-only C-tier; passthrough for archive ingest |

### 4.2 Output formats Spine should NOT write first-party

Spine refuses to ship a first-party writer for these formats. **All are candidates for third-party plugins per ADR 023 (forthcoming) — refused-by-Spine is not refused-by-the-ecosystem.** KFX is the one exception: it stays refused even for plugins per legal exposure (no public spec, reverse-engineering risk).

| Format | Why no first-party writer | Plugin path? | If user asks |
|---|---|---|---|
| **AZW3 / KF8** | **N/A — Spine DOES ship a first-class AZW3 writer.** See §4.1 row above. Sprint 16 / ADR 019. | n/a | Default-listed output; no flag needed. |
| **MOBI 6 (legacy PalmDOC)** | Pre-2010 device fleet is mostly dead; AZW3 writer covers the meaningful Kindle install base; calibre's MOBI 6 writer is full of legacy quirks Spine would have to reproduce for vanishing user count | Yes — community plugin candidate | Recommend AZW3 instead; if the user truly needs MOBI 6 for a specific device, point them at a plugin or the calibre fallback. |
| **KFX** | No public spec | **Refused even for plugins** | Refuse — period. Legal exposure is the gating concern. |
| **LIT (Microsoft Reader)** | Reader EOL'd 2012 | Yes — community plugin candidate | Suggest plugin if one exists, else refuse cleanly. |
| **LRF (Sony BBeB)** | Sony Reader EOL'd 2014 | Yes — community plugin candidate | Same. |
| **iBA (iBooks Author)** | Apple discontinued 2020; format never had broad reach | Yes — community plugin candidate | Suggest re-export from Pages. |
| **RB / TCR / SNB / PML / PalmDOC variants / eReader / PDB-family** | All defunct platforms (NuvoMedia, Psion, Shanda, Peanut Press, Palm, Fictionwise) | Yes — community plugin candidates | Suggest plugin if one exists, else refuse cleanly. |
| **HTML 4** | Superseded by XHTML/HTML5 | n/a (no third-party demand) | Spine emits HTML5 with explicit doctype regardless. |
| **FB2 (FictionBook)** | Niche but real (~5-8% of users — Russian/East-European/Pocketbook fleets) | n/a — first-party write is on the roadmap, opt-in not refused | Ship `spine-fmt-fb2` write-side as opt-in default-off. Read-side is required. |
| **OEB / OPF 1.x** | Predates EPUB; superseded | n/a | Refuse — there is no living target. |

### 4.3 Workflows Spine should NOT support

| Workflow | Why not |
|---|---|
| **DRM stripping** | Legal exposure under DMCA §1201 in the US, CDPA in UK, EU InfoSoc 6(4). Spine must explicitly refuse. Calibre handles this via the `DeDRM` third-party plugin which Spine will not bundle. |
| **News recipes** (calibre's RSS-fetch-and-package) | Live network input is non-deterministic and non-archivable. The 2026 alternative is OPDS. Spine should ship an OPDS client, not a news recipe engine. |
| **Catalog generation in legacy formats** | Calibre's "create catalog" can emit MOBI/AZW3/LRF catalogs. Spine should generate catalogs as EPUB 3 + OPDS 2 only. |
| **Cover-image generation from random color** | calibre's `covers.py` synthetic cover. Aesthetically bad; users should fetch real covers via metadata services. |
| **Batch heuristic processing** | Heuristics are content-dependent and non-deterministic. Make them per-Item opt-in, not bulk. |

### 4.4 Workflows that have moved off-tool

| Workflow | Where it went | Spine response |
|---|---|---|
| **Send-to-Kindle email** | Amazon's web upload + EPUB native acceptance | Spine ships a "send to Kindle" that uses Amazon's API directly when possible, falling back to email only for users without Amazon accounts |
| **Web → EPUB extraction** | Browser-extension readability extractors (Pocket-replaced-by-Mozilla, Reader View, etc.) | Out of scope. Spine accepts URLs into the OPDS workflow, not arbitrary web scraping. |
| **PDF → editable** | Adobe Acrobat, Google Docs, browser PDF tools | Spine handles only PDF→EPUB rescue, not full PDF editing |
| **Format conversion as a service** | Online converters (zamzar, online-convert) | Spine is local-only; no plans to offer a hosted service |

---

## 5. New / Ascending Formats and Workflows (2026+)

### 5.1 Things Spine should track

| Trend | Status | Spine action |
|---|---|---|
| **EPUB 3.3** ratified W3C 2023 | Current canon | Primary target; ensure full conformance |
| **Audiobook + EPUB media overlay** | Stable spec, growing adoption | Ship media overlay support in `spine-fmt-epub` reader path; defer write-side |
| **LCP (Readium License Content Protection)** | Open-source DRM alternative gaining adoption (Bibliotheca, Aldiko) | Refuse to defeat LCP; allow LCP-protected content to be stored if Spine is just a manager |
| **Web Publication** (W3C draft) | Slow; may not ship | Watch; do not invest |
| **Standard Ebooks production toolchain** | High-quality EPUBs with semantic markup, Schema.org, BIBFRAME-friendly | Use as ground truth for Spine's quality bar; collaborate on metadata schema |
| **AI-generated content → ebook pipeline** | Rapidly emerging | Out of scope for byte-identical; relevant for ingest |
| **PWA-as-ebook** | Niche | Watch; do not invest |
| **Apple Books fixed-layout EPUB extensions** | Stable, vendor-extension | Read-tolerate, write-decline |
| **KFX** | Amazon-only, no spec | Refuse |
| **Audiobook formats (M4B, AAX)** | Adjacent product space | Out of scope for Spine 1.x |

### 5.2 The BIBFRAME wave

LoC and the international library community are consolidating on BIBFRAME 2.0 for cataloging metadata (replacing MARC21 over the 2025-2030 window). Major library systems (Folio, ExLibris Alma, Polaris) are adding BIBFRAME-native ingest paths.

**This is Spine's primary architectural advantage and 2026's most important e-book industry shift.** Spine's BIBFRAME-native model (per `PLAN.md` §5) is positioned to interop natively with the next generation of library systems. v3 captures this here because **most users do not yet know they will want this** — but the library/research community already does, and consumer tools are downstream.

**Spine recommendations for the BIBFRAME wave:**
1. Default every conversion output to embed the BIBFRAME graph in `META-INF/spine-bibframe.ttl` plus `<meta property="bf:*">` projections in OPF.
2. Treat MARC21 input as a first-class ingest format alongside EPUB/PDF — many archive sources still emit MARC.
3. Ship an OPDS 2 + BIBFRAME catalog feature so a Spine library is itself a queryable linked-data endpoint.
4. Ensure the `id.loc.gov` reconcile-first flow (per `PLAN.md` §5) is on the default ingest path, not opt-in.

---

## 6. Per-Workflow Recommendation Summary Table

| Workflow | Default action | Tier target | Class | Time budget |
|---|---|---|---|---|
| W1 Library normalize | → EPUB 3 Instance, BIBFRAME-embedded, deterministic | A | Mostly 1, some 3 | 30s/Item median |
| W2 Author publish (DOCX→EPUB) | DOCX→OEB→EPUB 3, full graph | B | 1 | 5s |
| W2 Author publish (Markdown→EPUB) | Markdown→OEB→EPUB 3 | A | 1 | 1s |
| W2 Author publish (Scrivener→EPUB) | Scrivener-native ingest, then OEB→EPUB 3 | B | 1 | 10s |
| W3 Send EPUB to Kindle 2022+ | Pass-through, no conversion | A | 3 | <1s |
| W3 Send EPUB to Kobo | Pass-through + KEPUB polish (optional) | A | 3 | <1s |
| W3 Send EPUB to legacy Kindle | EPUB→AZW3 byte-identical mode | A | 1 | 5s |
| W4 Polish (font/margin/etc.) | In-place OEB edit | A | 3 | 1s |
| W5 Archive ingest (Standard Ebooks) | Pass-through with metadata enrich | A | 3 | <1s |
| W5 Archive ingest (Project Gutenberg) | EPUB ingest + corrections profile + metadata enrich | A | 3 | 2s |
| W5 Archive ingest (PDF/DJVU) | Convert to EPUB | C | 1 | 30s |
| W6 PDF rescue (text PDF) | MuPDF extract + EPUB emit | C | 1 | 10s |
| W6 PDF rescue (scanned) | Tesseract OCR + EPUB emit | C | 1 | 60s+ |
| W7 Read legacy MOBI/LIT/etc. | Read-only render in viewer | n/a | n/a | <1s |
| W7 Migrate legacy → EPUB | Format-specific input + OEB→EPUB | B | 1 | 5s |

---

## 7. UX Implications

The default UI of Spine should reflect the workflow distribution:

- **The "Convert" verb is overloaded in calibre.** It means metadata-edit, format-convert, polish, and send. Spine should split:
  - `Edit metadata` (W4 sub, Class 3) — single-click action on selection, instant
  - `Polish` (W4) — submenu with check-boxed transforms, runs in-place
  - `Convert` (W1, W2, W6) — opens a per-Item or bulk dialog with target-Instance-format selection
  - `Send to <device>` (W3) — auto-detects connected device, picks best format
- **Heuristics are not surfaced by default.** They are an "Advanced" tab, default off, and emit a non-deterministic-warning if engaged.
- **Tier downgrade is communicated.** When a conversion can only achieve B-tier (DOCX→EPUB) or C-tier (PDF→EPUB), the dialog says so before the user clicks Convert, and the result includes a tier badge.

---

## 8. Cross-references

- v1: foundational determinism analysis — non-determinism inventory, verification protocol, calibre source-line citations
- v2: Rust implementation deep-dive — EPUB→MOBI worked example, XHTML-bridge analysis, Rust crate ecosystem
- `PLAN.md` §5 (BIBFRAME data model), §6 (API contract), §8 (repo layout) — Spine's architectural foundation
- `docs/CALIBRE_INVENTORY.md` — exhaustive feature inventory of calibre

---

## 9. Open questions for v3

- Q1. Should Spine ship a calibre-import migration tool that maps a calibre library + its conversion preferences into Spine workflow profiles? Recommended yes, low cost, high value.
- Q2. How does Spine handle the "user gave me a KFX file" case? Best UX is "we cannot read this; here's a link to a third-party tool that can."
- Q3. Should Spine ship as a full GUI app on day 1 or CLI-first with the GUI as a Tauri shell over the same `spine-srv` API? Per `PLAN.md`, the answer is the latter.
- Q4. What is the canonical "default Spine library output format" for a brand-new library? Recommendation: EPUB 3.3 + BIBFRAME-embedded + deterministic mode on, period.
- Q5. Does Spine ever ship a writer for AZW3, given Amazon now ingests EPUB? Recommendation: yes, but as a "legacy device support" opt-in, not the default. Some users still have pre-2022 Kindles.

---

## Appendix — BIBFRAME Vocabulary Used in This Report

This report uses BIBFRAME 2.0 terminology to make the workflow recommendations precise. The vocabulary is anchored in the [Library of Congress BIBFRAME 2.0 Model](https://www.loc.gov/bibframe/docs/bibframe2-model.html) overview (April 21, 2016), quoted verbatim:

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

For an e-book context: *Pride and Prejudice* by Jane Austen is one **Work**. The Penguin Classics 2003 paperback, the Standard Ebooks 2019 EPUB 3, and the Amazon 2012 AZW3 are three distinct **Instances** of that Work. Two byte-different `.epub` files containing the Standard Ebooks 2019 release are two **Items** of that one Instance. Jane Austen is an **Agent** of the Work; "novels — England — 19th century" is a **Subject** of the Work.

### How this maps to Spine's workflows

- **W1 Library normalize**: a fan-out from one Instance (the user's source Instance, e.g. AZW3) to a new Instance (canonical EPUB 3) via Item-level conversion. The Work is unchanged.
- **W2 Author publish**: synthesizes a new Instance (the EPUB-3-for-distribution) from a source Instance (DOCX, Markdown). The Work is the same Work the author is creating.
- **W3 Send to device**: picks an Item that embodies the desired Instance for the device's preferred format. May convert if the device demands a different format Instance.
- **W4 Polish**: an Item-to-Item edit. Instance unchanged.
- **W5 Archive ingest**: imports Items embodying Instances of Works. The reconcile-first flow against `id.loc.gov` is *Work-level identification* — Spine looks up the Work URI, then identifies which Instance(s) the Item embodies.
- **W6 PDF rescue**: synthesizes a new derived Instance (EPUB) from a source PDF Instance. Work-level invariant; Instance is new.
- **W7 Format museum**: read-only support for Items of legacy Instance formats. No new Items created (until migration to a current Instance format).

### Format share and deprecated-formats — at the Instance level

When this report says "format share" or "deprecated formats," the *format* is a property of the Instance, not the Work or Item. *Pride and Prejudice* (Work) is not deprecated; the LIT-Microsoft-Reader-Instances of *Pride and Prejudice* are deprecated. The user has Items that embody those LIT Instances; Spine read-only-supports those Items and recommends migrating to a currently-published Instance format (EPUB 3).

### Vocabulary used in this report

- "Library" = a collection of Items, indexed by Instance and Work URIs.
- "Catalog" = the Instance-and-Work-level index of a library; one row per Instance (or one row per Work with Instance facets).
- "Send to device" = ship an Item to a device; if the device requires a different Instance format than the user's Item embodies, Spine converts.
- "Reformat" / "Polish" = an Item-to-Item edit that does not change the Instance.
- "Pass-through" = ship an Item without conversion; the Instance is unchanged.
- "Convert" = produce a new Item that may embody the same Instance (Class 1-3) or a derived Instance (Class 5).
- "Format" (EPUB, MOBI, PDF, etc.) = a property of the Instance; Instances of one Work in different formats are distinct Instances.

Where this report uses "book" colloquially (for example "User opens a book"), the precise BIBFRAME reading is given in context. In contractual prose, the BIBFRAME vocabulary is used directly. Proper nouns ("Standard Ebooks," "Apple Books," "iBooks Author," "Pocketbook," "Audiobook") and code identifiers (`rbook`, `iepub`, `ebook-convert`) are unchanged.

End of v3.
