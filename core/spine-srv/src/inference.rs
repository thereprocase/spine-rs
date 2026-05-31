//! ADR 016 §5 inferred-graph endpoints — Sprint 11 read + decide surface.
//!
//! Two handlers project the per-book inferred graph onto the Inspector's
//! "Inferred Suggestions" tab UX (ADR 016 §6):
//!
//! - `GET  /api/v1/inference/book/{book_uuid}`   — list candidate
//!   triples currently sitting in `urn:spine:graph:inferred:<book-uuid>`,
//!   joined with the §2 reification provenance fields.
//! - `POST /api/v1/inference/{inference_id}/decide` — body
//!   `{ action: "promote" | "reject", reason?: string }`. Single endpoint
//!   for both verdicts per ADR §5 line 165 (one action per row).
//!
//! Per ADR 016 §3 the asserted graph is `urn:spine:graph:asserted:<uuid>`
//! and the inferred graph is `urn:spine:graph:inferred:<uuid>`. The
//! Sprint 10 reconcile/ingest paths still write the asserted body to
//! `urn:spine:graph:book:<uuid>`; unifying the two asserted prefixes is
//! out of scope here (tracked separately). This module reads/writes the
//! ADR 016 §3 prefixes verbatim — promote target is `asserted:`,
//! matching the spec test seed at
//! `core/spine-srv/tests/inferred_endpoints_test.rs`.
//!
//! `POST /api/v1/inference/run` (ADR §5 row 1) is Sprint 12+ work — no
//! inferrer ships in this sprint per ADR's "Implementation Notes".

use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_SUBJECT: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject";
const RDF_PREDICATE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate";
const RDF_OBJECT: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#object";
const SPINE_INFERENCE: &str = "https://thereprocase.github.io/spine/ns/Inference";
const SPINE_CONFIDENCE: &str = "https://thereprocase.github.io/spine/ns/confidence";
const SPINE_INFERRED_BY: &str = "https://thereprocase.github.io/spine/ns/inferredBy";
const SPINE_INFERRED_AT: &str = "https://thereprocase.github.io/spine/ns/inferredAt";
const INFERRED_GRAPH_PREFIX: &str = "urn:spine:graph:inferred:";
const ASSERTED_GRAPH_PREFIX: &str = "urn:spine:graph:asserted:";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredCandidate {
    pub inference_id: String,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub confidence: Option<String>,
    pub inferred_by: Option<String>,
    pub inferred_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InferredListResponse {
    pub rows: Vec<InferredCandidate>,
}

#[derive(Debug, Deserialize)]
pub struct DecideRequest {
    pub action: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `GET /api/v1/inference/book/{uuid}` — list pending inferred triples.
pub async fn get_inference_book(
    Path(book_uuid_str): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<InferredListResponse>, (StatusCode, String)> {
    let book_uuid = Uuid::parse_str(&book_uuid_str)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid book uuid: {e}")))?;
    let graph_uri = format!("{INFERRED_GRAPH_PREFIX}{book_uuid}");
    let store = state.store.lock().await;
    let triples = store
        .get_triples(&graph_uri)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    let rows = parse_inferred_candidates(&triples);
    Ok(Json(InferredListResponse { rows }))
}

/// `POST /api/v1/inference/{inference_id}/decide` — promote or reject.
///
/// Per ADR 016 §5 line 165 + §7:
/// - `promote`: copy the projected `(s, p, o)` to the asserted graph,
///   delete reification + projected triple from the inferred graph.
/// - `reject`:  delete reification + projected triple from the inferred
///   graph; do NOT write to the asserted graph.
///
/// The audit-graph behavior (ADR §7 line 182 + §4) is deferred — no
/// audit graph mutation lands in this sprint. Rejection is currently a
/// hard delete; "user said no" persistence will arrive with the first
/// inferrer in Sprint 12+ (per ADR's "no inferrer ships" carve-out).
/// Tracked in TECH_DEBT under §1.2.
pub async fn post_decide(
    Path(inference_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<DecideRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.action != "promote" && body.action != "reject" {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "unknown action {:?}; ADR 016 §5 accepts only \"promote\" or \"reject\"",
                body.action
            ),
        ));
    }

    let store = state.store.lock().await;

    let graphs = store
        .list_all_graphs()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;

    let mut hit: Option<(String, Uuid, Vec<(String, String, String)>)> = None;
    for graph_uri in graphs {
        let Some(book_uuid_str) = graph_uri.strip_prefix(INFERRED_GRAPH_PREFIX) else {
            continue;
        };
        let triples = store
            .get_triples(&graph_uri)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
        let owns = triples.iter().any(|(s, p, o)| {
            s == &inference_id && p == RDF_TYPE && o == SPINE_INFERENCE
        });
        if !owns {
            continue;
        }
        let book_uuid = Uuid::parse_str(book_uuid_str).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("graph {graph_uri} carries malformed book uuid: {e}"),
            )
        })?;
        hit = Some((graph_uri, book_uuid, triples));
        break;
    }

    let Some((inferred_graph, book_uuid, inferred_triples)) = hit else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("inference {inference_id} not found"),
        ));
    };

    let candidate = parse_one_candidate(&inferred_triples, &inference_id).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("inference {inference_id} reification missing rdf:subject/predicate/object"),
        )
    })?;

    let new_inferred: Vec<(String, String, String)> = inferred_triples
        .into_iter()
        .filter(|(s, p, o)| {
            let is_reification = s == &inference_id;
            let is_projected = s == &candidate.subject
                && p == &candidate.predicate
                && o == &candidate.object;
            !(is_reification || is_projected)
        })
        .collect();
    store
        .replace_graph(&inferred_graph, &new_inferred)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;

    if body.action == "promote" {
        let asserted_graph = format!("{ASSERTED_GRAPH_PREFIX}{book_uuid}");
        let mut asserted = store
            .get_triples(&asserted_graph)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
        asserted.push((
            candidate.subject,
            candidate.predicate,
            candidate.object,
        ));
        store
            .replace_graph(&asserted_graph, &asserted)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

fn parse_inferred_candidates(
    triples: &[(String, String, String)],
) -> Vec<InferredCandidate> {
    triples
        .iter()
        .filter(|(_, p, o)| p == RDF_TYPE && o == SPINE_INFERENCE)
        .filter_map(|(s, _, _)| parse_one_candidate(triples, s))
        .collect()
}

fn parse_one_candidate(
    triples: &[(String, String, String)],
    inference_id: &str,
) -> Option<InferredCandidate> {
    let look = |predicate: &str| -> Option<String> {
        triples
            .iter()
            .find(|(s, p, _)| s == inference_id && p == predicate)
            .map(|(_, _, o)| o.clone())
    };
    let subject = look(RDF_SUBJECT)?;
    let predicate = look(RDF_PREDICATE)?;
    let object = look(RDF_OBJECT)?;
    Some(InferredCandidate {
        inference_id: inference_id.to_string(),
        subject,
        predicate,
        object,
        confidence: look(SPINE_CONFIDENCE),
        inferred_by: look(SPINE_INFERRED_BY),
        inferred_at: look(SPINE_INFERRED_AT),
    })
}
