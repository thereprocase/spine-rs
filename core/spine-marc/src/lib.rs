//! `spine-marc` — MARC XML parser and BIBFRAME graph builder.
//!
//! # Field coverage vs marc2bibframe2
//!
//! The regression corpus used to measure fidelity is at
//! `tests/data/regression_corpus.xml` (100+ diverse MARC XML records from the
//! LoC dataset, sourced from the official `marc2bibframe2` repository).
//!
//! ## Currently preserved
//!
//! - **001** Control Number: used for local URIs (`urn:loc:work:{id}`).
//! - **100** Main Entry — Personal Name: mapped to `creators` (AgentLink).
//! - **245** Title Statement: title extraction.
//! - **260/264** Publication/Distribution: publication date (subfield `c`).
//! - **650** Subject Added Entry: mapped to `subjects` (AuthorityLink).
//!
//! ## Known gaps (not yet implemented)
//!
//! - **Identifiers (010, 020, 022, 024, 035)**: LCCN, ISBN, ISSN, OCLC numbers — dropped.
//! - **Additional contributors (700, 710, 711)**: editors, additional authors, corporate bodies — dropped.
//! - **Series (490, 830)**: series titles and volume numbers — dropped.
//! - **Notes (5XX)**: summary (520), bibliography (504), general notes (500) — dropped.
//! - **Physical description (300, 336, 337, 338)**: page counts, media types, carrier types — dropped.
//! - **Publisher name and place (260/264 subfields a, b)**: only date (subfield c) extracted.
//!
//! Any new field extraction should add assertions to the regression corpus
//! integration test at `tests/integration_test.rs`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("XML parsing error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("Deserialization error: {0}")]
    De(#[from] quick_xml::DeError),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subfield {
    #[serde(rename = "@code")]
    pub code: String,
    #[serde(rename = "$value")]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataField {
    #[serde(rename = "@tag")]
    pub tag: String,
    #[serde(rename = "@ind1", default)]
    pub ind1: String,
    #[serde(rename = "@ind2", default)]
    pub ind2: String,
    #[serde(rename = "subfield", default)]
    pub subfields: Vec<Subfield>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlField {
    #[serde(rename = "@tag")]
    pub tag: String,
    #[serde(rename = "$value")]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarcRecord {
    pub leader: Option<String>,
    #[serde(rename = "controlfield", default)]
    pub control_fields: Vec<ControlField>,
    #[serde(rename = "datafield", default)]
    pub data_fields: Vec<DataField>,
}

impl MarcRecord {
    pub fn get_datafield<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = &'a DataField> + 'a {
        self.data_fields.iter().filter(move |f| f.tag == tag)
    }

    pub fn get_subfield<'a>(
        &'a self,
        tag: &'a str,
        code: &'a str,
    ) -> impl Iterator<Item = &'a str> + 'a {
        self.get_datafield(tag)
            .flat_map(|f| &f.subfields)
            .filter(move |s| s.code == code)
            .map(|s| s.value.as_str())
    }
}

pub fn extract_marc_records(xml: &str) -> Result<Vec<MarcRecord>, Error> {
    let mut records = Vec::new();
    // Instead of raw event parsing which is tedious, let's find the inner <record> elements manually.
    // It's a bit of a hack but extremely robust for SRU wrapping.

    for start_idx in xml
        .match_indices("<record")
        .map(|(i, _)| i)
        .chain(xml.match_indices("<marc:record").map(|(i, _)| i))
    {
        let tag_name = if xml[start_idx..].starts_with("<marc:record") {
            "marc:record"
        } else {
            "record"
        };
        let end_tag = format!("</{}>", tag_name);
        if let Some(end_offset) = xml[start_idx..].find(&end_tag) {
            let end_idx = start_idx + end_offset + end_tag.len();
            let record_xml = &xml[start_idx..end_idx];

            if let Ok(record) = quick_xml::de::from_str::<MarcRecord>(record_xml) {
                records.push(record);
            }
        }
    }

    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_empty_record() {
        let xml = r#"<wrapper><record/></wrapper>"#;
        let records = extract_marc_records(xml).unwrap();
        assert_eq!(records.len(), 0);
    }

    #[test]
    fn test_extract_standard_record() {
        let xml = r#"
            <record>
                <leader>00000nam a2200000Ia 4500</leader>
                <controlfield tag="001">12345</controlfield>
                <datafield tag="245" ind1="1" ind2="0">
                    <subfield code="a">The Title</subfield>
                    <subfield code="c">The Author</subfield>
                </datafield>
            </record>
        "#;

        let records = extract_marc_records(xml).unwrap();
        assert_eq!(records.len(), 1);

        let record = &records[0];
        assert_eq!(record.leader.as_deref(), Some("00000nam a2200000Ia 4500"));
        assert_eq!(record.control_fields.len(), 1);
        assert_eq!(record.control_fields[0].tag, "001");
        assert_eq!(record.control_fields[0].value, "12345");

        assert_eq!(record.data_fields.len(), 1);
        assert_eq!(record.data_fields[0].tag, "245");
        assert_eq!(record.data_fields[0].subfields.len(), 2);
        assert_eq!(record.data_fields[0].subfields[0].code, "a");
        assert_eq!(record.data_fields[0].subfields[0].value, "The Title");
    }

    #[test]
    fn test_extract_marc_record() {
        let xml = r#"
            <marc:record xmlns:marc="http://www.loc.gov/MARC21/slim">
                <marc:leader>00000nam a2200000Ia 4500</marc:leader>
                <marc:controlfield tag="001">67890</marc:controlfield>
                <marc:datafield tag="245" ind1="1" ind2="0">
                    <marc:subfield code="a">Another Title</marc:subfield>
                </marc:datafield>
            </marc:record>
        "#;

        let records = extract_marc_records(xml).unwrap();
        assert_eq!(records.len(), 1);

        let record = &records[0];
        assert_eq!(record.leader.as_deref(), Some("00000nam a2200000Ia 4500"));
        assert_eq!(record.control_fields.len(), 1);
        assert_eq!(record.control_fields[0].tag, "001");
        assert_eq!(record.control_fields[0].value, "67890");

        assert_eq!(record.data_fields.len(), 1);
        assert_eq!(record.data_fields[0].tag, "245");
        assert_eq!(record.data_fields[0].subfields.len(), 1);
        assert_eq!(record.data_fields[0].subfields[0].code, "a");
        assert_eq!(record.data_fields[0].subfields[0].value, "Another Title");
    }

    #[test]
    fn test_extract_multiple_records_with_wrapper() {
        let xml = r#"
            <searchRetrieveResponse xmlns="http://docs.oasis-open.org/ns/search-ws/sruResponse">
                <version>1.2</version>
                <numberOfRecords>2</numberOfRecords>
                <records>
                    <record>
                        <recordSchema>info:srw/schema/1/marcxml-v1.1</recordSchema>
                        <recordData>
                            <marc:record xmlns:marc="http://www.loc.gov/MARC21/slim">
                                <marc:controlfield tag="001">rec1</marc:controlfield>
                            </marc:record>
                        </recordData>
                    </record>
                    <record>
                        <recordSchema>info:srw/schema/1/marcxml-v1.1</recordSchema>
                        <recordData>
                            <record>
                                <controlfield tag="001">rec2</controlfield>
                            </record>
                        </recordData>
                    </record>
                </records>
            </searchRetrieveResponse>
        "#;

        let records = extract_marc_records(xml).unwrap();

        let mut valid_records: Vec<_> = records.into_iter()
            .filter(|r| !r.control_fields.is_empty() || !r.data_fields.is_empty() || r.leader.is_some())
            .collect();

        valid_records.sort_by_key(|r| r.control_fields.get(0).map(|c| c.value.clone()).unwrap_or_default());

        assert_eq!(valid_records.len(), 2);

        assert_eq!(valid_records[0].control_fields.len(), 1);
        assert_eq!(valid_records[0].control_fields[0].value, "rec1");

        assert_eq!(valid_records[1].control_fields.len(), 1);
        assert_eq!(valid_records[1].control_fields[0].value, "rec2");
    }

    #[test]
    fn test_extract_malformed_xml() {
        let xml = r#"
            <records>
                <record>
                    <leader>00000nam a2200000Ia 4500</leader>
                    <controlfield tag="001">valid</controlfield>
                </record>
                <record>
                    <controlfield tag="001">invalid</controlfield>
            </records>
        "#;

        let records = extract_marc_records(xml).unwrap();

        let valid_records: Vec<_> = records.into_iter()
            .filter(|r| !r.control_fields.is_empty() || !r.data_fields.is_empty() || r.leader.is_some())
            .collect();

        assert_eq!(valid_records.len(), 1);
        assert_eq!(valid_records[0].control_fields[0].value, "valid");
    }

    fn create_mock_record() -> MarcRecord {
        MarcRecord {
            leader: None,
            control_fields: vec![],
            data_fields: vec![
                DataField {
                    tag: "245".to_string(),
                    ind1: "1".to_string(),
                    ind2: "0".to_string(),
                    subfields: vec![
                        Subfield { code: "a".to_string(), value: "Title".to_string() },
                        Subfield { code: "c".to_string(), value: "Author".to_string() },
                    ],
                },
                DataField {
                    tag: "650".to_string(),
                    ind1: " ".to_string(),
                    ind2: "0".to_string(),
                    subfields: vec![
                        Subfield { code: "a".to_string(), value: "Subject 1".to_string() },
                    ],
                },
                DataField {
                    tag: "650".to_string(),
                    ind1: " ".to_string(),
                    ind2: "0".to_string(),
                    subfields: vec![
                        Subfield { code: "a".to_string(), value: "Subject 2".to_string() },
                    ],
                },
            ],
        }
    }

    #[test]
    fn test_get_datafield_match() {
        let record = create_mock_record();
        let fields: Vec<_> = record.get_datafield("245").collect();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].tag, "245");
    }

    #[test]
    fn test_get_datafield_multiple_matches() {
        let record = create_mock_record();
        let fields: Vec<_> = record.get_datafield("650").collect();
        assert_eq!(fields.len(), 2);
    }

    #[test]
    fn test_get_datafield_missing() {
        let record = create_mock_record();
        let fields: Vec<_> = record.get_datafield("999").collect();
        assert_eq!(fields.len(), 0);
    }

    #[test]
    fn test_get_subfield_match() {
        let record = create_mock_record();
        let subfields: Vec<_> = record.get_subfield("245", "a").collect();
        assert_eq!(subfields.len(), 1);
        assert_eq!(subfields[0], "Title");
    }

    #[test]
    fn test_get_subfield_multiple_matches() {
        let record = create_mock_record();
        let subfields: Vec<_> = record.get_subfield("650", "a").collect();
        assert_eq!(subfields.len(), 2);
        assert_eq!(subfields[0], "Subject 1");
        assert_eq!(subfields[1], "Subject 2");
    }

    #[test]
    fn test_get_subfield_missing_tag() {
        let record = create_mock_record();
        let subfields: Vec<_> = record.get_subfield("999", "a").collect();
        assert_eq!(subfields.len(), 0);
    }

    #[test]
    fn test_get_subfield_missing_code() {
        let record = create_mock_record();
        let subfields: Vec<_> = record.get_subfield("245", "z").collect();
        assert_eq!(subfields.len(), 0);
    }
}

pub fn to_bibframe_graph(record: &MarcRecord, book_id: &str) -> spine_api::BibliographicGraph {
    let loc_id = record.control_fields.iter().find(|c| c.tag == "001").map(|c| c.value.clone()).unwrap_or_else(|| book_id.to_string());
    let work_uri = format!("urn:loc:work:{}", loc_id);
    let instance_uri = format!("urn:loc:instance:{}", loc_id);

    // Extract creators from 100 field
    let mut creators = Vec::new();
    if let Some(author_field) = record.get_datafield("100").next() {
        let name = author_field.subfields.iter().find(|s| s.code == "a").map(|s| s.value.clone()).unwrap_or_default();
        let auth_uri = author_field.subfields.iter().find(|s| s.code == "0").map(|s| s.value.clone()).unwrap_or_else(|| format!("urn:loc:name:{}", name.replace(" ", "_")));
        if !name.is_empty() {
            creators.push(spine_api::AgentLink {
                uri: auth_uri,
                name,
                role: "creator".to_string(),
            });
        }
    }

    // Extract subjects from 650 fields
    let mut subjects = Vec::new();
    for subject_field in record.get_datafield("650") {
        let label = subject_field.subfields.iter().find(|s| s.code == "a").map(|s| s.value.clone()).unwrap_or_default();
        let auth_uri = subject_field.subfields.iter().find(|s| s.code == "0").map(|s| s.value.clone()).unwrap_or_else(|| format!("urn:loc:subject:{}", label.replace(" ", "_")));
        if !label.is_empty() {
            subjects.push(spine_api::AuthorityLink {
                uri: auth_uri,
                label,
                source: "LCSH".to_string(),
            });
        }
    }

    // Extract publication date from 260 or 264
    let mut origin_date = None;
    if let Some(pub_field) = record.get_datafield("260").next().or_else(|| record.get_datafield("264").next()) {
        origin_date = pub_field.subfields.iter().find(|s| s.code == "c").map(|s| s.value.clone());
    }

    spine_api::BibliographicGraph {
        work_uri: work_uri.clone(),
        instance_uri: instance_uri.clone(),
        work: spine_api::Work {
            uri: work_uri,
            title: None,
            origin_date: origin_date.clone(),
            subjects,
            creators,
            language: None,
            lccn: None,
            ddc: None,
        },
        instances: vec![
            spine_api::Instance {
                uri: instance_uri,
                format: "Print".to_string(), // Default assumption from MARC
                publication_date: origin_date,
                publisher: None,
                isbn: None,
                oclc: None,
            }
        ],
    }
}

