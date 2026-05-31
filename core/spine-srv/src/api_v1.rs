use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use calibre_db::{BookUpdate, DeletedBook, FacetCount};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use spine_api::v1::{
    AddInstanceRequest, AddRecentLibraryRequest, AddSubjectRequest, JobsSummary, LcshSuggestMatch,
    LcshSuggestResponse, LibraryBackupLastResponse, LibraryBackupRequest,
    LibraryBackupStartResponse, LibraryList, LocCacheStatus, StorageInfo, WriteInstanceResponse,
    WriteSubjectResponse,
};
use spine_bf::write::{
    self as bf_write, InstanceCandidate, ProvenanceContext, SetFieldsRequest, SpineWriteError,
    SubjectSource,
};
use spine_meta::reconcile::BlockingLocReconciler;
use spine_api::{BibliographicGraph, Book, ReadingProgress, SaveReadingProgressRequest};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Query-param structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct BookListQuery {
    /// Free-text search. Max 256 chars. Empty / absent → full list.
    pub q: Option<String>,
    /// Page size. Default 200, max 1000.
    pub limit: Option<u32>,
    /// Offset into the result set.
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteBookQuery {
    /// If true, also remove the on-disk folder. Default false (safer).
    pub delete_files: Option<bool>,
}

// ---------------------------------------------------------------------------
// Request body for PUT /api/v1/book/:id/metadata/fields
// ---------------------------------------------------------------------------

/// Body for the atomic metadata update endpoint. Both the BIBFRAME graph and
/// the calibre projection leg are written in a single cross-DB transaction.
///
/// For `urn:spine:*` URIs the book UUID is embedded in the URI suffix and the
/// handler verifies it matches the `:id` path parameter directly.
///
/// For HTTP(S) URIs (e.g. Library of Congress `id.loc.gov` records) the LoC
/// record ID differs from the local book UUID by design. Callers MUST supply
/// `book_uuid` equal to the `:id` path parameter so the handler can bind the
/// LoC record to the correct local book. Requests with an HTTP(S) `work_uri`
/// but without a matching `book_uuid` are rejected with 400.
///
/// Sending `book_uuid` for `urn:spine:*` URIs is accepted (redundant but not
/// an error) and its value must still equal the path `:id`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadataFieldsRequest {
    pub graph: BibliographicGraph,
    pub projection: BookUpdate,
    /// Required when `graph.work_uri` is an HTTP(S) URI (e.g., a LoC record).
    /// Optional for `urn:spine:*` URIs where the UUID is the URI suffix.
    /// When present, must equal the `:id` path parameter.
    pub book_uuid: Option<String>,
}

// ---------------------------------------------------------------------------
// GET /api/v1/book  (replaces the no-query version, adds search support)
// ---------------------------------------------------------------------------

/// Maximum length of the `q` search query parameter.
const MAX_QUERY_LEN: usize = 256;
/// Default page size for book list / search.
const DEFAULT_LIMIT: u32 = 200;
/// Maximum page size the server will honour.
const MAX_LIMIT: u32 = 1000;

pub async fn list_books_v1(
    Query(params): Query<BookListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Book>>, (StatusCode, String)> {
    if let Some(ref q) = params.q {
        if q.len() > MAX_QUERY_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("q exceeds maximum length of {MAX_QUERY_LEN} characters"),
            ));
        }
    }

    let limit = params.limit.unwrap_or(DEFAULT_LIMIT);
    if limit > MAX_LIMIT {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("limit exceeds maximum of {MAX_LIMIT}"),
        ));
    }

    let offset = params.offset.unwrap_or(0);

    // When q is present (even empty string), route through search_books so the
    // caller gets paginated results through a consistent code path. When q is
    // absent entirely, use list_enriched_books for graph hydration.
    match &params.q {
        Some(q) => {
            let q = q.clone();
            let books = {
                let lib = state.library.lock().await;
                match parse_field_prefix(&q) {
                    Some((field, value)) => lib
                        .search_books_by_field(field, value, Some(limit), Some(offset))
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
                    None => lib
                        .search_books(&q, Some(limit), Some(offset))
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
                }
            };
            // Hydrate the search results with BIBFRAME graphs. The batch
            // hydration path requires collecting URIs first.
            let graph_uris: Vec<String> =
                books.iter().map(|b| crate::graph_uri_for(&b.id)).collect();
            let uri_refs: Vec<&str> = graph_uris.iter().map(String::as_str).collect();
            let triples_by_graph = {
                let store = state.store.lock().await;
                store.get_triples_batch(&uri_refs).unwrap_or_default()
            };
            let books = books
                .into_iter()
                .map(|mut book| {
                    let uri = crate::graph_uri_for(&book.id);
                    if let Some(triples) = triples_by_graph.get(&uri) {
                        book.bibliographic_graph =
                            spine_bf::triples_to_bibliographic_graph(&book.id.to_string(), triples);
                    }
                    book
                })
                .collect();
            Ok(Json(books))
        }
        None => Ok(Json(crate::list_enriched_books(&state).await)),
    }
}

pub async fn get_book_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Json<Option<Book>> {
    Json(crate::get_enriched_book(&state, &id).await)
}

// ---------------------------------------------------------------------------
// GET /api/v1/facet/:kind
// ---------------------------------------------------------------------------

/// Returns the 5 recognised facet kinds.
fn dispatch_facet(
    lib: &calibre_db::CalibreLibrary,
    kind: &str,
) -> Result<Vec<FacetCount>, String> {
    match kind {
        "authors" => lib.list_authors().map_err(|e| e.to_string()),
        "tags" => lib.list_tags().map_err(|e| e.to_string()),
        "series" => lib.list_series().map_err(|e| e.to_string()),
        "publishers" => lib.list_publishers().map_err(|e| e.to_string()),
        "languages" => lib.list_languages().map_err(|e| e.to_string()),
        _ => Err(format!(
            "unknown facet kind '{kind}'; expected one of: authors, tags, series, publishers, languages"
        )),
    }
}

pub async fn list_facet(
    Path(kind): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<FacetCount>>, (StatusCode, String)> {
    let valid_kinds = ["authors", "tags", "series", "publishers", "languages"];
    if !valid_kinds.contains(&kind.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "unknown facet kind '{kind}'; expected one of: {}",
                valid_kinds.join(", ")
            ),
        ));
    }
    let lib = state.library.lock().await;
    dispatch_facet(&lib, &kind)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ---------------------------------------------------------------------------
// GET /api/v1/jobs
// ---------------------------------------------------------------------------

/// A single job entry as returned by the jobs list endpoint.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEntry {
    pub id: uuid::Uuid,
    pub status: crate::jobs::JobStatus,
}

/// Sanitise the error string inside a `Failed` job status before it goes on
/// the wire. Absolute paths and OS usernames can appear in rusqlite / tokio
/// error messages; sending them to the frontend risks leaking user account
/// names or filesystem structure in bug reports and browser developer tools.
///
/// Rules applied (in order):
/// 1. Replace Unix/Windows/UNC absolute path segments with `<path>`.
/// 2. Replace the current OS username (if obtainable) with `<user>`.
/// 3. Truncate to 512 **characters** (not bytes) to prevent large stack
///    traces on the wire without splitting a multi-byte UTF-8 sequence.
///
/// `Completed` and in-flight statuses are returned unchanged.
fn scrub_job_status(status: &crate::jobs::JobStatus) -> crate::jobs::JobStatus {
    use crate::jobs::JobStatus;
    let JobStatus::Failed(msg) = status else {
        return status.clone();
    };

    let mut s = msg.clone();

    // Replace Unix absolute paths, Windows drive paths, and UNC paths.
    s = replace_paths(&s);

    // Replace the OS username if we can obtain it. Both %USERNAME% (Windows)
    // and $USER / $LOGNAME (Unix) are covered by std::env.
    for var in &["USERNAME", "USER", "LOGNAME"] {
        if let Ok(username) = std::env::var(var) {
            if !username.is_empty() {
                s = s.replace(&username, "<user>");
            }
        }
    }

    // Truncate at 512 characters. String::truncate operates on byte offsets and
    // panics if the offset is not on a character boundary, so we find the byte
    // offset of the 512th character boundary ourselves.
    const MAX_CHARS: usize = 512;
    let char_count = s.chars().count();
    if char_count > MAX_CHARS {
        // Find the byte offset just past the 512th character.
        let cut = s
            .char_indices()
            .nth(MAX_CHARS)
            .map(|(byte_pos, _)| byte_pos)
            .unwrap_or(s.len());
        s.truncate(cut);
        s.push('…');
    }

    JobStatus::Failed(s)
}

/// Replace absolute filesystem path patterns in `s` with `<path>`.
///
/// Handles:
/// - Windows drive paths: `C:\foo` or `C:/foo`
/// - UNC paths: `\\server\share\...` (two leading backslashes)
/// - Unix absolute paths: `/foo/bar`
///
/// Uses `char_indices` for correct iteration over multi-byte UTF-8 strings.
/// Byte-casting (`bytes[i] as char`) is intentionally avoided — it would
/// produce incorrect characters for any non-ASCII code point.
///
/// This is intentionally conservative: only sequences that look like
/// absolute paths are replaced, not relative ones.
pub fn replace_paths(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let (_, ch) = chars[i];

        // UNC path: '\' '\' followed by a non-separator char.
        // Covers \\server\share\path patterns.
        if ch == '\\'
            && i + 1 < len
            && chars[i + 1].1 == '\\'
            && i + 2 < len
            && chars[i + 2].1 != '\\'
        {
            result.push_str("<path>");
            i += 2; // skip the two leading backslashes
            while i < len {
                let (_, c) = chars[i];
                if c.is_ascii_whitespace() || c == '"' || c == '\'' {
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Windows absolute path: single ASCII alpha + ':' + ('/' or '\')
        if ch.is_ascii_alphabetic()
            && i + 1 < len
            && chars[i + 1].1 == ':'
            && i + 2 < len
            && (chars[i + 2].1 == '/' || chars[i + 2].1 == '\\')
        {
            result.push_str("<path>");
            i += 3;
            while i < len {
                let (_, c) = chars[i];
                if c.is_ascii_whitespace() || c == '"' || c == '\'' {
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Unix absolute path: '/' followed by at least one non-whitespace char
        // that isn't another '/' (so bare '/' alone is not replaced).
        if ch == '/'
            && i + 1 < len
            && !chars[i + 1].1.is_ascii_whitespace()
            && chars[i + 1].1 != '/'
        {
            result.push_str("<path>");
            i += 1;
            while i < len {
                let (_, c) = chars[i];
                if c.is_ascii_whitespace() || c == '"' || c == '\'' {
                    break;
                }
                i += 1;
            }
            continue;
        }

        result.push(ch);
        i += 1;
    }

    result
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<JobEntry>> {
    // Sweep expired terminal jobs before building the response. This bounds
    // the map size without requiring a background task.
    state.evict_expired_jobs().await;

    let map = state.job_status.lock().await;
    let jobs = map
        .iter()
        .map(|(id, status)| JobEntry {
            id: *id,
            status: scrub_job_status(status),
        })
        .collect();
    Json(jobs)
}

// ---------------------------------------------------------------------------
// GET /api/v1/jobs/summary
// ---------------------------------------------------------------------------

/// Status-bucket tally of `AppState.job_status`. Cheap counterpart to
/// `/api/v1/jobs` for the Footer ticker, which only needs counts and
/// not per-job uuid + outcome detail. Evicts expired terminal jobs
/// before counting so the ticker matches the `/api/v1/jobs` list view
/// exactly (no off-by-one between the two ways of asking the same
/// question).
pub async fn get_jobs_summary_v1(
    State(state): State<Arc<AppState>>,
) -> Json<JobsSummary> {
    state.evict_expired_jobs().await;

    let map = state.job_status.lock().await;
    let mut summary = JobsSummary {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
    };
    for status in map.values() {
        match status {
            crate::jobs::JobStatus::Pending => {
                summary.pending = summary.pending.saturating_add(1);
            }
            crate::jobs::JobStatus::Running => {
                summary.running = summary.running.saturating_add(1);
            }
            crate::jobs::JobStatus::Completed(_) => {
                summary.completed = summary.completed.saturating_add(1);
            }
            crate::jobs::JobStatus::Failed(_) => {
                summary.failed = summary.failed.saturating_add(1);
            }
        }
    }
    Json(summary)
}

// ---------------------------------------------------------------------------
// GET /api/v1/loc/cache_status
// ---------------------------------------------------------------------------

/// Freshness summary for the LoC reconciliation cache. Consumed by the
/// desktop Footer "loc cache" line.
///
/// Returns `{ present: false, entries: 0, lastRefreshedAtMs: null }`
/// until the LoC cache layer lands; tracked TECH_DEBT §5.X. The
/// contract is upgrade-transparent: when a real cache arrives, this
/// handler swaps to live data without changing wire shape.
pub async fn get_loc_cache_status_v1(
    State(_state): State<Arc<AppState>>,
) -> Json<LocCacheStatus> {
    Json(LocCacheStatus {
        present: false,
        entries: 0,
        last_refreshed_at_ms: None,
    })
}

// ---------------------------------------------------------------------------
// POST /api/v1/library/backup  — Sprint 9.1
// GET  /api/v1/library/backup/last
// ---------------------------------------------------------------------------

/// Resolve a default backup destination directory when the caller did
/// not supply one. Prefers `<library-parent>/backups/` so backups live
/// next to the library by convention; falls back to the OS temp dir.
fn default_backup_dest(metadata_db_src: Option<&std::path::Path>) -> std::path::PathBuf {
    if let Some(src) = metadata_db_src {
        if let Some(parent) = src.parent() {
            return parent.join("backups");
        }
    }
    std::env::temp_dir().join("spine-backups")
}

/// Start an asynchronous library backup. Per the Sprint 9.1 design
/// + wire-shape consensus from internal design notes.
///
/// Always returns 202 Accepted; the actual `VACUUM INTO` runs in a
/// `Job::Backup` on the blocking pool and records its result via
/// `crate::backup::record_backup`. Poll `GET /api/v1/jobs/:id` for
/// terminal status, or read `GET /api/v1/library/backup/last` for the
/// most recent successful run.
pub async fn start_library_backup_v1(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LibraryBackupRequest>,
) -> Result<(StatusCode, Json<LibraryBackupStartResponse>), (StatusCode, String)> {
    // Resolve source DB paths via the additive accessors landed
    // alongside this commit. In-memory DBs (typical in tests) return
    // None and are skipped by `crate::backup::run_backup`.
    // CalibreLibrary already stores the path as a raw `&str` (returns
    // `:memory:` for in-memory). Filter it inline so we don't have to
    // change calibre-db's existing accessor signature (Codex-zone lane).
    let metadata_db_src: Option<std::path::PathBuf> = {
        let library = state.library.lock().await;
        let raw = library.metadata_db_path();
        if raw == ":memory:" || raw.starts_with("file::memory:") || raw.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(raw))
        }
    };
    let spine_db_src: Option<std::path::PathBuf> = {
        let store = state.store.lock().await;
        store.database_path().map(std::path::PathBuf::from)
    };

    // Resolve destination — caller override or sensible default.
    let dest_dir = match req
        .dest_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(p) => std::path::PathBuf::from(p),
        None => default_backup_dest(metadata_db_src.as_deref()),
    };

    // Dispatch the backup job. Job::Backup runs in spawn_blocking so
    // VACUUM INTO doesn't tie up the async runtime.
    let job = crate::jobs::Job::Backup {
        dest_dir: dest_dir.clone(),
        metadata_db_src,
        spine_db_src,
    };
    let job_id = state
        .job_queue
        .dispatch(job, state.clone())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("dispatch: {e}")))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(LibraryBackupStartResponse {
            job_id: job_id.0.to_string(),
            dest_path: dest_dir.to_string_lossy().into_owned(),
        }),
    ))
}

/// Return the most recent successful backup as `Option<…>` — the
/// serialized JSON is either `null` or an object with the four
/// `LibraryBackupLastResponse` fields. Reads the process-singleton
/// recorded by `crate::backup::record_backup`; surviving across server
/// restart is a Sprint 9 polish item.
pub async fn get_library_backup_last_v1(
    State(_state): State<Arc<AppState>>,
) -> Json<Option<LibraryBackupLastResponse>> {
    Json(
        crate::backup::last_backup().map(|info| LibraryBackupLastResponse {
            at_ms: info.at_ms,
            dest_path: info.dest_path,
            size_bytes: info.size_bytes,
            job_id: info.job_id,
        }),
    )
}

// ---------------------------------------------------------------------------
// GET /api/v1/loc/lcsh/suggest?q=<term>
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LcshSuggestQuery {
    pub q: String,
}

/// Maximum number of LCSH matches returned in a single autocomplete tick.
/// Capped at 10 so the dropdown stays scannable; id.loc.gov's suggest2 will
/// happily return more.
const LCSH_SUGGEST_LIMIT: usize = 10;

/// Maximum length of the `q` parameter. Mirrors `MAX_QUERY_LEN` on the
/// book search to keep the URL surface bounded; suggest2 is left-anchored
/// so longer terms are unusual.
const LCSH_SUGGEST_MAX_LEN: usize = 256;

/// Synchronous-reconcile timeout for the autocomplete endpoint. Matches
/// the spine-bf write-path 8 s budget per ADR 005 so the worst-case latency
/// the client sees never exceeds the worst-case write-path latency.
const LCSH_SUGGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// LCSH autocomplete read-only endpoint per Sprint 8 step 4.
///
/// Returns up to 10 LCSH matches for `q`, ordered as id.loc.gov returned
/// them (`sortmethod=alpha`, `searchtype=left-anchored`). Reuses
/// `LocClient::search_lcsh_subject` from Sprint 8 step 1.
///
/// This is a read-only auxiliary; per ADR 014 Path A consensus it does
/// **not** change the write-path body shape (which remains
/// `{ term, source }`). The frontend uses the result list to populate
/// an autocomplete dropdown; the canonical label the user picks is what
/// gets posted back as `term`.
///
/// Empty / whitespace `q` returns an empty match list without contacting
/// id.loc.gov so noisy autocomplete fires-on-every-keystroke don't cost
/// network round-trips.
pub async fn lcsh_suggest_v1(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LcshSuggestQuery>,
) -> Result<Json<LcshSuggestResponse>, (StatusCode, String)> {
    let trimmed = params.q.trim();
    if trimmed.is_empty() {
        return Ok(Json(LcshSuggestResponse {
            matches: Vec::new(),
        }));
    }
    if trimmed.len() > LCSH_SUGGEST_MAX_LEN {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("q must be {LCSH_SUGGEST_MAX_LEN} chars or fewer"),
        ));
    }

    let loc_client = state
        .get_or_init_loc_client()
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "LoC client unavailable".to_string(),
        ))?
        .clone();
    let term_owned = trimmed.to_string();

    let result = tokio::time::timeout(
        LCSH_SUGGEST_TIMEOUT,
        loc_client.search_lcsh_subject(&term_owned),
    )
    .await;

    match result {
        Ok(Ok(mut hits)) => {
            hits.truncate(LCSH_SUGGEST_LIMIT);
            let matches = hits
                .into_iter()
                .map(|h| LcshSuggestMatch {
                    uri: h.uri,
                    label: h.label,
                })
                .collect();
            Ok(Json(LcshSuggestResponse { matches }))
        }
        Ok(Err(e)) => Err((
            StatusCode::BAD_GATEWAY,
            format!("LCSH suggest backend error: {e}"),
        )),
        Err(_) => Err((
            StatusCode::GATEWAY_TIMEOUT,
            format!(
                "LCSH suggest timed out after {}s",
                LCSH_SUGGEST_TIMEOUT.as_secs()
            ),
        )),
    }
}

// ---------------------------------------------------------------------------
// POST /api/v1/library/recent
// ---------------------------------------------------------------------------

/// Idempotent push of a library path into the recent-libraries
/// snapshot. The Tauri shell calls this on every library switch (in
/// a follow-up commit) so that the HTTP contract has a server-side
/// authoritative read path; the durable store of recent libraries
/// remains Tauri's `DesktopConfig` until full migration (option C).
pub async fn add_recent_library_v1(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddRecentLibraryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "path must not be empty".to_string(),
        ));
    }
    state.push_recent_library(body.path).await;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// GET /api/v1/library/list
// ---------------------------------------------------------------------------

/// Combined snapshot of the recent-libraries list + currently-open
/// library path, for the desktop TitleBar library-switcher dropdown.
/// Returns the in-memory snapshot only; until the Tauri shell starts
/// pushing on every library switch (follow-up commit), this responds
/// with empty defaults on every fresh server boot.
pub async fn list_libraries_v1(
    State(state): State<Arc<AppState>>,
) -> Json<LibraryList> {
    let snapshot = state.recent_libraries.lock().await;
    Json(LibraryList {
        recent: snapshot.recent.clone(),
        current: snapshot.current.clone(),
    })
}

// ---------------------------------------------------------------------------
// GET /api/v1/storage
// ---------------------------------------------------------------------------

/// TTL-keyed cache entry for /api/v1/storage. Computing `covers_bytes`
/// walks `<library>/<author>/<title>/cover.jpg` — tens of thousands of
/// stat() calls on a multi-thousand-book library — and the desktop
/// Footer polls /storage on every library mount and on cadence
/// afterward. Caching cuts the steady-state cost to a mutex lock plus
/// a single-entry compare. Stale-on-edit: ingest and delete don't
/// invalidate this; user sees up to STORAGE_CACHE_TTL of staleness.
/// Acceptable for storage telemetry; never used for data-of-record.
///
/// Keyed by `library_path` so a library switch invalidates by path
/// mismatch (the next request after switch is a cache miss that
/// recomputes for the new library). Bounded to one entry — older paths
/// are simply overwritten on the next miss. Memory: ~100 bytes
/// resident regardless of how many libraries the user has cycled
/// through.
struct StorageCacheEntry {
    library_path: String,
    fetched_at: std::time::Instant,
    info: StorageInfo,
}

static STORAGE_CACHE: std::sync::OnceLock<tokio::sync::Mutex<Option<StorageCacheEntry>>> =
    std::sync::OnceLock::new();

const STORAGE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Returns disk-space + content-count summary for the currently open
/// library. Consumed by the desktop Footer storage block. Returns 503
/// when no library is open (e.g. embedded test mode that started
/// without `db_paths`). Memoized for `STORAGE_CACHE_TTL` per
/// `library_path`; see `STORAGE_CACHE` rationale.
pub async fn get_storage_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StorageInfo>, (StatusCode, String)> {
    let library_dir = {
        let lib = state.library.lock().await;
        lib.library_path().to_string()
    };

    let cache = STORAGE_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));

    // Cache hit?
    {
        let guard = cache.lock().await;
        if let Some(entry) = guard.as_ref() {
            if entry.library_path == library_dir
                && entry.fetched_at.elapsed() < STORAGE_CACHE_TTL
            {
                return Ok(Json(entry.info.clone()));
            }
        }
    }

    // Cache miss: compute fresh.
    let (spine_db_path, metadata_db_path) = {
        let paths = state.db_paths.as_ref().ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "no library open".to_string(),
        ))?;
        (paths.spine_db.clone(), paths.calibre_db.clone())
    };

    let spine_db_bytes = std::fs::metadata(&spine_db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let metadata_db_bytes = std::fs::metadata(&metadata_db_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Cover walk runs on the blocking pool — a multi-thousand-book library
    // means tens of thousands of `stat` calls, well above the on-thread
    // budget of the async runtime. Held outside any AppState mutex so
    // concurrent `/storage` requests don't serialize on `library`.
    let library_dir_for_walk = library_dir.clone();
    let covers_bytes =
        tokio::task::spawn_blocking(move || sum_cover_bytes(&library_dir_for_walk))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (book_count, last_import_at_ms) = {
        let lib = state.library.lock().await;
        let count = lib
            .count_books()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let last = lib
            .last_import_at_ms()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        (count, last)
    };

    let info = StorageInfo {
        spine_db_bytes,
        metadata_db_bytes,
        covers_bytes,
        book_count: u32::try_from(book_count).unwrap_or(u32::MAX),
        last_import_at_ms,
    };

    // Store cache entry. Race: two concurrent requests on the same
    // path may both compute and both write — last write wins, both
    // returns are correct values, no contention worth gating with a
    // single-flight guard at this access frequency.
    {
        let mut guard = cache.lock().await;
        *guard = Some(StorageCacheEntry {
            library_path: library_dir,
            fetched_at: std::time::Instant::now(),
            info: info.clone(),
        });
    }

    Ok(Json(info))
}

/// Recursive sum of `cover.jpg` sizes inside a calibre library directory.
/// Calibre stores covers at `<library>/<author>/<title>/cover.jpg`; this
/// walk targets that one filename only so the result is "cover storage"
/// and not "everything-in-the-library storage" (EPUB blobs would
/// dominate the latter and lie about what the user pays in metadata
/// overhead).
fn sum_cover_bytes(library_dir: &str) -> u64 {
    fn walk(path: &std::path::Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                walk(&entry.path(), total);
            } else if ft.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.eq_ignore_ascii_case("cover.jpg") {
                        if let Ok(meta) = entry.metadata() {
                            *total = total.saturating_add(meta.len());
                        }
                    }
                }
            }
        }
    }
    let mut total = 0u64;
    walk(std::path::Path::new(library_dir), &mut total);
    total
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/book/:id
// ---------------------------------------------------------------------------

pub async fn delete_book_v1(
    Path(id): Path<String>,
    Query(params): Query<DeleteBookQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<DeletedBook>, (StatusCode, String)> {
    // Validate that the path segment is a UUID.
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("'{id}' is not a valid UUID"),
        ));
    }

    let delete_files = params.delete_files.unwrap_or(false);

    // Confirm the book exists before opening a session — cheaper than letting
    // the session's inner query fail with a NoRows error.
    {
        let lib = state.library.lock().await;
        let exists = lib
            .get_book_by_uuid(&id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .is_some();
        if !exists {
            return Err((StatusCode::NOT_FOUND, format!("book '{id}' not found")));
        }
    }

    // Writes go through LibrarySession for cross-DB atomicity.
    let mut session = state
        .library_session()
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;

    tokio::task::spawn_blocking(move || session.delete_book_with_graph(&id, delete_files))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Parse a `<field>:<value>` query prefix per Sprint 12 §S12 step 6.
/// Returns `Some((field, value))` for the four known fields
/// (`author`, `tag`, `series`, `publisher`); falls through to `None`
/// for substring-fallback when:
/// - the prefix isn't a known field,
/// - no `:` is present,
/// - the prefix is non-ASCII or otherwise unparseable.
///
/// Quoted values (`tag:"Sci-Fi"`) are unwrapped. Trailing tokens after
/// the first prefix value are currently ignored — `author:Shelley
/// horror` filters on author=Shelley only. AND-combination with a
/// substring tail is a known follow-up tracked under TECH_DEBT (deferred
/// to Sprint 14+ search-grammar pass).
///
/// The function never panics and never errors — unparseable input is
/// always callable as `None`, preserving the "never 4xx on bad q"
/// contract.
fn parse_field_prefix(q: &str) -> Option<(&'static str, &str)> {
    let trimmed = q.trim();
    let (field_raw, rest) = trimmed.split_once(':')?;
    let field: &'static str = match field_raw {
        "author" => "author",
        "tag" => "tag",
        "series" => "series",
        "publisher" => "publisher",
        _ => return None,
    };
    let rest = rest.trim();
    let value = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split_once('"').map(|(v, _)| v).unwrap_or(stripped)
    } else {
        rest.split_whitespace().next().unwrap_or("")
    };
    if value.is_empty() {
        None
    } else {
        Some((field, value))
    }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/book/:id/metadata — Sprint 12 D4 Library Manage MVP
// ---------------------------------------------------------------------------

/// `PUT /api/v1/book/:id/metadata` — 8-field edit-metadata round-trip.
///
/// Body matches `SetFieldsRequest` (D4_WRITE scope). Each field
/// is `Option<T>` for partial PATCH semantics — `None` means leave
/// alone. The handler performs both legs of the cross-DB write:
///
/// - `spine_bf::set_fields` rewrites the BIBFRAME triples in
///   `urn:spine:graph:book:<uuid>`, replacing only the field-level
///   triples for the supplied fields. Adds `spine:assertedBy` +
///   `spine:assertedAt` provenance per Sprint 12 contract.
/// - `CalibreLibrary::update_book` updates the relational tables on
///   `metadata.db` (books, books_authors_link, tags, series,
///   publishers, languages link), runs the ported
///   `author_to_author_sort` for `books.author_sort` /
///   `authors.sort`, and bumps `books.last_modified`.
///
/// The two writes run sequentially under separate locks; cross-DB
/// atomicity for D4 MVP is `apply_metadata_update`'s job — partial-
/// write-on-crash is an acknowledged D4 risk tracked under TECH_DEBT
/// §1.1 follow-on. 404 on missing book; 400 on malformed body /
/// invalid path UUID; 204 on success.
pub async fn put_book_metadata_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetFieldsRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let book_uuid = uuid::Uuid::parse_str(&id)
        .map_err(|_| (StatusCode::BAD_REQUEST, format!("'{id}' is not a valid UUID")))?;

    {
        let lib = state.library.lock().await;
        let exists = lib
            .get_book_by_uuid(&id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .is_some();
        if !exists {
            return Err((StatusCode::NOT_FOUND, format!("book '{id}' not found")));
        }
    }

    let ctx = ProvenanceContext::default();
    {
        let store = state.store.lock().await;
        bf_write::set_fields(&store, &book_uuid, &body, &ctx).map_err(|e| match e {
            SpineWriteError::WorkNotFound { .. } => {
                (StatusCode::NOT_FOUND, format!("work '{id}' not found in spine.db"))
            }
            other => (StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;
    }

    let projection = set_fields_to_book_update(&body);
    if !projection.is_empty() {
        let lib = state.library.lock().await;
        lib.update_book(&id, &projection)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Convert the BIBFRAME-shaped `SetFieldsRequest` into the
/// calibre-table-shaped `BookUpdate` so `update_book` can replay the
/// same edit on `metadata.db`. The shape mismatch is intentional:
/// `SetFieldsRequest` is the wire shape that round-trips through
/// `spine_bf` cleanly; `BookUpdate` is the relational shape calibre
/// needs.
fn set_fields_to_book_update(req: &SetFieldsRequest) -> BookUpdate {
    BookUpdate {
        title: req.title.clone(),
        authors: req.authors.clone(),
        tags: req.tags.clone(),
        series: req.series.clone().map(|s| if s.is_empty() { None } else { Some(s) }),
        series_index: req.series_index,
        pubdate: req.pubdate.as_ref().map(|s| {
            if s.is_empty() {
                None
            } else {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|dt| dt.with_timezone(&Utc))
            }
        }),
        publisher: req
            .publisher
            .clone()
            .map(|s| if s.is_empty() { None } else { Some(s) }),
        languages: req.language.as_ref().map(|s| {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![s.clone()]
            }
        }),
    }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/book/:id/metadata/fields
// ---------------------------------------------------------------------------

/// Body size limit for the metadata fields endpoint: 1 MiB.
const METADATA_FIELDS_MAX_BYTES: usize = 1024 * 1024;

/// Validate that `work_uri` correctly references the book identified by `book_id`.
///
/// Accepted schemes:
/// - `urn:spine:work:<uuid>` — the suffix after the last `:` must equal `book_id`.
/// - `urn:*` — any urn: scheme; the suffix after the last `:` must equal `book_id`.
/// - `http(s)://...` — the LoC record ID differs from the local UUID by design.
///   The caller MUST supply `book_uuid` equal to `book_id`; if absent or mismatched
///   the request is rejected 400.
///
/// Fragments (`#...`) and query strings (`?...`) are always rejected — they are
/// not part of canonical work identity and historically were appended by the
/// frontend to smuggle the book UUID past a substring check.
fn validate_work_uri(
    work_uri: &str,
    book_id: &str,
    book_uuid: Option<&str>,
) -> Result<(), String> {
    if work_uri.is_empty() {
        // An empty URI is allowed — the graph may not have been reconciled yet.
        return Ok(());
    }

    // Fragments and query strings are never valid in a canonical work URI.
    if work_uri.contains('#') {
        return Err(format!(
            "graph.work_uri '{work_uri}' contains a fragment '#'; fragments are not \
             part of canonical work identity"
        ));
    }
    if work_uri.contains('?') {
        return Err(format!(
            "graph.work_uri '{work_uri}' contains a query string '?'; query strings are \
             not part of canonical work identity"
        ));
    }

    // For urn: URIs the final colon-delimited component must be the book UUID.
    if work_uri.starts_with("urn:") {
        let suffix = work_uri.rsplit(':').next().unwrap_or("");
        if suffix != book_id {
            return Err(format!(
                "graph.work_uri '{work_uri}' has UUID suffix '{suffix}' but path :id is \
                 '{book_id}'; they must match for urn: scheme URIs"
            ));
        }
        return Ok(());
    }

    // For HTTP/HTTPS URIs (e.g. LoC) the LoC record ID differs from the local
    // book UUID by design. The caller must supply `book_uuid` equal to the path
    // `:id` to bind the LoC record to the local book.
    if work_uri.starts_with("http://") || work_uri.starts_with("https://") {
        match book_uuid {
            None => {
                return Err(format!(
                    "graph.work_uri '{work_uri}' is an HTTP(S) URI but book_uuid is absent; \
                     callers must supply book_uuid equal to the path :id when work_uri is \
                     an HTTP(S) URI (e.g., a Library of Congress record)"
                ));
            }
            Some(uuid) if uuid != book_id => {
                return Err(format!(
                    "book_uuid '{uuid}' does not match path :id '{book_id}'; \
                     book_uuid must equal the path :id"
                ));
            }
            Some(_) => return Ok(()),
        }
    }

    // Unknown scheme — reject.
    Err(format!(
        "graph.work_uri '{work_uri}' uses an unrecognised scheme; expected \
         urn:spine:work:<uuid> or https://id.loc.gov/..."
    ))
}

pub async fn update_metadata_fields_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Result<StatusCode, (StatusCode, String)> {
    // Validate path UUID first (cheap).
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("'{id}' is not a valid UUID"),
        ));
    }

    // Read body with a hard cap before deserialization.
    let body_bytes = axum::body::to_bytes(request.into_body(), METADATA_FIELDS_MAX_BYTES + 1)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if body_bytes.len() > METADATA_FIELDS_MAX_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "request body exceeds {} bytes",
                METADATA_FIELDS_MAX_BYTES
            ),
        ));
    }

    let payload: UpdateMetadataFieldsRequest =
        serde_json::from_slice(&body_bytes).map_err(|e| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("invalid JSON body: {e}"),
            )
        })?;

    // Validate that the graph's work_uri references the same book as the path
    // :id. Two URI schemes are accepted:
    //
    // 1. urn:spine:work:<uuid>  — The UUID suffix (after the last `:`) must
    //    equal the path :id exactly.
    //
    // 2. http(s)://id.loc.gov/resources/works/<id>  — The ID component (after
    //    the last `/`, before any `?` or `#`) can differ from the path UUID;
    //    in this case the caller MUST supply a `book_uuid` field in the request
    //    body that matches the path :id. (This field is not yet in the struct
    //    but is validated via the explicit book_uuid match when present.)
    //
    // Fragments (`#...`) and query strings (`?...`) are not part of canonical
    // work identity and are rejected outright to prevent the historical bug
    // where the frontend appended `#{bookId}` to force a substring match.
    validate_work_uri(
        &payload.graph.work_uri,
        &id,
        payload.book_uuid.as_deref(),
    )
    .map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;

    let mut session = state
        .library_session()
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;

    let id_clone = id.clone();
    tokio::task::spawn_blocking(move || {
        session.apply_metadata_update(&id_clone, &payload.graph, &payload.projection)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map(|_| StatusCode::NO_CONTENT)
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/export
// ---------------------------------------------------------------------------

/// Placeholder OPF projection using calibre fields.
///
/// TODO(TECH_DEBT §3.8): Replace with a proper BIBFRAME → Dublin Core
/// projection via `spine-dc` once that crate is implemented. The current
/// output is a minimal OPF 2.0 file derived entirely from calibre surface
/// fields. It is sufficient for round-tripping format files but omits the
/// full BIBFRAME richness (subjects, authority URIs, etc.).
fn build_minimal_opf(book: &Book) -> String {
    let title = xml_escape(&book.title);
    let authors: String = book
        .authors
        .iter()
        .map(|a| format!("    <dc:creator>{}</dc:creator>\n", xml_escape(a)))
        .collect();
    let language = book
        .legacy_metadata
        .pub_date
        .as_deref()
        .map(|_| "") // unused; fall through to default
        .unwrap_or("");
    let _ = language; // reserved for future use
    let lang = "en";
    let pubdate = book
        .legacy_metadata
        .pub_date
        .as_deref()
        .unwrap_or("0101-01-01");
    let identifier = format!("urn:uuid:{}", book.id);

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         unique-identifier="BookId" version="2.0">
  <metadata>
    <dc:identifier id="BookId">{identifier}</dc:identifier>
    <dc:title>{title}</dc:title>
{authors}    <dc:language>{lang}</dc:language>
    <dc:date>{pubdate}</dc:date>
  </metadata>
  <manifest/>
  <spine/>
</package>
"#
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub async fn export_book_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Response, (StatusCode, String)> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("'{id}' is not a valid UUID"),
        ));
    }

    // Resolve the book and its format files while holding the library lock.
    let (book, format_paths) = {
        let lib = state.library.lock().await;
        let book = lib
            .get_book_by_uuid(&id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .ok_or_else(|| (StatusCode::NOT_FOUND, format!("book '{id}' not found")))?;
        let paths = lib
            .list_format_paths(&id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        (book, paths)
    };

    if format_paths.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("book '{id}' has no on-disk format files"),
        ));
    }

    // Build the zip in a blocking task — zip I/O is synchronous.
    let zip_bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        // Write the OPF first so readers find it at a predictable position.
        let opf = build_minimal_opf(&book);
        zip.start_file("metadata.opf", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

        for abs_path in &format_paths {
            let path = std::path::Path::new(abs_path);
            let raw_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string());
            let file_name = sanitize_zip_entry_name(&raw_name);
            let content =
                std::fs::read(path).map_err(|e| format!("read {abs_path}: {e}"))?;
            zip.start_file(&file_name, options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&content).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        Ok(buf.into_inner())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{id}.zip\""),
        )
        .body(Body::from(zip_bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(response)
}

pub async fn list_reading_progress_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ReadingProgress>>, StatusCode> {
    // Release the store lock before the mapping step. UUID parse and timestamp
    // construction (to_api_reading_progress) happen while the lock is held in
    // the naive version, blocking concurrent progress writes for the duration
    // of the map loop — disproportionate for a library of any size.
    let rows = {
        let store = state.store.lock().await;
        store
            .list_reading_progress()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    }; // lock released here
    let progress: Vec<_> = rows.into_iter().map(to_api_reading_progress).collect();
    Ok(Json(progress))
}

pub async fn get_book_progress_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<ReadingProgress>>, StatusCode> {
    let store = state.store.lock().await;
    let progress = store
        .get_reading_progress(&id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(to_api_reading_progress);
    Ok(Json(progress))
}

/// Maximum byte length of a CFI locator string. A real CFI is typically
/// a few hundred bytes; 4 KB is generous while still blocking a client that
/// tries to store multi-megabyte payloads in the progress table.
const MAX_LOCATOR_BYTES: usize = 4 * 1024;

pub async fn save_book_progress_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveReadingProgressRequest>,
) -> Result<Json<ReadingProgress>, (StatusCode, String)> {
    if payload.locator.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Locator is required".to_string()));
    }
    if payload.locator.len() > MAX_LOCATOR_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("locator exceeds {} bytes", MAX_LOCATOR_BYTES),
        ));
    }

    let store = state.store.lock().await;
    store
        .upsert_reading_progress(
            &id,
            &payload.locator,
            payload.progress_fraction,
            payload.chapter_label.as_deref(),
        )
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to save progress: {}", e),
            )
        })?;

    let saved = store
        .get_reading_progress(&id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to reload progress: {}", e),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Saved progress could not be reloaded".to_string(),
            )
        })?;

    Ok(Json(to_api_reading_progress(saved)))
}

use axum::extract::Multipart;
use tokio::fs::File as TokioFile;
use tokio::io::AsyncWriteExt;

/// Maximum bytes allowed for an uploaded EPUB. EPUBs above this size are
/// almost always either malformed archives or adversarial uploads. The
/// RequestBodyLimitLayer on the router is a coarser outer guard; this per-field
/// check fires earlier and provides a more specific error message.
const MAX_EPUB_BYTES: usize = 256 * 1024 * 1024;

pub async fn ingest_epub_v1(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<String>, (StatusCode, String)> {
    let mut temp_path = std::env::temp_dir();
    temp_path.push(format!("{}.epub", uuid::Uuid::new_v4()));

    let mut file = TokioFile::create(&temp_path).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create temp file: {}", e),
        )
    })?;

    let mut found_file = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
    {
        if field.name() == Some("file") {
            found_file = true;
            // Stream chunks to disk rather than buffering the full upload in
            // memory. A 256 MB EPUB would previously cause a 256 MB heap
            // allocation before a single byte hit the filesystem.
            let mut total: usize = 0;
            // Rebind so we can call chunk() on it.
            let mut field = field;
            loop {
                match field.chunk().await {
                    Ok(Some(chunk)) => {
                        total += chunk.len();
                        if total > MAX_EPUB_BYTES {
                            // Remove the partial temp file before returning.
                            tokio::fs::remove_file(&temp_path).await.ok();
                            return Err((
                                StatusCode::PAYLOAD_TOO_LARGE,
                                "EPUB exceeds 256 MB".to_string(),
                            ));
                        }
                        file.write_all(&chunk).await.map_err(|e| {
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!("Failed to write to temp file: {}", e),
                            )
                        })?;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            format!("Failed to read field: {}", e),
                        ));
                    }
                }
            }
            file.flush().await.map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to flush temp file: {}", e),
                )
            })?;
            break;
        }
    }

    if !found_file {
        return Err((
            StatusCode::BAD_REQUEST,
            "No 'file' field found in multipart form".to_string(),
        ));
    }

    let id = state
        .job_queue
        .dispatch(
            crate::jobs::Job::IngestEpub {
                path: temp_path,
                cleanup: true,
            },
            state.clone(),
        )
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Ingestion dispatch failed: {}", e),
            )
        })?;

    Ok(Json(id.0.to_string()))
}

pub async fn get_job_status(
    Path(id): Path<uuid::Uuid>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::jobs::JobStatus>, StatusCode> {
    // Sweep expired terminal jobs before the lookup so a very-recently-expired
    // job returns 404 (consistent with "we no longer know about it") rather
    // than stale data.
    state.evict_expired_jobs().await;

    let status_map = state.job_status.lock().await;
    match status_map.get(&id) {
        Some(status) => Ok(Json(scrub_job_status(status))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// Sanitise a filename for use as a zip entry name. Prevents path traversal,
/// Windows-reserved device names, null bytes, and bare `.`/`..` entries.
///
/// Specifically:
/// - Strips directory separators (`/` and `\`) — the entry lives at the root
///   of the zip, never in a sub-directory.
/// - Rejects `..` and `.` components (returns `"_"` as a safe fallback).
/// - Strips null bytes.
/// - Replaces Windows-reserved device names (CON, PRN, AUX, NUL, COM1-9,
///   LPT1-9) with `"_"` to prevent devices being opened on extraction.
/// - Falls back to `"unknown"` for an empty result.
pub(crate) fn sanitize_zip_entry_name(name: &str) -> String {
    // Strip null bytes first.
    let without_nulls: String = name.chars().filter(|&c| c != '\0').collect();

    // Strip all directory separator characters so the entry is always at the
    // root of the zip.
    let base: String = without_nulls
        .chars()
        .filter(|&c| c != '/' && c != '\\')
        .collect();

    // After stripping separators, reject traversal components.
    if base == ".." || base == "." {
        return "_".to_string();
    }

    // Windows-reserved device names (case-insensitive). Check the stem (part
    // before the first `.`) so `CON.txt` is also caught.
    let stem = base.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    if reserved {
        // Prepend underscore to defuse the reserved name.
        return format!("_{base}");
    }

    if base.is_empty() {
        return "unknown".to_string();
    }

    base
}

fn to_api_reading_progress(progress: spine_db::StoredReadingProgress) -> ReadingProgress {
    // Emit millisecond resolution to clients. Storage has been ms-precise
    // since the round-1 migration; this is the HTTP projection catching up
    // so a client can distinguish two saves made in the same second.
    let updated_at =
        DateTime::from_timestamp_millis(progress.updated_at_ms).unwrap_or_else(Utc::now);

    ReadingProgress {
        book_id: uuid::Uuid::parse_str(&progress.book_id).unwrap_or(uuid::Uuid::nil()),
        locator: progress.locator,
        progress_fraction: progress.progress_fraction,
        chapter_label: progress.chapter_label,
        updated_at,
    }
}

// ---------------------------------------------------------------------------
// ADR 014 Phase C — write API HTTP handlers (POST/DELETE /book/:id/subject,
// POST /book/:id/instance, PATCH /book/:id/instance/:instance_uuid/primary).
// ---------------------------------------------------------------------------

/// Map a `SpineWriteError` from spine-bf into an HTTP (status, body) tuple.
/// Centralized so the four handlers below stay terse — the mapping itself
/// is the contract surface (which errors → which HTTP code is what
/// frontends program against).
fn write_error_to_response(err: SpineWriteError) -> (StatusCode, String) {
    match err {
        SpineWriteError::WorkNotFound { .. } => (StatusCode::NOT_FOUND, err.to_string()),
        SpineWriteError::InstanceNotFound { .. } => (StatusCode::NOT_FOUND, err.to_string()),
        SpineWriteError::SubjectNotPresent { .. } => (StatusCode::NOT_FOUND, err.to_string()),
        SpineWriteError::InvalidInput(_) => (StatusCode::BAD_REQUEST, err.to_string()),
        SpineWriteError::AssertedRejectInferred => (StatusCode::BAD_REQUEST, err.to_string()),
        SpineWriteError::ShapeViolation { .. } => (StatusCode::UNPROCESSABLE_ENTITY, err.to_string()),
        SpineWriteError::ReconcileFailed(_) => (StatusCode::BAD_GATEWAY, err.to_string()),
        SpineWriteError::Store(_) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Parse a calibre book-uuid out of the path segment, returning a 400 if
/// malformed. The convention across spine-bf is that the calibre book-uuid
/// IS the work-uuid for graph addressing (`urn:spine:graph:book:<uuid>`).
fn parse_book_uuid(id: &str) -> Result<uuid::Uuid, (StatusCode, String)> {
    uuid::Uuid::parse_str(id).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            format!("'{id}' is not a valid book uuid"),
        )
    })
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/subject
// ---------------------------------------------------------------------------

/// Add a subject to a Work. ADR 014 §1+§5.
///
/// Body: `{ term: String, source: "lcsh" | "local-tag" }`. Inferred
/// source is rejected with 400 (inferred-graph mutations are
/// TECH_DEBT §1.2 and out of scope for this endpoint).
///
/// Reconcile: when source = "lcsh", the synchronous LoC reconciler
/// runs against id.loc.gov LCSH up to the 8-second timeout per ADR 005.
/// On match, response carries the LoC URI with `partial: false`. On
/// timeout/miss, URI is locally minted with `partial: true` and the
/// graph carries `spine:reconcileTimeoutAt` for background re-reconcile.
///
/// Body returned on 201: `{ subject_uri, partial }`. Frontend stores
/// `subject_uri` for subsequent DELETE.
pub async fn add_subject_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddSubjectRequest>,
) -> Result<(StatusCode, Json<WriteSubjectResponse>), (StatusCode, String)> {
    let work_uuid = parse_book_uuid(&id)?;

    let source = match body.source.as_str() {
        "lcsh" => SubjectSource::Lcsh,
        "local-tag" => SubjectSource::LocalTag,
        // "inferred" intentionally absent — must use inferred-graph path.
        other => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "invalid source: '{other}' — expected 'lcsh' or 'local-tag'"
                ),
            ));
        }
    };

    // Resolve the LoC client; 503 if construction failed at startup.
    let loc_client = state.get_or_init_loc_client().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "LoC client unavailable".to_string(),
    ))?;
    // Clone for the blocking thread; LocClient is Clone + cheap.
    let loc_client_owned = loc_client.clone();
    let state_clone = state.clone();
    let term_owned = body.term.clone();
    let work_uuid_owned = work_uuid;

    // spine-bf is sync; LCSH reconcile inside is async-via-block_on.
    // spawn_blocking shifts both off the async runtime's main pool so
    // an 8s LoC stall doesn't starve other handlers.
    let outcome = tokio::task::spawn_blocking(move || -> Result<_, SpineWriteError> {
        let handle = tokio::runtime::Handle::current();
        let store_guard = handle.block_on(state_clone.store.lock());
        let reconciler = BlockingLocReconciler::new(&loc_client_owned);
        let ctx = ProvenanceContext::default();
        bf_write::add_subject(
            &*store_guard,
            &reconciler,
            &work_uuid_owned,
            &term_owned,
            source,
            &ctx,
        )
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(write_error_to_response)?;

    Ok((
        StatusCode::CREATED,
        Json(WriteSubjectResponse {
            subject_uri: outcome.uri,
            partial: outcome.partial,
        }),
    ))
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/book/:id/subject?uri=<uri>
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct DeleteSubjectQuery {
    pub uri: String,
}

/// Remove a subject from a Work. ADR 014 §1+§5.
///
/// Idempotent caller can ignore 404 (subject wasn't present); strict
/// caller surfaces. spine-bf's `remove_subject` cleans both the
/// work→subject edge and the subject's own type/label/provenance
/// triples — subject URIs are graph-scoped per `add_subject`'s
/// minting, so the entity cleanup is safe.
pub async fn remove_subject_v1(
    Path(id): Path<String>,
    Query(params): Query<DeleteSubjectQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let work_uuid = parse_book_uuid(&id)?;
    if params.uri.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "uri query parameter must not be empty".to_string(),
        ));
    }

    let state_clone = state.clone();
    let uri_owned = params.uri.clone();

    tokio::task::spawn_blocking(move || -> Result<(), SpineWriteError> {
        let handle = tokio::runtime::Handle::current();
        let store_guard = handle.block_on(state_clone.store.lock());
        bf_write::remove_subject(&*store_guard, &work_uuid, &uri_owned)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(write_error_to_response)?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// POST /api/v1/book/:id/instance
// ---------------------------------------------------------------------------

/// Add a new Instance (edition) to a Work. ADR 014 §1+§2+§5.
///
/// Body: `AddInstanceRequest`. Required: `format`. Optional: ISBN,
/// title, publisher, publicationDate, reconcileAgainstLoc.
///
/// Reconcile: when `reconcileAgainstLoc` is unset or true, runs
/// `BlockingLocReconciler` against id.loc.gov SRU by ISBN first,
/// title+author fallback. 8s timeout per ADR 005. Match → LoC URI
/// + partial=false. Miss/timeout → mint `urn:spine:instance:<uuid>`
/// + partial=true + `spine:reconcileTimeoutAt` for background re-reconcile.
///
/// Returns 201 with `{ instance_uri, partial }`.
pub async fn add_instance_v1(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddInstanceRequest>,
) -> Result<(StatusCode, Json<WriteInstanceResponse>), (StatusCode, String)> {
    let work_uuid = parse_book_uuid(&id)?;

    if body.format.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "format must not be empty".to_string(),
        ));
    }

    let candidate = InstanceCandidate {
        format: body.format,
        publication_date: body.publication_date,
        publisher: body.publisher,
        isbn: body.isbn,
        title: body.title,
        reconcile_against_loc: body.reconcile_against_loc.unwrap_or(true),
    };

    let loc_client = state.get_or_init_loc_client().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "LoC client unavailable".to_string(),
    ))?;
    let loc_client_owned = loc_client.clone();
    let state_clone = state.clone();
    let work_uuid_owned = work_uuid;

    let outcome = tokio::task::spawn_blocking(move || -> Result<_, SpineWriteError> {
        let handle = tokio::runtime::Handle::current();
        let store_guard = handle.block_on(state_clone.store.lock());
        let reconciler = BlockingLocReconciler::new(&loc_client_owned);
        let ctx = ProvenanceContext::default();
        bf_write::add_instance(
            &*store_guard,
            &reconciler,
            &work_uuid_owned,
            candidate,
            &ctx,
        )
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(write_error_to_response)?;

    Ok((
        StatusCode::CREATED,
        Json(WriteInstanceResponse {
            instance_uri: outcome.uri,
            partial: outcome.partial,
        }),
    ))
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/book/:id/instance/:instance_uuid/primary
// ---------------------------------------------------------------------------

/// Designate an Instance as the primary edition of its Work. ADR 014 §1+§5.
///
/// Idempotent. The `:instance_uuid` path segment is interpreted as a
/// URI tail — clients send the full instance URI url-encoded. spine-bf's
/// `set_primary_instance` takes the full URI (LoC URIs include `://`
/// which path segments don't tolerate without encoding).
///
/// To keep the path segment URL-safe, this handler accepts the URI
/// via the body or — if the path-segment can be parsed as a UUID —
/// constructs a `urn:spine:instance:<uuid>` URI from it. For LoC-
/// reconciled instances (`http://id.loc.gov/...`), prefer the body
/// path: `{ instance_uri: "..." }`. Path-segment-as-uuid is the
/// ergonomic shortcut for the common locally-minted case.
pub async fn set_primary_instance_v1(
    Path((id, instance_segment)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let work_uuid = parse_book_uuid(&id)?;

    // Interpret the path segment: if it parses as a UUID, treat as a
    // locally-minted urn:spine:instance:<uuid>; otherwise reject (LoC
    // URIs need a body-based variant of this endpoint, deferred to a
    // future ADR amendment if/when use case lands).
    let instance_uri = if let Ok(_uuid) = uuid::Uuid::parse_str(&instance_segment) {
        format!("urn:spine:instance:{instance_segment}")
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "instance segment '{instance_segment}' must be a UUID; \
                 LoC-reconciled instance URIs need a body-based variant \
                 (deferred — see ADR 014)"
            ),
        ));
    };

    let state_clone = state.clone();
    let work_uuid_owned = work_uuid;

    tokio::task::spawn_blocking(move || -> Result<(), SpineWriteError> {
        let handle = tokio::runtime::Handle::current();
        let store_guard = handle.block_on(state_clone.store.lock());
        bf_write::set_primary_instance(&*store_guard, &work_uuid_owned, &instance_uri)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(write_error_to_response)?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use calibre_db::CalibreLibrary;
    use spine_db::SpineStore;
    use std::sync::{atomic::AtomicBool, Arc};
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    fn make_test_loc_cell() -> Arc<std::sync::OnceLock<Option<spine_meta::LocClient>>> {
        let cell = std::sync::OnceLock::new();
        cell.set(Some(
            spine_meta::LocClient::with_base_url("http://localhost:0").unwrap(),
        ))
        .unwrap();
        Arc::new(cell)
    }

    async fn make_state() -> Arc<AppState> {
        Arc::new(AppState {
            library: Mutex::new(CalibreLibrary::open(":memory:").unwrap()),
            store: Mutex::new(SpineStore::open(":memory:").unwrap()),
            db_paths: None,
            loc_client: make_test_loc_cell(),
            job_queue: Arc::new(crate::jobs::LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(AtomicBool::new(false)),
            recent_libraries: Mutex::new(crate::RecentLibrariesState::default()),
        })
    }

    #[tokio::test]
    async fn oversized_locator_returns_413() {
        let state = make_state().await;
        let router = crate::create_router(state);

        // A locator 1 byte over the 4 KB cap must be rejected with 413.
        let oversized_locator = "x".repeat(MAX_LOCATOR_BYTES + 1);
        let book_id = uuid::Uuid::new_v4();
        let body = serde_json::json!({
            "locator": oversized_locator,
            "progress_fraction": 0.5,
        })
        .to_string();

        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/book/{}/progress", book_id))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "a locator exceeding MAX_LOCATOR_BYTES must return 413"
        );
    }

    #[tokio::test]
    async fn valid_locator_does_not_return_413() {
        let state = make_state().await;
        let router = crate::create_router(state);

        // A locator exactly at the cap must not be rejected for size.
        let valid_locator = "x".repeat(MAX_LOCATOR_BYTES);
        let book_id = uuid::Uuid::new_v4();
        let body = serde_json::json!({
            "locator": valid_locator,
            "progress_fraction": 0.5,
        })
        .to_string();

        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/book/{}/progress", book_id))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_ne!(
            resp.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "a locator at exactly MAX_LOCATOR_BYTES must not return 413"
        );
    }

    // -----------------------------------------------------------------------
    // validate_work_uri
    // -----------------------------------------------------------------------

    #[test]
    fn work_uri_exact_match_urn_passes() {
        let id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let uri = format!("urn:spine:work:{id}");
        assert!(
            validate_work_uri(&uri, id, None).is_ok(),
            "urn:spine:work:<uuid> with matching uuid must pass"
        );
    }

    #[test]
    fn work_uri_mismatched_uuid_rejected() {
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let uri = format!("urn:spine:work:{other}");
        let result = validate_work_uri(&uri, id, None);
        assert!(
            result.is_err(),
            "urn:spine:work with a different uuid must be rejected; got Ok(())"
        );
    }

    #[test]
    fn work_uri_fragment_appended_rejected() {
        // This is the exact pattern the old frontend code produced:
        // `${graph.workUri}#${bookId}` to force the old substring check.
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let uri = format!("urn:spine:work:{id}#{id}");
        let result = validate_work_uri(&uri, id, None);
        assert!(
            result.is_err(),
            "URI with a fragment '#' must be rejected even if the uuid matches"
        );
    }

    #[test]
    fn work_uri_query_string_rejected() {
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let uri = format!("urn:spine:work:{id}?foo=bar");
        assert!(
            validate_work_uri(&uri, id, None).is_err(),
            "URI with a query string must be rejected"
        );
    }

    #[test]
    fn work_uri_loc_http_accepted_with_book_uuid() {
        // LoC URIs have a different ID component from the local book UUID.
        // They are accepted when book_uuid is supplied and matches the path id.
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let uri = "https://id.loc.gov/resources/works/12345678";
        assert!(
            validate_work_uri(uri, id, Some(id)).is_ok(),
            "LoC HTTPS URI must be accepted when book_uuid matches the path id"
        );
    }

    #[test]
    fn work_uri_loc_http_without_book_uuid_rejected() {
        // A LoC URI without book_uuid must be rejected 400 — the server has no
        // way to bind the LoC record to a local book without it.
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let uri = "https://id.loc.gov/resources/works/12345678";
        assert!(
            validate_work_uri(uri, id, None).is_err(),
            "LoC URI without book_uuid must be rejected"
        );
    }

    #[test]
    fn work_uri_loc_http_mismatched_book_uuid_rejected() {
        // book_uuid present but pointing at a different book.
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let uri = "https://id.loc.gov/resources/works/12345678";
        assert!(
            validate_work_uri(uri, id, Some(other)).is_err(),
            "LoC URI with mismatched book_uuid must be rejected"
        );
    }

    #[test]
    fn work_uri_loc_http_with_fragment_rejected() {
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let uri = format!("https://id.loc.gov/resources/works/12345678#{id}");
        assert!(
            validate_work_uri(&uri, id, Some(id)).is_err(),
            "LoC URI with a fragment must be rejected"
        );
    }

    #[test]
    fn work_uri_empty_passes() {
        // An empty URI is allowed — the graph may not have been reconciled.
        assert!(
            validate_work_uri("", "any-id", None).is_ok(),
            "empty work_uri must be allowed"
        );
    }

    #[test]
    fn work_uri_unknown_scheme_rejected() {
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        assert!(
            validate_work_uri("ftp://example.com/work/1", id, None).is_err(),
            "ftp:// scheme must be rejected"
        );
    }

    #[test]
    fn work_uri_urn_with_optional_book_uuid_still_validates_urn_suffix() {
        // When book_uuid is supplied alongside a urn: URI, the urn suffix check
        // still applies — book_uuid alone cannot bypass the suffix mismatch.
        let id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let bad_uri = format!("urn:spine:work:{other}");
        assert!(
            validate_work_uri(&bad_uri, id, Some(id)).is_err(),
            "urn: URI with wrong suffix must be rejected even when book_uuid is correct"
        );
    }

    // -----------------------------------------------------------------------
    // sanitize_zip_entry_name
    // -----------------------------------------------------------------------

    #[test]
    fn sanitize_strips_directory_separators() {
        assert_eq!(sanitize_zip_entry_name("OEBPS/chapter.xhtml"), "OEBPSchapter.xhtml");
        assert_eq!(sanitize_zip_entry_name("OEBPS\\chapter.xhtml"), "OEBPSchapter.xhtml");
        assert_eq!(sanitize_zip_entry_name("../../etc/passwd"), "....etcpasswd");
    }

    #[test]
    fn sanitize_rejects_dotdot_after_strip() {
        // After stripping separators, bare ".." becomes "_".
        assert_eq!(sanitize_zip_entry_name(".."), "_");
    }

    #[test]
    fn sanitize_rejects_dot_after_strip() {
        assert_eq!(sanitize_zip_entry_name("."), "_");
    }

    #[test]
    fn sanitize_strips_null_bytes() {
        let with_null = "file\0name.epub";
        let result = sanitize_zip_entry_name(with_null);
        assert!(!result.contains('\0'), "null byte must be stripped");
        assert_eq!(result, "filename.epub");
    }

    #[test]
    fn sanitize_windows_reserved_names_prefixed() {
        for name in &["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"] {
            let result = sanitize_zip_entry_name(name);
            assert!(
                result.starts_with('_'),
                "reserved name {name} must be prefixed with '_'; got {result}"
            );
        }
        // With extension.
        assert!(
            sanitize_zip_entry_name("CON.txt").starts_with('_'),
            "CON.txt must be prefixed with '_'"
        );
    }

    #[test]
    fn sanitize_normal_names_unchanged() {
        assert_eq!(sanitize_zip_entry_name("Hobbit_Adventures.epub"), "Hobbit_Adventures.epub");
        assert_eq!(sanitize_zip_entry_name("cover.jpg"), "cover.jpg");
    }

    #[test]
    fn sanitize_empty_returns_unknown() {
        assert_eq!(sanitize_zip_entry_name(""), "unknown");
    }

    // -----------------------------------------------------------------------
    // replace_paths + scrub_job_status
    // -----------------------------------------------------------------------

    #[test]
    fn replace_paths_unix_path_replaced() {
        let out = replace_paths("failed to open /home/alice/Library/metadata.db");
        assert_eq!(out, "failed to open <path>");
    }

    #[test]
    fn replace_paths_windows_drive_path_replaced() {
        let out = replace_paths("could not write C:\\Users\\bob\\Documents\\spine.db");
        assert_eq!(out, "could not write <path>");
    }

    #[test]
    fn replace_paths_windows_forward_slash_path_replaced() {
        let out = replace_paths("error: C:/Users/bob/spine.db not found");
        assert_eq!(out, "error: <path> not found");
    }

    #[test]
    fn replace_paths_unc_path_replaced() {
        let out = replace_paths(r"cannot open \\server\share\books\metadata.db");
        assert_eq!(out, "cannot open <path>");
    }

    #[test]
    fn replace_paths_bare_slash_not_replaced() {
        // A bare '/' (e.g. the root path marker in a message like "/ is full")
        // must not be replaced because it is not a path token.
        let out = replace_paths("disk / is full");
        assert_eq!(out, "disk / is full", "bare '/' followed by space must be left unchanged");
    }

    #[test]
    fn replace_paths_multibyte_utf8_safe() {
        // A string containing multi-byte UTF-8 characters that are NOT paths
        // must not be corrupted by the byte-iteration fix.
        let input = "erreur : café introuvable";
        let out = replace_paths(input);
        assert_eq!(out, input, "non-path multi-byte UTF-8 must pass through unchanged");
    }

    #[test]
    fn replace_paths_multibyte_utf8_path_replaced() {
        // A Unix path that happens to have a multi-byte char in a directory name
        // (e.g. /home/café/spine.db) must still be replaced without panicking.
        let input = "/home/café/spine.db is unavailable";
        let out = replace_paths(input);
        assert_eq!(out, "<path> is unavailable");
    }

    #[test]
    fn scrub_truncate_is_utf8_safe() {
        // Build a string of exactly 514 two-byte characters (e.g. 'ñ', U+00F1).
        // A naive s.truncate(512) on a 1028-byte string would split in the
        // middle of a two-byte sequence and panic. The fixed implementation
        // finds the 512th character boundary.
        use crate::jobs::JobStatus;
        let long_msg: String = std::iter::repeat('ñ').take(514).collect();
        let status = JobStatus::Failed(long_msg);
        // Must not panic.
        let scrubbed = scrub_job_status(&status);
        if let JobStatus::Failed(s) = scrubbed {
            // Result should be 512 'ñ' chars + '…' — all valid UTF-8.
            assert!(
                std::str::from_utf8(s.as_bytes()).is_ok(),
                "scrubbed string must be valid UTF-8"
            );
            let char_count = s.chars().count();
            // 512 content chars + 1 ellipsis = 513
            assert_eq!(char_count, 513, "truncated string must have 513 chars (512 content + ellipsis)");
        } else {
            panic!("scrub_job_status must return Failed for a Failed input");
        }
    }

    #[test]
    fn scrub_under_512_chars_not_truncated() {
        use crate::jobs::JobStatus;
        let short_msg = "short error".to_string();
        let status = JobStatus::Failed(short_msg.clone());
        if let crate::jobs::JobStatus::Failed(s) = scrub_job_status(&status) {
            assert!(
                !s.contains('…'),
                "string under 512 chars must not have truncation ellipsis appended"
            );
        }
    }
}
