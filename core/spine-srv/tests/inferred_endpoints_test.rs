//! Speculative integration tests for the Sprint 11 ADR 016 inferred-graph endpoints.
//!
//! Pre-pinning the wire-shape contract before the handlers land,
//! per the Sprint 11 design. The same approach that landed the
//! Settings drawer, backup endpoint, and the Sprint 10 reconcile endpoints
//! without iteration.
//!
//! EXPECTED RED until the ADR §5 endpoints are implemented:
//!   GET  /api/v1/inference/book/{book_uuid}      → 200 [InferredCandidate]
//!   POST /api/v1/inference/{inference_id}/decide → 204
//!     body: { "action": "promote" | "reject", "reason"?: string }
//!
//! Sprint 11 ships **read + decide**. The third ADR §5 endpoint
//! `POST /api/v1/inference/run { inferrer_id, book_uuid }` is the
//! Sprint 12+ first-inferrer ship per ADR's "Implementation Notes":
//! *"No inferrer is shipped by this ADR."* A separate spec lands then.
//!
//! ## Wire-shape adjudication
//!
//! The initial design listed book-rooted paths
//! (`/book/:id/inferred/...`); ADR §5 strawman uses inference-rooted
//! paths. The design review adjudicated **ADR §5 wins** because it treats
//! inference events as first-class reified entities matching the
//! §2 four-tuple provenance lock. These tests pin that shape.

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
const BF_WORK: &str = "http://id.loc.gov/ontologies/bibframe/Work";
const BF_SUBJECT: &str = "http://id.loc.gov/ontologies/bibframe/subject";
const SPINE_INFERENCE: &str = "https://thereprocase.github.io/spine/ns/Inference";
const SPINE_CONFIDENCE: &str = "https://thereprocase.github.io/spine/ns/confidence";
const SPINE_INFERRED_BY: &str = "https://thereprocase.github.io/spine/ns/inferredBy";
const SPINE_INFERRED_AT: &str = "https://thereprocase.github.io/spine/ns/inferredAt";
const RDF_SUBJECT: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject";
const RDF_PREDICATE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate";
const RDF_OBJECT: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#object";

/// Seed AppState with a Work in the asserted graph + ONE inferred
/// triple in the inferred graph (book-uuid scoped per ADR 016 §1).
/// Mirrors what a Sprint 12+ inferrer would have written: a
/// `bf:subject` candidate carrying the four ADR §2 lock-required
/// provenance predicates.
async fn state_with_one_inferred_subject() -> (Arc<AppState>, Uuid, String) {
    let library = CalibreLibrary::open(":memory:").expect("open in-memory calibre");
    let store = SpineStore::open(":memory:").expect("open in-memory spine.db");

    let book_uuid = Uuid::new_v4();
    let work_uri = format!("urn:spine:work:{}", Uuid::new_v4());
    let lcsh_subject_uri =
        "http://id.loc.gov/authorities/subjects/sh85076671".to_string();

    // Asserted graph: just the Work.
    let asserted_graph = format!("urn:spine:graph:asserted:{book_uuid}");
    let asserted: Vec<(String, String, String)> = vec![(
        work_uri.clone(),
        RDF_TYPE.to_string(),
        BF_WORK.to_string(),
    )];
    store
        .replace_graph(&asserted_graph, &asserted)
        .expect("seed asserted graph");

    // Inferred graph: one bf:subject candidate + reified provenance.
    // The inference node URI is the inference_id we'll route on in the
    // /decide endpoint — the implementation may pick a different identity scheme
    // (UUID-only fragment, hash of (s,p,o), DB row id stringified, etc.);
    // the GET response's `inferenceId` field is used verbatim in the
    // /decide path regardless of internal representation.
    let inferred_graph = format!("urn:spine:graph:inferred:{book_uuid}");
    let inference_node = format!("urn:spine:inference:{}", Uuid::new_v4());
    let inferred: Vec<(String, String, String)> = vec![
        // The projected (s, p, o) triple itself.
        (
            work_uri.clone(),
            BF_SUBJECT.to_string(),
            lcsh_subject_uri.clone(),
        ),
        // Reified provenance per ADR 016 §2.
        (
            inference_node.clone(),
            RDF_TYPE.to_string(),
            SPINE_INFERENCE.to_string(),
        ),
        (
            inference_node.clone(),
            RDF_SUBJECT.to_string(),
            work_uri.clone(),
        ),
        (
            inference_node.clone(),
            RDF_PREDICATE.to_string(),
            BF_SUBJECT.to_string(),
        ),
        (
            inference_node.clone(),
            RDF_OBJECT.to_string(),
            lcsh_subject_uri.clone(),
        ),
        (
            inference_node.clone(),
            SPINE_CONFIDENCE.to_string(),
            "0.87".to_string(),
        ),
        (
            inference_node.clone(),
            SPINE_INFERRED_BY.to_string(),
            "spine-inferrer-lcsh-suggest@0.1.0".to_string(),
        ),
        (
            inference_node.clone(),
            SPINE_INFERRED_AT.to_string(),
            "2026-05-12T14:30:00Z".to_string(),
        ),
    ];
    store
        .replace_graph(&inferred_graph, &inferred)
        .expect("seed inferred graph");

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

    (state, book_uuid, lcsh_subject_uri)
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

/// Pull the inference-id out of an InferredCandidate JSON. ADR §5
/// names the GET response type `InferredCandidate`; field name for
/// the per-row identity is conventionally `inferenceId` (camelCase
/// typeshare) but the implementation may pick `inference_id` or bare `id`.
fn inference_id(row: &serde_json::Value) -> Option<String> {
    for key in &["inferenceId", "inference_id", "id"] {
        if let Some(s) = row.get(*key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

fn extract_rows(resp: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = resp.as_array() {
        arr.clone()
    } else if let Some(obj) = resp.as_object() {
        obj.get("rows")
            .or_else(|| obj.get("inferred"))
            .or_else(|| obj.get("candidates"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/inference/book/{book_uuid}
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_inference_book_when_empty_returns_zero_rows() {
    let state = empty_state().await;
    let unknown_book = Uuid::new_v4();
    let path = format!("/api/v1/inference/book/{unknown_book}");
    let (status, _, raw) = request(state, Method::GET, &path, None).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "GET /inference/book/{{uuid}} for an unknown-but-valid book uuid must return 200 with empty list (NOT 404 — empty inferred graph is a valid state); got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = extract_rows(&resp);
    assert!(rows.is_empty(), "no inferred rows for unseeded book; got {rows:?}");
}

#[tokio::test]
async fn get_inference_book_surfaces_seeded_candidates_with_provenance() {
    let (state, book_uuid, lcsh_uri) = state_with_one_inferred_subject().await;
    let path = format!("/api/v1/inference/book/{book_uuid}");
    let (status, _, raw) = request(state, Method::GET, &path, None).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "GET /inference/book/{{uuid}} must return 200 with the seeded row; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = extract_rows(&resp);
    assert_eq!(rows.len(), 1, "seeded one inferred bf:subject; got {rows:?}");

    let row = &rows[0];
    let row_str = serde_json::to_string(row).expect("re-serialize row");

    // Hard contract: each row carries the four ADR §2 lock-required
    // provenance predicates somewhere in its payload (whether as
    // top-level fields, nested provenance object, or inline). String
    // contains-test is loose enough to absorb the implementation's choice of
    // serialization shape.
    assert!(
        row_str.contains("0.87") || row_str.contains("87"),
        "row must surface confidence (0.87 or 87%); got {row_str}",
    );
    assert!(
        row_str.contains("spine-inferrer-lcsh-suggest"),
        "row must surface inferredBy id; got {row_str}",
    );
    assert!(
        row_str.contains(&lcsh_uri),
        "row must surface the LCSH subject object URI; got {row_str}",
    );

    // Identity field for /decide routing must be present.
    assert!(
        inference_id(row).is_some(),
        "row must carry inferenceId / inference_id / id; got {row_str}",
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/inference/{inference_id}/decide
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_decide_promote_moves_triple_from_inferred_to_asserted_graph() {
    let (state, book_uuid, lcsh_uri) = state_with_one_inferred_subject().await;

    // Fetch first to learn the inference_id the handler emits.
    let get_path = format!("/api/v1/inference/book/{book_uuid}");
    let (_, _, raw) = request(state.clone(), Method::GET, &get_path, None).await;
    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = extract_rows(&resp);
    let id = inference_id(rows.first().expect("seeded row")).expect("inference_id");

    let decide_path = format!("/api/v1/inference/{id}/decide");
    let body = serde_json::json!({ "action": "promote" }).to_string();
    let (status, _, raw) =
        request(state.clone(), Method::POST, &decide_path, Some(body)).await;

    assert!(
        status.is_success(),
        "POST /decide {{action:\"promote\"}} must return 2xx; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    // After promotion: asserted graph contains the bf:subject triple,
    // inferred graph no longer carries the projected triple. (The audit
    // graph behavior is ADR 016 §7; not asserted here — that's a
    // follow-on test once the audit-graph URI scheme is pinned.)
    let store = state.store.lock().await;
    let asserted_graph = format!("urn:spine:graph:asserted:{book_uuid}");
    let asserted_triples = store
        .get_triples(&asserted_graph)
        .expect("read asserted graph after promote");
    let promoted = asserted_triples
        .iter()
        .any(|(_s, p, o)| p == BF_SUBJECT && o == &lcsh_uri);
    assert!(
        promoted,
        "promote must write (?s, bf:subject, <LCSH URI>) into the asserted graph; got triples: {asserted_triples:?}",
    );

    let inferred_graph = format!("urn:spine:graph:inferred:{book_uuid}");
    let inferred_triples = store
        .get_triples(&inferred_graph)
        .expect("read inferred graph after promote");
    let still_in_inferred = inferred_triples
        .iter()
        .any(|(_s, p, o)| p == BF_SUBJECT && o == &lcsh_uri);
    assert!(
        !still_in_inferred,
        "promote must delete the projected triple from the inferred graph; still present in: {inferred_triples:?}",
    );
}

#[tokio::test]
async fn post_decide_reject_removes_triple_without_promoting() {
    let (state, book_uuid, lcsh_uri) = state_with_one_inferred_subject().await;

    let get_path = format!("/api/v1/inference/book/{book_uuid}");
    let (_, _, raw) = request(state.clone(), Method::GET, &get_path, None).await;
    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = extract_rows(&resp);
    let id = inference_id(rows.first().expect("seeded row")).expect("inference_id");

    let decide_path = format!("/api/v1/inference/{id}/decide");
    let body = serde_json::json!({
        "action": "reject",
        "reason": "off-topic — not actually about library science"
    })
    .to_string();
    let (status, _, raw) =
        request(state.clone(), Method::POST, &decide_path, Some(body)).await;

    assert!(
        status.is_success(),
        "POST /decide {{action:\"reject\"}} must return 2xx; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let store = state.store.lock().await;
    // Asserted graph must NOT carry the rejected triple — that's the
    // whole point of rejection: "not yes," not "yes-then-no."
    let asserted_graph = format!("urn:spine:graph:asserted:{book_uuid}");
    let asserted = store
        .get_triples(&asserted_graph)
        .expect("read asserted graph after reject");
    let leaked = asserted
        .iter()
        .any(|(_s, p, o)| p == BF_SUBJECT && o == &lcsh_uri);
    assert!(
        !leaked,
        "reject must NOT promote the rejected triple to the asserted graph; got: {asserted:?}",
    );

    // Inferred graph row gone.
    let inferred_graph = format!("urn:spine:graph:inferred:{book_uuid}");
    let inferred = store
        .get_triples(&inferred_graph)
        .expect("read inferred graph after reject");
    let still_present = inferred
        .iter()
        .any(|(_s, p, o)| p == BF_SUBJECT && o == &lcsh_uri);
    assert!(
        !still_present,
        "reject must remove the projected triple from the inferred graph; still present in: {inferred:?}",
    );
}

#[tokio::test]
async fn post_decide_with_unknown_action_returns_4xx() {
    let (state, book_uuid, _) = state_with_one_inferred_subject().await;

    // Fetch first so we have a real inference_id (route is otherwise
    // 404 and we'd be conflating "bad action" with "missing row").
    let get_path = format!("/api/v1/inference/book/{book_uuid}");
    let (_, _, raw) = request(state.clone(), Method::GET, &get_path, None).await;
    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let rows = extract_rows(&resp);
    let id = inference_id(rows.first().expect("seeded row")).expect("inference_id");

    let decide_path = format!("/api/v1/inference/{id}/decide");
    let body = serde_json::json!({ "action": "ignore" }).to_string();
    let (status, _, raw) =
        request(state, Method::POST, &decide_path, Some(body)).await;

    assert!(
        status.is_client_error(),
        "POST /decide with unknown action must return 4xx (only \"promote\"|\"reject\" per ADR §5); got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}

#[tokio::test]
async fn post_decide_for_unknown_inference_id_returns_404() {
    let state = empty_state().await;
    let unknown = format!("urn:spine:inference:{}", Uuid::new_v4());
    let decide_path = format!("/api/v1/inference/{unknown}/decide");
    let body = serde_json::json!({ "action": "promote" }).to_string();
    let (status, _, raw) = request(state, Method::POST, &decide_path, Some(body)).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "POST /decide with unknown inference_id must 404; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );
}
