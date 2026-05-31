//! BIBFRAME / BIBFRAME-LC / Spine-extension predicate IRIs used by the
//! [`Metadata`](super::metadata::Metadata) projection.
//!
//! Calibre's source data model carries DC core terms plus calibre-specific
//! columns (`series`, `series_index`, `rating`, `timestamp`, `publication_type`,
//! `title_sort`). Per the S8 design review, Spine projects
//! calibre-specific columns onto canonical BIBFRAME 2.0 / BIBFRAME-LC
//! predicates on the way INTO the IR rather than retaining an opaque
//! key→value bag — that bag would weaken the BIBFRAME-native invariant locked
//! by `CLAUDE.md`.
//!
//! These constants are the IRIs Spine emits when serializing the IR back to
//! Turtle / JSON-LD / OPF `<meta>` projections.

/// `bf:` namespace base — Library of Congress BIBFRAME 2.0 ontology.
///
/// Per `CLAUDE.md` don'ts, Spine references **pinned context URIs** for
/// stored data rather than treating `http://id.loc.gov/ontologies/bibframe/`
/// as versionless. This constant exists for prefix expansion only; persisted
/// triples should use Spine's pinned-context wrapper around it.
pub const BF_NAMESPACE: &str = "http://id.loc.gov/ontologies/bibframe/";

/// `bflc:` namespace base — BIBFRAME-LC extensions (Library of Congress
/// project profile sitting alongside the core BIBFRAME ontology).
pub const BFLC_NAMESPACE: &str = "http://id.loc.gov/ontologies/bflc/";

/// `spine:` namespace base — Spine-internal extension predicates for state
/// that has no BIBFRAME-canonical home (user-private library state, ingest
/// administrative metadata, etc.).
pub const SPINE_NAMESPACE: &str = "https://spine.thereprocase.dev/ns/";

// -- Predicate IRIs (validated in the S8 design review) ----------------------

/// `bf:hasSeries` — Work-to-Series relationship. Calibre's `series` projects
/// here at the **Work** level (not Instance — this is one of the cross-cuts
/// flagged as a Work/Instance boundary concern in internal design notes).
pub const BF_HAS_SERIES: &str = "http://id.loc.gov/ontologies/bibframe/hasSeries";

/// `bflc:seriesEnumeration` — in-series position. Calibre's `series_index`
/// projects here as a literal on the series-membership statement.
pub const BFLC_SERIES_ENUMERATION: &str =
    "http://id.loc.gov/ontologies/bflc/seriesEnumeration";

/// `bf:genreForm` — genre/form classification. Calibre's `publication_type`
/// (e.g. "novel", "anthology", "biography") projects here with LCGFT-class
/// canonical values when reconciled, literal fallback otherwise.
pub const BF_GENRE_FORM: &str = "http://id.loc.gov/ontologies/bibframe/genreForm";

/// `bflc:titleSortKey` — non-Work title-sort variant. Calibre's `title_sort`
/// projects here. Distinct from `bflc:nonsortChars` (which is structural
/// markup); `titleSortKey` is the canonicalized sort form.
pub const BFLC_TITLE_SORT_KEY: &str =
    "http://id.loc.gov/ontologies/bflc/titleSortKey";

/// `spine:userRating` — user-private 0-10 rating. NOT BIBFRAME-canonical
/// (BIBFRAME models cataloging metadata, not user-side state). Calibre's
/// `rating` (0-10 scale, even values) projects here.
pub const SPINE_USER_RATING: &str = "https://spine.thereprocase.dev/ns/userRating";

/// `spine:libraryAddedAt` — unix-millisecond timestamp recording when the
/// Item was added to the user's local library. Library-administrative, not
/// bibliographic. Calibre's `timestamp` projects here.
pub const SPINE_LIBRARY_ADDED_AT: &str =
    "https://spine.thereprocase.dev/ns/libraryAddedAt";

/// `bf:oclc` — flat-form OCLC Control Number predicate (per §B.3 of the
/// design notes, mirrors the `bf:isbn` flat-form pattern already in
/// spine-bf). Note: canonical BIBFRAME uses
/// `bf:identifiedBy [a bf:OclcNumber ; rdf:value "..."]` — Spine's flat form
/// is shorthand and projects to the typed form at the spine-dc Sprint 13
/// boundary (per the Work/Instance boundary review item F4).
pub const BF_OCLC: &str = "http://id.loc.gov/ontologies/bibframe/oclc";

/// `bf:extent` — physical or file extent. For Spine's universe (e-books),
/// the natural value is the file-size string ("4.2 MB") or page-count when
/// available.
pub const BF_EXTENT: &str = "http://id.loc.gov/ontologies/bibframe/extent";

/// `bf:carrier` — RDA carrier-type identifier. Distinguishes "online
/// resource" from "computer disc" from "volume" (physical book), etc.
pub const BF_CARRIER: &str = "http://id.loc.gov/ontologies/bibframe/carrier";

/// `bf:isbn` — flat-form ISBN predicate (matches existing spine-bf pattern).
pub const BF_ISBN: &str = "http://id.loc.gov/ontologies/bibframe/isbn";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predicates_use_full_iris_not_curies() {
        // Persistence layer assumes full IRIs; CURIE-style ("bf:hasSeries") would
        // break the round-trip through any non-context-aware consumer.
        for predicate in [
            BF_HAS_SERIES,
            BFLC_SERIES_ENUMERATION,
            BF_GENRE_FORM,
            BFLC_TITLE_SORT_KEY,
            SPINE_USER_RATING,
            SPINE_LIBRARY_ADDED_AT,
            BF_OCLC,
            BF_EXTENT,
            BF_CARRIER,
            BF_ISBN,
        ] {
            assert!(
                predicate.starts_with("http://") || predicate.starts_with("https://"),
                "predicate must be a full IRI: {predicate}"
            );
        }
    }

    #[test]
    fn predicates_match_namespace_prefixes() {
        assert!(BF_HAS_SERIES.starts_with(BF_NAMESPACE));
        assert!(BF_GENRE_FORM.starts_with(BF_NAMESPACE));
        assert!(BF_OCLC.starts_with(BF_NAMESPACE));
        assert!(BF_EXTENT.starts_with(BF_NAMESPACE));
        assert!(BF_CARRIER.starts_with(BF_NAMESPACE));
        assert!(BF_ISBN.starts_with(BF_NAMESPACE));

        assert!(BFLC_SERIES_ENUMERATION.starts_with(BFLC_NAMESPACE));
        assert!(BFLC_TITLE_SORT_KEY.starts_with(BFLC_NAMESPACE));

        assert!(SPINE_USER_RATING.starts_with(SPINE_NAMESPACE));
        assert!(SPINE_LIBRARY_ADDED_AT.starts_with(SPINE_NAMESPACE));
    }
}
