//! EPUB → [`OebBook`] reader.
//!
//! Sprint-14 implementation. The function signature is the locked contract
//! (per internal design notes §4 — the read-time profile is a parameter,
//! not an `OebBook` field, per the S8 design review N3).
//!
//! # Determinism contract
//!
//! Per `BYTE_IDENTICAL_CONVERSION_PROTOCOL_v1` §3: no wall-clock reads, no
//! random UUID minting, sorted iteration on every `BTreeMap` / `Vec`
//! enumeration via [`spine_oeb::Manifest::iter_sorted`], no environment
//! leakage. The reader's only obligation is to *preserve* the structures
//! it parses without injecting non-deterministic state; output-side
//! enforcement of every byte-identical quirk is the writer's job
//! (Sprint 15+ ADR 018).
//!
//! # Sprint-14 status
//!
//! Milestone 1 lands: ZIP open, `META-INF/container.xml` parse, OPF
//! locate. Milestones 2–5 fill OPF metadata + manifest + spine + guide,
//! NCX/nav TOC fallback, and per-profile fixer wiring.

mod container;
mod edtf;
mod opf;
mod toc;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use spine_oeb::{
    Guide, GuideRef, Manifest, ManifestId, ManifestItem, OebBook, PageList, SourceProfile, Spine,
    SpineRef, Toc,
};
use zip::ZipArchive;

use crate::container::parse_container;
use crate::edtf::validate_edtf_l1;
use crate::opf::parse_opf;
use crate::toc::{fallback_from_spine, parse_nav_toc, parse_ncx, parse_page_list_from_nav};

/// Read an EPUB into the [`OebBook`] IR.
///
/// `profile = None` is equivalent to `Some(SourceProfile::Strict)` (no
/// fixers, hard-fail on malformed input). Plugin callers should always
/// pass `Some(profile)` explicitly so the fixer choice is auditable.
pub fn read_epub(path: &Path, profile: Option<SourceProfile>) -> Result<OebBook, EpubReadError> {
    let resolved = profile.unwrap_or_default();
    let fixers = resolved.fixers();

    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file).map_err(|e| EpubReadError::Zip(e.to_string()))?;

    // Reject content-level DRM up front. Font obfuscation declared via
    // `META-INF/encryption.xml` would also be readable here for the
    // deobfuscator (Sprint 14 follow-on); for now we surface DRM as a
    // hard error so the caller can route to a DRM-aware plugin.
    if archive.by_name("META-INF/encryption.xml").is_ok() {
        return Err(EpubReadError::EncryptedContent {
            detail: "META-INF/encryption.xml present; DRM/encryption out of scope for in-tree reader".into(),
            encryption_xml_path: "META-INF/encryption.xml".into(),
        });
    }

    let container_info = {
        let mut entry = archive
            .by_name("META-INF/container.xml")
            .map_err(|_| EpubReadError::MissingContainer)?;
        let mut xml = String::new();
        entry.read_to_string(&mut xml)?;
        parse_container(&xml)?
    };

    // Strict profile surfaces multi-rendition ambiguity as an error so
    // the caller picks deliberately. Other profiles take-first-and-warn
    // (warning surface lands when the reader has a logging channel —
    // tracked as a follow-on; for now non-strict callers swallow it).
    if container_info.additional_rootfiles > 0 && resolved == SourceProfile::Strict {
        return Err(EpubReadError::MultipleRootfilesAmbiguous {
            count: container_info.additional_rootfiles + 1,
            selected: container_info.opf_path.clone(),
        });
    }

    let opf_xml = {
        let mut entry = archive
            .by_name(&container_info.opf_path)
            .map_err(|_| EpubReadError::MissingOpf(container_info.opf_path.clone()))?;
        let mut xml = String::new();
        entry.read_to_string(&mut xml)?;
        xml
    };
    let mut parsed = parse_opf(&opf_xml)?;

    // Validate `<dc:date>` literals against EDTF Level-1 to match the
    // frontend's gate (`AddInstanceDialog.tsx`'s shipped regex).
    // Strict profile rejects on first malformed value; non-strict
    // profiles drop the offending date and continue. Per the S14
    // design review N1.5.
    let mut kept_dates = Vec::with_capacity(parsed.metadata.dates.len());
    for d in std::mem::take(&mut parsed.metadata.dates) {
        match validate_edtf_l1(&d.value) {
            Ok(()) => kept_dates.push(d),
            Err(_) if resolved != SourceProfile::Strict => {}
            Err(e) => {
                return Err(EpubReadError::MalformedDate {
                    value: e.value,
                    reason: e.reason,
                });
            }
        }
    }
    parsed.metadata.dates = kept_dates;

    // Resolve manifest hrefs against the OPF's parent directory so the
    // zip lookup matches calibre's behaviour: an OPF at `OEBPS/content.opf`
    // referencing `chapter1.xhtml` resolves to `OEBPS/chapter1.xhtml` in
    // the archive.
    let opf_dir = container_info
        .opf_path
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string());

    // Build a spine_position map keyed by idref so manifest items can
    // record their position in reading order.
    let spine_position_for: BTreeMap<&str, u32> = parsed
        .spine_refs
        .iter()
        .enumerate()
        .map(|(i, r)| (r.idref.as_str(), i as u32))
        .collect();

    // Optionally coalesce manifest entries that point at the same href
    // under different ids. Calibre's `manifest_dedupe` keeps the first
    // occurrence; downstream spine refs to dropped ids dangle and get
    // pruned by the spine-projection step below.
    let manifest_descriptors: Vec<_> = if fixers.manifest_dedupe {
        let mut seen: std::collections::BTreeSet<String> = Default::default();
        parsed
            .manifest_items
            .iter()
            .filter(|d| seen.insert(d.href.clone()))
            .cloned()
            .collect()
    } else {
        parsed.manifest_items.clone()
    };

    // Materialise manifest items, reading bytes from the zip. Failures
    // here surface as `MalformedManifest` (item references a missing
    // href). The Strict profile rejects on first failure; non-strict
    // profiles (PG / IA / Lenient) prune invalid items per
    // `FixerSet::manifest_prune_invalid`.
    let mut manifest = Manifest::default();
    for desc in &manifest_descriptors {
        let zip_path = match &opf_dir {
            Some(dir) => format!("{dir}/{}", desc.href),
            None => desc.href.clone(),
        };
        let bytes = match archive.by_name(&zip_path) {
            Ok(mut entry) => {
                let mut data = Vec::with_capacity(entry.size() as usize);
                entry.read_to_end(&mut data)?;
                data
            }
            Err(_) => {
                if fixers.manifest_prune_invalid {
                    continue;
                }
                return Err(EpubReadError::MalformedManifest {
                    id: desc.id.clone(),
                    href: desc.href.clone(),
                });
            }
        };

        let spine_position = spine_position_for.get(desc.id.as_str()).copied();
        let new_id = ManifestId(manifest.items.len() as u32);
        manifest.by_id.insert(desc.id.clone(), new_id);
        manifest.by_href.insert(desc.href.clone(), new_id);
        manifest.items.push(ManifestItem {
            id: desc.id.clone(),
            href: desc.href.clone(),
            media_type: desc.media_type.clone(),
            fallback: None, // resolved in second pass below
            data: bytes,
            spine_position,
            properties: desc.properties.clone(),
        });
    }

    // Second pass: resolve fallback ids → ManifestId. Items whose
    // fallback didn't survive pruning lose the link rather than failing.
    for (i, desc) in manifest_descriptors.iter().enumerate() {
        if i >= manifest.items.len() {
            // Item was pruned; nothing to fix up.
            continue;
        }
        if let Some(fb_id) = &desc.fallback_id {
            if let Some(target) = manifest.by_id.get(fb_id) {
                manifest.items[i].fallback = Some(*target);
            }
        }
    }

    // Build spine + guide. Spine entries with no surviving manifest item
    // are dropped (the manifest-prune fixer already applied above).
    let mut spine = Spine {
        items: Vec::new(),
        page_progression: parsed.page_progression,
    };
    for sref in &parsed.spine_refs {
        if let Some(item_id) = manifest.by_id.get(&sref.idref) {
            spine.items.push(SpineRef {
                item_id: *item_id,
                linear: sref.linear,
            });
        }
    }

    let mut guide = Guide::default();
    for gref in &parsed.guide_refs {
        let (href, fragment) = split_href_fragment(&gref.href);
        if let Some(item_id) = manifest.by_href.get(href) {
            guide.references.push(GuideRef {
                r#type: gref.r#type.clone(),
                title: gref.title.clone(),
                item_id: *item_id,
                fragment: fragment.map(|f| f.to_string()),
            });
        }
    }

    let toc = build_toc(&mut archive, &manifest, &spine, &opf_dir, fixers.toc_fallback_chain)?;
    let page_list = build_page_list(&manifest);

    Ok(OebBook {
        metadata: parsed.metadata,
        manifest,
        spine,
        guide,
        toc,
        page_list,
        source_profile_used: Some(resolved),
        ..OebBook::default()
    })
}

/// Extract the EPUB 3 page-list from the nav document if present.
/// Returns an empty `PageList` when no nav item carries
/// `<nav epub:type="page-list">`.
fn build_page_list(manifest: &Manifest) -> PageList {
    let nav_item = manifest
        .items
        .iter()
        .find(|i| i.properties.iter().any(|p| p == "nav"));
    let Some(nav) = nav_item else {
        return PageList::default();
    };
    let xml = match std::str::from_utf8(&nav.data) {
        Ok(s) => s,
        Err(_) => return PageList::default(),
    };
    match parse_page_list_from_nav(xml, manifest) {
        Ok(pages) => PageList { pages },
        Err(_) => PageList::default(),
    }
}

/// Walk the TOC fallback ladder per `FixerSet::toc_fallback_chain`:
/// EPUB 3 nav → NCX → spine-derived. Strict profile (chain off) tries
/// nav and NCX but skips the spine-derived fallback so absence of a
/// real TOC is recoverable but not silently masked.
fn build_toc(
    archive: &mut ZipArchive<File>,
    manifest: &Manifest,
    spine: &Spine,
    opf_dir: &Option<String>,
    fallback_chain: bool,
) -> Result<Toc, EpubReadError> {
    // Try EPUB 3 nav first (item with properties="nav").
    let nav_id = manifest
        .items
        .iter()
        .find(|i| i.properties.iter().any(|p| p == "nav"))
        .map(|i| i.id.clone());

    if let Some(id) = nav_id {
        let nav_item = &manifest.items[manifest.by_id[&id].0 as usize];
        let xml = std::str::from_utf8(&nav_item.data)
            .map_err(|e| EpubReadError::Encoding(format!("nav.xhtml: {e}")))?;
        let entries = parse_nav_toc(xml, manifest)?;
        if !entries.is_empty() {
            return Ok(Toc {
                root_label: None,
                entries,
            });
        }
    }

    // Try NCX. The NCX item is typically an `application/x-dtbncx+xml`
    // manifest entry, but the spec doesn't require that media-type
    // exactly; calibre also looks for a manifest item whose media-type
    // ends in `ncx+xml`. Match both.
    let ncx_id = manifest
        .items
        .iter()
        .find(|i| {
            i.media_type == "application/x-dtbncx+xml"
                || i.media_type.ends_with("ncx+xml")
        })
        .map(|i| i.id.clone());

    if let Some(id) = ncx_id {
        let ncx_item = &manifest.items[manifest.by_id[&id].0 as usize];
        // NCX bytes are already in `data` from the manifest pass; if
        // somehow empty, re-fetch from zip via opf-relative path.
        let xml_string;
        let xml = if !ncx_item.data.is_empty() {
            std::str::from_utf8(&ncx_item.data)
                .map_err(|e| EpubReadError::Encoding(format!("toc.ncx: {e}")))?
        } else {
            let zip_path = match opf_dir {
                Some(dir) => format!("{dir}/{}", ncx_item.href),
                None => ncx_item.href.clone(),
            };
            let mut entry = archive
                .by_name(&zip_path)
                .map_err(|e| EpubReadError::Zip(e.to_string()))?;
            xml_string = {
                let mut s = String::new();
                entry.read_to_string(&mut s)?;
                s
            };
            xml_string.as_str()
        };
        let entries = parse_ncx(xml, manifest)?;
        if !entries.is_empty() {
            return Ok(Toc {
                root_label: None,
                entries,
            });
        }
    }

    // Spine-derived fallback. Strict profile leaves this off so the
    // absence is observable; lenient/profile-with-chain falls back.
    if fallback_chain {
        let spine_ids: Vec<ManifestId> = spine.items.iter().map(|s| s.item_id).collect();
        return Ok(Toc {
            root_label: None,
            entries: fallback_from_spine(manifest, &spine_ids),
        });
    }

    Ok(Toc::default())
}

/// Split an OPF href on the first `#`. The fragment part (without the
/// `#`) is returned alongside the bare path.
fn split_href_fragment(href: &str) -> (&str, Option<&str>) {
    match href.split_once('#') {
        Some((path, frag)) => (path, Some(frag)),
        None => (href, None),
    }
}

/// Errors surfaced by [`read_epub`]. The variants mirror the failure
/// modes calibre's reader hits in practice; new failure modes get new
/// variants rather than overloading [`EpubReadError::Io`] /
/// [`EpubReadError::Encoding`].
#[derive(Debug, thiserror::Error)]
pub enum EpubReadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("missing META-INF/container.xml")]
    MissingContainer,
    #[error("missing rootfile in META-INF/container.xml")]
    MissingRootfile,
    /// EPUB 3.3 §3.5.4 allows multiple `<rootfile>` elements in
    /// `META-INF/container.xml` (one per rendition — typically a fixed-layout
    /// + reflowable pair). Calibre takes the first; Spine surfaces the
    /// ambiguity so callers can decide. Per the S14 design review N3.
    #[error("container has {count} rootfiles; first selected ({selected}) — pass profile.rendition to disambiguate")]
    MultipleRootfilesAmbiguous { count: usize, selected: String },
    #[error("missing OPF at {0}")]
    MissingOpf(String),
    /// `META-INF/encryption.xml` indicates DRM or font obfuscation. Spine
    /// handles font obfuscation in-line (see [`EpubReadError::FontDeobfuscation`])
    /// but rejects content-level DRM rather than guessing — DRM-bearing files
    /// are out of scope for the in-tree reader and route to a DRM-aware
    /// plugin (per ADR 023). Per the S14 design review N2.
    #[error("encrypted content at {encryption_xml_path}: {detail}")]
    EncryptedContent {
        detail: String,
        encryption_xml_path: String,
    },
    #[error("malformed manifest: item {id} references missing href {href}")]
    MalformedManifest { id: String, href: String },
    /// `<dc:date>` literal failed EDTF Level-1 validation. Matches the
    /// frontend's `AddInstanceDialog.tsx` gate so backend + frontend
    /// reject the same shapes. Per the S14 design review N1.5.
    #[error("malformed dc:date {value:?} ({reason})")]
    MalformedDate {
        value: String,
        reason: &'static str,
    },
    #[error("encoding: {0}")]
    Encoding(String),
    #[error("font deobfuscation: {0}")]
    FontDeobfuscation(String),
    #[error("xml: {0}")]
    Xml(String),
    #[error("zip: {0}")]
    Zip(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn build_richer_epub() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        zip.start_file("META-INF/container.xml", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();

        zip.start_file("OEBPS/content.opf", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Adventure</dc:title>
    <dc:creator opf:role="aut">A. Author</dc:creator>
    <dc:identifier id="bookid">urn:uuid:00000000-0000-0000-0000-000000000001</dc:identifier>
    <dc:language>en</dc:language>
    <meta name="calibre:series" content="Spine Saga"/>
    <meta name="calibre:series_index" content="1"/>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
  </manifest>
  <spine page-progression-direction="ltr" toc="ncx">
    <itemref idref="nav" linear="no"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
  <guide>
    <reference type="cover" title="Cover" href="ch1.xhtml#cover"/>
    <reference type="toc" href="nav.xhtml"/>
  </guide>
</package>"#,
        )
        .unwrap();

        let nav_xhtml = br#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
<nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chapter 1</a></li>
  <li><a href="ch2.xhtml#start">Chapter 2</a></li>
</ol></nav>
<nav epub:type="page-list"><ol>
  <li><a href="ch1.xhtml#p1">1</a></li>
  <li><a href="ch2.xhtml#p2">2</a></li>
</ol></nav>
</body></html>"#;
        let ncx_xml = br#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint playOrder="1"><navLabel><text>NCX Ch 1</text></navLabel><content src="ch1.xhtml"/></navPoint>
</navMap></ncx>"#;

        for (name, body) in [
            ("OEBPS/toc.ncx", &ncx_xml[..]),
            ("OEBPS/nav.xhtml", &nav_xhtml[..]),
            ("OEBPS/images/cover.png", &b"\x89PNG\r\n\x1a\nSTUB"[..]),
            ("OEBPS/ch1.xhtml", &b"<html>chapter 1</html>"[..]),
            ("OEBPS/ch2.xhtml", &b"<html>chapter 2</html>"[..]),
            ("OEBPS/styles.css", &b"body { color: black; }"[..]),
        ] {
            zip.start_file(name, stored).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
        buf.into_inner()
    }

    /// Build a minimal valid EPUB byte vec for round-trip testing.
    fn build_minimal_epub(extra_rootfiles: usize, with_encryption_xml: bool) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        let mut container = String::from(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>"#,
        );
        for i in 0..extra_rootfiles {
            container.push_str(&format!(
                "\n    <rootfile full-path=\"OEBPS/alt-{i}.opf\" media-type=\"application/oebps-package+xml\"/>"
            ));
        }
        container.push_str("\n  </rootfiles>\n</container>");
        zip.start_file("META-INF/container.xml", stored).unwrap();
        zip.write_all(container.as_bytes()).unwrap();

        if with_encryption_xml {
            zip.start_file("META-INF/encryption.xml", stored).unwrap();
            zip.write_all(b"<encryption/>").unwrap();
        }

        zip.start_file("OEBPS/content.opf", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Hello</dc:title>
    <dc:identifier id="bookid">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
  </metadata>
  <manifest><item id="x" href="x.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="x"/></spine>
</package>"#,
        )
        .unwrap();
        zip.finish().unwrap();
        buf.into_inner()
    }

    fn write_temp_epub(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("spine-fmt-epub-test-{name}.epub"));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn read_minimal_epub_records_profile() {
        let bytes = build_minimal_epub(0, false);
        let path = write_temp_epub("minimal", &bytes);
        let oeb =
            read_epub(&path, Some(SourceProfile::ProjectGutenberg)).expect("reads minimal epub");
        assert_eq!(
            oeb.source_profile_used,
            Some(SourceProfile::ProjectGutenberg)
        );
    }

    #[test]
    fn read_strict_rejects_multi_rootfile() {
        let bytes = build_minimal_epub(1, false);
        let path = write_temp_epub("multi", &bytes);
        match read_epub(&path, Some(SourceProfile::Strict)) {
            Err(EpubReadError::MultipleRootfilesAmbiguous { count, selected }) => {
                assert_eq!(count, 2);
                assert_eq!(selected, "OEBPS/content.opf");
            }
            other => panic!("expected MultipleRootfilesAmbiguous in strict, got {other:?}"),
        }
    }

    #[test]
    fn read_lenient_accepts_multi_rootfile_take_first() {
        let bytes = build_minimal_epub(1, false);
        let path = write_temp_epub("multi-lenient", &bytes);
        let oeb = read_epub(&path, Some(SourceProfile::Lenient)).expect("lenient takes first");
        assert_eq!(oeb.source_profile_used, Some(SourceProfile::Lenient));
    }

    #[test]
    fn read_rejects_drm_encrypted_content() {
        let bytes = build_minimal_epub(0, true);
        let path = write_temp_epub("drm", &bytes);
        match read_epub(&path, Some(SourceProfile::Lenient)) {
            Err(EpubReadError::EncryptedContent { encryption_xml_path, .. }) => {
                assert_eq!(encryption_xml_path, "META-INF/encryption.xml");
            }
            other => panic!("expected EncryptedContent, got {other:?}"),
        }
    }

    #[test]
    fn read_richer_epub_populates_metadata_manifest_spine_guide() {
        let bytes = build_richer_epub();
        let path = write_temp_epub("richer", &bytes);
        let oeb = read_epub(&path, Some(SourceProfile::ProjectGutenberg)).expect("reads richer");

        assert_eq!(oeb.metadata.titles, vec!["Adventure".to_string()]);
        assert_eq!(oeb.metadata.creators[0].name, "A. Author");
        assert_eq!(oeb.metadata.creators[0].role.as_deref(), Some("aut"));
        assert_eq!(
            oeb.metadata.series.as_ref().map(|s| s.title.as_str()),
            Some("Spine Saga")
        );
        assert_eq!(oeb.metadata.series_enumeration.as_deref(), Some("1"));

        // 6 manifest items declared, all hrefs resolve in the zip.
        assert_eq!(oeb.manifest.items.len(), 6);
        let by_id = &oeb.manifest.by_id;
        assert!(by_id.contains_key("ncx"));
        assert!(by_id.contains_key("nav"));
        assert!(by_id.contains_key("cover-img"));
        assert!(by_id.contains_key("ch1"));

        // ch1 is in spine at position 1 (nav at 0); record on item.
        let ch1 = oeb
            .manifest
            .items
            .iter()
            .find(|i| i.id == "ch1")
            .expect("ch1");
        assert_eq!(ch1.spine_position, Some(1));
        assert_eq!(ch1.data, b"<html>chapter 1</html>");

        // Properties survive.
        let nav = oeb.manifest.items.iter().find(|i| i.id == "nav").unwrap();
        assert_eq!(nav.properties, vec!["nav".to_string()]);
        let cover = oeb
            .manifest
            .items
            .iter()
            .find(|i| i.id == "cover-img")
            .unwrap();
        assert_eq!(cover.properties, vec!["cover-image".to_string()]);

        // Spine: nav at 0 (linear=no), ch1 at 1, ch2 at 2.
        assert_eq!(oeb.spine.items.len(), 3);
        assert_eq!(
            oeb.spine.items[0].item_id,
            *by_id.get("nav").unwrap()
        );
        assert!(!oeb.spine.items[0].linear);
        assert!(oeb.spine.items[1].linear);
        assert_eq!(oeb.spine.page_progression, spine_oeb::PageProgression::Ltr);

        // Guide: cover ref carries fragment, toc ref does not.
        assert_eq!(oeb.guide.references.len(), 2);
        let cover_ref = oeb
            .guide
            .references
            .iter()
            .find(|r| r.r#type == "cover")
            .unwrap();
        assert_eq!(cover_ref.fragment.as_deref(), Some("cover"));
        assert_eq!(cover_ref.item_id, *by_id.get("ch1").unwrap());
        let toc_ref = oeb
            .guide
            .references
            .iter()
            .find(|r| r.r#type == "toc")
            .unwrap();
        assert!(toc_ref.fragment.is_none());

        // TOC: EPUB 3 nav preferred over NCX. Two entries from nav.xhtml.
        assert_eq!(oeb.toc.entries.len(), 2);
        assert_eq!(oeb.toc.entries[0].label, "Chapter 1");
        assert_eq!(oeb.toc.entries[1].label, "Chapter 2");
        assert_eq!(oeb.toc.entries[1].fragment.as_deref(), Some("start"));

        // PageList: 2 entries from <nav epub:type="page-list">.
        assert_eq!(oeb.page_list.pages.len(), 2);
        assert_eq!(oeb.page_list.pages[0].label, "1");
        assert_eq!(oeb.page_list.pages[0].fragment.as_deref(), Some("p1"));

        // Manifest::iter_sorted should put spine items first by spine_position.
        let sorted_ids: Vec<&str> = oeb
            .manifest
            .iter_sorted()
            .map(|i| i.id.as_str())
            .collect();
        // spine: nav(0), ch1(1), ch2(2) — they should be the first three.
        assert_eq!(&sorted_ids[..3], &["nav", "ch1", "ch2"]);

        // OebBook::validate must accept this consistent structure.
        oeb.validate().expect("validate clean");
    }

    fn build_epub_with_dates(dates: &[&str]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
        )
        .unwrap();
        let mut opf = String::from(
            r#"<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Dated</dc:title>
    <dc:identifier id="bookid">x</dc:identifier>"#,
        );
        for d in dates {
            opf.push_str(&format!("\n    <dc:date>{d}</dc:date>"));
        }
        opf.push_str(
            r#"
  </metadata>
  <manifest><item id="x" href="x.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="x"/></spine>
</package>"#,
        );
        zip.start_file("OEBPS/c.opf", stored).unwrap();
        zip.write_all(opf.as_bytes()).unwrap();
        zip.start_file("OEBPS/x.xhtml", stored).unwrap();
        zip.write_all(b"<html/>").unwrap();
        zip.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn read_strict_rejects_malformed_dc_date() {
        let bytes = build_epub_with_dates(&["2024-13-99"]);
        let path = write_temp_epub("bad-date-strict", &bytes);
        match read_epub(&path, Some(SourceProfile::Strict)) {
            Err(EpubReadError::MalformedDate { value, .. }) => {
                assert_eq!(value, "2024-13-99");
            }
            other => panic!("expected MalformedDate, got {other:?}"),
        }
    }

    #[test]
    fn read_lenient_drops_malformed_dates_and_keeps_valid_ones() {
        let bytes = build_epub_with_dates(&["2024-04-25", "not-a-date", "2023-02-29"]);
        let path = write_temp_epub("bad-date-lenient", &bytes);
        let oeb = read_epub(&path, Some(SourceProfile::Lenient)).expect("lenient drops bad dates");
        // Only "2024-04-25" survives — the other two fail EDTF validation.
        assert_eq!(oeb.metadata.dates.len(), 1);
        assert_eq!(oeb.metadata.dates[0].value, "2024-04-25");
    }

    #[test]
    fn read_strict_skips_spine_fallback_when_no_toc_source_exists() {
        // Build an EPUB with NO nav and NO ncx — strict profile should
        // leave toc empty rather than spine-fallback (chain off).
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/c.opf", stored).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>NoToc</dc:title>
    <dc:identifier id="bookid">x</dc:identifier>
  </metadata>
  <manifest><item id="x" href="x.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="x"/></spine>
</package>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/x.xhtml", stored).unwrap();
        zip.write_all(b"<html/>").unwrap();
        zip.finish().unwrap();
        let path = write_temp_epub("notoc-strict", &buf.into_inner());

        let strict = read_epub(&path, Some(SourceProfile::Strict)).expect("strict reads");
        assert!(strict.toc.entries.is_empty(), "strict leaves toc empty");

        let lenient = read_epub(&path, Some(SourceProfile::Lenient)).expect("lenient reads");
        assert_eq!(
            lenient.toc.entries.len(),
            1,
            "lenient spine-fallback emits one entry per spine item"
        );
        assert_eq!(lenient.toc.entries[0].label, "x");
    }

    #[test]
    fn read_missing_file_returns_io_error() {
        let path = std::env::temp_dir().join("definitely-not-an-epub.epub");
        let _ = std::fs::remove_file(&path);
        match read_epub(&path, None) {
            Err(EpubReadError::Io(_)) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }
}
