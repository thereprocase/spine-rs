//! Spine OEB intermediate representation.
//!
//! `OebBook` and its sub-structures are the format-agnostic bridge for every
//! cross-family conversion (Class 1 + Class 5 per
//! `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md` §B). Format-input
//! plugins (`spine-fmt-epub`, `spine-fmt-mobi`, etc.) read source files into
//! this IR; format-output plugins serialize from it.
//!
//! Sprint-14 entry shape: this crate exposes the typed [`metadata::Metadata`]
//! struct plus the [`oeb::OebBook`] struct surface (manifest / spine /
//! guide / toc / page-list), the [`profile::SourceProfile`] selector, and
//! the [`predicates`] constants. The fields are `pub` end-to-end so format
//! plugins (per ADR 023) can construct + read.
//!
//! Reader/writer logic lives in `spine-fmt-epub`, `spine-fmt-mobi`, …;
//! `spine-oeb` itself has zero format-specific code.
//!
//! # Why typed-fields-not-hashmap for calibre's columns?
//!
//! Calibre's metadata layer carries DC core terms plus calibre-specific
//! columns (`series`, `series_index`, `rating`, `timestamp`, `publication_type`,
//! `title_sort`). An earlier draft considered a `calibre_terms: HashMap<String,
//! Vec<String>>` field on [`metadata::Metadata`] for round-trip fidelity. Per
//! `CLAUDE.md` don'ts ("Don't propose 'simplifying' the BIBFRAME model into
//! Dublin Core or back to MARC21 as primary"), that shape weakens the
//! BIBFRAME-native invariant: every downstream consumer would have to know
//! calibre's column names to extract the data.
//!
//! Spine projects each calibre column onto a canonical BIBFRAME 2.0 /
//! BIBFRAME-LC / Spine-extension predicate (validated in the S8 design
//! review). The mapping is auditable because every projected
//! field has a typed Rust shape — see [`metadata::Metadata`] for the full
//! list and [`predicates`] for the IRIs.

pub mod metadata;
pub mod oeb;
pub mod predicates;
pub mod profile;

pub use metadata::{
    CarrierType, Contributor, DateValue, Identifier, Metadata, SeriesRef, Subject, SubjectScheme,
};
pub use oeb::{
    Guide, GuideRef, Manifest, ManifestId, ManifestItem, OebBook, PageEntry, PageList,
    PageProgression, Spine, SpineRef, Toc, TocEntry, ValidationError,
};
pub use profile::{FixerSet, SourceProfile};
