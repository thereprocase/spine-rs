//! Speculative integration tests for the Sprint 10 reconcile endpoints.
//!
//! Pre-pinning the wire-shape contract before the handlers land,
//! per the Sprint 10 design.
//!
//! EXPECTED RED until the three Sprint 10 endpoints are implemented:
//!   GET  /api/v1/reconcile/queue                 → 200 [pending rows]
//!   POST /api/v1/reconcile/{book_id}/promote     → 204 (with `loc_uri`)
//!   POST /api/v1/reconcile/{book_id}/skip        → 204 (no body)
//!
//! Wire-shape derived from ADR 015 §5 + §6 + internal design notes (§6/§7).
//! Field names follow the existing spine-api typeshare conventions
//! (`pendingCount`, `bookId`, `flaggedAt`); the implementation may pick
//! different names, in which case the deserialize structs in the tests retarget.
//!
//! Mint-local is frontend-only per the design ("short-circuits to
//! spinemint URI") — no endpoint pinned here. If the implementation adds a
//! `POST .../resolve-mint` later (to write `spine:reconcileResolvedAt`),
//! a follow-on test goes here.

use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Method, Request, StatusCode},
};
use calibre_db::CalibreLibrary;
use spine_db::SpineStore;
use spine_srv::{create_router, jobs::LocalJobQueue, AppState};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_LABEL: &str = "http://www.w3.org/2000/01/rdf-schema#label";
const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";
const OWL_SAMEAS: &str = "http://www.w3.org/2002/07/owl#sameAs";
const SPINE_URI_SOURCE: &str = "https://thereprocase.github.io/spine/ns/uriSource";
const SPINE_RECONCILE_TIMEOUT_AT: &str =
    "https://thereprocase.github.io/spine/ns/reconcileTimeoutAt";

/// Seed AppState with a Work URI in a per-book graph, flagged as
/// needing-reconcile (spinemint URI + reconcileTimeoutAt > 0). Matches
/// what an ingest-pass would have written for a TimedOut book per
/// ADR 015 §2.
async fn state_with_pending_reconcile() -> (Arc<AppState>, Uuid, String) {
    let library = CalibreLibrary::open(":memory:").expect("open in-memory calibre");
    let store = SpineStore::open(":memory:").expect("open in-memory spine.db");

    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let triples: Vec<(String, String, String)> = vec![
        (work_uri.clone(), RDF_TYPE.to_string(), BF_WORK.to_string()),
        (
            work_uri.clone(),
            RDFS_LABEL.to_string(),
            "Reconcile Test Work".to_string(),
        ),
        (
            work_uri.clone(),
            SPINE_URI_SOURCE.to_string(),
            "spinemint".to_string(),
        ),
        (
            work_uri.clone(),
            SPINE_RECONCILE_TIMEOUT_AT.to_string(),
            "1714000000000".to_string(),
        ),
    ];
    store
        .replace_graph(&graph_uri, &triples)
        .expect("seed work graph with timeout flag");

    let loc_client = {
        let cell = std::sync::OnceLock::new();
        cell.set(Some(
            spine_meta::LocClient::with_base_urls("http://localhost:0", "http://localhost:0")
                .unwrap(),
        ))
        .unwrap();
        std::sync::Arc::new(cell)
    };

    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client,
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    (state, book_uuid, work_uri)
}

async fn empty_state() -> Arc<AppState> {
    let library = CalibreLibrary::open(":memory:").expect("open in-memory calibre");
    let store = SpineStore::open(":memory:").expect("open in-memory spine.db");

    let loc_client = {
        let cell = std::sync::OnceLock::new();
        cell.set(Some(
            spine_meta::LocClient::with_base_urls("http://localhost:0", "http://localhost:0")
                .unwrap(),
        ))
        .unwrap();
        std::sync::Arc::new(cell)
    };

    Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client,
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    })
}

async fn request(
    state: Arc<AppState>,
    method: Method,
    path: &str,
    body: Option<String>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let app = create_router(state);
    let mut req = Request::builder().method(method).uri(path);
    if body.is_some() {
        req = req.header(axum::http::header::CONTENT_TYPE, "application/json");
    }
    let resp = app
        .oneshot(req.body(body.map(Body::from).unwrap_or_else(Body::empty)).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, headers, bytes.to_vec())
}

// ---------------------------------------------------------------------------
// GET /api/v1/reconcile/queue
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_reconcile_queue_when_empty_returns_zero_rows() {
    let state = empty_state().await;
    let (status, _, raw) =
        request(state, Method::GET, "/api/v1/reconcile/queue", None).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "GET /reconcile/queue must return 200 even when empty; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    // The implementation may model the response as `{ rows: [...], pendingCount: N }`
    // (mirrors the existing `ReconcilesPendingResponse`) OR as a bare
    // array `[...]`. Accept either; field names are the load-bearing
    // contract.
    let rows = if let Some(obj) = resp.as_object() {
        obj.get("rows")
            .or_else(|| obj.get("queue"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        resp.as_array().cloned().unwrap_or_default()
    };
    assert!(rows.is_empty(), "queue must be empty when no books are flagged; got {rows:?}");
}

#[tokio::test]
async fn get_reconcile_queue_surfaces_books_with_reconcile_timeout_at() {
    let (state, book_uuid, _work_uri) = state_with_pending_reconcile().await;
    let (status, _, raw) =
        request(state, Method::GET, "/api/v1/reconcile/queue", None).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "GET /reconcile/queue must return 200; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = if let Some(obj) = resp.as_object() {
        obj.get("rows")
            .or_else(|| obj.get("queue"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        resp.as_array().cloned().unwrap_or_default()
    };

    assert_eq!(
        rows.len(),
        1,
        "exactly one book seeded with reconcileTimeoutAt should appear in queue; got {rows:?}",
    );

    // Per the existing ReconcilePendingRow: `bookId` (camelCase) is
    // the load-bearing field. Loose: accept `bookId`, `book_id`, or
    // `id`. Hard requirement: it must equal the seeded book uuid.
    let row = &rows[0];
    let row_book_id = row
        .get("bookId")
        .or_else(|| row.get("book_id"))
        .or_else(|| row.get("id"))
        .and_then(|v| v.as_str())
        .expect("row must carry book id under a known field name");
    assert_eq!(
        row_book_id,
        book_uuid.to_string(),
        "row bookId must match the seeded book uuid",
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/reconcile/{book_id}/promote
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_reconcile_promote_writes_owl_sameas_to_chosen_loc_uri() {
    let (state, book_uuid, _work_uri) = state_with_pending_reconcile().await;
    let chosen_loc_uri = "http://id.loc.gov/resources/works/14456236";
    let body = serde_json::json!({ "locUri": chosen_loc_uri }).to_string();

    let path = format!("/api/v1/reconcile/{book_uuid}/promote");
    let (status, _, raw) =
        request(state.clone(), Method::POST, &path, Some(body)).await;

    assert!(
        status.is_success(),
        "POST .../promote must return 2xx, got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    // Verify the store now carries an `owl:sameAs` edge from the
    // local Work URI to the chosen LoC URI per ADR 015 §5. Walk the
    // book's graph; require at least one (s, owl:sameAs, chosen) triple.
    let store = state.store.lock().await;
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let triples = store
        .get_triples(&graph_uri)
        .expect("read book graph after promote");
    let same_as_to_loc = triples
        .iter()
        .any(|(_s, p, o)| p == OWL_SAMEAS && o == chosen_loc_uri);
    assert!(
        same_as_to_loc,
        "promote must emit (?s, owl:sameAs, <chosen LoC URI>) into the book graph; got triples: {triples:?}",
    );
}

#[tokio::test]
async fn post_reconcile_promote_with_invalid_loc_uri_returns_4xx() {
    let (state, book_uuid, _) = state_with_pending_reconcile().await;
    let body = serde_json::json!({ "locUri": "not-a-uri" }).to_string();
    let path = format!("/api/v1/reconcile/{book_uuid}/promote");
    let (status, _, raw) =
        request(state, Method::POST, &path, Some(body)).await;

    assert!(
        status.is_client_error(),
        "promote with malformed locUri must return 4xx; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}

#[tokio::test]
async fn post_reconcile_promote_for_unknown_book_returns_404() {
    let state = empty_state().await;
    let body =
        serde_json::json!({ "locUri": "http://id.loc.gov/resources/works/14456236" }).to_string();
    let unknown = Uuid::new_v4();
    let path = format!("/api/v1/reconcile/{unknown}/promote");
    let (status, _, raw) =
        request(state, Method::POST, &path, Some(body)).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "promote for an unseeded book must 404; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/reconcile/{book_id}/skip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_reconcile_skip_zeroes_timeout_at_so_sweep_re_picks_immediately() {
    let (state, book_uuid, _work_uri) = state_with_pending_reconcile().await;
    let path = format!("/api/v1/reconcile/{book_uuid}/skip");
    let (status, _, raw) =
        request(state.clone(), Method::POST, &path, None).await;

    assert!(
        status.is_success(),
        "POST .../skip must return 2xx, got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let store = state.store.lock().await;
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let triples = store
        .get_triples(&graph_uri)
        .expect("read book graph after skip");
    let timeout_at_zero = triples
        .iter()
        .any(|(_s, p, o)| p == SPINE_RECONCILE_TIMEOUT_AT && o == "0");
    assert!(
        timeout_at_zero,
        "skip must rewrite spine:reconcileTimeoutAt to \"0\" so the §6 sweep re-picks; got triples: {triples:?}",
    );
}

#[tokio::test]
async fn post_reconcile_skip_for_unknown_book_returns_404() {
    let state = empty_state().await;
    let unknown = Uuid::new_v4();
    let path = format!("/api/v1/reconcile/{unknown}/skip");
    let (status, _, raw) = request(state, Method::POST, &path, None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "skip for an unseeded book must 404; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}
