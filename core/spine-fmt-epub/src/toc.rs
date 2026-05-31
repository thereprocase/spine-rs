//! TOC parsing — NCX (EPUB 2) and `<nav epub:type="toc">` (EPUB 3).
//!
//! Calibre's TOC fallback ladder (per internal design notes):
//! NCX → tour → html → spine → opf. Sprint-14 M4 implements the two
//! load-bearing rungs (NCX + nav.xhtml); the html/tour/opf rungs are
//! exercised on a tiny fraction of real-world EPUBs and land later as
//! `FixerSet::toc_fallback_chain` extras.
//!
//! The two parsers return [`spine_oeb::TocEntry`] trees directly. The
//! `read_epub` driver consults them in EPUB-version order — EPUB 3 nav
//! preferred when the manifest declares an item with `properties="nav"`,
//! else NCX, else an empty TOC.

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use spine_oeb::{Manifest, ManifestId, TocEntry};

use crate::EpubReadError;

/// Parse an NCX document into `Toc::entries`.
///
/// Resolves `<content src="...">` against the supplied [`Manifest`] by
/// href. Items whose src does not resolve to a manifest entry get
/// `item_id = None` (still kept; calibre does the same — entry remains
/// useful as a hierarchy label).
pub(crate) fn parse_ncx(xml: &str, manifest: &Manifest) -> Result<Vec<TocEntry>, EpubReadError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut stack: Vec<TocEntry> = Vec::new();
    let mut roots: Vec<TocEntry> = Vec::new();
    let mut current: Option<TocEntry> = None;
    let mut in_label = false;
    let mut in_text = false;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| EpubReadError::Xml(e.to_string()))?
        {
            Event::Start(e) => match e.local_name().as_ref() {
                b"navPoint" => {
                    if let Some(parent) = current.take() {
                        stack.push(parent);
                    }
                    current = Some(TocEntry {
                        label: String::new(),
                        item_id: None,
                        fragment: None,
                        play_order: read_u32_attr(&e, b"playOrder"),
                        children: Vec::new(),
                    });
                }
                b"navLabel" => in_label = true,
                b"text" if in_label => in_text = true,
                _ => {}
            },
            Event::Empty(e) => {
                if e.local_name().as_ref() == b"content" {
                    if let Some(c) = current.as_mut() {
                        if let Some(src) = attr_value(&e, b"src") {
                            let (path, fragment) = split_href_fragment(&src);
                            c.item_id = manifest.by_href.get(path).copied();
                            c.fragment = fragment.map(|f| f.to_string());
                        }
                    }
                }
            }
            Event::Text(t) if in_text => {
                if let Some(c) = current.as_mut() {
                    c.label
                        .push_str(&t.unescape().map_err(|err| EpubReadError::Xml(err.to_string()))?);
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"text" => in_text = false,
                b"navLabel" => in_label = false,
                b"navPoint" => {
                    if let Some(finished) = current.take() {
                        match stack.pop() {
                            Some(mut parent) => {
                                parent.children.push(finished);
                                current = Some(parent);
                            }
                            None => roots.push(finished),
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(roots)
}

/// Parse a `<nav epub:type="toc">` block from an EPUB 3 nav document.
///
/// Resolves `<a href="...">` against the manifest by href. The `<nav>`
/// element with `epub:type="toc"` is the canonical TOC; other navs
/// (`epub:type="page-list"` etc.) are parsed by other entry points.
pub(crate) fn parse_nav_toc(xml: &str, manifest: &Manifest) -> Result<Vec<TocEntry>, EpubReadError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut depth_into_toc = 0i32;
    let mut stack: Vec<TocEntry> = Vec::new();
    let mut roots: Vec<TocEntry> = Vec::new();
    let mut current: Option<TocEntry> = None;
    let mut in_a_text = false;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| EpubReadError::Xml(e.to_string()))?
        {
            Event::Start(e) => match e.local_name().as_ref() {
                b"nav" if depth_into_toc == 0 => {
                    if let Some(t) = attr_value(&e, b"type") {
                        if t == "toc" {
                            depth_into_toc = 1;
                        }
                    }
                }
                b"li" if depth_into_toc > 0 => {
                    if let Some(parent) = current.take() {
                        stack.push(parent);
                    }
                    current = Some(TocEntry {
                        label: String::new(),
                        item_id: None,
                        fragment: None,
                        play_order: None,
                        children: Vec::new(),
                    });
                }
                b"a" if depth_into_toc > 0 => {
                    if let Some(c) = current.as_mut() {
                        if let Some(href) = attr_value(&e, b"href") {
                            let (path, fragment) = split_href_fragment(&href);
                            c.item_id = manifest.by_href.get(path).copied();
                            c.fragment = fragment.map(|f| f.to_string());
                        }
                    }
                    in_a_text = true;
                }
                _ => {}
            },
            Event::Text(t) if in_a_text => {
                if let Some(c) = current.as_mut() {
                    c.label
                        .push_str(&t.unescape().map_err(|err| EpubReadError::Xml(err.to_string()))?);
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"a" => in_a_text = false,
                b"li" if depth_into_toc > 0 => {
                    if let Some(finished) = current.take() {
                        match stack.pop() {
                            Some(mut parent) => {
                                parent.children.push(finished);
                                current = Some(parent);
                            }
                            None => roots.push(finished),
                        }
                    }
                }
                b"nav" if depth_into_toc > 0 => depth_into_toc = 0,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(roots)
}

/// Parse `<nav epub:type="page-list">` from an EPUB 3 nav document.
/// Each `<li><a href="path#frag">label</a></li>` becomes one
/// [`PageEntry`].
pub(crate) fn parse_page_list_from_nav(
    xml: &str,
    manifest: &Manifest,
) -> Result<Vec<spine_oeb::PageEntry>, EpubReadError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_page_list = false;
    let mut current_label = String::new();
    let mut current_href: Option<String> = None;
    let mut in_a = false;
    let mut out: Vec<spine_oeb::PageEntry> = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| EpubReadError::Xml(e.to_string()))?
        {
            Event::Start(e) => match e.local_name().as_ref() {
                b"nav" if !in_page_list => {
                    if let Some(t) = attr_value(&e, b"type") {
                        if t == "page-list" {
                            in_page_list = true;
                        }
                    }
                }
                b"a" if in_page_list => {
                    in_a = true;
                    current_label.clear();
                    current_href = attr_value(&e, b"href");
                }
                _ => {}
            },
            Event::Text(t) if in_a => {
                current_label
                    .push_str(&t.unescape().map_err(|err| EpubReadError::Xml(err.to_string()))?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"a" if in_a => {
                    if let Some(href) = current_href.take() {
                        let (path, fragment) = split_href_fragment(&href);
                        if let Some(item_id) = manifest.by_href.get(path) {
                            out.push(spine_oeb::PageEntry {
                                label: std::mem::take(&mut current_label),
                                item_id: *item_id,
                                fragment: fragment.map(|f| f.to_string()),
                            });
                        }
                    }
                    in_a = false;
                }
                b"nav" if in_page_list => in_page_list = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

/// Spine-derived fallback TOC: one root entry per spine item, label
/// taken from the manifest item's id (the OPF doesn't carry a per-item
/// title; calibre's spine-fallback uses the file basename here).
pub(crate) fn fallback_from_spine(manifest: &Manifest, spine_item_ids: &[ManifestId]) -> Vec<TocEntry> {
    spine_item_ids
        .iter()
        .filter_map(|id| {
            let item = manifest.items.get(id.0 as usize)?;
            Some(TocEntry {
                label: item.id.clone(),
                item_id: Some(*id),
                fragment: None,
                play_order: None,
                children: Vec::new(),
            })
        })
        .collect()
}

fn attr_value(e: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.local_name().as_ref() == key {
            return attr.unescape_value().ok().map(|s| s.into_owned());
        }
    }
    None
}

fn read_u32_attr(e: &BytesStart<'_>, key: &[u8]) -> Option<u32> {
    attr_value(e, key).and_then(|s| s.parse().ok())
}

fn split_href_fragment(href: &str) -> (&str, Option<&str>) {
    match href.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (href, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use spine_oeb::ManifestItem;

    fn manifest_with(items: &[(&str, &str, &str)]) -> Manifest {
        let mut by_id = BTreeMap::new();
        let mut by_href = BTreeMap::new();
        let mut vec = Vec::new();
        for (i, (id, href, media)) in items.iter().enumerate() {
            by_id.insert(id.to_string(), ManifestId(i as u32));
            by_href.insert(href.to_string(), ManifestId(i as u32));
            vec.push(ManifestItem {
                id: id.to_string(),
                href: href.to_string(),
                media_type: media.to_string(),
                fallback: None,
                data: Vec::new(),
                spine_position: None,
                properties: Vec::new(),
            });
        }
        Manifest {
            items: vec,
            by_id,
            by_href,
        }
    }

    #[test]
    fn parse_ncx_flat_navmap() {
        let xml = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint playOrder="2"><navLabel><text>Chapter 2</text></navLabel><content src="ch2.xhtml#top"/></navPoint>
  </navMap>
</ncx>"#;
        let m = manifest_with(&[
            ("ch1", "ch1.xhtml", "application/xhtml+xml"),
            ("ch2", "ch2.xhtml", "application/xhtml+xml"),
        ]);
        let toc = parse_ncx(xml, &m).expect("ncx parses");
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].label, "Chapter 1");
        assert_eq!(toc[0].play_order, Some(1));
        assert_eq!(toc[0].item_id, Some(ManifestId(0)));
        assert!(toc[0].fragment.is_none());
        assert_eq!(toc[1].fragment.as_deref(), Some("top"));
    }

    #[test]
    fn parse_ncx_nested_navpoints() {
        let xml = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint><navLabel><text>Part I</text></navLabel><content src="p1.xhtml"/>
      <navPoint><navLabel><text>Ch 1</text></navLabel><content src="ch1.xhtml"/></navPoint>
      <navPoint><navLabel><text>Ch 2</text></navLabel><content src="ch2.xhtml"/></navPoint>
    </navPoint>
  </navMap>
</ncx>"#;
        let m = manifest_with(&[
            ("p1", "p1.xhtml", "application/xhtml+xml"),
            ("ch1", "ch1.xhtml", "application/xhtml+xml"),
            ("ch2", "ch2.xhtml", "application/xhtml+xml"),
        ]);
        let toc = parse_ncx(xml, &m).expect("ncx parses");
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].label, "Part I");
        assert_eq!(toc[0].children.len(), 2);
        assert_eq!(toc[0].children[0].label, "Ch 1");
        assert_eq!(toc[0].children[1].label, "Ch 2");
    }

    #[test]
    fn parse_nav_toc_basic() {
        let xml = r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="ch1.xhtml">Chapter 1</a></li>
        <li><a href="ch2.xhtml#start">Chapter 2</a></li>
      </ol>
    </nav>
  </body>
</html>"#;
        let m = manifest_with(&[
            ("ch1", "ch1.xhtml", "application/xhtml+xml"),
            ("ch2", "ch2.xhtml", "application/xhtml+xml"),
        ]);
        let toc = parse_nav_toc(xml, &m).expect("nav parses");
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].label, "Chapter 1");
        assert_eq!(toc[0].item_id, Some(ManifestId(0)));
        assert_eq!(toc[1].fragment.as_deref(), Some("start"));
    }

    #[test]
    fn parse_nav_toc_ignores_other_nav_blocks() {
        let xml = r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="page-list">
      <ol><li><a href="ch1.xhtml#p1">1</a></li></ol>
    </nav>
    <nav epub:type="toc">
      <ol><li><a href="ch1.xhtml">Real Chapter</a></li></ol>
    </nav>
  </body>
</html>"#;
        let m = manifest_with(&[("ch1", "ch1.xhtml", "application/xhtml+xml")]);
        let toc = parse_nav_toc(xml, &m).expect("nav parses");
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].label, "Real Chapter");
    }

    #[test]
    fn fallback_from_spine_emits_one_entry_per_spine_id() {
        let m = manifest_with(&[
            ("ch1", "ch1.xhtml", "application/xhtml+xml"),
            ("ch2", "ch2.xhtml", "application/xhtml+xml"),
        ]);
        let toc = fallback_from_spine(&m, &[ManifestId(0), ManifestId(1)]);
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].label, "ch1");
        assert_eq!(toc[0].item_id, Some(ManifestId(0)));
    }

    #[test]
    fn parse_page_list_emits_page_entries() {
        let xml = r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="page-list">
      <ol>
        <li><a href="ch1.xhtml#p1">i</a></li>
        <li><a href="ch1.xhtml#p2">ii</a></li>
        <li><a href="ch2.xhtml#p3">1</a></li>
      </ol>
    </nav>
  </body>
</html>"#;
        let m = manifest_with(&[
            ("ch1", "ch1.xhtml", "application/xhtml+xml"),
            ("ch2", "ch2.xhtml", "application/xhtml+xml"),
        ]);
        let pages = parse_page_list_from_nav(xml, &m).expect("page-list parses");
        assert_eq!(pages.len(), 3);
        assert_eq!(pages[0].label, "i");
        assert_eq!(pages[0].fragment.as_deref(), Some("p1"));
        assert_eq!(pages[2].label, "1");
        assert_eq!(pages[2].item_id, ManifestId(1));
    }

    #[test]
    fn ncx_unresolved_src_keeps_label_drops_item_id() {
        let xml = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint><navLabel><text>Orphan</text></navLabel><content src="missing.xhtml"/></navPoint>
  </navMap>
</ncx>"#;
        let m = manifest_with(&[("ch1", "ch1.xhtml", "application/xhtml+xml")]);
        let toc = parse_ncx(xml, &m).expect("ncx parses");
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].label, "Orphan");
        assert!(toc[0].item_id.is_none());
    }
}
