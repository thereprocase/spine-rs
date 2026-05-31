//! `OebBook` and its sub-structures — the format-agnostic intermediate
//! representation for cross-family conversions (Class 1 + Class 5 per
//! `docs/research/BYTE_IDENTICAL_CONVERSION_PROTOCOL_v2.md` §B).
//!
//! Mirrors the structural shape of calibre's `OEBBook`
//! (`oeb/base.py:1775-2007`) projected into idiomatic Rust per the
//! constraints captured in internal design notes.
//!
//! Sprint-14 scope: this is the *struct surface only*. The fields are
//! `pub` end-to-end so plugins implementing additional formats (per ADR 023)
//! can construct + read them. Reader/writer logic lands in
//! `spine-fmt-epub`, `spine-fmt-mobi`, etc.; this crate has zero
//! format-specific code.
//!
//! Item bytes are eager (`Vec<u8>`) for v1 — simpler `Send + Sync`, EPUBs
//! are small. A lazy-loader path may be added when memory pressure surfaces
//! on mobile (per the S8 design review N1); the current shape keeps that
//! option open behind an additive enum field.

use std::collections::BTreeMap;

use crate::metadata::Metadata;
use crate::profile::SourceProfile;

/// Intermediate representation for any cross-family conversion.
#[derive(Debug, Clone, Default)]
pub struct OebBook {
    pub metadata: Metadata,
    pub manifest: Manifest,
    pub spine: Spine,
    pub guide: Guide,
    pub toc: Toc,
    pub page_list: PageList,
    /// Profile that ran the read. Records WHAT happened during the read
    /// (for round-trip auditing); the read-time *choice* of profile is the
    /// `read_epub` parameter. `None` = read by something other than a
    /// profile-driven reader (synthetic / test fixture).
    pub source_profile_used: Option<SourceProfile>,
}

// -- Manifest ----------------------------------------------------------------

/// Collection of all files in the book. Items are addressed by
/// [`ManifestId`]; spine + guide + TOC reference items by id.
///
/// Mirrors calibre's `Manifest` (`oeb/base.py:909-1306`). Calibre's lazy
/// `_loader` is replaced by eager `data: Vec<u8>` for v1.
#[derive(Debug, Clone, Default)]
pub struct Manifest {
    pub items: Vec<ManifestItem>,
    /// id → index into `items`. Maintained alongside `items`; serialization
    /// determinism comes from `iter_sorted` (per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1`
    /// §3.4 I6 — sort by `(spine_position, media_type, href, id)` before any output).
    pub by_id: BTreeMap<String, ManifestId>,
    pub by_href: BTreeMap<String, ManifestId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ManifestId(pub u32);

#[derive(Debug, Clone)]
pub struct ManifestItem {
    /// OPF `id` attribute (must be unique within the manifest).
    pub id: String,
    /// Posix path inside the EPUB zip.
    pub href: String,
    pub media_type: String,
    pub fallback: Option<ManifestId>,
    /// Eager-loaded content bytes. May become a `LoaderHandle` enum on
    /// memory-pressured platforms (mobile); current shape keeps that
    /// option open additively.
    pub data: Vec<u8>,
    /// Index into [`Spine::items`] if part of reading order.
    pub spine_position: Option<u32>,
    /// EPUB 3 manifest item properties (`cover-image`, `nav`,
    /// `scripted`, etc.). Empty for EPUB 2.
    pub properties: Vec<String>,
}

// `linear` lives on [`SpineRef`] only — EPUB 3.3 places `linear="no"` on
// `<itemref>` (spine entry), NOT on `<item>` (manifest entry). Calibre's
// model agrees. Per the S14 design review §C.2 (W1), keeping a manifest-side
// copy would let it disagree with the spine-side truth without an enforced
// invariant.

impl Manifest {
    /// Iterate `&ManifestItem` in canonical sort order per
    /// `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1` §3.4 I6:
    /// `(spine_position, media_type, href, id)`.
    ///
    /// Spine items come first (lowest `spine_position` first), then
    /// non-spine items sorted by `(media_type, href, id)`. This is the
    /// only way the writer should walk `items` when producing OPF output;
    /// the `Vec`'s native iteration order is source-OPF order, which is
    /// not byte-identical-stable across re-emits.
    ///
    /// Per the S14 design review N1.
    pub fn iter_sorted(&self) -> impl Iterator<Item = &ManifestItem> {
        let mut indices: Vec<usize> = (0..self.items.len()).collect();
        indices.sort_by(|&a, &b| {
            let lhs = &self.items[a];
            let rhs = &self.items[b];
            // spine items first (lowest spine_position first), non-spine
            // items collated last via `unwrap_or(u32::MAX)`. None vs None
            // tie-breaks fall through to the `(media_type, href, id)` tail.
            let lhs_spine = lhs.spine_position.unwrap_or(u32::MAX);
            let rhs_spine = rhs.spine_position.unwrap_or(u32::MAX);
            (lhs_spine, &lhs.media_type, &lhs.href, &lhs.id).cmp(&(
                rhs_spine,
                &rhs.media_type,
                &rhs.href,
                &rhs.id,
            ))
        });
        indices.into_iter().map(move |i| &self.items[i])
    }
}

impl OebBook {
    /// Verify the structural invariants the IR's `pub`-fields-end-to-end
    /// API does not statically enforce:
    ///
    /// - Every [`ManifestItem::id`] is present in [`Manifest::by_id`] and
    ///   maps back to its slot.
    /// - Every [`ManifestItem::href`] is present in [`Manifest::by_href`]
    ///   and maps back to its slot.
    /// - The two indexes contain no entries pointing at non-existent
    ///   slots (no stale rows after plugin mutation).
    /// - Every [`SpineRef`], [`GuideRef`], [`TocEntry`] (recursively),
    ///   and [`PageEntry`] reference resolves to an in-range
    ///   [`ManifestId`].
    ///
    /// Sprint-14 trust-the-integrator stance keeps this advisory: plugin
    /// authors who prefer the safe path call `validate()` after their
    /// mutations; the reader path itself does not (yet — see N6 for the
    /// builder-API follow-up).
    ///
    /// Per the S14 design review N6.
    pub fn validate(&self) -> Result<(), ValidationError> {
        let item_count = self.manifest.items.len();
        let max_id = ManifestId(item_count.saturating_sub(1) as u32);

        // The IR addresses items by index-into-Vec; ManifestId(n) is in
        // range iff n < items.len(). All four reference sites below check
        // against this range.
        let in_range = |id: ManifestId| (id.0 as usize) < item_count;

        // by_id: every items[i].id is present and points back at i.
        for (i, item) in self.manifest.items.iter().enumerate() {
            let mid = ManifestId(i as u32);
            match self.manifest.by_id.get(&item.id) {
                Some(found) if *found == mid => {}
                Some(found) => {
                    return Err(ValidationError::ManifestIdIndexMismatch {
                        id: item.id.clone(),
                        item_at: mid,
                        index_points_at: *found,
                    });
                }
                None => {
                    return Err(ValidationError::ManifestIdIndexMissing {
                        id: item.id.clone(),
                    });
                }
            }
            match self.manifest.by_href.get(&item.href) {
                Some(found) if *found == mid => {}
                Some(found) => {
                    return Err(ValidationError::ManifestHrefIndexMismatch {
                        href: item.href.clone(),
                        item_at: mid,
                        index_points_at: *found,
                    });
                }
                None => {
                    return Err(ValidationError::ManifestHrefIndexMissing {
                        href: item.href.clone(),
                    });
                }
            }
        }

        // Stale index entries (id present but no matching item slot).
        for (id, mid) in &self.manifest.by_id {
            if !in_range(*mid) {
                return Err(ValidationError::ManifestIdIndexStale {
                    id: id.clone(),
                    points_at: *mid,
                    item_count,
                });
            }
        }
        for (href, mid) in &self.manifest.by_href {
            if !in_range(*mid) {
                return Err(ValidationError::ManifestHrefIndexStale {
                    href: href.clone(),
                    points_at: *mid,
                    item_count,
                });
            }
        }

        // Spine, guide, TOC, page-list cross-references.
        for (i, sref) in self.spine.items.iter().enumerate() {
            if !in_range(sref.item_id) {
                return Err(ValidationError::SpineRefDangling {
                    spine_index: i,
                    item_id: sref.item_id,
                    max: max_id,
                });
            }
        }
        for (i, gref) in self.guide.references.iter().enumerate() {
            if !in_range(gref.item_id) {
                return Err(ValidationError::GuideRefDangling {
                    guide_index: i,
                    item_id: gref.item_id,
                    max: max_id,
                });
            }
        }
        validate_toc_entries(&self.toc.entries, in_range, max_id)?;
        for (i, page) in self.page_list.pages.iter().enumerate() {
            if !in_range(page.item_id) {
                return Err(ValidationError::PageEntryDangling {
                    page_index: i,
                    item_id: page.item_id,
                    max: max_id,
                });
            }
        }

        Ok(())
    }
}

fn validate_toc_entries<F>(
    entries: &[TocEntry],
    in_range: F,
    max: ManifestId,
) -> Result<(), ValidationError>
where
    F: Fn(ManifestId) -> bool + Copy,
{
    for entry in entries {
        if let Some(id) = entry.item_id
            && !in_range(id)
        {
            return Err(ValidationError::TocEntryDangling {
                label: entry.label.clone(),
                item_id: id,
                max,
            });
        }
        validate_toc_entries(&entry.children, in_range, max)?;
    }
    Ok(())
}

/// Structural invariant violations surfaced by [`OebBook::validate`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("manifest by_id has no entry for item id {id:?}")]
    ManifestIdIndexMissing { id: String },
    #[error(
        "manifest by_id[{id:?}] points at {index_points_at:?} but the item with that id is at {item_at:?}"
    )]
    ManifestIdIndexMismatch {
        id: String,
        item_at: ManifestId,
        index_points_at: ManifestId,
    },
    #[error(
        "manifest by_id[{id:?}] points at {points_at:?} but only {item_count} item(s) exist"
    )]
    ManifestIdIndexStale {
        id: String,
        points_at: ManifestId,
        item_count: usize,
    },
    #[error("manifest by_href has no entry for item href {href:?}")]
    ManifestHrefIndexMissing { href: String },
    #[error(
        "manifest by_href[{href:?}] points at {index_points_at:?} but the item with that href is at {item_at:?}"
    )]
    ManifestHrefIndexMismatch {
        href: String,
        item_at: ManifestId,
        index_points_at: ManifestId,
    },
    #[error(
        "manifest by_href[{href:?}] points at {points_at:?} but only {item_count} item(s) exist"
    )]
    ManifestHrefIndexStale {
        href: String,
        points_at: ManifestId,
        item_count: usize,
    },
    #[error("spine[{spine_index}] references {item_id:?} but max manifest id is {max:?}")]
    SpineRefDangling {
        spine_index: usize,
        item_id: ManifestId,
        max: ManifestId,
    },
    #[error("guide[{guide_index}] references {item_id:?} but max manifest id is {max:?}")]
    GuideRefDangling {
        guide_index: usize,
        item_id: ManifestId,
        max: ManifestId,
    },
    #[error("toc entry {label:?} references {item_id:?} but max manifest id is {max:?}")]
    TocEntryDangling {
        label: String,
        item_id: ManifestId,
        max: ManifestId,
    },
    #[error("page-list[{page_index}] references {item_id:?} but max manifest id is {max:?}")]
    PageEntryDangling {
        page_index: usize,
        item_id: ManifestId,
        max: ManifestId,
    },
}

// -- Spine -------------------------------------------------------------------

/// Reading order. References Manifest items by [`ManifestId`].
/// Mirrors calibre's `Spine` (`oeb/base.py:1307-1388`).
#[derive(Debug, Clone, Default)]
pub struct Spine {
    pub items: Vec<SpineRef>,
    pub page_progression: PageProgression,
}

#[derive(Debug, Clone)]
pub struct SpineRef {
    pub item_id: ManifestId,
    /// `false` for ancillary content (footnotes, etc.).
    pub linear: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PageProgression {
    #[default]
    Ltr,
    Rtl,
    Default,
}

// -- Guide -------------------------------------------------------------------

/// Navigation guide (cover, title-page, toc, etc.). Mirrors calibre's
/// `Guide` (`oeb/base.py:1389-1517`).
#[derive(Debug, Clone, Default)]
pub struct Guide {
    pub references: Vec<GuideRef>,
}

#[derive(Debug, Clone)]
pub struct GuideRef {
    /// Guide reference type (`cover`, `title-page`, `toc`, `index`, …).
    pub r#type: String,
    pub title: Option<String>,
    pub item_id: ManifestId,
    /// Anchor inside the referenced item.
    pub fragment: Option<String>,
}

// -- Toc ---------------------------------------------------------------------

/// Hierarchical table of contents. Mirrors calibre's `TOC`
/// (`oeb/base.py:1518-1695`).
#[derive(Debug, Clone, Default)]
pub struct Toc {
    pub root_label: Option<String>,
    pub entries: Vec<TocEntry>,
}

#[derive(Debug, Clone)]
pub struct TocEntry {
    pub label: String,
    pub item_id: Option<ManifestId>,
    pub fragment: Option<String>,
    /// NCX `playOrder`; some EPUBs use this for non-spine sequencing.
    pub play_order: Option<u32>,
    pub children: Vec<TocEntry>,
}

// -- PageList ----------------------------------------------------------------

/// Print-page mapping (Adobe page-map / EPUB 3 page-list).
/// Mirrors calibre's `PageList` (`oeb/base.py:1696-1774`).
#[derive(Debug, Clone, Default)]
pub struct PageList {
    pub pages: Vec<PageEntry>,
}

#[derive(Debug, Clone)]
pub struct PageEntry {
    /// Page label as printed (`i`, `ii`, `1`, `2`, …).
    pub label: String,
    pub item_id: ManifestId,
    pub fragment: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oebbook_default_is_empty() {
        let oeb = OebBook::default();
        assert!(oeb.manifest.items.is_empty());
        assert!(oeb.manifest.by_id.is_empty());
        assert!(oeb.manifest.by_href.is_empty());
        assert!(oeb.spine.items.is_empty());
        assert_eq!(oeb.spine.page_progression, PageProgression::Ltr);
        assert!(oeb.guide.references.is_empty());
        assert!(oeb.toc.entries.is_empty());
        assert!(oeb.toc.root_label.is_none());
        assert!(oeb.page_list.pages.is_empty());
        assert!(oeb.source_profile_used.is_none());
    }

    #[test]
    fn manifest_id_is_orderable() {
        // Required for deterministic sort per BYTE_IDENTICAL §3.4 I6.
        let mut ids = vec![ManifestId(3), ManifestId(1), ManifestId(2)];
        ids.sort();
        assert_eq!(ids, vec![ManifestId(1), ManifestId(2), ManifestId(3)]);
    }

    #[test]
    fn page_progression_default_is_ltr() {
        // Default matches EPUB 3.3 §3.4.10 default for unspecified
        // `page-progression-direction`.
        assert_eq!(PageProgression::default(), PageProgression::Ltr);
    }

    fn item(id: &str, href: &str, media: &str, spine: Option<u32>) -> ManifestItem {
        ManifestItem {
            id: id.into(),
            href: href.into(),
            media_type: media.into(),
            fallback: None,
            data: Vec::new(),
            spine_position: spine,
            properties: Vec::new(),
        }
    }

    fn manifest_with(items: Vec<ManifestItem>) -> Manifest {
        let mut by_id = BTreeMap::new();
        let mut by_href = BTreeMap::new();
        for (i, it) in items.iter().enumerate() {
            by_id.insert(it.id.clone(), ManifestId(i as u32));
            by_href.insert(it.href.clone(), ManifestId(i as u32));
        }
        Manifest {
            items,
            by_id,
            by_href,
        }
    }

    #[test]
    fn iter_sorted_puts_spine_first_then_collates_others() {
        // Source-OPF order: cover, c2, c1, css. Canonical: c1, c2, cover, css.
        // (spine_position=Some asc → cover-image media-type → href tiebreaker.)
        let m = manifest_with(vec![
            item("cover", "cover.xhtml", "application/xhtml+xml", None),
            item("c2", "c2.xhtml", "application/xhtml+xml", Some(1)),
            item("c1", "c1.xhtml", "application/xhtml+xml", Some(0)),
            item("css", "style.css", "text/css", None),
        ]);
        let order: Vec<&str> = m.iter_sorted().map(|i| i.id.as_str()).collect();
        assert_eq!(order, vec!["c1", "c2", "cover", "css"]);
    }

    #[test]
    fn iter_sorted_tiebreaks_non_spine_by_media_then_href_then_id() {
        // All non-spine; differ on media first, then href, then id.
        let m = manifest_with(vec![
            item("z", "b.css", "text/css", None),
            item("a", "a.css", "text/css", None),
            item("img", "z.png", "image/png", None),
        ]);
        let order: Vec<&str> = m.iter_sorted().map(|i| i.id.as_str()).collect();
        assert_eq!(order, vec!["img", "a", "z"]);
    }

    #[test]
    fn validate_accepts_consistent_oebbook() {
        let mut oeb = OebBook::default();
        oeb.manifest = manifest_with(vec![
            item("c1", "c1.xhtml", "application/xhtml+xml", Some(0)),
            item("css", "s.css", "text/css", None),
        ]);
        oeb.spine.items.push(SpineRef {
            item_id: ManifestId(0),
            linear: true,
        });
        oeb.guide.references.push(GuideRef {
            r#type: "cover".into(),
            title: None,
            item_id: ManifestId(0),
            fragment: None,
        });
        oeb.toc.entries.push(TocEntry {
            label: "Chapter 1".into(),
            item_id: Some(ManifestId(0)),
            fragment: None,
            play_order: Some(1),
            children: Vec::new(),
        });
        oeb.page_list.pages.push(PageEntry {
            label: "1".into(),
            item_id: ManifestId(0),
            fragment: None,
        });
        assert_eq!(oeb.validate(), Ok(()));
    }

    #[test]
    fn validate_catches_dangling_spine_ref() {
        let mut oeb = OebBook::default();
        oeb.manifest = manifest_with(vec![item(
            "c1",
            "c1.xhtml",
            "application/xhtml+xml",
            Some(0),
        )]);
        oeb.spine.items.push(SpineRef {
            item_id: ManifestId(99),
            linear: true,
        });
        match oeb.validate() {
            Err(ValidationError::SpineRefDangling { item_id, .. }) => {
                assert_eq!(item_id, ManifestId(99));
            }
            other => panic!("expected SpineRefDangling, got {other:?}"),
        }
    }

    #[test]
    fn validate_catches_stale_by_id_index_after_plugin_pop() {
        // Plugin scenario: items popped without index update.
        let mut oeb = OebBook::default();
        oeb.manifest = manifest_with(vec![
            item("c1", "c1.xhtml", "application/xhtml+xml", Some(0)),
            item("c2", "c2.xhtml", "application/xhtml+xml", Some(1)),
        ]);
        oeb.manifest.items.pop();
        // by_id still carries "c2" -> ManifestId(1) but only 1 item left.
        match oeb.validate() {
            Err(ValidationError::ManifestIdIndexStale {
                id,
                points_at,
                item_count,
            }) => {
                assert_eq!(id, "c2");
                assert_eq!(points_at, ManifestId(1));
                assert_eq!(item_count, 1);
            }
            other => panic!("expected ManifestIdIndexStale, got {other:?}"),
        }
    }

    #[test]
    fn validate_catches_dangling_nested_toc_entry() {
        let mut oeb = OebBook::default();
        oeb.manifest = manifest_with(vec![item(
            "c1",
            "c1.xhtml",
            "application/xhtml+xml",
            Some(0),
        )]);
        oeb.toc.entries.push(TocEntry {
            label: "Part I".into(),
            item_id: Some(ManifestId(0)),
            fragment: None,
            play_order: None,
            children: vec![TocEntry {
                label: "Ch 1.1".into(),
                item_id: Some(ManifestId(7)),
                fragment: None,
                play_order: None,
                children: Vec::new(),
            }],
        });
        match oeb.validate() {
            Err(ValidationError::TocEntryDangling {
                label, item_id, ..
            }) => {
                assert_eq!(label, "Ch 1.1");
                assert_eq!(item_id, ManifestId(7));
            }
            other => panic!("expected TocEntryDangling on nested child, got {other:?}"),
        }
    }
}
