//! ADR 015 §4 + §5 + §6 — reconcile drawer backend.
//!
//! Three handlers project the user-visible reconcile drawer onto
//! `spine.db`'s named graphs:
//!
//! - `GET  /api/v1/reconcile/queue`              — books whose graph carries
//!   a non-zero `spine:reconcileTimeoutAt` (drawer "needs review" set).
//! - `POST /api/v1/reconcile/{book_id}/promote`  — accept a LoC suggestion;
//!   writes `(work, owl:sameAs, locUri)` per ADR 006 + ADR 015 §5. The
//!   `spinemint` provenance on the local Work URI is preserved.
//! - `POST /api/v1/reconcile/{book_id}/skip`     — set the book's
//!   `spine:reconcileTimeoutAt` to `"0"` so the §6 background sweep
//!   re-picks it on the next tick.
//!
//! Mint-local is intentionally a frontend-only short-circuit (the drawer
//! treats the existing `spinemint` URI as final and removes its row);
//! there is no `/mint-local` endpoint per the Sprint 10 design.

use crate::{graph_uri_for, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";
const OWL_SAMEAS: &str = "http://www.w3.org/2002/07/owl#sameAs";
const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";
const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
const BOOK_GRAPH_PREFIX: &str = "urn:spine:graph:book:";

#[derive(Debug, Serialize)]
pub struct ReconcileQueueRow {
    #[serde(rename = "bookId")]
    pub book_id: String,
}

#[derive(Debug, Serialize)]
pub struct ReconcileQueueResponse {
    pub rows: Vec<ReconcileQueueRow>,
}

/// `GET /api/v1/reconcile/queue` — list books awaiting reconcile review.
///
/// Returns `{ rows: [{ bookId: "<uuid>" }, …] }` with one row per book
/// graph carrying a non-zero `spine:reconcileTimeoutAt` triple. An empty
/// queue is `{ rows: [] }` with status 200.
pub async fn get_reconcile_queue(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ReconcileQueueResponse>, (StatusCode, String)> {
    let store = state.store.lock().await;
    let graphs = store
        .list_reconcile_pending_graphs()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    let rows = graphs
        .into_iter()
        .filter_map(|g| {
            g.strip_prefix(BOOK_GRAPH_PREFIX)
                .map(|id| ReconcileQueueRow { book_id: id.to_string() })
        })
        .collect();
    Ok(Json(ReconcileQueueResponse { rows }))
}

#[derive(Debug, Deserialize)]
pub struct PromoteRequest {
    /// Chosen LoC authority URI. CamelCase on the wire to match the
    /// vitest contract pinned in the sprint-10 spec and the
    /// drawer's existing typeshare conventions.
    #[serde(rename = "locUri")]
    pub loc_uri: String,
}

/// `POST /api/v1/reconcile/{book_id}/promote` — accept a LoC suggestion.
///
/// Writes `(work, owl:sameAs, locUri)` to the book's named graph per
/// ADR 006 + ADR 015 §5. The original `urn:spine:work:*` URI is left
/// intact (its `spine:uriSource = "spinemint"` provenance is the
/// truthful record of write-time mint); query-time `owl:sameAs`
/// expansion produces the union view.
pub async fn promote(
    Path(book_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PromoteRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let book_uuid = Uuid::parse_str(&book_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid book uuid: {e}")))?;
    if oxrdf::NamedNode::new(&body.loc_uri).is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("malformed locUri (not an absolute IRI): {}", body.loc_uri),
        ));
    }
    let graph_uri = graph_uri_for(&book_uuid);
    let store = state.store.lock().await;
    let triples = store
        .get_triples(&graph_uri)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    if triples.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("book {book_uuid} has no graph in spine.db"),
        ));
    }
    let work_uri = triples
        .iter()
        .find(|(_, p, o)| p == RDF_TYPE && o == BF_WORK)
        .map(|(s, _, _)| s.clone())
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("book {book_uuid} has no bf:Work entity"),
            )
        })?;
    store
        .insert_triple(&work_uri, OWL_SAMEAS, &body.loc_uri, &graph_uri)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    // Per ADR 015 §5 turtle example + durability review item C3:
    // the LoC URI on the other side of the owl:sameAs edge carries
    // `spine:uriSource = "locref"`. Sweep gets it right; drawer-promote
    // was missing it before this fix, leaving the promoted URI without
    // provenance.
    store
        .insert_triple(&body.loc_uri, SPINE_URI_SOURCE, "locref", &graph_uri)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/reconcile/{book_id}/skip` — defer this book to the §6
/// background sweep.
///
/// Rewrites every `spine:reconcileTimeoutAt` triple in the book's graph
/// to `"0"` so the next sweep tick re-picks it immediately. The drawer
/// row is dismissed on the frontend; the book lands back in the queue
/// only if the sweep returns `Unmatched`-with-candidates again.
pub async fn skip(
    Path(book_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let book_uuid = Uuid::parse_str(&book_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid book uuid: {e}")))?;
    let graph_uri = graph_uri_for(&book_uuid);
    let store = state.store.lock().await;
    let triples = store
        .get_triples(&graph_uri)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    if triples.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("book {book_uuid} has no graph in spine.db"),
        ));
    }
    let new_triples: Vec<(String, String, String)> = triples
        .into_iter()
        .map(|(s, p, o)| {
            if p == SPINE_RECONCILE_TIMEOUT_AT {
                (s, p, "0".to_string())
            } else {
                (s, p, o)
            }
        })
        .collect();
    store
        .replace_graph(&graph_uri, &new_triples)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spine-db: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}
