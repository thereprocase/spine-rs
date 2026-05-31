use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Deserialize;
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Deserialize, Default)]
pub struct Metadata {
    pub titles: Vec<String>,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
    pub identifiers: Vec<String>,
    pub dates: Vec<String>,
    pub publishers: Vec<String>,
    pub subjects: Vec<String>,
    pub descriptions: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum EpubError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("XML parsing error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("Missing container.xml")]
    MissingContainer,
    #[error("Missing rootfile entry in container.xml")]
    MissingRootfile,
    #[error("Missing OPF file at {0}")]
    MissingOpf(String),
}

/// Extract metadata from an EPUB file at the given path.
///
/// Parses Dublin Core elements by local name only — `<dc:title>`, `<title>`,
/// or any other prefix all match. Real-world EPUBs put DC elements in the
/// `dc:` prefix; the previous serde-based implementation matched only the
/// literal element name and silently produced empty Metadata for any
/// real-world file.
pub fn extract_epub_metadata(path: &Path) -> Result<Metadata, EpubError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = {
        let mut container_file = archive
            .by_name("META-INF/container.xml")
            .map_err(|_| EpubError::MissingContainer)?;
        let mut container_xml = String::new();
        container_file.read_to_string(&mut container_xml)?;
        parse_container_for_opf(&container_xml)?
    };

    let mut opf_file = archive
        .by_name(&opf_path)
        .map_err(|_| EpubError::MissingOpf(opf_path.clone()))?;
    let mut opf_xml = String::new();
    opf_file.read_to_string(&mut opf_xml)?;

    parse_opf_metadata(&opf_xml)
}

fn parse_container_for_opf(xml: &str) -> Result<String, EpubError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Empty(e) | Event::Start(e) => {
                if e.local_name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"full-path" {
                            return Ok(attr.unescape_value()?.into_owned());
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Err(EpubError::MissingRootfile)
}

fn parse_opf_metadata(xml: &str) -> Result<Metadata, EpubError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut meta = Metadata::default();
    let mut buf = Vec::new();
    let mut in_metadata = false;
    let mut current: Option<DcField> = None;
    let mut text = String::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let local = e.local_name();
                let local = local.as_ref();
                if local == b"metadata" {
                    in_metadata = true;
                } else if in_metadata {
                    current = DcField::from_local(local);
                    text.clear();
                }
            }
            Event::End(e) => {
                let local = e.local_name();
                let local = local.as_ref();
                if local == b"metadata" {
                    in_metadata = false;
                } else if let Some(field) = current.take() {
                    let value = std::mem::take(&mut text);
                    if !value.is_empty() {
                        field.push(&mut meta, value);
                    }
                }
            }
            Event::Text(t) if current.is_some() => {
                text.push_str(&t.unescape()?);
            }
            Event::CData(t) if current.is_some() => {
                text.push_str(&String::from_utf8_lossy(t.as_ref()));
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(meta)
}

#[derive(Copy, Clone)]
enum DcField {
    Title,
    Creator,
    Language,
    Identifier,
    Date,
    Publisher,
    Subject,
    Description,
}

impl DcField {
    fn from_local(local: &[u8]) -> Option<Self> {
        match local {
            b"title" => Some(Self::Title),
            b"creator" => Some(Self::Creator),
            b"language" => Some(Self::Language),
            b"identifier" => Some(Self::Identifier),
            b"date" => Some(Self::Date),
            b"publisher" => Some(Self::Publisher),
            b"subject" => Some(Self::Subject),
            b"description" => Some(Self::Description),
            _ => None,
        }
    }

    fn push(self, meta: &mut Metadata, value: String) {
        match self {
            Self::Title => meta.titles.push(value),
            Self::Creator => meta.creators.push(value),
            Self::Language => meta.languages.push(value),
            Self::Identifier => meta.identifiers.push(value),
            Self::Date => meta.dates.push(value),
            Self::Publisher => meta.publishers.push(value),
            Self::Subject => meta.subjects.push(value),
            Self::Description => meta.descriptions.push(value),
        }
    }
}

impl Metadata {
    pub fn bibframe_preservation_triples(&self, id: uuid::Uuid) -> Vec<(String, String, String)> {
        const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        const RDFS_LABEL: &str = "http://www.w3.org/2000/01/rdf-schema#label";
        const RDF_VALUE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#value";
        const BF_IDENTIFIER: &str = "http://id.loc.gov/ontologies/bibframe/Identifier";
        const BF_IDENTIFIED_BY: &str = "http://id.loc.gov/ontologies/bibframe/identifiedBy";
        const BF_LANGUAGE: &str = "http://id.loc.gov/ontologies/bibframe/language";
        const BF_NOTE: &str = "http://id.loc.gov/ontologies/bibframe/note";
        const BF_NOTE_CLASS: &str = "http://id.loc.gov/ontologies/bibframe/Note";
        const BF_SUMMARY: &str = "http://id.loc.gov/ontologies/bibframe/summary";
        const BF_SUMMARY_CLASS: &str = "http://id.loc.gov/ontologies/bibframe/Summary";
        const BF_SOURCE: &str = "http://id.loc.gov/ontologies/bibframe/source";
        const BF_SUBJECT: &str = "http://id.loc.gov/ontologies/bibframe/subject";
        const BF_TOPIC: &str = "http://id.loc.gov/ontologies/bibframe/Topic";

        let work_uri = format!("urn:spine:work:{id}");
        let instance_uri = format!("urn:spine:instance:{id}");
        let scope = short_hash(&id.to_string());
        let mut triples = Vec::new();

        for (index, language) in self
            .languages
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let node = format!("_:epub_{scope}_language_{index}");
            triples.push((work_uri.clone(), BF_LANGUAGE.to_string(), node.clone()));
            triples.push((node.clone(), RDFS_LABEL.to_string(), language.to_string()));
            triples.push((
                node,
                BF_SOURCE.to_string(),
                "EPUB OPF dc:language".to_string(),
            ));
        }

        for (index, identifier) in self
            .identifiers
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let node = format!("_:epub_{scope}_identifier_{index}");
            triples.push((
                instance_uri.clone(),
                BF_IDENTIFIED_BY.to_string(),
                node.clone(),
            ));
            triples.push((
                node.clone(),
                RDF_TYPE.to_string(),
                BF_IDENTIFIER.to_string(),
            ));
            triples.push((node.clone(), RDF_VALUE.to_string(), identifier.to_string()));
            triples.push((
                node,
                BF_SOURCE.to_string(),
                "EPUB OPF dc:identifier".to_string(),
            ));
        }

        for (index, subject) in self
            .subjects
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let node = format!("urn:spine:subject:epub:{scope}:{index}");
            triples.push((work_uri.clone(), BF_SUBJECT.to_string(), node.clone()));
            triples.push((node.clone(), RDF_TYPE.to_string(), BF_TOPIC.to_string()));
            triples.push((node.clone(), RDFS_LABEL.to_string(), subject.to_string()));
            triples.push((
                node,
                BF_SOURCE.to_string(),
                "EPUB OPF dc:subject".to_string(),
            ));
        }

        for (index, description) in self
            .descriptions
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let node = format!("_:epub_{scope}_summary_{index}");
            triples.push((work_uri.clone(), BF_SUMMARY.to_string(), node.clone()));
            triples.push((
                node.clone(),
                RDF_TYPE.to_string(),
                BF_SUMMARY_CLASS.to_string(),
            ));
            triples.push((
                node.clone(),
                RDFS_LABEL.to_string(),
                description.to_string(),
            ));
            triples.push((
                node,
                BF_SOURCE.to_string(),
                "EPUB OPF dc:description".to_string(),
            ));
        }

        for (index, date) in self
            .dates
            .iter()
            .skip(1)
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .enumerate()
        {
            let node = format!("_:epub_{scope}_date_note_{index}");
            triples.push((instance_uri.clone(), BF_NOTE.to_string(), node.clone()));
            triples.push((
                node.clone(),
                RDF_TYPE.to_string(),
                BF_NOTE_CLASS.to_string(),
            ));
            triples.push((node.clone(), RDFS_LABEL.to_string(), date.to_string()));
            triples.push((
                node,
                BF_SOURCE.to_string(),
                "EPUB OPF additional dc:date".to_string(),
            ));
        }

        triples
    }

    pub fn into_book(self, id: uuid::Uuid) -> spine_api::Book {
        use chrono::Utc;
        use spine_api::{Book, LegacyMetadata};

        let title = self
            .titles
            .into_iter()
            .next()
            .unwrap_or_else(|| "Unknown Title".to_string());

        Book {
            id,
            title,
            authors: self.creators,
            legacy_metadata: LegacyMetadata {
                publisher: self.publishers.into_iter().next(),
                pub_date: self.dates.into_iter().next(),
                series: None,
                series_index: None,
                tags: self.subjects,
                description: self.descriptions.into_iter().next(),
                has_cover: false,
            },
            bibliographic_graph: None, // Will be filled by spine-bf if needed
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIXED_OPF: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uuid_id">
  <metadata xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Welcome to Spine</dc:title>
    <dc:language>en</dc:language>
    <dc:creator opf:role="aut">The Spine Project</dc:creator>
    <dc:identifier id="uuid_id" opf:scheme="uuid">f64f491a-163a-40b6-a6ca-b4a27f61d6d3</dc:identifier>
    <dc:publisher>Spine</dc:publisher>
    <dc:subject>welcome</dc:subject>
    <dc:subject>reference</dc:subject>
  </metadata>
</package>"#;

    const UNPREFIXED_OPF: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <title>Bare Title</title>
    <creator>Bare Creator</creator>
    <language>en</language>
  </metadata>
</package>"#;

    const CONTAINER_XML: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
   <rootfiles>
      <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
   </rootfiles>
</container>"#;

    #[test]
    fn parses_dc_prefixed_metadata() {
        let m = parse_opf_metadata(PREFIXED_OPF).unwrap();
        assert_eq!(m.titles, vec!["Welcome to Spine"]);
        assert_eq!(m.creators, vec!["The Spine Project"]);
        assert_eq!(m.languages, vec!["en"]);
        assert_eq!(m.publishers, vec!["Spine"]);
        assert_eq!(m.subjects, vec!["welcome", "reference"]);
        assert_eq!(m.identifiers, vec!["f64f491a-163a-40b6-a6ca-b4a27f61d6d3"]);
    }

    #[test]
    fn preserves_epub_metadata_as_bibframe_triples() {
        let m = parse_opf_metadata(PREFIXED_OPF).unwrap();
        let id = uuid::Uuid::parse_str("f64f491a-163a-40b6-a6ca-b4a27f61d6d3").unwrap();
        let triples = m.bibframe_preservation_triples(id);

        assert!(triples.iter().any(|(_, p, o)| {
            p == "http://id.loc.gov/ontologies/bibframe/language" && o.starts_with("_:")
        }));
        assert!(triples.iter().any(|(_, p, o)| {
            p == "http://www.w3.org/1999/02/22-rdf-syntax-ns#value"
                && o == "f64f491a-163a-40b6-a6ca-b4a27f61d6d3"
        }));
        assert!(triples.iter().any(|(_, p, o)| {
            p == "http://www.w3.org/2000/01/rdf-schema#label" && o == "welcome"
        }));
    }

    #[test]
    fn parses_unprefixed_metadata() {
        let m = parse_opf_metadata(UNPREFIXED_OPF).unwrap();
        assert_eq!(m.titles, vec!["Bare Title"]);
        assert_eq!(m.creators, vec!["Bare Creator"]);
        assert_eq!(m.languages, vec!["en"]);
    }

    #[test]
    fn parses_container_rootfile() {
        let path = parse_container_for_opf(CONTAINER_XML).unwrap();
        assert_eq!(path, "OEBPS/content.opf");
    }
}
