/// Integration tests for the Wave 2 D4/D5 endpoints.
///
/// Test strategy: each test spins up the router via `tower::ServiceExt::oneshot`
/// with an in-memory or temp-dir state, then inspects HTTP status codes and
/// response bodies. Session-based write endpoints that require real on-disk
/// SQLite files use `tempfile::TempDir` to provide genuine ATTACH-compatible
/// paths. Endpoints that only need the existing `CalibreLibrary` mutex path
/// use `:memory:` as in the existing router_test.rs.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use calibre_db::{CalibreLibrary, DualDbPaths};
use rusqlite::Connection;
use spine_api::{AgentLink, AuthorityLink, BibliographicGraph, Instance, Work};
use spine_db::SpineStore;
use spine_srv::{create_router, jobs::LocalJobQueue, AppState};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use zip::write::SimpleFileOptions;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Minimal AppState backed by `:memory:` databases. Cannot be used for
/// session-write tests (ATTACH cannot share an in-memory connection). Use
/// `state_with_files` for those.
fn memory_state() -> Arc<AppState> {
    Arc::new(AppState {
        library: Mutex::new(CalibreLibrary::open(":memory:").unwrap()),
        store: Mutex::new(SpineStore::open(":memory:").unwrap()),
        db_paths: None,
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    })
}

/// Initialize a real calibre-schema metadata.db in `dir`. Returns the path.
/// We create the schema manually so the tests don't need `calibredb` installed.
fn init_calibre_db(dir: &Path) -> std::path::PathBuf {
    let db_path = dir.join("metadata.db");
    let conn = Connection::open(&db_path).unwrap();
    // Minimal calibre schema — just the tables the handlers touch.
    conn.execute_batch(
        "
        CREATE TABLE books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT 'Unknown',
            sort TEXT,
            author_sort TEXT NOT NULL DEFAULT 'Unknown',
            path TEXT NOT NULL DEFAULT '',
            uuid TEXT,
            has_cover BOOL NOT NULL DEFAULT 0,
            pubdate TEXT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            last_modified TEXT NOT NULL DEFAULT (datetime('now')),
            series_index REAL NOT NULL DEFAULT 1.0
        );
        CREATE TABLE authors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE,
            sort TEXT
        );
        CREATE TABLE books_authors_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            author INTEGER NOT NULL REFERENCES authors(id)
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE
        );
        CREATE TABLE books_tags_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            tag INTEGER NOT NULL REFERENCES tags(id)
        );
        CREATE TABLE series (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE,
            sort TEXT
        );
        CREATE TABLE books_series_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            series INTEGER NOT NULL REFERENCES series(id)
        );
        CREATE TABLE publishers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE,
            sort TEXT
        );
        CREATE TABLE books_publishers_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            publisher INTEGER NOT NULL REFERENCES publishers(id)
        );
        CREATE TABLE languages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lang_code TEXT NOT NULL COLLATE NOCASE
        );
        CREATE TABLE books_languages_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            lang_code INTEGER NOT NULL REFERENCES languages(id),
            item_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            format TEXT NOT NULL COLLATE NOCASE,
            uncompressed_size INTEGER NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL UNIQUE REFERENCES books(id),
            text TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE identifiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book INTEGER NOT NULL REFERENCES books(id),
            type TEXT NOT NULL COLLATE NOCASE DEFAULT 'isbn',
            val TEXT NOT NULL DEFAULT ''
        );
        ",
    )
    .unwrap();
    db_path
}

/// Insert a minimal book row and return its UUID.
fn insert_book(conn: &Connection, title: &str) -> String {
    let book_uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO books (title, sort, author_sort, path, uuid)
         VALUES (?1, ?1, 'Unknown', ?2, ?3)",
        rusqlite::params![
            title,
            format!("Author/{} (1)", title.replace(' ', "_")),
            book_uuid
        ],
    )
    .unwrap();
    book_uuid
}

/// Write a minimal epub zip to `dir/Book.epub` and record it in data.
fn write_and_register_epub(conn: &Connection, dir: &Path, book_id: i64, book_title: &str) {
    let epub_path = dir.join(format!("{book_title}.epub"));
    let file = std::fs::File::create(&epub_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default();
    zip.start_file("OEBPS/chapter.xhtml", opts).unwrap();
    zip.write_all(b"<html><body>hello</body></html>").unwrap();
    zip.finish().unwrap();

    conn.execute(
        "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?1, 'EPUB', 100, ?2)",
        rusqlite::params![book_id, book_title],
    )
    .unwrap();
}

/// Create a full `AppState` backed by real on-disk files in `dir`. Returns
/// `(state, book_uuid, book_id)` where `book_id` is the SQLite rowid.
fn state_with_files(
    dir: &Path,
) -> (Arc<AppState>, String) {
    let calibre_db = init_calibre_db(dir);
    let spine_db = dir.join("spine.db");

    let conn = Connection::open(&calibre_db).unwrap();
    let book_uuid = insert_book(&conn, "Hobbit Adventures");
    let book_id: i64 = conn.last_insert_rowid();

    // Create the book directory so delete_files=true tests can walk it.
    let book_dir = dir.join(format!("Author/Hobbit_Adventures (1)"));
    std::fs::create_dir_all(&book_dir).unwrap();
    write_and_register_epub(&conn, &book_dir, book_id, "Hobbit_Adventures");
    drop(conn);

    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });
    (state, book_uuid)
}

/// State with multiple books for facet/search tests.
fn state_with_multiple_books(dir: &Path) -> (Arc<AppState>, Vec<String>) {
    let calibre_db = init_calibre_db(dir);
    let spine_db = dir.join("spine.db");

    let conn = Connection::open(&calibre_db).unwrap();

    // Insert authors first, then link.
    let tolkien_uuid = insert_book(&conn, "The Hobbit");
    let tolkien_id = conn.last_insert_rowid();
    let _tolkien_author_id: i64 = {
        conn.execute(
            "INSERT INTO authors (name, sort) VALUES ('J.R.R. Tolkien', 'Tolkien, J.R.R.')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO books_authors_link (book, author) VALUES (?1, ?2)",
            [tolkien_id, id],
        )
        .unwrap();
        id
    };
    let tolkien_tag_id: i64 = {
        conn.execute("INSERT INTO tags (name) VALUES ('Fantasy')", []).unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO books_tags_link (book, tag) VALUES (?1, ?2)",
            [tolkien_id, id],
        )
        .unwrap();
        id
    };

    let rowling_uuid = insert_book(&conn, "Harry Potter");
    let rowling_id = conn.last_insert_rowid();
    {
        conn.execute(
            "INSERT INTO authors (name, sort) VALUES ('J.K. Rowling', 'Rowling, J.K.')",
            [],
        )
        .unwrap();
        let author_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO books_authors_link (book, author) VALUES (?1, ?2)",
            [rowling_id, author_id],
        )
        .unwrap();
        // Share the Fantasy tag.
        conn.execute(
            "INSERT INTO books_tags_link (book, tag) VALUES (?1, ?2)",
            [rowling_id, tolkien_tag_id],
        )
        .unwrap();
    }

    drop(conn);

    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });
    (state, vec![tolkien_uuid, rowling_uuid])
}

async fn do_request(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    body: Option<(&str, &str)>, // (content_type, body_bytes)
) -> (StatusCode, Vec<u8>) {
    let app = create_router(state);
    let mut builder = Request::builder().method(method).uri(path);
    let req_body = if let Some((ct, b)) = body {
        builder = builder.header("content-type", ct);
        Body::from(b.to_string())
    } else {
        Body::empty()
    };
    let resp = app.oneshot(builder.body(req_body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

// ---------------------------------------------------------------------------
// GET /api/v1/book (search)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn book_list_empty_q_returns_all_books() {
    let dir = tempfile::tempdir().unwrap();
    let (state, uuids) = state_with_multiple_books(dir.path());
    let (status, body) = do_request(state, "GET", "/api/v1/book?q=", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    // Both books must appear.
    assert_eq!(arr.len(), 2, "empty q must return all books; got {arr:?}");
    let _ = uuids; // suppress unused
}

#[tokio::test]
async fn book_list_q_filters_by_title() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    let (status, body) = do_request(state, "GET", "/api/v1/book?q=hobbit", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(arr.len(), 1, "q=hobbit should return exactly one book; got {arr:?}");
    let title = arr[0]["title"].as_str().unwrap();
    assert!(
        title.to_lowercase().contains("hobbit"),
        "returned book title '{title}' should contain 'hobbit'"
    );
}

#[tokio::test]
async fn book_list_no_q_returns_all_books() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    // No q parameter at all — uses list_enriched_books path.
    let (status, body) = do_request(state, "GET", "/api/v1/book", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(arr.len(), 2, "no-q must return all books; got {arr:?}");
}

#[tokio::test]
async fn book_list_q_too_long_returns_400() {
    let state = memory_state();
    let long_q = "x".repeat(257);
    let path = format!("/api/v1/book?q={long_q}");
    let (status, _) = do_request(state, "GET", &path, None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "q longer than 256 chars must return 400"
    );
}

#[tokio::test]
async fn book_list_limit_above_max_returns_400() {
    let state = memory_state();
    let (status, _) = do_request(state, "GET", "/api/v1/book?limit=1001", None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "limit > 1000 must return 400"
    );
}

#[tokio::test]
async fn book_list_limit_at_max_is_accepted() {
    let state = memory_state();
    let (status, _) = do_request(state, "GET", "/api/v1/book?limit=1000", None).await;
    assert_eq!(status, StatusCode::OK, "limit == 1000 must not return 400");
}

#[tokio::test]
async fn book_list_q_filters_by_author() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    let (status, body) = do_request(state, "GET", "/api/v1/book?q=Tolkien", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(
        arr.len(),
        1,
        "q=Tolkien should match by author name; got {arr:?}"
    );
}

// ---------------------------------------------------------------------------
// GET /api/v1/facet/:kind
// ---------------------------------------------------------------------------

#[tokio::test]
async fn facet_authors_returns_counts_descending() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    let (status, body) = do_request(state, "GET", "/api/v1/facet/authors", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert!(!arr.is_empty(), "authors facet must return at least one entry");

    // Verify count-desc ordering: each entry's bookCount must be >= the next.
    for window in arr.windows(2) {
        let a = window[0]["bookCount"].as_u64().unwrap_or(0);
        let b = window[1]["bookCount"].as_u64().unwrap_or(0);
        assert!(
            a >= b,
            "facet authors must be sorted count-desc; got {a} before {b}"
        );
    }
}

#[tokio::test]
async fn facet_tags_returns_ok() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    let (status, body) = do_request(state, "GET", "/api/v1/facet/tags", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    // "Fantasy" tag linked to 2 books.
    assert!(!arr.is_empty(), "tags facet must return entries");
    let fantasy = arr
        .iter()
        .find(|e| e["name"].as_str() == Some("Fantasy"))
        .expect("Fantasy tag must appear");
    assert_eq!(
        fantasy["bookCount"].as_u64().unwrap(),
        2,
        "Fantasy tag should have bookCount=2"
    );
}

#[tokio::test]
async fn facet_series_publishers_languages_return_ok() {
    // Use a real calibre schema (not :memory: with no tables) so the SQL
    // queries against the series/publishers/languages tables don't error.
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_multiple_books(dir.path());
    for kind in &["series", "publishers", "languages"] {
        let path = format!("/api/v1/facet/{kind}");
        let (status, _) = do_request(state.clone(), "GET", &path, None).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "facet/{kind} must return 200 on empty (real-schema) library"
        );
    }
}

#[tokio::test]
async fn facet_invalid_kind_returns_400() {
    let state = memory_state();
    let (status, body) = do_request(state, "GET", "/api/v1/facet/potatoes", None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unknown facet kind must return 400"
    );
    let text = std::str::from_utf8(&body).unwrap();
    assert!(
        text.contains("potatoes") || text.contains("unknown"),
        "error body should describe the bad kind; got: {text}"
    );
}

// ---------------------------------------------------------------------------
// GET /api/v1/jobs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jobs_list_returns_all_jobs() {
    let state = memory_state();

    // Dispatch a real job so something lands in job_status.
    let job_id = state
        .job_queue
        .dispatch(
            spine_srv::jobs::Job::ConvertFormat {
                book_id: uuid::Uuid::new_v4(),
                target_format: "epub".to_string(),
            },
            state.clone(),
        )
        .await
        .unwrap();

    // Poll up to ~1s for the spawned task to register the job in job_status.
    // Fixed-sleep was flaky under load; poll-with-timeout is deterministic.
    let mut last_arr: Vec<serde_json::Value> = Vec::new();
    let mut last_status = StatusCode::OK;
    let target = job_id.0.to_string();
    let mut found = false;
    for _ in 0..20 {
        let (status, body) = do_request(state.clone(), "GET", "/api/v1/jobs", None).await;
        last_status = status;
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        last_arr = parsed.as_array().cloned().unwrap_or_default();
        if last_arr.iter().any(|e| e["id"].as_str() == Some(&target)) {
            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(last_status, StatusCode::OK);
    assert!(
        found,
        "jobs list must include job {} by id within 1s; got {last_arr:?}",
        job_id.0
    );
}

#[tokio::test]
async fn jobs_list_empty_when_no_jobs_dispatched() {
    let state = memory_state();
    let (status, body) = do_request(state, "GET", "/api/v1/jobs", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(
        parsed.as_array().unwrap().is_empty(),
        "jobs list must be empty when no jobs have been dispatched"
    );
}

#[tokio::test]
async fn jobs_list_includes_failed_job() {
    let state = memory_state();
    // ConvertFormat and FetchMetadata are stubs that immediately fail.
    let job_id = state
        .job_queue
        .dispatch(
            spine_srv::jobs::Job::FetchMetadata {
                book_id: uuid::Uuid::new_v4(),
            },
            state.clone(),
        )
        .await
        .unwrap();

    // Wait for the background task to mark it failed.
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let map = state.job_status.lock().await;
        if let Some(status) = map.get(&job_id.0) {
            if matches!(status, spine_srv::jobs::JobStatus::Failed(_)) {
                break;
            }
        }
    }

    let (status, body) = do_request(state, "GET", "/api/v1/jobs", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    let entry = arr
        .iter()
        .find(|e| e["id"].as_str() == Some(&job_id.0.to_string()))
        .expect("jobs list must include the failed job");
    assert_eq!(
        entry["status"]["status"].as_str(),
        Some("failed"),
        "failed job must show status=failed; got {entry:?}"
    );
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/book/:id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_book_non_uuid_id_returns_400() {
    let state = memory_state();
    let (status, _) = do_request(state, "DELETE", "/api/v1/book/not-a-uuid", None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "non-UUID book id must return 400"
    );
}

#[tokio::test]
async fn delete_book_unknown_uuid_returns_404() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_files(dir.path());
    let missing = uuid::Uuid::new_v4();
    let path = format!("/api/v1/book/{missing}");
    let (status, _) = do_request(state, "DELETE", &path, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "missing book must return 404");
}

#[tokio::test]
async fn delete_book_removes_db_rows_leaves_disk() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    // Record the book dir path before deletion.
    let book_dir = dir.path().join("Author/Hobbit_Adventures (1)");
    assert!(
        book_dir.exists(),
        "test precondition: book directory must exist before delete"
    );

    let path = format!("/api/v1/book/{book_uuid}");
    // No delete_files param → default false.
    let (status, body) = do_request(state.clone(), "DELETE", &path, None).await;
    assert_eq!(status, StatusCode::OK, "delete must return 200; body={}", std::str::from_utf8(&body).unwrap_or("?"));

    // The directory must still be on disk.
    assert!(
        book_dir.exists(),
        "book directory must survive when delete_files is not set (defaults false)"
    );

    // The DB row must be gone — the library reports None for the UUID.
    let lib = state.library.lock().await;
    let found = lib.get_book_by_uuid(&book_uuid).unwrap();
    assert!(found.is_none(), "book DB row must be gone after delete");
}

#[tokio::test]
async fn delete_book_with_delete_files_removes_disk_folder() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let book_dir = dir.path().join("Author/Hobbit_Adventures (1)");
    assert!(book_dir.exists(), "precondition: book dir must exist");

    let path = format!("/api/v1/book/{book_uuid}?delete_files=true");
    let (status, _) = do_request(state, "DELETE", &path, None).await;
    assert_eq!(status, StatusCode::OK, "delete with delete_files=true must return 200");

    assert!(
        !book_dir.exists(),
        "book directory must be removed when delete_files=true"
    );
}

#[tokio::test]
async fn delete_book_response_body_is_deleted_book_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let path = format!("/api/v1/book/{book_uuid}");
    let (status, body) = do_request(state, "DELETE", &path, None).await;
    assert_eq!(status, StatusCode::OK);

    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        parsed["uuid"].as_str(),
        Some(book_uuid.as_str()),
        "deleted book UUID in response must match path parameter"
    );
    assert!(
        parsed["path"].is_string(),
        "response must include a 'path' field"
    );
    let deleted_files = parsed["deletedFiles"].as_array().unwrap();
    assert!(
        deleted_files.is_empty(),
        "deletedFiles must be empty when delete_files=false"
    );
}

// ---------------------------------------------------------------------------
// PUT /api/v1/book/:id/metadata/fields
// ---------------------------------------------------------------------------

fn make_update_body(book_uuid: &str) -> String {
    let graph = BibliographicGraph {
        work_uri: format!("urn:spine:work:{book_uuid}"),
        instance_uri: format!("urn:spine:instance:{book_uuid}"),
        work: Work {
            uri: format!("urn:spine:work:{book_uuid}"),
            title: Some("Updated Title".to_string()),
            origin_date: None,
            subjects: vec![AuthorityLink {
                uri: "http://id.loc.gov/authorities/subjects/sh00000000".to_string(),
                label: "Fiction".to_string(),
                source: "LCSH".to_string(),
            }],
            creators: vec![AgentLink {
                uri: "http://id.loc.gov/authorities/names/n000000".to_string(),
                name: "Test Author".to_string(),
                role: "aut".to_string(),
            }],
            language: Some("eng".to_string()),
            lccn: None,
            ddc: None,
        },
        instances: vec![Instance {
            uri: format!("urn:spine:instance:{book_uuid}"),
            format: "EPUB".to_string(),
            publication_date: None,
            publisher: Some("Test Publisher".to_string()),
            isbn: None,
            oclc: None,
        }],
    };

    let projection = calibre_db::BookUpdate {
        title: Some("Updated Title".to_string()),
        authors: Some(vec!["Test Author".to_string()]),
        tags: None,
        series: None,
        series_index: None,
        pubdate: None,
        publisher: Some(Some("Test Publisher".to_string())),
        languages: Some(vec!["eng".to_string()]),
    };

    serde_json::json!({
        "graph": graph,
        "projection": projection,
    })
    .to_string()
}

#[tokio::test]
async fn put_metadata_fields_happy_path_returns_204() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let body = make_update_body(&book_uuid);
    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, _) =
        do_request(state.clone(), "PUT", &path, Some(("application/json", &body))).await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "successful metadata update must return 204"
    );

    // Verify calibre was updated.
    let lib = state.library.lock().await;
    let book = lib.get_book_by_uuid(&book_uuid).unwrap().unwrap();
    assert_eq!(book.title, "Updated Title", "calibre title must reflect the update");
}

#[tokio::test]
async fn put_metadata_fields_oversize_body_returns_413() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    // 1 MiB + 1 byte.
    let oversize = "x".repeat(1024 * 1024 + 1);
    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, _) = do_request(
        state,
        "PUT",
        &path,
        Some(("application/json", &oversize)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "body > 1 MiB must return 413"
    );
}

#[tokio::test]
async fn put_metadata_fields_mismatched_uuid_returns_400() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    // Build a body for a different UUID.
    let other_uuid = uuid::Uuid::new_v4().to_string();
    let body = make_update_body(&other_uuid);
    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, resp_body) =
        do_request(state, "PUT", &path, Some(("application/json", &body))).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "mismatched work_uri uuid vs path must return 400; body={}",
        std::str::from_utf8(&resp_body).unwrap_or("?")
    );
}

#[tokio::test]
async fn put_metadata_fields_non_uuid_path_returns_400() {
    let state = memory_state();
    let body = r#"{"graph":{},"projection":{}}"#;
    let (status, _) = do_request(
        state,
        "PUT",
        "/api/v1/book/not-a-uuid/metadata/fields",
        Some(("application/json", body)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/export
// ---------------------------------------------------------------------------

#[tokio::test]
async fn export_book_returns_zip_with_opf() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let path = format!("/api/v1/book/{book_uuid}/export");
    let (status, body) = do_request(state, "POST", &path, None).await;
    assert_eq!(status, StatusCode::OK, "export must return 200");

    // Verify Content-Type header via the router. We can also parse the zip.
    // Parse the zip and verify metadata.opf is present.
    let cursor = std::io::Cursor::new(body);
    let mut archive = zip::ZipArchive::new(cursor).expect("response must be a valid zip");

    let entry_names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(
        entry_names.contains(&"metadata.opf".to_string()),
        "zip must contain metadata.opf; entries: {entry_names:?}"
    );

    let mut opf = archive.by_name("metadata.opf").unwrap();
    let mut opf_text = String::new();
    std::io::Read::read_to_string(&mut opf, &mut opf_text).unwrap();
    assert!(
        opf_text.contains("<dc:title>"),
        "OPF must contain a dc:title element; got: {opf_text}"
    );
}

#[tokio::test]
async fn export_book_contains_format_file() {
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let path = format!("/api/v1/book/{book_uuid}/export");
    let (status, body) = do_request(state, "POST", &path, None).await;
    assert_eq!(status, StatusCode::OK);

    let cursor = std::io::Cursor::new(body);
    let mut archive = zip::ZipArchive::new(cursor).unwrap();
    let entry_names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();

    // The epub file registered in state_with_files is Hobbit_Adventures.epub.
    assert!(
        entry_names.iter().any(|n| n.ends_with(".epub")),
        "zip must contain the epub format file; entries: {entry_names:?}"
    );
}

#[tokio::test]
async fn export_book_non_uuid_id_returns_400() {
    let state = memory_state();
    let (status, _) = do_request(state, "POST", "/api/v1/book/bad-id/export", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn export_book_unknown_uuid_returns_404() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_files(dir.path());
    let missing = uuid::Uuid::new_v4();
    let (status, _) =
        do_request(state, "POST", &format!("/api/v1/book/{missing}/export"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn export_book_no_formats_returns_404() {
    // Book exists but has no data rows → list_format_paths returns empty.
    let dir = tempfile::tempdir().unwrap();
    let calibre_db = init_calibre_db(dir.path());
    let spine_db = dir.path().join("spine.db");

    let conn = Connection::open(&calibre_db).unwrap();
    let book_uuid = insert_book(&conn, "No Format Book");
    // Do NOT insert a data row — no formats.
    drop(conn);

    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    let path = format!("/api/v1/book/{book_uuid}/export");
    let (status, _) = do_request(state, "POST", &path, None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "book with no formats must return 404 on export"
    );
}

// ---------------------------------------------------------------------------
// Search — LIKE wildcard escape (review item W5)
// ---------------------------------------------------------------------------

/// Helper: open a state with a single book whose title is `title`.
fn state_with_one_book(dir: &std::path::Path, title: &str) -> Arc<AppState> {
    let calibre_db = init_calibre_db(dir);
    let spine_db = dir.join("spine.db");
    let conn = Connection::open(&calibre_db).unwrap();
    insert_book(&conn, title);
    drop(conn);
    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    })
}

#[tokio::test]
async fn search_percent_wildcard_does_not_match_every_book() {
    // A `%` in the query must be treated as a literal percent sign, not as
    // a LIKE wildcard. The library has one book whose title does not contain
    // `%`; the search must return zero results.
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_one_book(dir.path(), "The Hobbit");
    let (status, body) = do_request(state, "GET", "/api/v1/book?q=%25", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(
        arr.len(),
        0,
        "query '%' (URL-encoded as %25) must not match a book that doesn't contain '%'; got {arr:?}"
    );
}

#[tokio::test]
async fn search_underscore_wildcard_does_not_match_single_char() {
    // A `_` in the query must be treated as a literal underscore, not as
    // a single-char wildcard. "The Hobbit" contains no `_`; the search must
    // return zero results.
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_one_book(dir.path(), "The Hobbit");
    let (status, body) = do_request(state, "GET", "/api/v1/book?q=_", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(
        arr.len(),
        0,
        "query '_' must not match a book that doesn't contain '_'; got {arr:?}"
    );
}

// ---------------------------------------------------------------------------
// Search — publisher + series field alignment (review item W10)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_matches_by_publisher() {
    let dir = tempfile::tempdir().unwrap();
    let calibre_db = init_calibre_db(dir.path());
    let spine_db = dir.path().join("spine.db");

    let conn = Connection::open(&calibre_db).unwrap();
    let book_uuid = insert_book(&conn, "Foundation");
    let book_id = conn.last_insert_rowid();

    // Add a publisher linked to this book.
    conn.execute("INSERT INTO publishers (name, sort) VALUES ('Gnome Press', 'Gnome Press')", [])
        .unwrap();
    let pub_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO books_publishers_link (book, publisher) VALUES (?1, ?2)",
        rusqlite::params![book_id, pub_id],
    )
    .unwrap();
    drop(conn);

    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    let (status, body) = do_request(state, "GET", "/api/v1/book?q=Gnome+Press", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(
        arr.len(),
        1,
        "search by publisher name must return the matching book; got {arr:?}"
    );
    assert_eq!(
        arr[0]["id"].as_str(),
        Some(book_uuid.as_str()),
        "returned book UUID must match"
    );
    let _ = book_uuid;
}

#[tokio::test]
async fn search_matches_by_series() {
    let dir = tempfile::tempdir().unwrap();
    let calibre_db = init_calibre_db(dir.path());
    let spine_db = dir.path().join("spine.db");

    let conn = Connection::open(&calibre_db).unwrap();
    let book_uuid = insert_book(&conn, "Foundation");
    let book_id = conn.last_insert_rowid();

    // Add a series linked to this book.
    conn.execute(
        "INSERT INTO series (name, sort) VALUES ('Foundation Series', 'Foundation Series')",
        [],
    )
    .unwrap();
    let series_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO books_series_link (book, series) VALUES (?1, ?2)",
        rusqlite::params![book_id, series_id],
    )
    .unwrap();
    drop(conn);

    let library = CalibreLibrary::open(calibre_db.to_str().unwrap()).unwrap();
    let store = SpineStore::open(spine_db.to_str().unwrap()).unwrap();
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: calibre_db.to_str().unwrap().to_string(),
            spine_db: spine_db.to_str().unwrap().to_string(),
        }),
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    let (status, body) = do_request(state, "GET", "/api/v1/book?q=Foundation+Series", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = parsed.as_array().unwrap();
    assert_eq!(
        arr.len(),
        1,
        "search by series name must return the matching book; got {arr:?}"
    );
    assert_eq!(
        arr[0]["id"].as_str(),
        Some(book_uuid.as_str()),
        "returned book UUID must match"
    );
    let _ = book_uuid;
}

// ---------------------------------------------------------------------------
// PUT /api/v1/book/:id/metadata/fields — work_uri validation (review item C3)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn put_metadata_fields_fragment_uri_returns_400() {
    // A work_uri with a fragment '#' appended — the old frontend pattern —
    // must be rejected with 400.
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    // Build a body where work_uri has the fragment the old frontend added.
    let frag_uri = format!("urn:spine:work:{book_uuid}#{book_uuid}");
    let graph = serde_json::json!({
        "workUri": frag_uri,
        "instanceUri": format!("urn:spine:instance:{book_uuid}"),
        "work": {
            "uri": format!("urn:spine:work:{book_uuid}"),
            "title": "Something",
            "subjects": [],
            "creators": []
        },
        "instances": []
    });
    let body = serde_json::json!({
        "graph": graph,
        "projection": {}
    })
    .to_string();

    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, _) = do_request(state, "PUT", &path, Some(("application/json", &body))).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "work_uri with fragment must return 400"
    );
}

#[tokio::test]
async fn put_metadata_fields_loc_uri_without_book_uuid_returns_400() {
    // A LoC HTTP URI in work_uri without book_uuid in the request body must
    // be rejected with 400 — the server cannot bind the LoC record to a local
    // book without it.
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let loc_uri = "https://id.loc.gov/resources/works/12345678";
    let graph = serde_json::json!({
        "workUri": loc_uri,
        "instanceUri": format!("urn:spine:instance:{book_uuid}"),
        "work": {
            "uri": loc_uri,
            "title": "Foundation",
            "subjects": [],
            "creators": []
        },
        "instances": []
    });
    // Deliberately omit book_uuid from the request body.
    let body = serde_json::json!({
        "graph": graph,
        "projection": {}
    })
    .to_string();

    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, resp_body) =
        do_request(state, "PUT", &path, Some(("application/json", &body))).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "LoC URI without book_uuid must return 400; body={}",
        std::str::from_utf8(&resp_body).unwrap_or("?")
    );
}

#[tokio::test]
async fn put_metadata_fields_loc_uri_with_matching_book_uuid_succeeds() {
    // A LoC HTTP URI with book_uuid equal to the path :id must succeed.
    let dir = tempfile::tempdir().unwrap();
    let (state, book_uuid) = state_with_files(dir.path());

    let loc_uri = "https://id.loc.gov/resources/works/12345678";
    let graph = serde_json::json!({
        "workUri": loc_uri,
        "instanceUri": format!("urn:spine:instance:{book_uuid}"),
        "work": {
            "uri": loc_uri,
            "title": "Foundation",
            "subjects": [],
            "creators": []
        },
        "instances": []
    });
    let body = serde_json::json!({
        "graph": graph,
        "projection": {},
        "bookUuid": book_uuid
    })
    .to_string();

    let path = format!("/api/v1/book/{book_uuid}/metadata/fields");
    let (status, resp_body) =
        do_request(state, "PUT", &path, Some(("application/json", &body))).await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "LoC URI with matching book_uuid must return 204; body={}",
        std::str::from_utf8(&resp_body).unwrap_or("?")
    );
}

// ---------------------------------------------------------------------------
// Sprint 6 endpoints — /api/v1/storage, /api/v1/jobs/summary,
// /api/v1/loc/cache_status, POST/GET /api/v1/library/recent + /list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn storage_returns_503_when_no_library_open() {
    // memory_state has db_paths = None (in-memory ATTACH not supported).
    let state = memory_state();
    let (status, body) = do_request(state, "GET", "/api/v1/storage", None).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "/storage must 503 when AppState.db_paths is None; body={}",
        std::str::from_utf8(&body).unwrap_or("?")
    );
}

#[tokio::test]
async fn storage_returns_info_with_real_files() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_files(dir.path());

    let (status, body) = do_request(state, "GET", "/api/v1/storage", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(
        parsed.get("spineDbBytes").is_some(),
        "response must include spineDbBytes; got {parsed:?}"
    );
    assert!(parsed.get("metadataDbBytes").is_some());
    assert!(parsed.get("coversBytes").is_some());
    assert_eq!(
        parsed["bookCount"].as_u64(),
        Some(1),
        "bookCount must reflect the single book inserted by state_with_files"
    );
    assert!(
        parsed["metadataDbBytes"].as_u64().unwrap_or(0) > 0,
        "metadata.db should have nonzero size after schema init"
    );
}

#[tokio::test]
async fn storage_cache_hit_returns_identical_response() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_with_files(dir.path());

    let (status1, body1) = do_request(state.clone(), "GET", "/api/v1/storage", None).await;
    assert_eq!(status1, StatusCode::OK);

    let (status2, body2) = do_request(state, "GET", "/api/v1/storage", None).await;
    assert_eq!(status2, StatusCode::OK);

    // Within TTL the cache must serve the same bytes — same library_path
    // key, same fetched_at-window. If the cache were keyed wrong, the
    // covers walk would produce identical (deterministic) bytes anyway,
    // so this isn't a perfect cache-hit assertion; combined with the
    // unit-test invariants in api_v1.rs (lock-and-return on hit) it
    // documents the contract a future regression would have to break.
    assert_eq!(
        body1, body2,
        "second /storage request within TTL must serve identical body"
    );
}

#[tokio::test]
async fn jobs_summary_zero_state_when_empty() {
    let state = memory_state();
    let (status, body) = do_request(state, "GET", "/api/v1/jobs/summary", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["pending"].as_u64(), Some(0));
    assert_eq!(parsed["running"].as_u64(), Some(0));
    assert_eq!(parsed["completed"].as_u64(), Some(0));
    assert_eq!(parsed["failed"].as_u64(), Some(0));
}

#[tokio::test]
async fn jobs_summary_counts_match_status_map() {
    let state = memory_state();

    // Manually populate job_status with each variant. We deliberately
    // do NOT touch job_terminal_at — evict_expired_jobs only evicts
    // entries that have a terminal-at timestamp older than TTL, so
    // entries without a timestamp survive every sweep.
    {
        let mut map = state.job_status.lock().await;
        map.insert(uuid::Uuid::new_v4(), spine_srv::jobs::JobStatus::Pending);
        map.insert(uuid::Uuid::new_v4(), spine_srv::jobs::JobStatus::Running);
        map.insert(uuid::Uuid::new_v4(), spine_srv::jobs::JobStatus::Running);
        map.insert(
            uuid::Uuid::new_v4(),
            spine_srv::jobs::JobStatus::Completed("abc".to_string()),
        );
        map.insert(
            uuid::Uuid::new_v4(),
            spine_srv::jobs::JobStatus::Failed("err".to_string()),
        );
    }

    let (status, body) = do_request(state, "GET", "/api/v1/jobs/summary", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["pending"].as_u64(), Some(1));
    assert_eq!(parsed["running"].as_u64(), Some(2));
    assert_eq!(parsed["completed"].as_u64(), Some(1));
    assert_eq!(parsed["failed"].as_u64(), Some(1));
}

#[tokio::test]
async fn loc_cache_status_returns_stub_shape() {
    let state = memory_state();
    let (status, body) = do_request(state, "GET", "/api/v1/loc/cache_status", None).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        parsed["present"].as_bool(),
        Some(false),
        "stub must report present=false until LoC cache layer lands"
    );
    assert_eq!(parsed["entries"].as_u64(), Some(0));
    assert!(
        parsed["lastRefreshedAtMs"].is_null(),
        "lastRefreshedAtMs must be null in stub state; got {:?}",
        parsed["lastRefreshedAtMs"]
    );
}

#[tokio::test]
async fn library_recent_push_then_list_round_trip() {
    let state = memory_state();

    let body = r#"{"path":"/path/to/lib1"}"#;
    let (status, _) = do_request(
        state.clone(),
        "POST",
        "/api/v1/library/recent",
        Some(("application/json", body)),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "successful push returns 204");

    let (list_status, list_body) =
        do_request(state, "GET", "/api/v1/library/list", None).await;
    assert_eq!(list_status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let recent = parsed["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].as_str(), Some("/path/to/lib1"));
    assert_eq!(
        parsed["current"].as_str(),
        Some("/path/to/lib1"),
        "push must also set `current` so a single mutation covers the user-action"
    );
}

#[tokio::test]
async fn library_recent_dedup_moves_to_front() {
    let state = memory_state();

    for path in &["/a", "/b", "/a"] {
        let body = format!(r#"{{"path":"{path}"}}"#);
        let (status, _) = do_request(
            state.clone(),
            "POST",
            "/api/v1/library/recent",
            Some(("application/json", &body)),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (_, list_body) = do_request(state, "GET", "/api/v1/library/list", None).await;
    let parsed: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let recent: Vec<&str> = parsed["recent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        recent,
        vec!["/a", "/b"],
        "third push of /a must dedup the prior /a and move it to front; got {recent:?}"
    );
    assert_eq!(parsed["current"].as_str(), Some("/a"));
}

#[tokio::test]
async fn library_recent_truncates_to_five() {
    let state = memory_state();

    for i in 1..=6 {
        let path = format!("/lib{i}");
        let body = format!(r#"{{"path":"{path}"}}"#);
        let (status, _) = do_request(
            state.clone(),
            "POST",
            "/api/v1/library/recent",
            Some(("application/json", &body)),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (_, list_body) = do_request(state, "GET", "/api/v1/library/list", None).await;
    let parsed: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let recent: Vec<&str> = parsed["recent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        recent.len(),
        5,
        "after 6 pushes, recent must be truncated to 5; got {recent:?}"
    );
    // Newest at index 0; oldest dropped.
    assert_eq!(recent[0], "/lib6");
    assert!(
        !recent.iter().any(|p| *p == "/lib1"),
        "oldest entry /lib1 must have been dropped after truncate-to-5; got {recent:?}"
    );
}

#[tokio::test]
async fn library_recent_empty_path_returns_400() {
    let state = memory_state();
    let body = r#"{"path":""}"#;
    let (status, body_bytes) = do_request(
        state,
        "POST",
        "/api/v1/library/recent",
        Some(("application/json", body)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "empty path must return 400; body={}",
        std::str::from_utf8(&body_bytes).unwrap_or("?")
    );
}
