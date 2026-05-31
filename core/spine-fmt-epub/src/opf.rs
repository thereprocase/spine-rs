//! OPF (Open Packaging Format) parser.
//!
//! Walks an OPF document with quick-xml's pull parser and emits a
//! [`ParsedOpf`] aggregate that the read_epub driver projects into the
//! IR's [`Metadata`] / [`Manifest`] / [`Spine`] / [`Guide`] structs.
//!
//! Sprint-14 milestone scope:
//! - **M2** (this milestone): DC core elements + EPUB 2 `<meta name>` and
//!   EPUB 3 `<meta property>` for calibre-specific projection terms +
//!   BIBFRAME-recommended additive predicates (`bf:oclc`, `bf:extent`,
//!   `bf:carrier`, `bf:genreForm`).
//! - **M3**: `<manifest>` + `<spine>` + `<guide>` walking.
//!
//! The parser is single-pass: one walk of the XML feeds metadata, manifest,
//! spine, and guide collectors. Element handling is by *local name* so the
//! parser is namespace-prefix-agnostic (real-world EPUBs use `dc:title`,
//! `<title>`, or any other prefix; calibre's emitter alone has been
//! observed using all three).

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use spine_oeb::predicates;
use spine_oeb::{
    CarrierType, Contributor, DateValue, Identifier, Metadata, PageProgression, SeriesRef, Subject,
    SubjectScheme,
};

use crate::EpubReadError;

/// Aggregate output of one OPF parse pass.
#[derive(Debug, Default)]
pub(crate) struct ParsedOpf {
    pub(crate) metadata: Metadata,
    pub(crate) manifest_items: Vec<ManifestItemDescriptor>,
    pub(crate) spine_refs: Vec<SpineRefDescriptor>,
    pub(crate) page_progression: PageProgression,
    pub(crate) guide_refs: Vec<GuideRefDescriptor>,
}

/// Bytes-free manifest entry as it appears in the OPF; the read_epub
/// driver pairs this with the zip archive to materialise the actual
/// [`spine_oeb::ManifestItem`] (with `data: Vec<u8>` filled).
#[derive(Debug, Clone)]
pub(crate) struct ManifestItemDescriptor {
    pub(crate) id: String,
    pub(crate) href: String,
    pub(crate) media_type: String,
    pub(crate) fallback_id: Option<String>,
    pub(crate) properties: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SpineRefDescriptor {
    pub(crate) idref: String,
    /// EPUB linear attribute. Default true (linear=yes).
    pub(crate) linear: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct GuideRefDescriptor {
    pub(crate) r#type: String,
    pub(crate) title: Option<String>,
    /// Posix path inside the zip; may include `#fragment`.
    pub(crate) href: String,
}

/// Parse an OPF document into a [`ParsedOpf`].
pub(crate) fn parse_opf(xml: &str) -> Result<ParsedOpf, EpubReadError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut out = ParsedOpf::default();
    let mut section = Section::None;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| EpubReadError::Xml(e.to_string()))?
        {
            Event::Start(e) => match e.local_name().as_ref() {
                b"metadata" => section = Section::Metadata,
                b"manifest" => section = Section::Manifest,
                b"spine" => {
                    section = Section::Spine;
                    if let Some(dir) = attr_value(&e, b"page-progression-direction") {
                        out.page_progression = match dir.as_str() {
                            "ltr" => PageProgression::Ltr,
                            "rtl" => PageProgression::Rtl,
                            _ => PageProgression::Default,
                        };
                    }
                }
                b"guide" => section = Section::Guide,
                _ if section == Section::Metadata => {
                    let local = e.local_name().as_ref().to_vec();
                    let text = read_text(&mut reader)
                        .map_err(|err| EpubReadError::Xml(err.to_string()))?;
                    handle_metadata_start_or_empty(&mut out.metadata, &e, &local, Some(&text));
                }
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                b"metadata" | b"manifest" | b"spine" | b"guide" => section = Section::None,
                _ => {}
            },
            Event::Empty(e) => match section {
                Section::Metadata => {
                    let local = e.local_name().as_ref().to_vec();
                    handle_metadata_start_or_empty(&mut out.metadata, &e, &local, None);
                }
                Section::Manifest if e.local_name().as_ref() == b"item" => {
                    if let Some(item) = read_manifest_item(&e) {
                        out.manifest_items.push(item);
                    }
                }
                Section::Spine if e.local_name().as_ref() == b"itemref" => {
                    if let Some(idref) = attr_value(&e, b"idref") {
                        let linear = attr_value(&e, b"linear")
                            .map(|v| v != "no")
                            .unwrap_or(true);
                        out.spine_refs.push(SpineRefDescriptor { idref, linear });
                    }
                }
                Section::Guide if e.local_name().as_ref() == b"reference" => {
                    if let (Some(t), Some(href)) =
                        (attr_value(&e, b"type"), attr_value(&e, b"href"))
                    {
                        out.guide_refs.push(GuideRefDescriptor {
                            r#type: t,
                            title: attr_value(&e, b"title"),
                            href,
                        });
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

fn read_manifest_item(e: &BytesStart<'_>) -> Option<ManifestItemDescriptor> {
    let id = attr_value(e, b"id")?;
    let href = attr_value(e, b"href")?;
    let media_type = attr_value(e, b"media-type")?;
    let fallback_id = attr_value(e, b"fallback");
    let properties = attr_value(e, b"properties")
        .map(|s| {
            s.split_whitespace()
                .map(|t| t.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ManifestItemDescriptor {
        id,
        href,
        media_type,
        fallback_id,
        properties,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    None,
    Metadata,
    Manifest,
    Spine,
    Guide,
}

fn handle_metadata_start_or_empty(
    md: &mut Metadata,
    e: &BytesStart<'_>,
    local: &[u8],
    text: Option<&str>,
) {
    match local {
        b"title" => {
            if let Some(t) = text {
                md.titles.push(t.into());
            }
        }
        b"creator" => {
            if let Some(t) = text {
                md.creators.push(read_contributor(e, t));
            }
        }
        b"contributor" => {
            if let Some(t) = text {
                md.contributors.push(read_contributor(e, t));
            }
        }
        b"language" => {
            if let Some(t) = text {
                md.languages.push(t.into());
            }
        }
        b"identifier" => {
            if let Some(t) = text {
                md.identifiers.push(Identifier {
                    value: t.into(),
                    scheme: attr_value(e, b"scheme"),
                });
            }
        }
        b"date" => {
            if let Some(t) = text {
                md.dates.push(DateValue {
                    value: t.into(),
                    event: attr_value(e, b"event"),
                });
            }
        }
        b"publisher" => {
            if let Some(t) = text {
                md.publishers.push(t.into());
            }
        }
        b"subject" => {
            if let Some(t) = text {
                md.subjects.push(Subject {
                    label: t.into(),
                    authority_uri: None,
                    scheme: SubjectScheme::LocalTag,
                });
            }
        }
        b"description" => {
            if let Some(t) = text {
                md.descriptions.push(t.into());
            }
        }
        b"rights" => {
            if let Some(t) = text {
                md.rights.push(t.into());
            }
        }
        b"relation" => {
            if let Some(t) = text {
                md.relations.push(t.into());
            }
        }
        b"coverage" => {
            if let Some(t) = text {
                md.coverage.push(t.into());
            }
        }
        b"source" => {
            if let Some(t) = text {
                md.source.push(t.into());
            }
        }
        b"type" => {
            if let Some(t) = text {
                md.r#type.push(t.into());
            }
        }
        b"format" => {
            if let Some(t) = text {
                md.format.push(t.into());
            }
        }
        b"meta" => {
            handle_meta_element(md, e, text);
        }
        _ => {}
    }
}

/// EPUB 2 `<meta name="..." content="..."/>` and EPUB 3
/// `<meta property="...">value</meta>` both land here. Calibre emits
/// most of its custom columns via these — the EPUB 2 idiom for older
/// libraries, EPUB 3 idiom for current ones.
fn handle_meta_element(md: &mut Metadata, e: &BytesStart<'_>, body_text: Option<&str>) {
    // EPUB 2 idiom: name + content. EPUB 3 idiom: property (+ refines)
    // with the value in element body.
    let name = attr_value(e, b"name");
    let content = attr_value(e, b"content");
    let property = attr_value(e, b"property");

    let (key, value) = match (name, content, property, body_text) {
        (Some(n), Some(c), _, _) => (n, c),
        (_, _, Some(p), Some(t)) => (p, t.to_string()),
        // EPUB 3 emitters in legacy-compat mode emit
        // `<meta property="X" content="Y"/>` (empty element with both
        // property AND content). Per the S14 M2 design review N4: catch
        // this after the EPUB 2 / EPUB 3 main arms so name+content
        // retains priority. Real-world: calibre 5.x in legacy mode.
        (_, Some(c), Some(p), _) => (p, c),
        _ => return,
    };

    project_meta_pair(md, &key, &value);
}

/// Project a (key, value) `<meta>` pair onto the canonical [`Metadata`]
/// fields per the S8 design review §B.3 + §W1.
/// Unknown predicates land in `extensions` keyed by their full IRI when
/// the key resolves to one; calibre-prefixed keys without a canonical
/// home stay under their `calibre:` prefix in extensions.
fn project_meta_pair(md: &mut Metadata, key: &str, value: &str) {
    match key {
        "calibre:series" => {
            md.series = Some(SeriesRef {
                title: value.into(),
                work_uri: None,
            });
        }
        "calibre:series_index" => {
            md.series_enumeration = Some(value.into());
        }
        "calibre:title_sort" => {
            md.title_sort_key = Some(value.into());
        }
        "calibre:rating" => {
            if let Ok(n) = value.parse::<u8>() {
                md.user_rating = Some(n);
            }
        }
        "calibre:timestamp" => {
            // calibre emits RFC-3339 datetime here (e.g.
            // `2024-04-15T13:45:32+00:00`). Parse to unix-ms and
            // populate the typed `library_added_at` so a calibre →
            // Spine → calibre round trip preserves the original
            // library-add time. Per the S14 M2 design review W1: the
            // earlier "wait for EDTF parser" comment was a misread —
            // calibre's timestamp is RFC-3339 datetime, not EDTF.
            // Falls back to extensions if the parse fails so the
            // original bytes are still recoverable.
            match chrono::DateTime::parse_from_rfc3339(value) {
                Ok(dt) => {
                    md.library_added_at = Some(dt.timestamp_millis());
                }
                Err(_) => {
                    md.extensions
                        .entry(key.into())
                        .or_default()
                        .push(value.into());
                }
            }
        }
        // BIBFRAME-recommended additive (S8 design review §B.3).
        k if k.eq_ignore_ascii_case("bf:oclc") || k == predicates::BF_OCLC => {
            md.oclc = Some(value.into());
        }
        k if k.eq_ignore_ascii_case("bf:extent") || k == predicates::BF_EXTENT => {
            md.extent = Some(value.into());
        }
        k if k.eq_ignore_ascii_case("bf:carrier") || k == predicates::BF_CARRIER => {
            md.carrier = Some(parse_carrier_iri(value));
        }
        k if k.eq_ignore_ascii_case("bf:genreform") || k == predicates::BF_GENRE_FORM => {
            md.genre_form.push(value.into());
        }
        _ => {
            // EPUB 2 cover idiom <meta name="cover" content="..."/> stays
            // here; M3 manifest walker resolves the cover-image properties.
            md.extensions
                .entry(key.into())
                .or_default()
                .push(value.into());
        }
    }
}

fn parse_carrier_iri(value: &str) -> CarrierType {
    match value {
        "http://id.loc.gov/vocabulary/carriers/cr" | "cr" => CarrierType::OnlineResource,
        "http://id.loc.gov/vocabulary/carriers/cd" | "cd" => CarrierType::ComputerDisc,
        "http://id.loc.gov/vocabulary/carriers/ck" | "ck" => CarrierType::ComputerChip,
        "http://id.loc.gov/vocabulary/carriers/nc" | "nc" => CarrierType::Volume,
        other => CarrierType::Other(other.into()),
    }
}

fn read_contributor(e: &BytesStart<'_>, text: &str) -> Contributor {
    Contributor {
        name: text.into(),
        file_as: attr_value(e, b"file-as"),
        role: attr_value(e, b"role"),
    }
}

/// Read attribute by local name, unescaping the value. Returns `None`
/// if the attribute is absent or fails to decode.
fn attr_value(e: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.local_name().as_ref() == key {
            return attr.unescape_value().ok().map(|s| s.into_owned());
        }
    }
    None
}

/// Read concatenated text + CDATA up to the matching `End` event. Stops
/// at any unexpected EOF (which the caller surfaces as `EpubReadError`).
fn read_text(reader: &mut Reader<&[u8]>) -> Result<String, quick_xml::Error> {
    let mut out = String::new();
    let mut buf = Vec::new();
    let mut depth = 1usize;
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Text(t) => out.push_str(&t.unescape()?),
            Event::CData(c) => out.push_str(&String::from_utf8_lossy(&c)),
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(xml: &str) -> Metadata {
        parse_opf(xml).expect("opf parses").metadata
    }

    #[test]
    fn parses_dc_core_in_any_prefix() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Hello</dc:title>
    <title>Bare</title>
    <dc:creator opf:role="aut" opf:file-as="Author, Test">Test Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier opf:scheme="ISBN">978-0-00-000000-0</dc:identifier>
    <dc:date opf:event="publication">2026-04-25</dc:date>
    <dc:publisher>Spine Press</dc:publisher>
    <dc:subject>Fiction</dc:subject>
    <dc:description>A description.</dc:description>
    <dc:rights>CC0</dc:rights>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.titles, vec!["Hello".to_string(), "Bare".into()]);
        assert_eq!(md.languages, vec!["en".to_string()]);
        assert_eq!(md.creators.len(), 1);
        assert_eq!(md.creators[0].name, "Test Author");
        assert_eq!(md.creators[0].role.as_deref(), Some("aut"));
        assert_eq!(md.creators[0].file_as.as_deref(), Some("Author, Test"));
        assert_eq!(md.identifiers.len(), 1);
        assert_eq!(md.identifiers[0].value, "978-0-00-000000-0");
        assert_eq!(md.identifiers[0].scheme.as_deref(), Some("ISBN"));
        assert_eq!(md.dates.len(), 1);
        assert_eq!(md.dates[0].value, "2026-04-25");
        assert_eq!(md.dates[0].event.as_deref(), Some("publication"));
        assert_eq!(md.publishers, vec!["Spine Press".to_string()]);
        assert_eq!(md.subjects.len(), 1);
        assert_eq!(md.subjects[0].label, "Fiction");
        assert_eq!(md.descriptions, vec!["A description.".to_string()]);
        assert_eq!(md.rights, vec!["CC0".to_string()]);
    }

    #[test]
    fn projects_calibre_meta_idioms_to_bibframe_fields() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta name="calibre:series" content="The Spine Saga"/>
    <meta name="calibre:series_index" content="3"/>
    <meta name="calibre:title_sort" content="Spine Saga, The"/>
    <meta name="calibre:rating" content="8"/>
    <meta name="cover" content="cover-img"/>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.series.as_ref().map(|s| s.title.as_str()), Some("The Spine Saga"));
        assert_eq!(md.series_enumeration.as_deref(), Some("3"));
        assert_eq!(md.title_sort_key.as_deref(), Some("Spine Saga, The"));
        assert_eq!(md.user_rating, Some(8));
        // EPUB 2 cover idiom passes through to extensions until M3
        // manifest walker resolves cover-image properties.
        assert_eq!(
            md.extensions.get("cover").map(|v| v.as_slice()),
            Some(["cover-img".to_string()].as_slice())
        );
    }

    #[test]
    fn projects_epub3_meta_property_idiom() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta property="bf:oclc">123456789012</meta>
    <meta property="bf:extent">320 pages</meta>
    <meta property="bf:carrier">cr</meta>
    <meta property="bf:genreForm">Novel</meta>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.oclc.as_deref(), Some("123456789012"));
        assert_eq!(md.extent.as_deref(), Some("320 pages"));
        assert_eq!(md.carrier, Some(CarrierType::OnlineResource));
        assert_eq!(md.genre_form, vec!["Novel".to_string()]);
    }

    #[test]
    fn unknown_meta_keys_pass_through_to_extensions() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta property="schema:bookFormat">EBook</meta>
    <meta name="custom:somekey" content="someval"/>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(
            md.extensions.get("schema:bookFormat").map(|v| v.as_slice()),
            Some(["EBook".to_string()].as_slice())
        );
        assert_eq!(
            md.extensions.get("custom:somekey").map(|v| v.as_slice()),
            Some(["someval".to_string()].as_slice())
        );
    }

    #[test]
    fn calibre_timestamp_parses_rfc3339_to_library_added_at_unix_ms() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta name="calibre:timestamp" content="2018-03-15T13:45:32+00:00"/>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.library_added_at, Some(1521121532000));
        // No extensions passthrough on successful parse — the typed
        // field is the canonical home now.
        assert!(md.extensions.get("calibre:timestamp").is_none());
    }

    #[test]
    fn calibre_timestamp_unparseable_falls_back_to_extensions() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta name="calibre:timestamp" content="not-a-datetime"/>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert!(md.library_added_at.is_none());
        assert_eq!(
            md.extensions.get("calibre:timestamp").map(|v| v.as_slice()),
            Some(["not-a-datetime".to_string()].as_slice())
        );
    }

    #[test]
    fn epub3_legacy_compat_property_plus_content_idiom() {
        // Calibre 5.x in legacy-compat mode emits this shape — both
        // property AND content on an empty <meta/>. Per the S14
        // M2 review N4, the projection now catches it.
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta property="bf:oclc" content="987654321098"/>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.oclc.as_deref(), Some("987654321098"));
    }

    #[test]
    fn carrier_iri_round_trip_full_form() {
        let xml = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <meta property="bf:carrier">http://id.loc.gov/vocabulary/carriers/nc</meta>
  </metadata>
</package>"#;
        let md = parse(xml);
        assert_eq!(md.carrier, Some(CarrierType::Volume));
    }
}
