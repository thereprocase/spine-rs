//! Bibliographic [`Metadata`] for an OEB book.
//!
//! Mirrors the structural shape of calibre's `Metadata` class
//! (`calibre/ebooks/oeb/base.py:659-908`) but projects calibre-specific
//! columns onto canonical BIBFRAME 2.0 / BIBFRAME-LC predicates rather than
//! retaining them as opaque key→value pairs. Predicate IRIs live in
//! [`super::predicates`] and were validated against the S8 design review
//! before this code landed.
//!
//! # Why not an opaque hashmap?
//!
//! An earlier draft considered a `calibre_terms: HashMap<String, Vec<String>>`
//! field for round-trip fidelity. Per `CLAUDE.md` don'ts ("Don't propose
//! 'simplifying' the BIBFRAME model into Dublin Core or back to MARC21 as
//! primary"), that shape weakens the BIBFRAME-native invariant — every
//! downstream consumer would have to know calibre's column names to extract
//! the data, recreating the 1995 Dublin-Core-as-lingua-franca mistake. A
//! typed predicate map is the contract: each calibre column maps to exactly
//! one BIBFRAME / `bflc:` / `spine:` predicate, and the mapping is auditable.

use std::collections::BTreeMap;

/// Bibliographic metadata for an OEB book — the IR analogue of an OPF
/// `<metadata>` block plus calibre-specific columns projected onto BIBFRAME.
///
/// Field grouping reflects the source: DC core terms first (multi-valued per
/// EPUB/OPF spec), then BIBFRAME-projected calibre columns (single-valued
/// where the source is single-valued), then the `extensions` passthrough for
/// genuinely-unknown OPF metadata that isn't a calibre column.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    // -- Dublin Core core --------------------------------------------------

    /// `dc:title` — book title(s). EPUB allows multiple titles (main, subtitle,
    /// short, expanded, etc.); calibre flattens to one but Spine preserves the
    /// list.
    pub titles: Vec<String>,

    /// `dc:creator` — primary creators (authors, composers, etc.). Order is
    /// authored-order from the source OPF, NOT alphabetical.
    pub creators: Vec<Contributor>,

    /// `dc:contributor` — secondary contributors (editors, translators,
    /// illustrators, etc.).
    pub contributors: Vec<Contributor>,

    /// `dc:language` — BCP-47 language tags. EPUB requires at least one;
    /// Spine accepts the full list.
    pub languages: Vec<String>,

    /// `dc:identifier` — opaque identifiers (ISBN, OCLC, UUID, DOI, etc.).
    /// Per-identifier scheme is preserved in [`Identifier::scheme`].
    pub identifiers: Vec<Identifier>,

    /// `dc:date` — dates in EDTF Level 1 form per §C of the design notes. Multiple
    /// dates may carry distinct events (publication, modification, etc.).
    pub dates: Vec<DateValue>,

    /// `dc:publisher` — publisher names (literal). Reconciliation to authority
    /// records (e.g. `<http://id.loc.gov/vocabulary/organizations/...>`)
    /// happens at the BIBFRAME projection layer, not here.
    pub publishers: Vec<String>,

    /// `dc:subject` — subject headings. Reconciled to LCSH where possible
    /// (per `core/spine-bf::SubjectReconciler`); local-tag fallback otherwise.
    pub subjects: Vec<Subject>,

    /// `dc:description` — abstracts, blurbs, descriptions.
    pub descriptions: Vec<String>,

    /// `dc:rights` — rights statement(s).
    pub rights: Vec<String>,

    /// `dc:relation` — related-work URIs or literals.
    pub relations: Vec<String>,

    /// `dc:coverage` — temporal/spatial coverage statements.
    pub coverage: Vec<String>,

    /// `dc:source` — provenance source(s) of this Item.
    pub source: Vec<String>,

    /// `dc:type` — Dublin Core type (e.g. "Text", "Image"). Rarely used in
    /// trade EPUBs; kept for completeness.
    pub r#type: Vec<String>,

    /// `dc:format` — declared format (often duplicates the carrier or the
    /// MIME type). Use [`Self::carrier`] for the BIBFRAME-correct
    /// disambiguator between online-resource vs computer-disc vs volume.
    pub format: Vec<String>,

    // -- BIBFRAME-projected calibre-specific columns -----------------------

    /// `bf:hasSeries` — Work-to-Series relationship. Calibre's `series` column
    /// projects here. Note: BIBFRAME models series at the **Work** level; the
    /// projection layer hoists Instance-side calibre `series` to the parent
    /// Work URI when emitting canonical BIBFRAME.
    pub series: Option<SeriesRef>,

    /// `bflc:seriesEnumeration` — in-series position (e.g. "3" for "the third
    /// book in the series"). Calibre's `series_index`. Stored as a literal so
    /// non-numeric forms ("3a", "3.5") round-trip.
    pub series_enumeration: Option<String>,

    /// `spine:userRating` — user's 0-10 rating. NOT BIBFRAME-canonical (it's
    /// user-side state, not cataloging). Calibre's `rating` projects here.
    /// Spine convention: even values 0, 2, 4, 6, 8, 10 (calibre's user-facing
    /// 0-5 stars × 2). Implementation accepts the full 0-10 range without
    /// further constraint.
    pub user_rating: Option<u8>,

    /// `spine:libraryAddedAt` — unix-millisecond timestamp recording when
    /// the Item joined the user's library. Library-administrative metadata.
    /// Calibre's `timestamp` projects here.
    pub library_added_at: Option<i64>,

    /// `bf:genreForm` — genre/form classification. Calibre's `publication_type`
    /// projects here. Reconciled to LCGFT URIs where possible; literal fallback.
    pub genre_form: Vec<String>,

    /// `bflc:titleSortKey` — canonicalized sort form of the title. Calibre's
    /// `title_sort` projects here.
    pub title_sort_key: Option<String>,

    // -- BIBFRAME additive (S8 design review §B recommendation) ------------

    /// `bf:oclc` — flat-form OCLC Control Number. Projected to canonical
    /// `bf:identifiedBy [a bf:OclcNumber]` at the spine-dc emit boundary.
    pub oclc: Option<String>,

    /// `bf:extent` — file-size string or page count.
    pub extent: Option<String>,

    /// `bf:carrier` — RDA carrier type. Defaults to
    /// [`CarrierType::OnlineResource`] for EPUBs delivered as files.
    pub carrier: Option<CarrierType>,

    // -- Vendor-extension passthrough --------------------------------------

    /// Predicate IRI → values for OPF `<meta>` entries that don't map to any
    /// known field above. NOT used for calibre-specific columns (those have
    /// dedicated typed fields); strictly for genuinely-unknown vendor
    /// metadata that arrives via prefix-extensions in the source OPF. Keys
    /// are full IRIs, not CURIEs, for round-trip stability.
    pub extensions: BTreeMap<String, Vec<String>>,
}

/// A creator or contributor of the work.
///
/// Mirrors calibre's `dc:creator`/`dc:contributor` shape with the OPF
/// `file-as` attribute preserved separately from the display name (so
/// "Tolkien, J. R. R." can sort as written without rewriting the display
/// form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contributor {
    /// Display form of the name ("J. R. R. Tolkien").
    pub name: String,
    /// OPF `opf:file-as` attribute — sort form of the name ("Tolkien, J. R. R.").
    pub file_as: Option<String>,
    /// MARC relator code or BIBFRAME role IRI ("aut", "edt", "ill"...).
    pub role: Option<String>,
}

/// An opaque identifier and its scheme.
///
/// The scheme determines BIBFRAME class projection: `"isbn"` →
/// `bf:identifiedBy [a bf:Isbn]`, `"oclc"` → `bf:identifiedBy [a bf:OclcNumber]`,
/// etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identifier {
    pub value: String,
    /// `"isbn"`, `"oclc"`, `"uuid"`, `"doi"`, `"asin"`, etc. Lowercase by
    /// convention; case-folding happens at parse time.
    pub scheme: Option<String>,
}

/// A date-typed value in EDTF Level 1 form (per §C of the design notes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateValue {
    /// EDTF Level 1 string. Validated by the reader; stored verbatim.
    pub value: String,
    /// OPF `opf:event` attribute — the kind of date this is
    /// ("creation", "publication", "modification"...).
    pub event: Option<String>,
}

/// A subject heading.
///
/// `authority_uri` is `Some` only after reconciliation against `id.loc.gov`
/// (or another authority); local-tag subjects carry `None` until promoted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub label: String,
    pub authority_uri: Option<String>,
    pub scheme: SubjectScheme,
}

/// Subject classification scheme.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SubjectScheme {
    /// Library of Congress Subject Headings.
    Lcsh,
    /// Book Industry Standards and Communications subject codes.
    Bisac,
    /// User-supplied tag with no authority record.
    #[default]
    LocalTag,
    /// Other authority (FAST, MeSH, etc.) — preserved as a free-form scheme
    /// identifier.
    Other(String),
}

/// Reference to a series (the series itself is a `bf:Work`).
///
/// `work_uri` is `None` until the series Work is reconciled or minted at the
/// spine-bf write boundary; the bare `title` is sufficient for round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesRef {
    pub title: String,
    pub work_uri: Option<String>,
}

/// RDA carrier type — distinguishes the physical/electronic substrate.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CarrierType {
    /// `<http://id.loc.gov/vocabulary/carriers/cr>` — online resource
    /// (EPUB on disk, file-system delivery). Default for Spine's universe.
    #[default]
    OnlineResource,
    /// `<http://id.loc.gov/vocabulary/carriers/cd>` — computer disc.
    ComputerDisc,
    /// `<http://id.loc.gov/vocabulary/carriers/ck>` — computer chip cartridge
    /// (e-readers with replaceable cartridges, niche but cataloged).
    ComputerChip,
    /// `<http://id.loc.gov/vocabulary/carriers/nc>` — volume (physical book).
    Volume,
    /// Free-form RDA carrier IRI for vocabulary growth.
    Other(String),
}

impl CarrierType {
    /// Returns the canonical RDA carrier IRI for this variant.
    pub fn iri(&self) -> &str {
        match self {
            Self::OnlineResource => "http://id.loc.gov/vocabulary/carriers/cr",
            Self::ComputerDisc => "http://id.loc.gov/vocabulary/carriers/cd",
            Self::ComputerChip => "http://id.loc.gov/vocabulary/carriers/ck",
            Self::Volume => "http://id.loc.gov/vocabulary/carriers/nc",
            Self::Other(iri) => iri,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_default_is_empty() {
        let m = Metadata::default();
        assert!(m.titles.is_empty());
        assert!(m.creators.is_empty());
        assert!(m.series.is_none());
        assert!(m.user_rating.is_none());
        assert!(m.extensions.is_empty());
    }

    #[test]
    fn metadata_holds_calibre_projection_round_trip_shape() {
        // Models calibre's typical row: title + author + series + index + rating
        // + timestamp + publication_type + title_sort projected onto BIBFRAME
        // predicates rather than retained as opaque columns.
        let m = Metadata {
            titles: vec!["The Fellowship of the Ring".to_owned()],
            creators: vec![Contributor {
                name: "J. R. R. Tolkien".to_owned(),
                file_as: Some("Tolkien, J. R. R.".to_owned()),
                role: Some("aut".to_owned()),
            }],
            series: Some(SeriesRef {
                title: "The Lord of the Rings".to_owned(),
                work_uri: None,
            }),
            series_enumeration: Some("1".to_owned()),
            user_rating: Some(10),
            library_added_at: Some(1_745_500_000_000),
            genre_form: vec!["Fantasy fiction".to_owned()],
            title_sort_key: Some("Fellowship of the Ring, The".to_owned()),
            ..Metadata::default()
        };

        assert_eq!(m.series.as_ref().unwrap().title, "The Lord of the Rings");
        assert_eq!(m.series_enumeration.as_deref(), Some("1"));
        assert_eq!(m.user_rating, Some(10));
        assert!(m.oclc.is_none()); // Not set; default
        assert!(m.extensions.is_empty()); // No vendor-extension passthrough used
    }

    #[test]
    fn carrier_iri_round_trips_canonical_values() {
        assert_eq!(
            CarrierType::OnlineResource.iri(),
            "http://id.loc.gov/vocabulary/carriers/cr"
        );
        assert_eq!(
            CarrierType::Volume.iri(),
            "http://id.loc.gov/vocabulary/carriers/nc"
        );
        assert_eq!(
            CarrierType::Other("urn:custom:tablet".to_owned()).iri(),
            "urn:custom:tablet"
        );
    }

    #[test]
    fn carrier_default_is_online_resource() {
        // Spine's universe is e-books on disk; default the carrier to the
        // overwhelmingly-common case so callers don't have to set it for
        // every Item.
        assert_eq!(CarrierType::default(), CarrierType::OnlineResource);
    }

    #[test]
    fn subject_scheme_default_is_local_tag() {
        // A subject with no authority match defaults to a local user tag.
        // LCSH-reconciled subjects must explicitly set the scheme.
        assert_eq!(SubjectScheme::default(), SubjectScheme::LocalTag);
    }

    #[test]
    fn extensions_passthrough_uses_full_iris() {
        // Vendor-extension passthrough keys are full IRIs (not CURIEs) so the
        // round-trip through any non-context-aware consumer is stable.
        let mut m = Metadata::default();
        m.extensions.insert(
            "https://kobo.com/ns/kepub-version".to_owned(),
            vec!["1.17".to_owned()],
        );
        let key = m.extensions.keys().next().unwrap();
        assert!(key.starts_with("http"));
    }
}
