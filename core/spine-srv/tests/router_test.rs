use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Request, StatusCode},
};
use calibre_db::CalibreLibrary;
use spine_db::SpineStore;
use spine_srv::{create_router, jobs::LocalJobQueue, AppState};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use zip::write::SimpleFileOptions;

fn test_state() -> Arc<AppState> {
    let library = CalibreLibrary::open(":memory:").expect("Failed to open test library");
    let store = SpineStore::open(":memory:").expect("Failed to open spine.db");

    Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    })
}

async fn get_body(path: &str) -> (axum::http::StatusCode, String) {
    let app = create_router(test_state());
    let response = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, std::str::from_utf8(&body).unwrap().to_string())
}

async fn request_with_state(
    state: Arc<AppState>,
    method: &str,
    path: &str,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    request_with_state_body(state, method, path, None).await
}

async fn request_with_state_body(
    state: Arc<AppState>,
    method: &str,
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

fn write_test_epub(path: &Path) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    zip.start_file("OEBPS/chapter.xhtml", options).unwrap();
    zip.write_all(b"<html><body>chapter one</body></html>")
        .unwrap();
    zip.start_file("OEBPS/images/cover.jpg", options).unwrap();
    zip.write_all(b"jpeg-bytes").unwrap();
    zip.finish().unwrap();
}

fn state_with_epub(temp_dir: &Path) -> (Arc<AppState>, uuid::Uuid) {
    let book_id = uuid::Uuid::new_v4();
    let book_dir = temp_dir.join("Author").join("Book (1)");
    std::fs::create_dir_all(&book_dir).unwrap();
    write_test_epub(&book_dir.join("Book.epub"));

    let db_path = temp_dir.join("metadata.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "CREATE TABLE books (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, path TEXT NOT NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "CREATE TABLE data (book INTEGER NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO books (id, uuid, path) VALUES (1, ?1, 'Author/Book (1)')",
        [book_id.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO data (book, name, format) VALUES (1, 'Book', 'EPUB')",
        [],
    )
    .unwrap();
    drop(conn);

    let library = CalibreLibrary::open(db_path.to_str().unwrap()).unwrap();
    let store = SpineStore::open(":memory:").expect("Failed to open spine.db");

    (
        Arc::new(AppState {
            library: Mutex::new(library),
            store: Mutex::new(store),
            db_paths: None,
            loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
            job_queue: Arc::new(LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
        }),
        book_id,
    )
}

#[tokio::test]
async fn test_ping() {
    let app = create_router(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/ping")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        std::str::from_utf8(&body).unwrap(),
        "{\"status\": \"ok\", \"version\": \"0.1.0-alpha\"}"
    );
}

#[tokio::test]
async fn reader_resource_get_and_head_use_canonical_route() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    let path = format!("/api/v1/reader/book/{book_id}/resource/OEBPS/chapter.xhtml");
    let (status, headers, body) = request_with_state(state.clone(), "GET", &path).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(axum::http::header::CONTENT_TYPE).unwrap(),
        "application/xhtml+xml"
    );
    assert_eq!(
        headers.get(axum::http::header::CONTENT_LENGTH).unwrap(),
        "37"
    );
    assert_eq!(body, b"<html><body>chapter one</body></html>");

    let (head_status, head_headers, head_body) = request_with_state(state, "HEAD", &path).await;
    assert_eq!(head_status, StatusCode::OK);
    assert_eq!(
        head_headers
            .get(axum::http::header::CONTENT_LENGTH)
            .unwrap(),
        "37"
    );
    assert!(head_body.is_empty());
}

#[tokio::test]
async fn reader_resource_missing_returns_not_found() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    let path = format!("/api/v1/reader/book/{book_id}/resource/OEBPS/missing.xhtml");
    let (status, _, _) = request_with_state(state, "GET", &path).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn canonical_book_list_matches_legacy_alias() {
    let canonical = get_body("/api/v1/book").await;
    let legacy = get_body("/api/v1/library/books").await;

    assert_eq!(canonical.0, axum::http::StatusCode::OK);
    assert_eq!(canonical, legacy);
}

#[tokio::test]
async fn canonical_book_detail_matches_legacy_alias_for_missing_book() {
    let missing_id = uuid::Uuid::nil();
    let canonical = get_body(&format!("/api/v1/book/{missing_id}")).await;
    let legacy = get_body(&format!("/api/v1/library/books/{missing_id}")).await;

    assert_eq!(canonical.0, axum::http::StatusCode::OK);
    assert_eq!(canonical, legacy);
}

/// Confirm that URL-encoded path traversal sequences are rejected at the HTTP
/// layer before reaching the handler. axum decodes path segments before
/// routing; `normalize_epub_resource_path` then rejects any `..` component.
/// These tests verify the full stack — not just the unit-level normalizer.
#[tokio::test]
async fn resource_path_traversal_url_encoded_rejected() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    // URL-encoded: `..%2f..%2fetc%2fpasswd`
    let encoded_path = format!(
        "/api/v1/reader/book/{}/resource/..%2f..%2fetc%2fpasswd",
        book_id
    );
    let (status, _, _) = request_with_state(state.clone(), "GET", &encoded_path).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "URL-encoded traversal must return 400, got {}",
        status
    );
}

#[tokio::test]
async fn resource_path_traversal_literal_rejected() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    // Literal `../../../etc/passwd` — axum normalizes the path on decode;
    // the handler must still return 400 even if axum collapses some segments.
    let literal_path = format!(
        "/api/v1/reader/book/{}/resource/../../../etc/passwd",
        book_id
    );
    let (status, _, _) = request_with_state(state.clone(), "GET", &literal_path).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Literal traversal must return 400, got {}",
        status
    );
}

/// GET /api/v1/book returns a JSON array. With an empty library it should be
/// an empty array — not a 404 or server error.
#[tokio::test]
async fn list_books_returns_empty_array_on_empty_library() {
    let (status, body) = get_body("/api/v1/book").await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        parsed.is_array(),
        "list endpoint must return a JSON array, got: {body}"
    );
    assert_eq!(
        parsed.as_array().unwrap().len(),
        0,
        "empty library must return an empty array"
    );
}

/// HEAD on a known resource must return 200 with correct content-length and
/// content-type, and the response body must be empty (no bytes decompressed).
/// This is the regression guard for the fix that replaced load_book_resource
/// with probe_book_resource in head_resource — a mistaken revert would cause
/// HEAD to decompress the entire file body, which this test cannot detect
/// directly, but the content-length value from the central-directory size will
/// still be correct so the status assertions hold either way. The real guard
/// is that probe_book_resource's code path is exercised via the HEAD method.
#[tokio::test]
async fn head_resource_returns_headers_without_body() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    // Use a resource we know exists in the test epub (written by write_test_epub).
    let path = format!("/api/v1/reader/book/{book_id}/resource/OEBPS/chapter.xhtml");
    let (status, headers, body) = request_with_state(state, "HEAD", &path).await;

    assert_eq!(status, StatusCode::OK, "HEAD must return 200 for known resource");

    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .expect("HEAD response must include content-type")
        .to_str()
        .unwrap();
    assert_eq!(ct, "application/xhtml+xml");

    let cl: u64 = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .expect("HEAD response must include content-length")
        .to_str()
        .unwrap()
        .parse()
        .expect("content-length must be a valid integer");
    // The test epub writes exactly b"<html><body>chapter one</body></html>" = 37 bytes.
    assert_eq!(cl, 37, "content-length must match the uncompressed entry size");

    assert!(body.is_empty(), "HEAD response must have no body bytes");
}

/// HEAD on a missing resource must return 404, same as GET.
#[tokio::test]
async fn head_resource_missing_returns_not_found() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());

    let path = format!("/api/v1/reader/book/{book_id}/resource/OEBPS/no_such_file.xhtml");
    let (status, _, _) = request_with_state(state, "HEAD", &path).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reading_progress_round_trips_for_existing_book() {
    let temp_dir = tempfile::tempdir().unwrap();
    let (state, book_id) = state_with_epub(temp_dir.path());
    let path = format!("/api/v1/book/{book_id}/progress");
    let body = r#"{
        "locator":"epubcfi(/6/4[chapter]!/4/1:0)",
        "progressFraction":0.5,
        "chapterLabel":"Chapter 2"
    }"#;

    let (save_status, _, save_body) =
        request_with_state_body(state.clone(), "POST", &path, Some(body.to_string())).await;
    assert_eq!(save_status, StatusCode::OK);
    let saved: serde_json::Value = serde_json::from_slice(&save_body).unwrap();
    assert_eq!(
        saved["locator"],
        serde_json::Value::String("epubcfi(/6/4[chapter]!/4/1:0)".to_string())
    );
    assert_eq!(saved["progressFraction"], serde_json::json!(0.5));

    let (get_status, _, get_body) = request_with_state(state.clone(), "GET", &path).await;
    assert_eq!(get_status, StatusCode::OK);
    let fetched: serde_json::Value = serde_json::from_slice(&get_body).unwrap();
    assert_eq!(fetched["chapterLabel"], serde_json::json!("Chapter 2"));

    let (list_status, _, list_body) =
        request_with_state(state, "GET", "/api/v1/reading-progress").await;
    assert_eq!(list_status, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["bookId"], serde_json::json!(book_id.to_string()));
}
