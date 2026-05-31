//! `META-INF/container.xml` parser.
//!
//! EPUB 3.3 §3.5 requires every container archive to contain
//! `META-INF/container.xml` listing one or more `<rootfile>` elements,
//! each pointing at an OPF (Open Packaging Format) document. The first
//! rootfile is the publication's primary rendition; additional rootfiles
//! denote alternative renditions of the same Work (e.g. a fixed-layout
//! companion to a reflowable primary).
//!
//! Spine reports the count when `> 1` so callers can disambiguate via
//! [`EpubReadError::MultipleRootfilesAmbiguous`](crate::EpubReadError::MultipleRootfilesAmbiguous).
//! Calibre silently takes the first; Spine takes the first by default
//! but surfaces the ambiguity (per the S14 design review N3).

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::EpubReadError;

/// Outcome of parsing `META-INF/container.xml`. Always carries the chosen
/// rootfile path; when `additional_rootfiles > 0` callers can opt into
/// failing with [`EpubReadError::MultipleRootfilesAmbiguous`] depending on
/// their profile.
#[derive(Debug)]
pub(crate) struct ContainerInfo {
    pub(crate) opf_path: String,
    pub(crate) additional_rootfiles: usize,
}

/// Parse `META-INF/container.xml` content. Returns the path of the first
/// `<rootfile full-path="..."/>` element plus a count of any further
/// rootfiles in the same container.
pub(crate) fn parse_container(xml: &str) -> Result<ContainerInfo, EpubReadError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut first_path: Option<String> = None;
    let mut additional = 0usize;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| EpubReadError::Xml(e.to_string()))?
        {
            Event::Empty(e) | Event::Start(e) => {
                if e.local_name().as_ref() == b"rootfile" {
                    let mut full_path: Option<String> = None;
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"full-path" {
                            full_path = Some(
                                attr.unescape_value()
                                    .map_err(|err| EpubReadError::Xml(err.to_string()))?
                                    .into_owned(),
                            );
                            break;
                        }
                    }
                    if let Some(path) = full_path {
                        if first_path.is_none() {
                            first_path = Some(path);
                        } else {
                            additional += 1;
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let opf_path = first_path.ok_or(EpubReadError::MissingRootfile)?;
    Ok(ContainerInfo {
        opf_path,
        additional_rootfiles: additional,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_rootfile() {
        let xml = r#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>"#;
        let info = parse_container(xml).expect("parses");
        assert_eq!(info.opf_path, "OEBPS/content.opf");
        assert_eq!(info.additional_rootfiles, 0);
    }

    #[test]
    fn parse_multi_rootfile_keeps_first_and_counts_rest() {
        let xml = r#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="reflowable/content.opf" media-type="application/oebps-package+xml"/>
                <rootfile full-path="fixed/content.opf" media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>"#;
        let info = parse_container(xml).expect("parses");
        assert_eq!(info.opf_path, "reflowable/content.opf");
        assert_eq!(info.additional_rootfiles, 1);
    }

    #[test]
    fn missing_rootfile_yields_specific_error() {
        let xml = r#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles/>
            </container>"#;
        match parse_container(xml) {
            Err(EpubReadError::MissingRootfile) => {}
            other => panic!("expected MissingRootfile, got {other:?}"),
        }
    }
}
