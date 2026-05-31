# ADR 017: Conversion Pipeline IR — `OebBook` Contract

## Status
Draft (2026-04-25, Sprint 14 prep — `read_epub` bytes in flight on `sprint-14-impl`)

## Context

The conversion pipeline crosses families (EPUB → AZW3, FB2 → EPUB, etc.) by lifting source bytes into a format-agnostic intermediate representation, applying transforms in IR, then serializing into the target. Calibre calls this the `OEBBook` (`oeb/base.py:1775-2007`). Spine inherits the shape with three modifications: typed Rust structs instead of dynamic Python, `pub`-fields-end-to-end so plugins symmetrically consume the IR, and an explicit determinism contract enforced by an `iter_sorted` invariant on `Manifest`.

ADR 023 §"3. spine-bf invariants" added a forwarding line — *"`OebBook`, `Container`, `SourceProfile` are the IR types the initial sketch lands. ADR 017 (forthcoming, Sprint 14) locks them. Plugin authors target the IR; first-party code targets the same IR. Symmetry is the contract."* This ADR is that lock.

The struct surface already exists at `core/spine-oeb/src/oeb.rs` (`sprint-14-impl-prep`, merged on `fed975b`), with `Manifest::iter_sorted` and `OebBook::validate` as the two methods carrying the determinism + structural-integrity invariants. Sprint 14 (`read_epub`) is filling that surface in real time. The risk this ADR closes is implementation drift: without a written contract, Sprint 16 `write_azw3` or Sprint 17 `read_fb2` could pick a divergent IR shape and force a refactor pass on `read_epub`.

`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md` (the authoritative version; v3 is a workflow atlas, not the determinism spec) §3 inventories every non-determinism source in calibre's pipeline. ADR 017 ratifies the IR shape that lets Spine reproduce calibre's bytes deterministically; the per-format remediation table itself (T1-T4, U1-U8, R1-R2, I1-I7, E1-E9, F1-F4) stays in the protocol doc as the implementer's checklist.

## Decision

### 1. IR shape — `OebBook` is canonical

`core/spine-oeb::OebBook` (and its sub-structures) is the **single** intermediate representation for cross-family conversion. Every reader (`spine-fmt-epub::read_epub`, future `spine-fmt-mobi::read_azw3`, every plugin `InputFormat`) produces an `OebBook`. Every writer (Sprint 15 `write_epub`, Sprint 16 `write_azw3`, every plugin `OutputFormat`) consumes one. The shape, locked here:

```rust
pub struct OebBook {
    pub metadata:             Metadata,                  // BIBFRAME-projected DC core + calibre columns
    pub manifest:             Manifest,                  // items + by_id/by_href indexes
    pub spine:                Spine,                     // reading order + page-progression
    pub guide:                Guide,                     // cover/title-page/toc references
    pub toc:                  Toc,                       // hierarchical TOC (NCX or nav.xhtml)
    pub page_list:            PageList,                  // print-page mapping
    pub source_profile_used:  Option<SourceProfile>,     // audit field: what profile ran the read
}
```

Sub-struct shapes (`Manifest::items: Vec<ManifestItem>` + `by_id` + `by_href`; `Spine::items: Vec<SpineRef>` with `linear: bool` on the spine-side per review item S14-W1, NOT on the manifest-side; `Guide::references`, `Toc::entries` recursive, `PageList::pages`, `Metadata` with typed BIBFRAME-projected fields) are as they currently exist in `core/spine-oeb/src/oeb.rs` and `metadata.rs`. Future additions are permitted, but the existing fields + their types are locked through Sprint 19 (mobile parity sprint). After Sprint 19 a follow-on ADR may revisit if mobile-memory pressure surfaces a lazy-loader requirement on `ManifestItem::data` (currently eager `Vec<u8>` per the `oeb.rs` doc-comment).

`pub`-fields-end-to-end is the contract. There is no private inner state; no constructor that "knows" something the type doesn't expose. The cost of this choice is borne in §5 (validation is advisory, not statically enforced); the benefit is symmetry — first-party readers/writers and plugin readers/writers see exactly the same surface, and `core/spine-oeb` carries zero format-specific code.

### 2. Determinism contract

**Same source bytes + same options → same target bytes.** Bit-for-bit. Across platforms, across runs, across Spine versions within the same major release.

The contract is enforced at three layers:

1. **`OebBook` itself is deterministic by construction.** `Manifest::items` is a `Vec` (insertion order is the file's source-OPF order — non-canonical), but every output path MUST iterate via `Manifest::iter_sorted()` which collates items as `(spine_position, media_type, href, id)` per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1 §3.4 I6`. Source-OPF order is preserved on the `Vec` for diagnostic / round-trip-audit purposes; canonical output is the `iter_sorted` walk. *This is the load-bearing invariant.* A writer that walks `manifest.items` directly is broken; the lint, when added, is at-the-callsite.

2. **The pipeline's external non-determinism sources are eliminated by the format-side readers/writers.** Every `T*` / `U*` / `R*` / `E*` row in `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1 §3` is a known leak; the remediation column is the implementer's checklist. ADR 017 doesn't relitigate the table — it points at it. The IR doesn't carry a wall-clock timestamp, doesn't mint UUIDs at random, doesn't read system fonts, doesn't shell out to external binaries; if a reader/writer needs any of those, it carries them as explicit options on the read/write call (e.g. `WriteOpts::build_time: Option<UnixTimestamp>`) so the deterministic-mode caller can pin them.

3. **Iteration discipline beyond `Manifest`**. `Toc::entries` is a recursive `Vec<TocEntry>` — order is meaningful (the document's TOC sequence), so writers walk in storage order, no sort. `Guide::references` and `PageList::pages` are similarly order-significant. `Metadata` fields are typed (no `HashMap`), so iteration order is the struct field declaration order. Any future field added as a map MUST use `BTreeMap` (sorted-by-key) to preserve serialization determinism; `HashMap` is forbidden in `OebBook` and its sub-structures.

This contract is testable: build the same `OebBook` twice, serialize twice through the same writer with the same options, and the byte sequences match exactly. Sprint 15 corpus tests will assert this directly.

### 3. Boundaries — what's in scope, what's not

**In scope** (this ADR):
- `OebBook` struct shape lock.
- Determinism contract + `iter_sorted` invariant.
- Plugin-author–facing IR symmetry.
- `OebBook::validate` advisory (§5).
- Source-profile `SourceProfile` parameterization (passed to readers, recorded as `source_profile_used` in the resulting `OebBook`).

**Out of scope** (deferred):
- **Where transforms live** (style flatten, font embed, cover rationalization, image re-encode). These are mutators that take `&mut OebBook` (or `&mut Container` for same-format polish per ADR 023's `PolishOp`) and produce a new `OebBook`. The `transforms/` tree's structure, ordering, and dependency-graph live in a future ADR (slot TBD; ADR 018 was repurposed to lock EPUB writer determinism for Sprint 15). ADR 017's job is to lock the IR shape so the future transforms ADR can lock how transforms compose over it.
- **`Container` IR for same-format polish.** Calibre's "polish" path edits a ZIP-shaped container in place (no IR lift). ADR 023 references `Container` as a peer IR. Its shape is deferred to a future ADR alongside `PolishOp` (provisionally ADR 020 per ADR 018 §7's same-redirect).
- **Per-format format readers/writers.** `read_epub` (Sprint 14), `write_epub` (Sprint 15), `write_azw3` (Sprint 16, scope locked separately by ADR 019), `read_azw3` (Sprint 17), `read_fb2` (Sprint 17), etc. ADR 017 is upstream of all of them.
- **The plugin loader** (`spine-plugin-api` crate, `~/.local/share/spine/plugins/` discovery). Locked by ADR 023; ADR 017 only ratifies the IR types ADR 023 §2 refers to.

### 4. Plugin extensibility — IR symmetry is the contract

ADR 023 §2 declares five plugin trait families: `InputFormat`, `OutputFormat`, `PolishOp`, `MetadataReconciler`, `MetadataImporter` (the sixth, `ReaderEngine`, is renderer-side and doesn't touch this IR). `InputFormat::read` returns an `OebBook`. `OutputFormat::write` consumes `&OebBook`. `PolishOp::run` is `Container`-shaped and deferred to ADR 018.

Two consequences load-bear here:

1. **Plugins target the same IR as first-party code.** A community-shipped FB2 reader produces an `OebBook` indistinguishable from `spine-fmt-epub::read_epub`'s output. No "plugin IR" sub-shape, no plugin-only fields, no second-class status. The `pub`-fields-end-to-end design (§1) is what makes this symmetric — a plugin that wants to construct a `ManifestItem` with a specific `media_type` does so the same way `spine-fmt-epub` does.

2. **Sprint 14's `read_epub` MUST NOT silently close the plugin door.** Two specific traps to dodge: (a) constructing `OebBook` instances through a private constructor that plugin code can't call; (b) embedding format-detection / dispatch logic inside `spine-fmt-epub` that other readers can't extend. The `read_epub` signature locked at `core/spine-fmt-epub::read_epub(&Path, Option<SourceProfile>) -> Result<OebBook, EpubReadError>` matches the `InputFormat::read` shape exactly (modulo error type), so dropping `spine-fmt-epub` behind the `InputFormat` trait at Sprint 17 (when the loader lands) is a one-line `impl`, not a refactor.

The `InputFormat::read` signature carries `SourceProfile` by value (`profile: SourceProfile`), not `Option<SourceProfile>`. First-party readers may default to `SourceProfile::Strict` when none is supplied (the current `read_epub` does this); plugins MAY follow the same default but the trait method receives the resolved value. The optional-vs-required distinction is a first-party API ergonomic choice that doesn't leak into the plugin contract.

### 5. `OebBook::validate()` — advisory, not load-bearing

`pub`-fields-end-to-end means the IR's structural invariants (manifest indexes consistent, spine references resolve, TOC entries point at real items) cannot be statically enforced. `OebBook::validate()` exists for callers who want a runtime check; it walks `Manifest::by_id`, `Manifest::by_href`, `Spine::items`, `Guide::references`, `Toc::entries` (recursive), and `PageList::pages` and returns a `ValidationError` enum.

Sprint 14 stance: trust the integrator. `read_epub` does NOT call `validate()` on its output (parser bugs are caught by tests, not by post-hoc validation). Plugin authors who mutate `OebBook` in-flight (per ADR 023 plugin path) MAY call `validate()` defensively — review item S14-N6 captured this as the recommended path, and a future Sprint 19 builder-API ADR may make validation non-optional for mutation paths. For now, `validate()` is a tool, not a gate.

### 6. Out-of-scope items explicitly named

(So nobody re-asks them.)

- **No Iterator-of-bytes reader trait.** Readers return owned `OebBook`. Streaming readers were considered and rejected — EPUBs are small, and streaming complicates the determinism contract (partial IRs can't be canonically iterated).
- **No `Arc<OebBook>` shared-IR pattern.** Each conversion owns its `OebBook`. The `Clone` on `OebBook` is cheap enough (small structs, eager byte data) for the cases that need it.
- **No async readers/writers (yet).** Per ADR 023 §"open questions" — plugin traits are sync. If profiling shows network-fetching readers (e.g. an OPDS plugin) need async, a future ADR introduces async trait variants; ADR 017 doesn't pre-empt that decision.
- **No "lossy round-trip OK" carve-out.** Every reader is responsible for losslessness within the source format's expressive range. EPUB → OebBook → EPUB MUST be byte-identical (modulo platform-pinned options); EPUB → OebBook → AZW3 is bounded by AZW3's expressive range (locked by ADR 019).

## Rejected Alternatives

**Alt A — `HashMap<String, MetadataValue>` flexible metadata bag instead of typed `Metadata` struct.** Calibre uses this shape (`oeb/base.py::Metadata` is dict-like) to absorb arbitrary OPF/EXTH terms. Spine rejected at the `core/spine-oeb/src/lib.rs` doc-comment level: weakens the BIBFRAME-native invariant, forces every downstream consumer to know calibre's column names, and `HashMap` iteration order is non-deterministic. Typed `Metadata` with explicit BIBFRAME-projected fields is what the project's CLAUDE.md don'ts already lock; this ADR re-affirms.

**Alt B — Streaming reader returning `Iterator<Item = OebChunk>` for memory-pressured platforms.** Considered for mobile (review item S8-N1). Rejected as premature: EPUBs are small (<50MB common, <200MB worst case for image-heavy comics), eager `Vec<u8>` on `ManifestItem::data` is fine on every target platform we ship to. The `data: Vec<u8>` field is held open additively — a future `ManifestItem::data: ItemData` enum with `Eager(Vec<u8>) | Lazy(LoaderHandle)` variants is permitted without breaking the IR-shape lock.

**Alt C — Internal `OebBookBuilder` type with private fields, exposed only via methods.** Would statically enforce the §5 invariants. Rejected because it breaks plugin symmetry (§4) — plugins would need a separate `OebBookBuilder`-shaped surface OR the builder couldn't be private. Either way, the symmetric contract dies. The advisory `validate()` is the right point in the design space: invariants are checkable, not enforced; the cost is paid by integrators, not by every-`pub`-field reader.

**Alt D — Two IRs: `OebBookRead` (immutable, returned by readers) and `OebBookWrite` (mutable, consumed by writers).** Considered to make the const-vs-mutable boundary explicit. Rejected — transforms (future ADR) need mutation, and routing every transform through a `OebBookRead → OebBookWrite` conversion-then-back is two extra clones per transform. The single mutable `OebBook` is simpler and the use-site convention (`&OebBook` for read, `&mut OebBook` for transform) carries the discipline.

## Cross-references

- **`core/spine-oeb/src/oeb.rs`** — the canonical struct definitions this ADR ratifies.
- **`core/spine-oeb/src/oeb.rs::Manifest::iter_sorted`** — the determinism invariant (§2). Per review item S14-N1.
- **`core/spine-oeb/src/oeb.rs::OebBook::validate`** — advisory invariant check (§5). Per review item S14-N6.
- **`core/spine-oeb/src/profile.rs::SourceProfile`** — read-time profile selector. Per review item S14-N3 (parameter-not-field).
- **`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1.md §3`** — non-determinism inventory; per-format implementers' checklist.
- **`docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v3.md §4.2`** — workflow / format-tier framing; references the `OebBook` IR as the bridge for cross-family conversions.
- **ADR 018** — EPUB writer determinism (ZIP / OPF / serialization byte-stability contract). NOTE: original §3 of this ADR deferred transforms-tree + `Container` + `PolishOp` to ADR 018; ADR 018 was repurposed for Sprint 15 writer-determinism (higher-urgency lane), and the transforms/Container/PolishOp lock moves to a future ADR (slot TBD).
- **ADR 019 (forthcoming, Sprint 16 prep)** — AZW3 writer scope. The `OebBook` → AZW3 boundary is bounded by AZW3's expressive range, locked there.
- **ADR 023 §2** — plugin trait families (`InputFormat`, `OutputFormat`, `PolishOp`). ADR 017 ratifies the IR types those traits refer to.
- Internal design notes — the `OebBook` struct design rationale folded into the implementation.

## Revision history

- 2026-04-25 — Initial draft (Sprint 14 prep; `read_epub` bytes in flight). Ratifies `OebBook` shape from `sprint-14-impl-prep` (`fed975b`); locks `Manifest::iter_sorted` determinism invariant; defers transforms (originally → ADR 018; see 2026-04-25 patch below), AZW3 writer scope (ADR 019), plugin loader (ADR 023). Status: Draft.
- 2026-04-25 — Cross-ref patch (alongside ADR 018 draft commit). ADR 018 was repurposed from "transforms tree + `Container` + `PolishOp`" to "EPUB writer determinism" for higher-urgency Sprint 15 dispatch. §3 + `Cross-references` updated to reference "future ADR (slot TBD)" for the transforms/Container/PolishOp triad rather than ADR 018. Status: Draft (unchanged).
