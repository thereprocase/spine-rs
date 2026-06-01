# Spine — design plan

A plan for a Rust-core e-book library manager with a modern split frontend: a solid library model, real metadata sources, and a conversion pipeline, on a foundation designed from day one to reach phones, not just desktops — no Qt, no QtWebEngine, no desktop-only idiom. Where Spine ports proven, format-specific logic from the upstream [calibre](https://github.com/kovidgoyal/calibre) project (GPL-3.0), it credits it; see §10.

Primary platforms: **Windows, macOS, Linux, Android.** iOS is welcome if it doesn't cost extra — meaning if the React Native mobile codebase happens to compile for it and Apple's free developer provisioning is enough to sideload. No App Store spend.

---

## 1. Fork, and why there will be two repos

- **`thereprocase/calibre`** — clean fork of `kovidgoyal/calibre`. Kept as the reference implementation, the license lineage, and a pullable upstream (`git remote add upstream kovidgoyal/calibre`) for format fixes and metadata-source patches we want to port. No invasive changes land here. Occasional cherry-picks back out.
- **`thereprocase/spine`** *(pending `crates.io` / `npm` / domain availability check — fallback **ledger**)* — new repo, new language choices, new architecture. GPL-3.0 because we will inevitably port algorithmic decisions and format-specific quirks from upstream calibre, and even under a clean-room interpretation keeping the same license avoids every future "is this derivative?" argument. README and per-crate `NOTICE` files point back to upstream calibre for attribution.

**On the name.** Spine is named on its own terms, not as a derivative brand. **Spine** is the EPUB-spec term for a book's ordered content list — native to the domain, short, and with no collision with active projects on first check. (A new project in this category should pick a distinctive name rather than one adjacent to an existing tool's, both to stand on its own and to avoid any trademark ambiguity.)

Why two repos and not one branch: calibre's `master` moves ~50 commits/week. A divergent rewrite inside the same repo either blocks upstream syncs or becomes a permanent orphan branch. A sibling repo lets us cherry-pick from the fork whenever upstream fixes a format parser we care about, without merge-conflict archaeology.

---

## 2. Architecture at a glance

```
           ┌──────────────────────────────────────────────────────────┐
           │   Frontends (any language, any platform, any era)        │
           │                                                          │
           │   - Tauri 2 + React        (desktop: Win/Mac/Linux)      │
           │   - React Native + Expo    (Android, iOS-if-free)        │
           │   - (later, anyone)        Swift/Kotlin/web/TV/terminal  │
           └───────────────────────────┬──────────────────────────────┘
                                       │
                  One API contract (HTTP/OpenAPI shape, serde types).
                  Transport is deployment-specific, cheapest that works:
                                       │
       ┌───────────────────────────────┼──────────────────────────────┐
       │                               │                              │
   ┌───▼────────────────┐  ┌───────────▼─────────────┐  ┌─────────────▼──────┐
   │ In-process direct  │  │ Local sidecar via       │  │ Remote over        │
   │ function call      │  │ Unix Domain Socket /    │  │ TCP + TLS + auth   │
   │ (1-5 μs w/ serde)  │  │ Named Pipe (10-50 μs)   │  │ (LAN or Internet)  │
   │                    │  │                         │  │                    │
   │ Tauri commands →   │  │ UDS on Linux/macOS      │  │ Plex-for-books,    │
   │   axum handlers    │  │ Named Pipes on Windows  │  │ NAS-hosted, VPS    │
   │ RN TurboModule →   │  │ No TCP port bound       │  │ Third-party iOS,   │
   │   axum handlers    │  │ Filesystem-permissioned │  │ TV, watch, browser │
   └────────┬───────────┘  └────────────┬────────────┘  └──────────┬─────────┘
            │                           │                          │
            └───────────────────────────┴──────────────────────────┘
                                       │
           ┌───────────────────────────▼──────────────────────────────┐
           │   spine-srv  (the only thing that matters long-term)   │
           │                                                          │
           │   axum router + handlers, OpenAPI-specified, versioned   │
           │   - REST /api/v1/ (library, books, metadata, convert, …) │
           │   - OPDS /opds/ (read-only catalog)                      │
           │   - WebSocket /ws/ (live updates, progress)              │
           │                                                          │
           │   Callable three ways, identical semantics:              │
           │   (a) tower::Service::call directly in Rust              │
           │   (b) mounted on UDS/Named Pipe listener                 │
           │   (c) mounted on TCP+TLS listener                        │
           │                                                          │
           │   Embeds (in-process, Rust call graph):                  │
           │     calibre-db • spine-db • spine-bf •                   │
           │     spine-marc • spine-onix • spine-dc •                 │
           │     spine-epub-meta • spine-oeb •                        │
           │     spine-fmt-* • spine-meta                             │
           └──────────────────────────────────────────────────────────┘

           ┌──────────────────────────────────────────────────────────┐
           │   Third-party native deps                                │
           │   rusqlite • html5ever • lopdf • pdfium • freetype       │
           │   hunspell • libicu (system or bundled)                  │
           └──────────────────────────────────────────────────────────┘
```

The seam is **the API contract, not a language boundary**. Everything below the seam is headless Rust, testable without a display, cross-compiles to seven ABIs (x86_64 / aarch64 × Windows / macOS / Linux / Android / iOS). Everything above the seam is whatever that platform does best. The `spine-api` crate defines request/response types in Rust via serde; a build step generates matching TypeScript via `typeshare`. Frontends consume these generated types so the contract is single-sourced.

**The transport is never TCP loopback.** A frontend sharing a machine with the server uses in-process calls or a Unix Domain Socket / Named Pipe — no port bound, no firewall surface, no AV inspection, permissioned by the filesystem. TCP is reserved for genuinely remote deployments, where it's paired with TLS and token auth.

---

## 3. Demolition list (what we deliberately leave out)

Direct carryover from our earlier conversation; dated here for the PR body.

**Dead formats.** LIT, LRF, LRS, LRX, PDB, PML, SNB, TCR. Dead-format parsers take `msdes/`, `lzx/`, LRF paths in `speedup.c`, and ~15 kLOC of Python with them. CHM kept as optional input only if someone screams.

**The 1500 news recipes.** Graveyard of broken scrapers. Cut from v1. If revived in v2, they become a separate TypeScript+Cheerio package, not shipped in-core.

**The Qt ebook editor.** Dead without QtWebEngine. No modern replacement plan. Sigil exists; it's fine.

**A bespoke custom HTTP server.** Upstream ships its own. We use axum.

**Device plugins.** Calibre's USB-to-Kindle plugin architecture. The new phone *is* the device. If someone needs desktop→reader sync later, resurface via a thin WebUSB/MTP plugin on the Tauri side only.

**UniFFI and per-language core bindings.** We previously planned a `calibre-ffi` crate with UniFFI-generated Kotlin/Swift bindings. Dropped. Frontends never link the core library — they always go through `spine-srv`'s HTTP-shaped API, which is served in-process via Tauri commands / RN TurboModule, over a UDS/Named Pipe for same-machine sidecars, or over TCP+TLS for remote. One contract, three transports, zero per-language binding generators.

---

## 4. Port list (what we keep, what we rewrite)

**OEB intermediate representation.** Calibre's actual innovation. HTML + CSS + images in a zip, orchestrated by a pipeline. Port the *pipeline contract* to Rust; keep it format-agnostic. Each format plugin reads into OEB, OEB gets transformed, each format plugin writes from OEB. This shape stays.

**Library DB layer.** Port `calibre.db.cache.Cache` + `calibre.db.backend.DB` to Rust + `rusqlite` + `serde`. Keep the `metadata.db` schema byte-compatible so a calibre user can point our app at their existing library and it Just Works. This is load-bearing for adoption.

**Format parsers.**
- EPUB: Rust has several starter crates; expect to write our own for write support. Read is easy (it's a zip + XHTML), write is where calibre's details matter.
- MOBI/AZW3: port from calibre. This is where calibre's code is genuinely valuable — the format is underspecified and calibre is the de facto reference.
- PDF: `pdfium` via `pdfium-render` for input; `lopdf` or a genpdf-style wrapper for output. We will lose some of calibre's PDF-input heuristics and will have to port them over time.
- DOCX: `docx-rs` for input, same for output. Calibre's DOCX support is solid; port specific fixups as we hit them.
- TXT / HTML: trivial.
- FB2 / RTF: straight port from calibre, low complexity.

**Metadata sources.** Reordered: MARC-native first, commercial scrapers as fallback. Calibre's metadata pipeline was built backwards — it optimizes for Amazon's product catalog, which is why "pubdate" in calibre means "when this SKU became available for sale," not "when the work was written." We flip it:

1. **Library of Congress SRU** — free HTTP API to the LoC catalog, returns MARCXML. Primary source for anything published in the US since roughly forever.
2. **OpenLibrary** — publishes full MARC dumps under CC0; has a structured API that returns MARC-ish JSON plus raw MARC records for many books. Free.
3. **Z39.50 / SRU to other national libraries** (BL, DNB, BNF) — for European and non-English works that LoC has weaker coverage of.
4. **OCLC WorldCat Search API** — best coverage but costs money at non-trivial scale. Optional, opt-in.
5. **Amazon / Google Books / Goodreads** — scrape-based, Dublin-Core-shaped, becomes the fallback for the commercial long tail (contemporary fiction, self-published, textbook editions) that library catalogs underserve. Results get upgraded to a minimal MARC record via DC→MARC crosswalk at ingest.

Each source is its own Rust module under `spine-meta`. Ingest normalizes everything to a MARC21 record before it touches `spine.db`. The Dublin-Core-shaped sources get "cast upward" via a DC→MARC crosswalk (LoC publishes one; it's lossy but deterministic).

**C extensions worth modernizing not porting.**
- `html5-parser` (calibre's own) → `html5ever` (Servo).
- `podofo` → `lopdf` + `pdfium`.
- `icu.c` → `icu` / `icu_collations` Rust crates.
- `hunspell` → `hunspell-rs` or FFI to system hunspell.
- `speedup.c`, `matcher.c`, `imageops` → native Rust, should be faster anyway.

**Viewer.** Drop calibre's QtWebEngine viewer entirely. Use **foliate-js** inside a WebView on every platform. It's MIT, actively maintained, and renders EPUB + annotations + TTS in a browser. Saves months. One of the biggest single wins in this plan.

---

## 5. Metadata: BIBFRAME 2.0-native, everything else mapped in

Spine's internal metadata truth is **BIBFRAME 2.0**, the Library of Congress's RDF/linked-data successor to MARC21. Every other bibliographic format Spine touches — MARC21, ONIX 3.0, EPUB 3.3 package metadata, FRBR, Dublin Core — is mapped into BIBFRAME on ingest and projected out of BIBFRAME on export. This is the single decision that separates Spine from every other e-book manager on the planet.

### Why BIBFRAME 2.0 and not MARC21

MARC21 (1968) encodes more metadata than any consumer format, but it's a flat record format with positional encoding, opaque field codes, and no native linking model. We considered MARC21 first; BIBFRAME is strictly better for a 2026+ project:

- **BIBFRAME is RDF.** Every fact is a triple; every resource has a URI; graphs merge cleanly; external authorities (LoC name authority, VIAF, ISNI, LCSH) are first-class citizens via URI linking.
- **BIBFRAME encodes FRBR directly.** Three core classes — `bf:Work` (the conceptual creation), `bf:Instance` (a specific published embodiment), `bf:Item` (your actual copy) — map cleanly to FRBR Work/Manifestation/Item, with Expression folded into Work-with-properties. "Frankenstein 1818" vs "Frankenstein 1831 revised" vs "Standard Ebooks' 2023 EPUB of the 1818 text" is three resources with the right relationships, not three tag conventions.
- **BIBFRAME is forward-compatible.** LoC adopted it as official in 2016; BIBFRAME 2.0 shipped in 2016, 2.2 in 2019; research libraries are actively migrating from MARC to BIBFRAME. Every future library data source will serve BIBFRAME natively; MARC becomes the legacy input path.
- **BIBFRAME is extensible.** Mix in vocabularies from Schema.org, Dublin Core Terms, FOAF, SKOS, ONIX — the RDF graph just gets richer. No "we'd need to add a subfield" arguments with a standards committee; add a new predicate URI.
- **MARC21 maps into BIBFRAME losslessly.** LoC publishes `marc2bibframe2`, a canonical XSLT conversion with hundreds of documented field-to-predicate mappings. We port this to Rust. MARC records ingested from LoC arrive as MARC, leave our ingest pipeline as BIBFRAME, round-trip back to MARC via `bibframe2marc` if we ever need to export MARCXML.

The rant that motivated this whole thread — librarians solved scholarly date modeling in 1968 — still holds. MARC21 has the fields. BIBFRAME 2.0 has the fields *and* the relationships *and* the authority linking *and* the extensibility. We pick the superset.

### What the model captures

The three core BIBFRAME classes per book:

| Class | Represents | Example |
|---|---|---|
| **`bf:Work`** | Conceptual creation | "Frankenstein" the novel |
| **`bf:Instance`** | Specific material embodiment | Standard Ebooks' 2023 EPUB edition of the 1818 text |
| **`bf:Item`** | Your actual copy | `/library/frankenstein.epub` with bookmark at ch. 12 |

Plus supporting classes: `bf:Agent` (people, orgs, with roles: creator, translator, editor, illustrator, narrator), `bf:Subject`, `bf:Topic`, `bf:GenreForm`, `bf:Event`, `bf:Place`, `bf:AdminMetadata` for cataloging provenance.

What this captures vs. calibre's flat model (partial list):

| Data type | Calibre flat model | Spine BIBFRAME |
|---|---|---|
| Original composition date | ✗ (custom column hack) | `bf:originDate` on `bf:Work` |
| Edition publication date | `pubdate` (ambiguous) | `bf:publication`/`bf:date` on `bf:Instance` |
| Multiple editions of same work | ✗ (separate library entries) | One Work → N Instances |
| Translators, illustrators, editors | Author field, awkward | `bf:Agent` with role |
| Serialization history | Notes field if anything | `bf:Event` nodes with dates and places |
| Canterbury-Tales-class compositions | ✗ | Multiple `bf:originDate`, `bf:hasExpression` chain, `bf:note` |
| Authority-controlled subjects | Free-text tags | `bf:Subject` → LoC/FAST/VIAF URI |
| "X is a sequel to Y" | Series number | `rdac:succeededBy` / `bf:relation` |
| "X is a translation of Y" | ✗ | `bf:translation` / `bf:translationOf` |
| Adaptation chains | ✗ | `bf:derivativeOf` graph |
| Reading progress, bookmarks, annotations | Inconsistent sidecar files | `bf:Item` properties, SPARQL-queryable |
| Multiple copies of same edition | ✗ | N `bf:Item` → 1 `bf:Instance` |
| Cataloging provenance | ✗ | `bf:AdminMetadata` node |

### Storage model

`spine.db` is a SQLite file containing an **RDF triple store with named graphs**. One named graph per book, keyed by `metadata.db.books.uuid`, plus shared graphs for authorities (authors, subjects, places, publishers) that link across books.

Schema uses **dictionary-encoded terms** (term IDs in the triples table, not inlined literals) so that long `bf:note` literals and repeated URIs don't balloon the primary key or index size. This is what Jena TDB, Blazegraph, Virtuoso, and Oxigraph's native backends all do:

```sql
CREATE TABLE terms (
    id       INTEGER PRIMARY KEY,
    kind     INTEGER NOT NULL,     -- 0=URI, 1=literal, 2=blank
    value    TEXT NOT NULL,
    datatype TEXT,                 -- xsd type for typed literals
    language TEXT,                 -- BCP 47 for lang-tagged literals
    UNIQUE (kind, value, datatype, language)
);

CREATE TABLE triples (
    graph_id     INTEGER NOT NULL,
    subject_id   INTEGER NOT NULL,
    predicate_id INTEGER NOT NULL,
    object_id    INTEGER NOT NULL,
    PRIMARY KEY (graph_id, subject_id, predicate_id, object_id)
);
CREATE INDEX idx_triples_spo ON triples(subject_id, predicate_id, object_id);
CREATE INDEX idx_triples_pos ON triples(predicate_id, object_id, subject_id);
CREATE INDEX idx_triples_gsp ON triples(graph_id, subject_id, predicate_id);

CREATE TABLE graphs (
    id            INTEGER PRIMARY KEY,
    name          TEXT UNIQUE NOT NULL,
    book_uuid     TEXT REFERENCES books(uuid),   -- NULL for shared authority/inference/asserted graphs
    graph_kind    TEXT NOT NULL,                 -- "book-asserted", "book-inferred", "authority", ...
    created       TEXT NOT NULL,
    updated       TEXT NOT NULL,
    source        TEXT,                           -- "loc-sru", "openlibrary", "onix", "user", ...
    source_id     TEXT,                           -- upstream record ID for provenance
    bf_profile    TEXT NOT NULL,                  -- "bf-lc-2.2" — pinned BIBFRAME profile version
    shacl_report  TEXT                            -- JSON of last SHACL validation result
);

CREATE TABLE raw_records (
    book_uuid  TEXT NOT NULL,
    source     TEXT NOT NULL,                 -- "marc21", "onix3", "opf", "bibframe-jsonld"
    content    BLOB NOT NULL,                 -- raw bytes for round-trip fidelity
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (book_uuid, source)
);

CREATE TABLE authorities (
    uri           TEXT PRIMARY KEY,           -- e.g. http://id.loc.gov/authorities/names/n79095059
    local_graph   TEXT,                       -- graph name holding cached Turtle CBD
    authority_src TEXT NOT NULL,              -- "lcnaf", "lcsh", "lcgft", "fast", "viaf", "isni", "wikidata"
    resolved_at   TEXT,
    expires_at    TEXT,                       -- lazy-refresh on first use after expiry
    cbd_turtle    BLOB                        -- concise bounded description, Turtle-serialized
);

CREATE TABLE mapping_overrides (
    book_uuid   TEXT,                         -- NULL for global default
    target      TEXT NOT NULL,                -- "metadata.db.pubdate", "epub3.dc:date", ...
    sparql      TEXT NOT NULL,                -- SPARQL SELECT expression
    PRIMARY KEY (book_uuid, target)
);

CREATE TABLE normalization_rules (
    version     TEXT PRIMARY KEY,             -- e.g. "2026.04" — ruleset version for deterministic URI minting
    rules_json  TEXT NOT NULL                 -- title/author/language normalization rules
);
```

**Query layer**: Rust uses [Oxigraph](https://github.com/oxigraph/oxigraph) (pure-Rust RDF + SPARQL engine, MIT/Apache). **SPARQL is the only query path** — no SQL-direct fast lane. Every access, including Simple-tab flat views, goes through SPARQL. Hot views are handled by explicit materialization (SQLite views or cached `CONSTRUCT`-projected tables), not by bypassing the RDF layer. This is a deliberate choice: divergent SQL and SPARQL paths mean two mental models, two test matrices, and two cache-invalidation stories. One path, one truth.

Oxigraph's `oxrdf` crate provides term canonicalization — `"1818"^^xsd:gYear` and `"1818-01-01"^^xsd:date` remain distinct triples (they mean different things precision-wise), but syntactic variants of the same term dedupe via the `terms` table UNIQUE constraint.

**BIBFRAME ontology version is pinned.** Every graph records its `bf_profile` (e.g. `"bf-lc-2.2"`). Stored JSON-LD uses a Spine-owned context URI like `https://spine.thereprocase.dev/context/bf-2.2.jsonld` that resolves to a bundled copy of LoC's BIBFRAME 2.2 + BF-LC profile. When LoC ships a new version, we ship a new context; a migration tool rewrites stored graphs on user opt-in. Stored data never silently drifts with upstream ontology changes.

**SHACL validation** runs on every ingest against the **BF-LC profile** (the LoC subset that reflects production cataloging — more permissive than strict BIBFRAME-full, appropriate for messy real-world data). Failures are **stored, not rejected**: the validation report lands in `graphs.shacl_report`, triples still ingest, the Raw-mode UI surfaces the failures. Only hard errors (missing required class, unparseable URI) refuse ingest.

**Why SQLite triple table and not Oxigraph's native RocksDB?** Operational simplicity. Calibre users are used to one `metadata.db` file per library. Two SQLite files side-by-side is a familiar pattern. A RocksDB directory isn't. Perf cost is negligible at our scale (a 10k-book library is ~500k-5M triples; SQLite with dictionary-encoded terms handles this trivially).

**Raw-record preservation**: every ingested record (MARC, ONIX, OPF, JSON-LD) is stored in `raw_records` as original bytes. Any future mapping improvement can re-derive triples without another round-trip to LoC/OpenLibrary. Belt-and-suspenders for data durability. A user who wipes `spine.db` loses only user-authored graph edits (annotations, manual enrichment); every machine-ingested fact is re-derivable from `raw_records` + the current crosswalk rules.

### Transactional and atomicity model

- **A book-graph is the atomic unit for writes.** Changing metadata on one book = one transaction touching one `graphs.id`.
- **Authority-graph writes use a two-phase protocol.** Resolving a new author authority runs in a separate transaction from the book edit that triggered it — the book write doesn't wait on the network, and a failed authority resolution doesn't roll back the edit.
- **Authority merges (LoC merges n79095059 into n79095060) are handled via `owl:sameAs`, not by rewriting existing triples.** The old URI remains valid as an alias; queries UNION both sides. Destroying URIs destroys annotation provenance.
- **Graph deletion touches only the book-graph.** Shared authority triples remain. Reference-counted GC runs on `VACUUM` and prunes orphaned authority entries with zero inbound references.
- **Vacuum is explicit, not automatic.** Users trigger library cleanup from a settings action. Matches calibre's model.

### Identity: reconcile-first against id.loc.gov, mint locally only for gaps

Spine does not invent parallel URIs for entities LoC has already catalogued. `id.loc.gov` is a free, public, dereferenceable linked-data service publishing Works, Hubs (clusters of translations/adaptations), Instances, Agents (NACO), Subjects (LCSH), Genre/Form (LCGFT). We reference these URIs directly. Federation, interop, and linked-data participation fall out as a consequence; re-minting would fragment the graph Spine exists to join.

**Reconciliation pipeline per entity (Work, Agent, Subject), in priority order:**

1. **LCCN direct lookup** — if the source OPF or embedded catalog record carries a Library of Congress Control Number, dereference directly. Highest confidence.
2. **ISBN → Instance → Work traversal** — if the source carries an ISBN, look up the Instance in LoC; follow `bf:instanceOf` to the Work.
3. **Exact match on normalized title + normalized primary author** — against LoC's Work index.
4. **Fuzzy match + user confirmation** — LLM-assisted candidate ranking; present top-N to the user, confidence scores visible. Never silently commit.
5. **Mint locally** — only if no LoC match survives user review. Deterministic:
   ```
   urn:spine:work:{sha256(normalized_title | normalized_author)[:16]}
   ```
   Two users independently cataloguing the same small-press novel LoC has never touched arrive at the same URI. Merging libraries preserves Work identity automatically.

**Normalization rules are versioned.** The tuple `("Lord of the Rings", "Tolkien, J.R.R.")` and `("The Lord of the Rings", "J. R. R. Tolkien")` must hash identically; the rules that make this true are frozen per-version in `normalization_rules`. Rule changes require an explicit migration path. Mixing URIs generated under different rule versions is refused until migrated.

**Promotion on later reconciliation**: when a spine-local URI is later matched to a LoC URI (LoC catalogued it; user confirms), the spine-local URI is *not deleted* — it becomes an alias via `owl:sameAs`. Existing triples on it remain. New triples attach to the LoC URI. Queries UNION both sides. User annotations that referenced the spine-local URI continue to resolve.

**Ambiguous matches use the Work Stub pattern**: multiple LoC candidates with similar scores → create a tentative Work flagged `spine:resolutionPending`, link to all candidates via `spine:candidateMatch` with per-candidate confidence, surface the resolution UI. Don't force a decision.

**Hubs** (the BIBFRAME class above Work that clusters translations/adaptations): when both sides exist in LoC, assert the Hub using LoC URIs; when one side is outside LoC, mint locally for that side and assert the Hub between them. When neither side is in LoC, omit the Hub and use only the translation-of / adaptation-of predicate — no synthetic Hub URI until federation evidence demands one.

### URI provenance is universal

Every URI (LoC, spine-local, Wikidata, VIAF, etc.) in the graph carries provenance properties via an adjacent `bf:AdminMetadata` node:

- `spine:uriSource` — one of `loc`, `spine-local`, `user-promoted`, `external-other`
- `spine:uriResolvedAt` — ISO 8601 timestamp of last successful dereference (for LoC URIs)
- `spine:uriCachedCopy` — reference to the local cache entry (for LoC URIs)
- `spine:normalizationRuleVersion` — for spine-local URIs, the ruleset used to derive them

Users see provenance in the UI. A date labelled "1818 (source: LoC, confidence 1.0, resolved 2026-04-20)" is trustable in a way an unlabeled "1818" is not.

### Asserted vs inferred triples

LLM-generated matches, heuristic title normalization, OCR-derived metadata, and confidence-scored fuzzy reconciliations are **inferred**, not asserted. Inferred triples carry:

- `spine:confidence` — float, 0.0 to 1.0
- `spine:inferredBy` — model identifier, ruleset version, or `"user"`
- `spine:inferredAt` — ISO 8601 timestamp

Pattern C from the amicus brief: **confidence as a first-class property, not named-graph separation or RDF-star reification**. Simpler to query, simpler to reason about, adequate for the scope. Promotion to asserted status (removing the inference properties) requires explicit user action or a user-set trust threshold.

The failure mode we are avoiding: LLMs asked for a date produce one, confidently. For Canterbury-Tales-class works where the real answer is "unknown within a century," unmarked confident fabrication propagates into the graph and gets cited as authoritative. Every inferred triple being tagged-at-rest means the UI and downstream exports can treat it appropriately — display with uncertainty, include by user opt-in, exclude from automated reconciliation passes.

### LoC authority cache

- **Granularity**: entity-level. Cache the Turtle serialization of each dereferenced URI's Concise Bounded Description (CBD).
- **Location**: Spine-local app data (shared across libraries on the same host), not per-book. Per-EPUB cache files are a portability projection, not the primary cache.
- **TTL**: 90 days default, user-configurable. LoC data changes slowly.
- **Refresh**: lazy. Dereference on first use after TTL expiry. Never block user action on a network refresh.
- **Fail-soft**: when `id.loc.gov` is unreachable, use cached values. Uncached entities fall to spine-local minting with a `spine:reconciliationPending` flag, retried on next successful network pass.
- **Offline pre-seed**: we bundle LCSH, LCNAF, LCGFT, FAST, and MARC relator code dumps (all CC0) with Spine for offline authority resolution out of the box. Downloaded-once, not dereferenced-per-use.

### Ingest pipeline

```
Source record (MARC21 / ONIX 3.0 / EPUB OPF / JSON-LD / plain DC)
    │
    ▼
Parse into native in-memory form
    │ (spine-marc, spine-onix, spine-epub-meta, spine-dc, spine-bf)
    ▼
Reconcile identities against id.loc.gov (LCCN → ISBN → title+author → fuzzy)
    │ (any unmatched entities mint spine-local URIs deterministically)
    ▼
Map to BIBFRAME 2.0 triples with URI provenance tagged
    │ (format-specific converter crates + LoC-published mapping rules)
    ▼
Classify asserted vs inferred; tag inferred triples with confidence
    │
    ▼
SHACL-validate against BF-LC profile (accept + flag, store report)
    │
    ▼
Insert into spine.db (one asserted graph + one inferred graph per book)
    │
    ▼
Raw bytes → raw_records (provenance)
```

Every metadata source ends in the same BIBFRAME shape. BIBFRAME is the canonical form; everything else is input or output.

**Source-to-BIBFRAME crates:**

- **`spine-bf`** — BIBFRAME core: types, validation (SHACL shapes), RDF serialization (JSON-LD, Turtle, N-Triples, RDF/XML), SPARQL via Oxigraph. Primary crate.
- **`spine-marc`** — MARC21 parser (ISO 2709 + MARCXML) and bidirectional MARC↔BIBFRAME converter. Rust port of LoC's `marc2bibframe2` rules. Also writes MARC when we need to export MARCXML for OPDS alternative representations.
- **`spine-onix`** — ONIX 3.0 parser and ONIX→BIBFRAME converter. ONIX is the richest *commercial* metadata standard (publisher info, territory rights, sales categorization, marketing copy). Mapped to BIBFRAME `bf:Instance` + `schema:offers` + custom `onix:*` predicates for fields BIBFRAME doesn't express natively.
- **`spine-epub-meta`** — EPUB 3.3 package metadata parser and OPF→BIBFRAME converter. EPUB 3.3's `<meta property>` mechanism already supports arbitrary RDF vocabularies, so this is a direct mapping.
- **`spine-dc`** — Dublin Core projection, both directions. Used for the EPUB `<dc:*>` baseline, for calibre's `metadata.db` columns, and as fallback ingest for flat-DC sources (Amazon/Google scrapes). LoC publishes DC↔BIBFRAME crosswalks.

### Metadata source priority

Reordered from calibre to favor BIBFRAME-native and MARC sources over commercial scrapers:

1. **LoC SRU / BIBFRAME endpoint** — LoC's id.loc.gov serves BIBFRAME directly for many records; SRU returns MARCXML which converts losslessly. Primary source for anything published in the US since roughly forever.
2. **OpenLibrary** — full MARC dumps under CC0; also has a structured JSON API. Free.
3. **ONIX feeds from publishers** — when available (some publishers publish ONIX; trade databases like Bowker subscribe to aggregated feeds). Commercial angle.
4. **Z39.50 / SRU to national libraries** (British Library, DNB, BnF, NLA) — for non-US, non-English works.
5. **OCLC WorldCat Search API** — best coverage, costs money at scale. Opt-in.
6. **Amazon / Google Books / Goodreads** — DC-shaped scrapes, fallback for commercial long tail. Upcast to minimal BIBFRAME via DC→BIBFRAME crosswalk.

### EPUB 3.3 burn-in export: three-layer strategy

The phrase "EPUB backward compatibility" conflates three goals that pull in different directions:

- **A. Legacy readers open the file without error.** Any valid EPUB satisfies this. Free.
- **B. Metadata survives round-trips through non-Spine tooling.** If a user opens a Spine EPUB in Calibre, edits the title, re-exports, does the BIBFRAME graph come back out intact? Depends on where it's stored.
- **C. Legacy readers surface metadata to a human.** User on a Kobo Mini can actually see the translator credit, authority-controlled subjects, Work-level origin date.

No single storage location satisfies all three. We use three layers, read in priority order on import; **first hit wins, no cross-layer merge**.

**Layer 1 (canonical, truth): `META-INF/spine-bibframe.ttl`** — Turtle-serialized BIBFRAME graph inside the OCF container's `META-INF/` directory. The OCF spec reserves specific filenames there but does not prohibit additional files; reading systems ignore unknown META-INF entries; packaging tools (epubcheck, Calibre, Sigil) treat META-INF as opaque and preserve it through round-trips. This is where the real graph lives on disk.

Also in META-INF: `spine-loc-cache.ttl` — Concise Bounded Descriptions of every LoC URI referenced in the canonical graph, so an offline Spine instance receiving the file can still render labels and types without dereferencing.

**Layer 2 (projection fallback): OPF `<meta>` elements** — a curated subset of high-value fields projected into the package document, in case Layer 1 is stripped by an overzealous tool. Covers Work-level fields (`bf:originDate`, authority URIs on creators/subjects, work ID) and the canonical-graph pointer (`spine:canonicalGraphRef`). Any embedded JSON-LD values **must be CDATA-wrapped** because OPF parsers reject unescaped `<`, `>`, `&` in attribute-less text content. (`]]>` inside JSON-LD content splits the CDATA section — emitter handles this.)

**Layer 3 (optional, human-visible): back-matter "Cataloging Record" XHTML page** — auto-generated at export time from the canonical graph, RDFa-tagged for machine re-extraction. **Off by default** for Spine-to-Spine transfers (noise in the reading experience); **on by default** for "share" exports targeted at legacy readers. User-togglable per export. Regenerated from the graph every export — never user-edited; if the user edits it, the edits don't persist to the graph on reimport.

**Dublin Core baseline** (`<dc:*>` in OPF) is always written as a projection of the current BIBFRAME graph via the user's mapping. Universally compatible, device-safe.

Example OPF fragment with all layers referenced:

```xml
<package xmlns="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:bf="http://id.loc.gov/ontologies/bibframe/"
         xmlns:bflc="http://id.loc.gov/ontologies/bflc/"
         xmlns:schema="http://schema.org/"
         xmlns:spine="https://spine.thereprocase.dev/ns/"
         prefix="bf: http://id.loc.gov/ontologies/bibframe/
                 bflc: http://id.loc.gov/ontologies/bflc/
                 schema: http://schema.org/
                 spine: https://spine.thereprocase.dev/ns/"
         version="3.0">
  <metadata>
    <!-- DC baseline: device-compatible projection -->
    <dc:title id="title">Frankenstein</dc:title>
    <dc:creator id="creator" opf:file-as="Shelley, Mary Wollstonecraft">
      Mary Wollstonecraft Shelley
    </dc:creator>
    <dc:date>2023-04-12</dc:date>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId" opf:scheme="ISBN">9780000000000</dc:identifier>

    <!-- Layer 2: OPF projection of high-value BIBFRAME fields -->
    <meta property="bf:originDate" refines="#work">1818</meta>
    <meta property="spine:workURI" refines="#work">
      http://id.loc.gov/resources/works/16028517
    </meta>
    <meta property="spine:workURISource" refines="#work">loc</meta>
    <meta property="bflc:creatorCharacteristic" refines="#creator">
      http://id.loc.gov/authorities/names/n79095059
    </meta>
    <meta property="schema:genre" refines="#work">Gothic fiction</meta>
    <meta property="bf:subject" refines="#work">
      http://id.loc.gov/authorities/subjects/sh85008810
    </meta>

    <!-- Pointer to Layer 1 (canonical) -->
    <meta property="spine:canonicalGraphRef">META-INF/spine-bibframe.ttl</meta>
    <meta property="spine:bfProfile">bf-lc-2.2</meta>
    <meta property="spine:contextURI">
      https://spine.thereprocase.dev/context/bf-2.2.jsonld
    </meta>
  </metadata>
  <!-- manifest, spine, guide... -->
</package>
```

**Reimport priority:**
1. `META-INF/spine-bibframe.ttl` — canonical Turtle. Full graph, authoritative.
2. OPF `<meta>` with `spine:` or `bf:` properties — projected subset. Used if Layer 1 is missing.
3. Back-matter RDFa — presentation layer. Last resort; presence indicates the user's tooling stripped both canonical and OPF layers.
4. Standard DC elements — universal fallback. Upcast to minimal BIBFRAME via DC→BF crosswalk.

First hit wins. No cross-layer merge (silent conflicts are worse than partial recovery).

**Round-trip guarantee (Spine → other tool → Spine):** if the intermediate tool preserves `META-INF/`, the full graph round-trips losslessly. If the intermediate tool strips unknown META-INF entries (rare; we'll document which ones do), Layer 2 survives and recovers a high-value subset. Layer 3 provides a degraded-but-nonempty recovery even if both META-INF and OPF customizations are stripped.

### Projection to older / lossy formats

| Target | Data loss | What survives |
|---|---|---|
| **EPUB 3.3 (primary)** | None — full BIBFRAME embedded | Everything |
| **EPUB 2.0.1** | Partial — no arbitrary RDF; DCMES only | Dublin Core subset per user's mapping |
| **MOBI / AZW3** | Heavy — Mobipocket header only | Title, author, publisher, date, ISBN, language, description |
| **Calibre `metadata.db`** | Moderate — DC-shaped columns + `marc:*` tag convention | DC fields + tagged refinements |
| **OPDS feed entry** | Moderate — Atom + DC | DC + cover link + linked BIBFRAME JSON-LD alternative |
| **MARCXML** | Small — BIBFRAME → MARC via LoC `bibframe2marc` | MARC21 equivalent (lossy only where BIBFRAME has no MARC equivalent) |
| **BIBFRAME JSON-LD / Turtle / RDF/XML** | None | Everything |

All projections driven by the same `MappingEngine`. User config governs every output. LoC's published crosswalks ship as defaults:
- BIBFRAME → MARC21 (`bibframe2marc`)
- BIBFRAME → Dublin Core
- MARC21 → BIBFRAME (`marc2bibframe2`)
- Dublin Core → MARC21 (and transitively, → BIBFRAME)

### The projection UI

Mapping UI is unchanged in shape from the prior plan — user picks which BIBFRAME predicate feeds which DC-shaped output field, globally and per-book. Example for `pubdate`:

```
pubdate (Dublin Core / calibre metadata.db / EPUB <dc:date>)
 ◉ bf:publication/bf:date on instance — edition publication date   [default]
 ○ bf:originDate on work — original composition date
 ○ bf:provisionActivity/bf:date — first publication (any provision)
 ○ MIN(bf:originDate, bf:publication/bf:date)
 ○ Custom SPARQL expression…

 Per-book overrides: [2 books] [edit]
```

Defaults live in settings. Per-book overrides via right-click. Most users never touch this; the scholarly 5% get a first-class surface.

### Metadata editor UI

Spine's metadata pane has three tabs:

- **Simple** — flat view with calibre-familiar field names (title, author, series, tags, pubdate, description). Edits here upcast to BIBFRAME via the mapping.
- **Bibliographic** — full BIBFRAME graph view organized by Work → Instance → Item, with relationship editors (add translator, add subject authority, link to other Works). What a modern cataloger would expect. Hidden behind a "cataloger mode" toggle.
- **Raw** — developer view with Turtle / JSON-LD pretty-print, SPARQL query box, raw record (MARC/ONIX/OPF) display. For debugging and power users.

Mobile exposes only the Simple tab. Editing BIBFRAME graphs on a phone is a category error.

### SPARQL endpoint

`GET /api/v1/sparql?query=…` and `POST /api/v1/sparql` (for longer queries). Auth-gated behind the "advanced mode" permission on a per-user-account basis. Scholars can run queries like "find all pre-1900 works by women authors translated from French with any reading progress." The query engine is Oxigraph in-memory; the dataset is loaded from `spine.db` for each query. Ship a snippet library + autocomplete — nobody writes production SPARQL from scratch.

### Metadata domains modeled

Beyond core bibliographic description, BIBFRAME natively models several domains that calibre and consumer formats treat inconsistently or not at all. Spine commits to first-class support for each:

| Domain | BIBFRAME/Schema.org predicates | DC / calibre projection | Notes |
|---|---|---|---|
| **Accessibility** | `schema:accessibilityFeature`, `schema:accessibilityHazard`, `schema:accessMode`, `schema:accessModeSufficient` (EPUB 3.3 native) | Tags (`marc:access:*`) | Screen-reader users filter on this; EPUB 3.3 carries it in OPF; we ingest, store, and preserve through every export path. Losing it would exclude a real audience. |
| **Rights / licensing** | `bf:usageAndAccessPolicy`, `bf:copyrightDate`, `dcterms:rights`, `dcterms:license` | `rights` column (DC) + tags | Public domain vs CC-BY vs all-rights-reserved distinguishes a PG book from a DRM-free indie. First-class for archive users. |
| **Annotations, progress, notes** | [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) via `oa:hasTarget` → `bf:Item` | Separate calibre annotation tables | Reading progress, highlights, marginalia promoted from per-reader state to graph-native, SPARQL-queryable. Enables "show me books I've abandoned past 50%." |
| **Covers** | `bf:coverArt`, `schema:image` | `cover` file reference in metadata.db | Explicit BIBFRAME modeling so cover provenance (LoC thumbnail, user upload, generated) is trackable. |
| **Multi-volume works** | `bf:hasPart` / `bf:partOf` | Series + tags | Les Misérables, Proust — five-volume works treated as one `bf:Work` with five `bf:hasPart` child Works. Different from series. |
| **Series** | `bf:hasSeries` → another `bf:Work` with `bf:seriesStatement` | `series` + `series_index` (calibre-compat) | Bridgerton's 8 books are one series Work with eight member Works. Maps cleanly to calibre's flat series model on projection. |
| **Intended audience / reading level** | `bf:intendedAudience`, `schema:typicalAgeRange` | Tag | Kindle carries reading-age; useful for family libraries where a parent filters child-appropriate books. |

Each of the seven has documented ingest sources (where the data comes from), BIBFRAME shape (how it's modeled in the graph), and projection paths (how it lands in DC/OPF/calibre output). Crosswalk rules ship in `tools/crosswalks/` with user-overridable SPARQL expressions.

### Phasing

BIBFRAME support is load-bearing through every phase:

- **Phase 1**: `spine-bf` crate has BIBFRAME 2.2 + BF-LC profile types (pinned via Spine-owned context URI), RDF serialization (Turtle primary, JSON-LD / N-Triples / RDF/XML), SHACL validation, SPARQL via Oxigraph. `spine.db` schema created with dictionary-encoded terms. `spine-marc` implements **read first, write second** — MARC21 parse + MARC→BIBFRAME via ported `marc2bibframe2` rules is the common case; MARC export is rare and lands later. Bundled CC0 authority dumps (LCSH, LCNAF, LCGFT, FAST, MARC relator codes) as build-time assets in `spine-bf/data/`. No UI yet.
- **Phase 2**: ingest from LoC SRU + OpenLibrary + EPUB OPF produces real BIBFRAME graphs with URI provenance + asserted/inferred separation. Reconcile-first identity pipeline (LCCN → ISBN → title+author → fuzzy → mint) runs on ingest. LoC authority cache online with 90-day TTL and fail-soft offline behavior. Simple tab shows projected DC view with confidence badges and provenance tooltips. Bibliographic tab exists, read-only. Exports to EPUB 3.3 burn in full BIBFRAME via `META-INF/spine-bibframe.ttl` canonical + OPF projection fallback + optional back-matter. Projections to calibre metadata.db, MOBI, EPUB 2 work with default mappings.
- **Phase 3**: full Bibliographic tab editing on desktop (Work/Instance/Item graph editor with authority autocomplete against bundled + network LoC data). Per-book mapping overrides UI. SPARQL endpoint exposed behind auth with a snippet library. Mobile stays Simple-only; editing BIBFRAME on a phone is a category error.
- **Phase 4**: ONIX 3.0 ingest (scope: partial, documented — the ONIX↔BIBFRAME crosswalk is draft-quality; we ship a manifest of mapped vs preserved-in-raw-records fields rather than claiming a solved crosswalk). Authority resolution against VIAF, ISNI, Wikidata in addition to LCNAF/LCSH. Promotion-on-reconciliation UI for spine-local URIs that later match LoC records. Bulk BIBFRAME re-fetch against LoC for existing libraries. SRU-only for international libraries (Z39.50 has no viable Rust implementation; BL/DNB/BnF all expose SRU).

---

## 6. API contract and transport

The single most important durability decision in Spine. The HTTP-shaped API is the contract; it outlives every frontend and every backend implementation. Frontends are interchangeable, backend can be rewritten, third parties can write their own clients — the API is the product.

### The contract

- **OpenAPI 3.1** spec, versioned `/api/v1/…`, lives in `spine-api/openapi.yaml` as a generated artifact. Source of truth is the Rust type definitions in `spine-api`; OpenAPI is generated via `utoipa` or similar.
- **Types shared across the language boundary** via `typeshare`: Rust structs with `#[derive(Serialize, Deserialize, TypeShare)]` generate matching TypeScript types at build time. Frontends import these and never invent request/response shapes.
- **Versioning discipline**: `/api/v1/` is forever. When we need incompatible changes, `/api/v2/` launches alongside, both served, v1 deprecated on a timescale measured in years, not sprints. Backwards-compatible additions (new optional fields, new endpoints) are fine on v1.
- **Error shape is uniform**: every error response is `{ "error": { "code": "…", "message": "…", "details": {…} } }`. Error codes are enumerated in `spine-api` and documented in the OpenAPI spec.

### The three transports

All three serve the identical axum router. The frontend's client library picks the transport at startup based on deployment config.

**1. In-process (default for embedded apps)**

The Tauri desktop app and RN mobile app include `spine-srv` as a crate. The axum `Router` is constructed but never bound to a listener. Frontend calls go through:

- **Tauri**: one Tauri command per endpoint group (or one generic `api_call(method, path, body)` command), which constructs a `tower::Service` request and calls `Router::call` directly. Per-call cost: 1-5 μs, dominated by serde.
- **RN**: one TurboModule exposing `async call_api(method: string, path: string, body: string): Promise<string>`. The native side does the same `Router::call` trick. JSI overhead ~10-50 μs; serde ~1-5 μs; handler work dominates.

No TCP port bound. No network surface. No firewall or antivirus gets involved. Authentication is trivial (same process, same user).

**2. Local sidecar (Unix Domain Socket / Named Pipe)**

For users who want `spine-srv` running as a background service independent of any GUI — launches at login, serves whatever frontends connect. Linux/macOS bind a UDS at `~/.local/share/spine/spine.sock`; Windows binds a named pipe at `\\.\pipe\spine`. Filesystem permissions gate access: only the user who owns the socket/pipe can connect.

HTTP-over-UDS is supported directly by `hyper` and `axum`; clients use `hyper-unix` or the platform equivalent. Per-call cost: 10-50 μs. No TCP, no port, no firewall surface.

**3. Remote (TCP + TLS + auth)**

Plex-for-books mode. User runs `spine-srv` on a NAS, home server, or VPS. Binds TCP with TLS (self-signed or Let's Encrypt via `rustls-acme`). Token-based auth — user creates accounts on the server, pairs devices via QR code or a short-lived pairing code, each device gets a long-lived token stored in platform secure storage (Keychain / Credential Manager / Keystore / libsecret).

Discovery on the LAN via **mDNS/Bonjour** — server advertises `_spine._tcp.local`, frontends on the same network see available servers automatically. Manual URL entry always works too.

### Why this is security-forward

- Default deployment (embedded) has **zero network surface**. No port to scan, no service to fingerprint, no firewall pop-up.
- Sidecar deployment uses filesystem permissions, not network ACLs — if your user can't read the socket, they can't talk to the server. Simpler threat model.
- Remote deployment forces explicit TLS+auth+opt-in. No accidental exposure via a misconfigured bind address.
- The frontend client library makes it impossible to call without auth — the type system doesn't expose unauthenticated endpoints on remote transports.

### Why this is durability-forward

- The API contract is the one durable artifact. Lasts decades.
- Frontends can be rewritten at any cadence, in any language, without touching the server.
- The backend can be rewritten (Rust → whatever) without touching frontends, as long as the OpenAPI spec holds.
- Third-party frontends become possible the day the OpenAPI spec stabilizes. Someone writes an iOS Swift client, a tvOS client, a terminal client, a voice-assistant skill — none of our code on their device.
- The only operational difference between "app alone on your laptop" and "family NAS with five readers" is the transport config. Same server, same API, same frontends.

### Acknowledged costs

- **Phase 0 has to nail the OpenAPI shape.** The URL structure, resource model, error format, and versioning rules are permanent. Sloppy Phase 0 is the one mistake we can't undo.
- **iOS background execution** may not permit a sidecar subprocess. The embedded-in-process path covers us there — no subprocess needed. iOS remains "embedded only, no local sidecar." Acceptable.
- **serde cost on every call** is ~1-5 μs that direct Rust function calls wouldn't pay. For this product, invisible. For a game engine it'd matter; here it doesn't.

---

## 7. Frontend strategy

Cross-referencing the responsive/universal React reference (`responsive-universal-reference.md` §2) — we are squarely in **Option B: separate apps, shared core**, because desktop and mobile diverge meaningfully:

| | Desktop | Mobile |
|---|---|---|
| **Primary verb** | Manage library, bulk convert, edit metadata, sync to device | Read, download from server, manage shelf |
| **Interaction** | Pointer, keyboard, menu bar, right-click | Touch, gestures, bottom tabs |
| **Data density** | Wide tables, multi-pane, command palette | Single-item focus, master-detail |
| **Network model** | Local library on disk | Usually a client of a calibre-server on the LAN |

Code sharing happens at the **Rust core** boundary, not the React component boundary. We're not attempting a Tamagui-style universal primitive layer in v1 — the products are different enough that separate component libraries per platform is the honest choice.

### Desktop: Tauri 2 + React

- **Tauri 2** — Rust backend, system WebView frontend. No Electron, no 200MB idle RAM. The Rust core links directly into the Tauri host.
- **React** + **Vite** + **Tailwind** — fast dev loop, standard ecosystem.
- **TanStack Table** for the library grid (calibre's core interaction surface; needs to be fast and feature-rich).
- **foliate-js** in a WebView frame for in-app reading.
- Native menu bar, keyboard shortcuts, right-click context menus — all via Tauri APIs.
- Ships as .msi (Windows), .dmg (macOS, unsigned for dev; notarization is $99/yr and a v2 question), .deb/.AppImage (Linux).

### Mobile: Android native (Kotlin + Jetpack Compose) — iOS off-roadmap

> **2026-04-24: SUPERSEDED FOR ANDROID BY ADR 011.** Android shipped as native Kotlin + Jetpack Compose single-activity in Sprint 2. `apps/mobile/android/` holds the real implementation. The bridge is JNI via `spine-jni` crate + `SpineCore.callApi(method, path, body)` in Kotlin — not a React Native TurboModule. Material3 is the design baseline. The "React Native + Expo + TurboModule + NativeWind" prose below (and the Expo / RN mentions scattered elsewhere in this document at §1 diagram, §3 UniFFI-rejection paragraph, §7 deployment modes, §8 repo layout, §10 phasing, §11 risks, §Phase-0 checklist) predates the mobile implementation and is **historical context only**. If iOS is ever added to the roadmap, Compose Multiplatform is the strong candidate per ADR 011 §Alternatives. The deployment-mode split (Standalone vs. Client), the embedded-`spine-srv`-via-in-process-router design, the sideload/F-Droid distribution story, and the `call_api(method, path, body)` transport contract are all **still correct** — only the frontend framework changed.

Baseline stack per `react-native-ui-reference.md` §3 — RN 0.85+, Reanimated 4, Gesture Handler 3, Expo Router 6, New Architecture on. *(Historical — see banner above.)*

- **Expo SDK 55+** — managed workflow. Expo Dev Build for the native TurboModule that hosts the embedded `spine-srv`.
- **Expo Router 6** file-based routing with native tabs (liquid glass on iOS, Material 3 on Android).
- **FlashList v2** for the book grid — libraries can be 10k+ books.
- **@gorhom/bottom-sheet** for metadata-editing drawers.
- **react-native-webview** hosting foliate-js as the reader.
- **Embedded `spine-srv` via a single TurboModule** — the Rust server (including `calibre-db`, `spine-db`, `spine-bf`, `spine-marc`, `spine-onix`, `spine-epub-meta`, `spine-dc`, `spine-oeb`, `spine-fmt-*`, `spine-meta`) compiles to a `.so` on Android and an `.xcframework` on iOS. The TurboModule exposes `async call_api(method, path, body)` and dispatches into the in-process axum router with zero TCP. Conversion + metadata + BIBFRAME graph queries all run on-device; library lives locally. Same HTTP-shaped contract the remote mode uses, same serde types on both sides.
- **Two deployment modes:**
  1. **Standalone** — embedded `spine-srv` manages a local library. Full conversion pipeline, works offline. Scoped Storage + SAF for user-selected library location. Primary mode for handoff-style devices.
  2. **Client** — no embedded server; app is a pure HTTP client against a remote Spine server (or upstream calibre's content server — both speak OPDS). Primary mode for "phone is a reader, desktop or NAS is the library."
- Android distribution: sideload APK + F-Droid if they'll take it.
- iOS distribution: TestFlight for beta, free sideload via Xcode + Apple ID (7-day re-sign cycle is a known cost). App Store is explicitly out of scope.

### Web: optional v2, Next.js or Vite

Spine's web surface is primarily **spine-srv's OPDS + REST + thin HTML reader**, served from the desktop app when the user opts in (or from a standalone server deployment). If we want a richer web client later, drop it in `apps/web/` and point it at the same REST API. No rush.

---

## 8. Repo layout (spine)

```
spine/
├── core/                       # Rust workspace
│   ├── Cargo.toml              # workspace root
│   ├── calibre-db/             # metadata.db reader/writer (calibre-compat)
│   ├── spine-db/               # spine.db RDF triple store (SQLite-backed),
│   │                           # Oxigraph query layer, named graph per book
│   ├── spine-bf/               # BIBFRAME 2.0 core: types, SHACL validation,
│   │                           # JSON-LD/Turtle/N-Triples/RDF-XML serialization,
│   │                           # SPARQL via Oxigraph
│   ├── spine-marc/             # MARC21 ISO 2709 + MARCXML parse/write;
│   │                           # bidirectional MARC ↔ BIBFRAME (Rust port of
│   │                           # LoC marc2bibframe2 / bibframe2marc rules)
│   ├── spine-onix/             # ONIX 3.0 parse; ONIX → BIBFRAME converter
│   ├── spine-epub-meta/        # EPUB 3.3 OPF package metadata parse/write;
│   │                           # EPUB OPF ↔ BIBFRAME (burns BIBFRAME into
│   │                           # exported EPUB 3.3 OPFs via <meta property>)
│   ├── spine-dc/               # Dublin Core projections both directions;
│   │                           # BF ↔ DC and DC ↔ MARC crosswalks (LoC data)
│   ├── spine-oeb/              # OEB intermediate representation pipeline
│   ├── spine-fmt-epub/
│   ├── spine-fmt-mobi/
│   ├── spine-fmt-pdf/
│   ├── spine-fmt-docx/
│   ├── spine-fmt-txt/
│   ├── spine-fmt-html/
│   ├── spine-fmt-fb2/
│   ├── spine-fmt-rtf/
│   ├── spine-meta/           # LoC SRU, OpenLibrary, Z39.50/SRU-to-others,
│   │                           # OCLC, Amazon/Google fallback
│   ├── spine-api/            # Request/response types, OpenAPI spec,
│   │                           # typeshare-generated TS types for frontends
│   ├── spine-srv/            # axum router + handlers; callable in-process,
│   │                           # over UDS/Named Pipe, or over TCP+TLS
│   └── spine-cli/            # Thin binary wrapping spine-srv's handlers
├── apps/
│   ├── desktop/                # Tauri 2 + React
│   ├── mobile/                 # Expo RN
│   └── web/                    # (later) Next.js or Vite
├── packages/                   # shared JS/TS only
│   ├── ui-shared/              # tokens, icons, OPDS client, zod schemas
│   ├── bibframe-ui/            # BIBFRAME graph editor React components
│   │                           # (Work/Instance/Item panes, authority
│   │                           # autocomplete, SPARQL box) for desktop + web
│   └── foliate-host/           # foliate-js integration wrapper
├── tools/
│   ├── fixtures/               # sample EPUBs, MOBIs, MARC records,
│   │                           # ONIX feeds, BIBFRAME JSON-LD for CI
│   ├── format-tests/           # round-trip test harness
│   └── crosswalks/             # LoC crosswalk data (MARC↔BIBFRAME,
│                               # BIBFRAME↔DC, DC↔MARC), user-overridable
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PORTING-FROM-CALIBRE.md
│   ├── DB-SCHEMA.md            # metadata.db compat notes + spine.db triple schema
│   ├── BIBFRAME-GUIDE.md       # how Spine uses BIBFRAME 2.0: classes,
│   │                           # predicates, conventions, URI scheme
│   ├── MARC21-GUIDE.md         # MARC support as an ingest/export format
│   ├── ONIX-GUIDE.md           # ONIX 3.0 ingest mapping
│   └── CROSSWALK.md            # default mappings between all formats
├── PLAN.md                     # this file, eventually moves here
└── README.md
```

Note on naming: **`calibre-db` is the only crate that keeps the `calibre-` prefix**, and it does so because its entire job is to read and write upstream calibre's `metadata.db` in a byte-compatible way — the name describes exactly what the crate is bound to. Every other crate is `spine-*`. The product is Spine; the user-facing binary is `spine`; everything internal wears the same name. Attribution and license lineage to upstream calibre happen in `COPYRIGHT`, `NOTICE` files, and `docs/PORTING-FROM-CALIBRE.md` — not in crate names.

Toolchain:
- **pnpm workspaces** for JS/TS. **Turborepo** for build orchestration above Cargo.
- **Cargo workspace** for Rust; one `Cargo.lock` at `core/`.
- **Biome** for JS lint+format. **rustfmt** + **clippy** for Rust, pedantic mode on.
- **cargo-deny** for license audit (GPL3 hygiene).
- **CI**: GitHub Actions. Matrix over x86_64-pc-windows-msvc, x86_64-apple-darwin, aarch64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-linux-android, aarch64-apple-ios.

---

## 9. Phasing

Each phase ends in a shippable artifact. Nobody phases "almost ready."

### Phase 0 — Repo bring-up + API contract + reality checks (2-3 weeks)

**Repo setup:**
- Verify `spine` availability on crates.io / npm / github.com/thereprocase (fallback `ledger`)
- Create `thereprocase/spine` repo with GPL-3.0 LICENSE, README, CLAUDE.md, CONTRIBUTING.md
- Cargo workspace scaffolding with empty crates per §8
- pnpm/Turborepo scaffold; hello-world Tauri app in `apps/desktop`; hello-world Expo app in `apps/mobile`
- CI green on empty workspace across the full build matrix
- **`spine-api` crate: draft OpenAPI 3.1 spec** — URL structure, resource model, error format, versioning rules. This is the durable contract; get it right. Include a concrete draft of `/api/v1/book/{id}` response shape — the JSON frontends see is as permanent as the URL scheme.
- **Transport hello-world**: one trivial `GET /api/v1/ping` endpoint, callable via (a) in-process `Router::call` from a Rust test, (b) Tauri command, (c) RN TurboModule, (d) UDS/Named Pipe listener, (e) TCP. All five paths must work.
- **Prior art review (one day each, before BIBFRAME API surfaces freeze in Phase 1):**
  - [FOLIO](https://www.folio.org/) Inventory / Source Record Manager — BIBFRAME-aware open-source ILS, has solved Work/Instance/Item boundary edge cases
  - [Koha's BIBFRAME roadmap](https://koha-community.org/) — takes the opposite stance (MARC canonical, BIBFRAME computed); rationale illuminates tradeoffs
  - [Readium LCP](https://readium.org/lcp/) — open DRM standard; Spine's position on DRM-encrypted commercial content must be explicit (options: refuse / support LCP / user-side de-DRM)

**Reality-check stress tests — all must pass before Phase 1 begins:**

- **S1. `marc2bibframe2` round-trip fidelity.** Grab 100 real MARC records from LoC's public dumps. Convert to BIBFRAME via LoC's Ruby `marc2bibframe2`, convert back via `bibframe2marc`. Document lossy fields. This corpus becomes the Rust port's regression test set in Phase 1.
- **S2. Oxigraph-over-SQLite scale check.** Generate synthetic RDF approximating 10k books (~500k-5M triples). Load into `spine.db`. Time typical queries: "all books by author X," "all works between 1800-1850," "full-text title match." If any query exceeds 100 ms, add materialized views or reconsider. Acceptable-cost discovery before commitment.
- **S3. EPUB 3.3 OPF + META-INF compatibility matrix.** Build a synthetic EPUB 3.3 with `META-INF/spine-bibframe.ttl`, OPF `<meta>` projections, and a CDATA-wrapped JSON-LD blob. Open in: Calibre viewer, Thorium, Apple Books (macOS), Kindle PC, Kobo desktop app, ReadEra (Android). Verify: none corrupt the file on metadata re-save; document which preserve META-INF and OPF extras on re-export. Drop claims of support for readers that strip our layers; warn in the export UI for those targets.
- **S4. LoC SRU reliability characterization.** Run continuous SRU queries (1/minute) for 72 hours. Record error rate, p50/p95/p99 latency, 429 behavior. Fold into `spine-meta`'s retry+backoff policy. Expect ~5-10% error rate (field-observed on similar workloads); plan accordingly.
- **S5. Authority resolution hit-rate on real data.** Take a 1000-book calibre library (upstream's test library or a Project Gutenberg dump). Attempt VIAF/ISNI/LCNAF resolution by author name. Record: percentage resolving cleanly, percentage ambiguous (multiple candidates), percentage unknown. Determines whether Phase 4 authority resolution can be automated or requires curator intervention.
- **S6. OpenLibrary data quality sample.** 20-book random sample from an existing library. Check `first_publish_year` against known-correct originals. Field-observed: ~10% wrong (Prisoner of Zenda returned 1800; actual 1894). Confirms whether to downgrade OpenLibrary from a primary source to "supplementary, confirmation required" in `spine-meta`'s priority list.

**Exit criteria**: `cargo build` + `pnpm build` pass across the matrix. `GET /api/v1/ping` works via all five transports. All six stress tests have documented results. Prior-art review complete with written takeaways in `docs/PRIOR-ART.md`. A Tauri window opens saying "hello" wired through the Tauri-command transport.

### Phase 1 — Core MVP: read an existing calibre library (4-6 weeks)

- `calibre-db` reads an existing `metadata.db` (schema-compatible)
- `spine-db` RDF triple schema created; empty sidecar alongside existing metadata.db works; Oxigraph integration for SPARQL
- `spine-bf` has BIBFRAME 2.0 core types, RDF serialization (JSON-LD, Turtle), SHACL validation
- `spine-marc` parses ISO 2709 + MARCXML and converts MARC21 → BIBFRAME via ported LoC mapping
- `spine-dc` projects BIBFRAME → Dublin Core via default crosswalk
- `spine-oeb` skeleton + EPUB read-only plugin
- `spine-cli` can `list`, `show`, `export` books (thin wrapper around `spine-srv`'s handlers)
- `spine-srv` exposes OPDS feed + core REST endpoints (list books, get book, get metadata, get BIBFRAME graph as JSON-LD)

**Exit criteria**: point desktop binary at an existing calibre library folder, get a JSON list of books via `/api/v1/books`. Point a browser at `spine-srv`, get an OPDS feed that an existing reader app can consume.

### Phase 2 — Desktop MVP (6-8 weeks)

- Tauri 2 app with library grid, book detail, metadata edit
- foliate-js viewer embedded
- EPUB + MOBI + PDF read; EPUB + MOBI + PDF + TXT convert
- Metadata fetch from 2 sources (Amazon + OpenLibrary)
- Adds/removes books from library; writes back to `metadata.db`

**Exit criteria**: a calibre user can uninstall calibre, install us, and do the 80% case (browse, read, convert, metadata-fetch) on their existing library without data migration.

### Phase 3 — Mobile MVP (6-8 weeks)

- Expo app with RN + Rust FFI
- Library grid (FlashList v2), book detail, reader (foliate-js in WebView)
- OPDS client mode: connect to any `spine-srv` or upstream calibre server, browse, download
- Standalone mode: import EPUB/MOBI from file picker, read, keep local library
- Sideloadable APK on GitHub Releases; TestFlight for iOS if we go there

**Exit criteria**: the friend receiving the Kindle Voyage could alternatively read her romantasy on her Android phone via our app, talking to the desktop library or standalone.

### Phase 4 — Feature parity (ongoing)

- Full format matrix (DOCX/FB2/RTF/HTML round-trip)
- News recipes reborn as a TS service (if anyone cares)
- Bulk operations, smart collections, saved searches
- Desktop device-sync plugins (USB to Kindle, Kobo, etc.)

### Phase 5 — Things calibre never had

- Proper sync protocol (instead of "point everyone at the same folder")
- Cloud-optional — user-hosted only; no SaaS play
- A library model that survives being edited concurrently by desktop and mobile

---

## 10. Licensing

**GPL-3.0**, matching upstream. Obligations we care about:
- Every `spine-fmt-*` crate that ports logic from upstream calibre must credit `calibre (kovidgoyal)` in a `NOTICE` or crate-level doc comment, with a reference to the specific source file and git SHA we ported from.
- `PORTING-FROM-CALIBRE.md` is the authoritative provenance log.
- Third-party dep licenses tracked via `cargo-deny`. Any non-GPL-compatible dep gets rejected at CI.

The OPDS + REST boundary means a future proprietary mobile client (someone else's, not ours) talking to our server is fine — GPL doesn't reach across the HTTP wire. We benefit from this when we decide whether to AGPL-upgrade `spine-srv` later; for v1, straight GPL-3.0 keeps things simple.

---

## 11. Risks and open questions

**RN TurboModule + Expo Dev Build friction.** Embedding a Rust cdylib as a TurboModule that exposes `call_api(method, path, body)` is "doable, known, not polished." Expect a week of yak-shaving in Phase 3 to get `cargo ndk` + `cargo xcode` + Expo prebuild + the New Architecture TurboModule codegen cooperating. Mitigation: verify on a hello-world API call in Phase 0, before any product work depends on it. Same risk as the old UniFFI plan, narrower surface — we only ship one native method instead of one per endpoint.

**Format parity.** Calibre's MOBI writer has ~15 years of bug-fix quirks encoded in it. We will ship something that converts MOBI "correctly for 95% of books" and will slowly burn through the other 5% via bug reports. Accept this. Do not try to boil the ocean in Phase 2.

**The `metadata.db` schema is compatibility-frozen, full stop.** Decision locked: we read and write upstream calibre's `metadata.db` schema byte-compatibly through every release. A user can point Spine at an existing calibre library, use it, and switch back to upstream calibre without migration. All Spine-specific richness lives in `spine.db`, a sidecar SQLite file in the same library directory, keyed to `metadata.db.books.uuid`. If `spine.db` is missing, calibre-style Dublin Core metadata is still fully present and functional in `metadata.db`. Never add columns to `metadata.db`. The `marc:*` tag convention on the user's existing kindle library (see memory: `project_marc_tag_scheme.md`) is a worthwhile intermediate representation for calibre-only users, but Spine supersedes it internally — the sidecar stores structured MARC records, and `marc:*` tags on export become a user-enabled option rather than the only place edition metadata can live.

**iOS distribution.** App Store submission is genuinely a slog — Apple Review rejects "competing e-book reader" apps often enough to be a meme. Sideload-only (free dev cert, 7-day re-sign) is the honest ceiling unless someone volunteers $99/yr and the review fight.

**Desktop signing.** Windows Authenticode is ~$200/yr EV cert; macOS notarization is $99/yr Apple Dev. Until someone volunteers, desktop builds ship unsigned with README instructions on how to allow them. Linux doesn't care.

**Upstream relationship.** Spine pulls upstream fixes one-way and does not send changes back upstream. No claim of being "the next calibre" appears in any user-facing copy — Spine stands on its own.

**LoC SRU reliability.** Field-observed ~5-10% error rate (timeouts, 500s, malformed responses). LoC BIBFRAME endpoint covers *new* cataloging only; historical records are MARC-only via SRU. Mitigation: retry-with-backoff mandatory, offline cache required, bundle LCSH/LCNAF/LCGFT dumps as build-time assets for offline authority resolution.

**ONIX → BIBFRAME crosswalk maturity.** No universally accepted ONIX 3.0 → BIBFRAME 2.x mapping exists. EDItEUR, BIC, and LoC have partial work; none is authoritative. `spine-onix` will make mapping decisions that are genuinely contested. Mitigation: scope `spine-onix` to "partial, documented" in Phase 4; ship a manifest of mapped vs preserved-in-raw-records fields; do not claim a solved crosswalk.

**BIBFRAME ontology drift.** The `http://id.loc.gov/ontologies/bibframe/` namespace doesn't encode a version. Predicates get added, occasionally redefined. Stored data from 2027 may reference predicates that didn't exist in 2026 unless we pin. Mitigation: Spine-owned context URI (`https://spine.thereprocase.dev/context/bf-2.2.jsonld`) that resolves to a bundled pinned copy. Migration tooling rewrites stored graphs on user opt-in when we ship a new pinned version.

**Z39.50 tooling.** Essentially no pure-Rust Z39.50 support exists; `yaz` bindings to the C library are thin. Mitigation: SRU-only for international libraries (BL, DNB, BnF all support modern SRU alongside legacy Z39.50). Z39.50 is a hypothetical v2 concern; may never land.

**Privacy of deterministic local URIs.** `urn:spine:work:<hash(title|author)>` is nice for federation (two users with the same book converge) and also makes libraries correlatable if URIs leak via OPDS feeds or exported EPUBs. Open question: per-library salt? Per-user namespace? Need a privacy model documented before federation features ship.

**LLM-generated metadata fabrication.** Models asked for a date produce one, confidently. For Works where the real answer is "unknown within a century," confident fabrication propagates into the graph and gets cited as authoritative. Mitigated structurally by the asserted-vs-inferred separation (§5) — every inferred triple carries confidence + inferredBy, promotion to asserted requires explicit user action. But discipline in Phase 2+ UI affordances will matter.

**Backup granularity.** `spine.db` + `metadata.db` + raw files. User deleting `spine.db` loses user-authored graph edits (annotations, manual enrichment) but nothing machine-ingested (`raw_records` enables re-derivation). Open question: what's the backup-unit users think in? Library folder? Per-book? Needs a doc before Phase 3 ships mobile.

**Handling upstream schema evolution.** If upstream ships a `metadata.db` schema change (rare but has happened), Spine must follow or diverge. Open question: auto-follow via migration? Pin to Last Known Good schema? Document response plan before Phase 2.

**iOS FFI verification for in-process axum.** Plan asserts iOS lets us run the in-process axum router through app background cycles. In-process means no separate process; should work, but iOS background execution is famously restrictive. Verify empirically on a real iOS build in Phase 0.

---

## 12. First commits (Phase 0 checklist)

1. Verify `spine` availability on crates.io, npm, github.com/thereprocase, and a quick domain search. If any blocker, fall back to `ledger` (rerun checks).
2. Create the empty repo with LICENSE (GPL-3.0), README, CLAUDE.md, CONTRIBUTING.md. Move this PLAN.md to `docs/PLAN.md`. Copy the peer review and amicus brief into `docs/` for continuing reference.
3. Cargo workspace with empty crates listed in §8 repo layout: `calibre-db`, `spine-db`, `spine-bf`, `spine-marc`, `spine-onix`, `spine-epub-meta`, `spine-dc`, `spine-oeb`, `spine-fmt-{epub,mobi,pdf,docx,txt,html,fb2,rtf}`, `spine-meta`, `spine-api`, `spine-srv`, `spine-cli`, plus `spine-test-corpus` for fixtures.
4. pnpm workspace with `apps/desktop` (Tauri hello-world) and `apps/mobile` (Expo hello-world).
5. CI skeleton — build matrix green on an empty workspace.
6. `docs/PORTING-FROM-CALIBRE.md` with header and empty provenance table.
7. `docs/PRIOR-ART.md` — FOLIO / Koha / Readium LCP review notes, one section each.
8. `spine-api` — draft OpenAPI 3.1 with at minimum `GET /api/v1/ping` and concrete draft of `/api/v1/book/{id}` response shape. Lock URL structure, error format, and book-resource JSON shape.
9. Transport hello-world: `/api/v1/ping` reachable via in-process, Tauri command, RN TurboModule, UDS/Named Pipe, and TCP. All five green in CI.
10. Bundle CC0 authority data (LCSH, LCNAF, LCGFT, FAST, MARC relator codes) as build-time assets in `spine-bf/data/`.
11. Run stress tests S1-S6 from §9 Phase 0. Document results in `docs/PHASE-0-REALITY-CHECK.md`.

Nothing in Phase 0 is creative. It's all preamble. The first interesting commit is Phase 1 — "read an existing calibre library" — and that's the point at which the project either stays alive or doesn't.

---

## Appendix A — Name

**Picked: Spine** (pending availability check on `crates.io`, `npm`, `github.com/thereprocase/spine`, and an obvious-domain search).

Rationale: EPUB-spec native term (the `<spine>` element is the ordered list of content in an EPUB), short, pronounceable, no collision with existing e-book projects on first check, clean of any calibre-derived branding.

Fallback: **Ledger**. Dropped from shortlist: *Caliber* (too adjacent to an existing tool's name), several handle-derived names (tie the project too closely to a personal username), *Longhand* (cute but doesn't say "books").

Verify availability in Phase 0 step 1 before any commits land.

---

*Last revised: 2026-04-20. Authored collaboratively with Claude Opus 4.7.*
