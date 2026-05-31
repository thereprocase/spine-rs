//! Integration tests for the ADR 014 spine-bf write API HTTP endpoints.
//!
//! Coverage (one round-trip per endpoint, per an architecture review):
//!   * POST   /api/v1/book/:id/subject  (source = "local-tag")
//!   * POST   /api/v1/book/:id/subject  (source = "lcsh", LCSH adapter
//!                                       still stubbed → mints partial)
//!   * DELETE /api/v1/book/:id/subject?uri=<uri>
//!   * POST   /api/v1/book/:id/instance (reconcileAgainstLoc=false to
//!                                       skip the LoC SRU call)
//!   * PATCH  /api/v1/book/:id/instance/:instance_uuid/primary
//!
//! These tests deliberately avoid hitting id.loc.gov by either:
//!   1. Using `source = "local-tag"` for subjects (no reconcile path), or
//!   2. Using the SubjectReconciler stub which currently always returns
//!      `Ok(None)` (LCSH adapter not yet wired — see
//!      `core/spine-meta/src/reconcile.rs` SubjectReconciler::reconcile),
//!      or
//!   3. Setting `reconcileAgainstLoc=false` on the instance candidate.
//!
//! The LocClient is constructed against `http://localhost:0` so that any
//! accidental LoC traffic fails fast. When the LCSH adapter lands
//! (Step 1), the LCSH-source test below will need to be revisited
//! to either stub the SRU endpoint via mockito or stay on the `local-tag`
//! happy path.

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
const BF_INSTANCE: &str = "http://id.loc.gov/ontologies/bibframe/Instance";
const BF_SUBJECT: &str = "http://id.loc.gov/ontologies/bibframe/subject";
const BF_INSTANCE_OF: &str = "http://id.loc.gov/ontologies/bibframe/instanceOf";
const SPINE_PRIMARY_INSTANCE: &str = "https://thereprocase.github.io/spine/ns/primaryInstance";

/// Build an in-memory `AppState` with a single Work seeded into the
/// per-book graph at `urn:spine:graph:book:<book_uuid>`. The work-uuid
/// returned IS the book-uuid passed in the path — `parse_book_uuid` in
/// `spine-srv::api_v1` treats them as one and the same.
async fn state_with_seeded_work() -> (Arc<AppState>, Uuid) {
    let library = CalibreLibrary::open(":memory:").expect("open in-memory calibre");
    let store = SpineStore::open(":memory:").expect("open in-memory spine.db");

    let book_uuid = Uuid::new_v4();
    let graph_uri = format!("urn:spine:graph:book:{book_uuid}");
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let triples: Vec<(String, String, String)> = vec![
        (work_uri.clone(), RDF_TYPE.to_string(), BF_WORK.to_string()),
        (work_uri, RDFS_LABEL.to_string(), "Test Work".to_string()),
    ];
    store
        .replace_graph(&graph_uri, &triples)
        .expect("seed work graph");

    let loc_client = {
        let cell = std::sync::OnceLock::new();
        cell.set(Some(
            // Both SRU + LCSH overridden to port 0 so any reconcile that
            // escapes our local-tag / no-reconcile guards fails fast
            // instead of hitting real id.loc.gov from the test suite
            // (which is what happened when the SubjectReconciler stub
            // got replaced by the real LCSH adapter — `with_base_url`
            // alone only redirects SRU; the new `search_lcsh_subject`
            // would fall back to the production default).
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

    (state, book_uuid)
}

async fn request_json(
    state: Arc<AppState>,
    method: Method,
    path: &str,
    body: Option<String>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let app = create_router(state);
    let mut request = Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header(axum::http::header::CONTENT_TYPE, "application/json");
    }
    let response = app
        .oneshot(
            request
                .body(body.map(Body::from).unwrap_or_else(Body::empty))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, body.to_vec())
}

fn graph_uri_for(book_uuid: Uuid) -> String {
    format!("urn:spine:graph:book:{book_uuid}")
}

async fn read_graph(state: &AppState, graph_uri: &str) -> Vec<(String, String, String)> {
    let store = state.store.lock().await;
    store.get_triples(graph_uri).expect("read graph")
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/subject  (local-tag)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_subject_local_tag_round_trips_to_graph() {
    let (state, book_uuid) = state_with_seeded_work().await;
    let path = format!("/api/v1/book/{book_uuid}/subject");
    let body = r#"{"term":"to-read","source":"local-tag"}"#.to_string();

    let (status, _, raw) = request_json(state.clone(), Method::POST, &path, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "body: {:?}", String::from_utf8_lossy(&raw));

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json");
    let subject_uri = resp["subjectUri"].as_str().expect("subjectUri");
    assert!(
        subject_uri.starts_with("urn:spine:subject:tag:"),
        "local-tag must mint urn:spine:subject:tag:* — got {subject_uri}"
    );
    assert_eq!(
        resp["partial"], serde_json::Value::Bool(false),
        "local-tag never reconciles, partial must be false"
    );

    // Verify the work→subject edge landed in the graph.
    let triples = read_graph(&state, &graph_uri_for(book_uuid)).await;
    assert!(
        triples.iter().any(|(_, p, o)| p == BF_SUBJECT && o == subject_uri),
        "work→subject edge missing from graph after POST"
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/subject  (lcsh, network-error path → 502)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_subject_lcsh_network_error_surfaces_502() {
    // Before the LCSH adapter landed this endpoint pinned the SubjectReconciler stub
    // (which returned Ok(None) and minted partial). With the real adapter
    // wired in spine-meta::reconcile, network-failure on the LCSH endpoint
    // returns Err(SpineWriteError::ReconcileFailed); the handler maps
    // that to 502 BAD_GATEWAY (see spine-srv::api_v1::write_error_to_response).
    //
    // Both URLs in `state_with_seeded_work` point at port 0, so any LCSH
    // call fails connect → adapter → 502. The Ok(None)→partial-mint path
    // is covered by spine-bf's `add_subject_lcsh_unmatched_mints_partial`
    // unit test using the AlwaysUnmatched reconciler stub; we don't need
    // to re-pin it through the HTTP layer.
    let (state, book_uuid) = state_with_seeded_work().await;
    let path = format!("/api/v1/book/{book_uuid}/subject");
    let body = r#"{"term":"Cyberpunk fiction","source":"lcsh"}"#.to_string();

    let (status, _, raw) = request_json(state, Method::POST, &path, Some(body)).await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "LCSH unreachable must surface as 502, got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/book/:id/subject?uri=<uri>
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_subject_removes_work_to_subject_edge() {
    let (state, book_uuid) = state_with_seeded_work().await;
    let path = format!("/api/v1/book/{book_uuid}/subject");

    // POST first to produce a known URI.
    let body = r#"{"term":"draft","source":"local-tag"}"#.to_string();
    let (post_status, _, post_raw) =
        request_json(state.clone(), Method::POST, &path, Some(body)).await;
    assert_eq!(post_status, StatusCode::CREATED);
    let post_resp: serde_json::Value = serde_json::from_slice(&post_raw).expect("json");
    let subject_uri = post_resp["subjectUri"].as_str().expect("subjectUri").to_string();

    // DELETE round-trip. The `urn:spine:subject:tag:<uuid>` URI contains
    // only colons + hex-uuid characters, all valid in a query value
    // without percent-encoding — pass raw.
    let delete_path = format!("/api/v1/book/{book_uuid}/subject?uri={subject_uri}");
    let (del_status, _, del_raw) = request_json(state.clone(), Method::DELETE, &delete_path, None).await;
    assert_eq!(
        del_status,
        StatusCode::NO_CONTENT,
        "delete body: {:?}",
        String::from_utf8_lossy(&del_raw)
    );

    // Graph must no longer carry the work→subject edge.
    let triples = read_graph(&state, &graph_uri_for(book_uuid)).await;
    assert!(
        !triples.iter().any(|(_, p, o)| p == BF_SUBJECT && o == &subject_uri),
        "work→subject edge must be gone after DELETE"
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/instance  (reconcileAgainstLoc=false)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_instance_no_reconcile_mints_local_uri() {
    let (state, book_uuid) = state_with_seeded_work().await;
    let path = format!("/api/v1/book/{book_uuid}/instance");
    let body = r#"{"format":"epub","reconcileAgainstLoc":false}"#.to_string();

    let (status, _, raw) = request_json(state.clone(), Method::POST, &path, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "body: {:?}", String::from_utf8_lossy(&raw));

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json");
    let instance_uri = resp["instanceUri"].as_str().expect("instanceUri");
    assert!(
        instance_uri.starts_with("urn:spine:instance:"),
        "no-reconcile add_instance must mint urn:spine:instance:<uuid> — got {instance_uri}"
    );
    // `partial` flags "reconcile pending in background" — only meaningful
    // when the user wanted reconcile but it timed out or missed. With
    // `reconcileAgainstLoc=false` the user opted out, so there's nothing
    // to re-reconcile and partial is false.
    assert_eq!(
        resp["partial"], serde_json::Value::Bool(false),
        "explicit opt-out from reconcile must not set partial"
    );

    // Verify the new Instance is wired to the seeded Work.
    let triples = read_graph(&state, &graph_uri_for(book_uuid)).await;
    assert!(
        triples.iter().any(|(s, p, o)| s == instance_uri && p == RDF_TYPE && o == BF_INSTANCE),
        "graph must declare new instance as bf:Instance"
    );
    assert!(
        triples.iter().any(|(s, p, _)| s == instance_uri && p == BF_INSTANCE_OF),
        "instance must link to its parent Work via bf:instanceOf"
    );
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/book/:id/instance/:instance_uuid/primary
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_set_primary_instance_writes_primary_triple() {
    let (state, book_uuid) = state_with_seeded_work().await;
    let post_path = format!("/api/v1/book/{book_uuid}/instance");
    let body = r#"{"format":"epub","reconcileAgainstLoc":false}"#.to_string();

    let (post_status, _, post_raw) =
        request_json(state.clone(), Method::POST, &post_path, Some(body)).await;
    assert_eq!(post_status, StatusCode::CREATED);
    let post_resp: serde_json::Value = serde_json::from_slice(&post_raw).expect("json");
    let instance_uri = post_resp["instanceUri"].as_str().expect("instanceUri").to_string();

    // Extract the bare UUID (after the urn:spine:instance: prefix) for the
    // path segment — handler only accepts the UUID form for locally-minted
    // instances, full LoC URIs need the body variant (see ADR 014 §5).
    let instance_uuid = instance_uri
        .strip_prefix("urn:spine:instance:")
        .expect("instance URI must use the urn:spine:instance: prefix");

    let patch_path = format!("/api/v1/book/{book_uuid}/instance/{instance_uuid}/primary");
    let (patch_status, _, patch_raw) =
        request_json(state.clone(), Method::PATCH, &patch_path, None).await;
    assert_eq!(
        patch_status,
        StatusCode::NO_CONTENT,
        "patch body: {:?}",
        String::from_utf8_lossy(&patch_raw)
    );

    // The graph must now carry <work> spine:primaryInstance <instance>.
    let triples = read_graph(&state, &graph_uri_for(book_uuid)).await;
    assert!(
        triples
            .iter()
            .any(|(_, p, o)| p == SPINE_PRIMARY_INSTANCE && o == &instance_uri),
        "primary-instance triple missing after PATCH; graph: {triples:?}"
    );
}
