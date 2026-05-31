pub mod v1;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use typeshare::typeshare;
use uuid::Uuid;

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: Uuid,
    pub title: String,
    pub authors: Vec<String>,
    pub legacy_metadata: LegacyMetadata,
    pub bibliographic_graph: Option<BibliographicGraph>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub book_id: Uuid,
    pub locator: String,
    pub progress_fraction: Option<f64>,
    pub chapter_label: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReadingProgressRequest {
    pub locator: String,
    pub progress_fraction: Option<f64>,
    pub chapter_label: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMetadata {
    pub publisher: Option<String>,
    pub pub_date: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f32>,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub has_cover: bool,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographicGraph {
    pub work_uri: String,
    pub instance_uri: String,
    pub work: Work,
    pub instances: Vec<Instance>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub uri: String,
    pub title: Option<String>,
    pub origin_date: Option<String>,
    pub subjects: Vec<AuthorityLink>,
    pub creators: Vec<AgentLink>,
    pub language: Option<String>,
    pub lccn: Option<String>,
    pub ddc: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub uri: String,
    pub format: String,
    pub publication_date: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub oclc: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityLink {
    pub uri: String,
    pub label: String,
    pub source: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLink {
    pub uri: String,
    pub name: String,
    pub role: String, // e.g., "creator", "translator", "editor"
}
