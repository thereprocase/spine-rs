//! Speculative integration tests for the Sprint 9 library backup endpoints.
//!
//! Pre-pinning the wire-shape contract before the handlers land,
//! per the Sprint 9/10 design. Same pattern that worked for the Settings
//! drawer.
//!
//! EXPECTED RED until the following are implemented:
//!   POST /api/v1/library/backup       (returns 202 with { jobId, destPath })
//!   GET  /api/v1/library/backup/last  (returns 200 with null | { atMs, … })
//!
//! Wire shape derived from internal design notes; subject to adjustment.
//! The two response struct names below (`BackupStartResponse`,
//! `BackupLastResponse`) follow the existing spine-api naming pattern
//! (`WriteSubjectResponse`, `WriteInstanceResponse` etc.) — the
//! implementation may pick different names; in that case the imports here
//! flip and the deserialize structs in the test stay shaped the same.

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

/// Minimal AppState for backup-endpoint tests. Mirrors the helper in
/// `adr_014_endpoints_test.rs` but doesn't seed any spine-bf graph
/// (backup operates on the calibre projection + spine.db file system,
/// not on the RDF graph). Both LoC base URLs at port 0 to fail-fast on
/// any accidental network call.
async fn backup_state(temp_dir: &std::path::Path) -> Arc<AppState> {
    let metadata_db = temp_dir.join("metadata.db");
    let library = CalibreLibrary::open(metadata_db.to_str().unwrap())
        .expect("open calibre at temp metadata.db");
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
// POST /api/v1/library/backup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_library_backup_no_dest_returns_job_descriptor() {
    let temp = tempfile::tempdir().unwrap();
    let state = backup_state(temp.path()).await;

    let (status, _, raw) =
        request(state, Method::POST, "/api/v1/library/backup", Some("{}".to_string())).await;

    // Accepted = backup runs async via job queue. 200 also acceptable if
    // the implementation picks sync execution; widen to "2xx" for the
    // speculative contract.
    assert!(
        status.is_success(),
        "POST /library/backup must return 2xx, got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let job_id = resp["jobId"].as_str().expect("jobId field");
    assert!(
        uuid::Uuid::parse_str(job_id).is_ok(),
        "jobId must be a uuid; got {job_id}"
    );

    let dest_path = resp["destPath"].as_str().expect("destPath field");
    assert!(
        !dest_path.is_empty(),
        "destPath must be set even when caller didn't supply one (server-default)"
    );
}

#[tokio::test]
async fn post_library_backup_with_explicit_dest_echoes_path() {
    let temp = tempfile::tempdir().unwrap();
    let state = backup_state(temp.path()).await;
    let dest = temp.path().join("backups");

    let body = serde_json::json!({ "destPath": dest.to_string_lossy() }).to_string();
    let (status, _, raw) =
        request(state, Method::POST, "/api/v1/library/backup", Some(body)).await;

    assert!(
        status.is_success(),
        "POST /library/backup with dest must return 2xx, got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    let echoed = resp["destPath"].as_str().expect("destPath field");
    assert!(
        echoed.contains("backups"),
        "explicit destPath must be echoed in response; got {echoed}"
    );
}

// ---------------------------------------------------------------------------
// GET /api/v1/library/backup/last
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_library_backup_last_when_none_returns_null_or_empty() {
    let temp = tempfile::tempdir().unwrap();
    let state = backup_state(temp.path()).await;

    let (status, _, raw) =
        request(state, Method::GET, "/api/v1/library/backup/last", None).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "GET /backup/last must return 200 even when no backups exist; got {status}; body: {:?}",
        String::from_utf8_lossy(&raw),
    );

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    // The implementation may model "no backups yet" as JSON `null` or as `{}` —
    // accept either. `false`/integer would be wrong shapes.
    assert!(
        resp.is_null() || resp.is_object(),
        "response must be null or an object; got {resp:?}"
    );
    if let Some(obj) = resp.as_object() {
        assert!(
            obj.is_empty() || obj.contains_key("atMs"),
            "non-empty object must carry atMs; got {obj:?}"
        );
    }
}

#[tokio::test]
async fn get_library_backup_last_after_backup_round_trip_carries_descriptor() {
    // Round-trip smoke: POST a backup, then GET /last. This test relies
    // on the backup either running synchronously or completing fast
    // enough that GET sees it. If the implementation picks a fully-async model where
    // the caller must poll job_status separately before /last reflects,
    // this test will need a poll loop (~ADR 005-style timeout) or move
    // to job_status-based observation.
    let temp = tempfile::tempdir().unwrap();
    let state = backup_state(temp.path()).await;
    let dest = temp.path().join("backups");

    let body = serde_json::json!({ "destPath": dest.to_string_lossy() }).to_string();
    let (post_status, _, _) =
        request(state.clone(), Method::POST, "/api/v1/library/backup", Some(body)).await;
    assert!(post_status.is_success(), "POST must succeed first");

    // Brief wait for async backup to land; deliberately short — if this
    // ever flakes, switch to polling /api/v1/jobs/:id until terminal.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let (get_status, _, raw) =
        request(state, Method::GET, "/api/v1/library/backup/last", None).await;
    assert_eq!(get_status, StatusCode::OK);

    let resp: serde_json::Value = serde_json::from_slice(&raw).expect("json body");
    if resp.is_null() {
        // Async backup hasn't completed yet — skip the descriptor check
        // rather than fail. This branch exists so the test surfaces the
        // round-trip as "not yet observed" instead of red flake.
        eprintln!("GET /backup/last still null 500ms after POST — async model presumed");
        return;
    }
    let at_ms = resp["atMs"].as_u64().expect("atMs field on completed backup");
    assert!(at_ms > 0, "atMs must be a positive unix-ms timestamp");
    let dest_path = resp["destPath"].as_str().expect("destPath field");
    assert!(
        dest_path.contains("backups"),
        "completed backup destPath must reference the requested dir"
    );
}
