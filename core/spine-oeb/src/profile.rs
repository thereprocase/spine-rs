//! Source-archive profile selector for cross-family reads.
//!
//! Per the v3 workflow atlas §2.5, archive sources have characteristic
//! deficiencies (or, in the case of Standard Ebooks, characteristic
//! polish). The profile selects which fixer-chain entries the reader
//! engages.
//!
//! Per the S8 design review N3, [`SourceProfile`] is a *parameter* to
//! `read_epub`, NOT a field on [`OebBook`](crate::oeb::OebBook). The IR
//! records the result of the read in `OebBook::source_profile_used` for
//! round-trip auditing only.

/// Per-archive-source fixer-chain selector. The reader's behaviour for an
/// unknown EPUB (no `<dc:source>` clue, no profile passed) is
/// [`SourceProfile::Strict`] — refuse on malformed manifests rather than
/// silently rewriting structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceProfile {
    /// All fixers off; refuse on malformed manifests. Default for
    /// Spine-internal round-trip tests + arbitrary user files.
    #[default]
    Strict,
    /// All fixers on (manifest-prune, cover-rationalize, TOC fallback chain,
    /// encoding cleanup, font deobfuscation). Default for archive ingest from
    /// known-deficient sources (Project Gutenberg's automated EPUB pipeline
    /// emits items that fail strict validation).
    ProjectGutenberg,
    /// Pass-through with metadata enrich. Standard Ebooks ships
    /// gold-standard EPUBs; fixers off, validation strict.
    ///
    /// Per the S14 design review N5: SE intentionally emits both EPUB 2
    /// (`<meta name="cover" .../>`) and EPUB 3 (`<item properties="cover-image"/>`)
    /// cover idioms on the same Item for downstream-reader compatibility.
    /// `rationalize_cover_v3` would normalise to one — that would be a
    /// regression against SE's emit choices, so the fixer stays off here.
    /// Spine round-trips an SE EPUB exactly as published.
    StandardEbooks,
    /// Like [`SourceProfile::ProjectGutenberg`] but with IA-specific format
    /// heuristics (DAISY-source detection, OAP fallback).
    InternetArchive,
    /// All fixers on, encoding lenient. For arbitrary web-source EPUBs
    /// (Pocketbook ecosystem, other distributors).
    Lenient,
}

impl SourceProfile {
    /// Resolve the profile to its concrete fixer toggle bitmap.
    pub fn fixers(&self) -> FixerSet {
        match self {
            SourceProfile::Strict => FixerSet::default(),
            SourceProfile::ProjectGutenberg => FixerSet {
                manifest_prune_invalid: true,
                manifest_add_missing: true,
                manifest_dedupe: true,
                rationalize_cover_v2: true,
                rationalize_cover_v3: true,
                toc_fallback_chain: true,
                encoding_lenient: false,
                strip_kepub: false,
            },
            SourceProfile::StandardEbooks => FixerSet::default(),
            SourceProfile::InternetArchive => FixerSet {
                manifest_prune_invalid: true,
                manifest_add_missing: true,
                manifest_dedupe: true,
                rationalize_cover_v2: true,
                rationalize_cover_v3: true,
                toc_fallback_chain: true,
                encoding_lenient: true,
                strip_kepub: false,
            },
            SourceProfile::Lenient => FixerSet {
                manifest_prune_invalid: true,
                manifest_add_missing: true,
                manifest_dedupe: true,
                rationalize_cover_v2: true,
                rationalize_cover_v3: true,
                toc_fallback_chain: true,
                encoding_lenient: true,
                strip_kepub: true,
            },
        }
    }
}

/// Fine-grained fixer toggle bitmap. The reader chains map 1:1 onto these
/// flags so plugins can construct a custom `FixerSet` directly if the
/// stock profiles don't fit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FixerSet {
    /// Drop manifest items whose `href` does not resolve inside the zip.
    pub manifest_prune_invalid: bool,
    /// Add manifest entries for files in the zip that are referenced by
    /// the spine / TOC but missing from `<manifest>`.
    pub manifest_add_missing: bool,
    /// Coalesce manifest entries that point at the same href under
    /// different ids (calibre's `manifest_dedupe`).
    pub manifest_dedupe: bool,
    /// Calibre's `rationalize_cover2` (EPUB 2 cover normalisation; per
    /// roadmap §364 mandate).
    pub rationalize_cover_v2: bool,
    /// EPUB 3 cover normalisation (`properties="cover-image"`).
    pub rationalize_cover_v3: bool,
    /// Calibre's TOC fallback ladder: NCX → tour → html → spine → opf.
    pub toc_fallback_chain: bool,
    /// Treat encoding declarations as advisory; sniff + repair via
    /// `encoding_rs`-style recovery rather than refusing the file.
    pub encoding_lenient: bool,
    /// Strip Kobo-extension manipulations (`unkepubify`).
    pub strip_kepub: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_disables_all_fixers() {
        assert_eq!(SourceProfile::Strict.fixers(), FixerSet::default());
    }

    #[test]
    fn standard_ebooks_disables_all_fixers() {
        // SE ships gold-standard EPUBs — fixer-chain rewriting them would
        // be a regression, not a fix.
        assert_eq!(SourceProfile::StandardEbooks.fixers(), FixerSet::default());
    }

    #[test]
    fn project_gutenberg_enables_structural_fixers_but_not_encoding_lenience() {
        // PG's automated pipeline emits structurally-broken manifests; its
        // text declarations are accurate, so encoding-lenience stays off.
        let f = SourceProfile::ProjectGutenberg.fixers();
        assert!(f.manifest_prune_invalid);
        assert!(f.rationalize_cover_v2);
        assert!(f.toc_fallback_chain);
        assert!(!f.encoding_lenient);
        assert!(!f.strip_kepub);
    }

    #[test]
    fn lenient_enables_kepub_strip() {
        assert!(SourceProfile::Lenient.fixers().strip_kepub);
    }

    #[test]
    fn default_is_strict() {
        assert_eq!(SourceProfile::default(), SourceProfile::Strict);
    }
}
