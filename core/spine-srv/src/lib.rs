use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use calibre_db::{CalibreLibrary, DualDbPaths, LibrarySession};
use spine_api::{BibliographicGraph, Book};
use spine_db::SpineStore;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
#[cfg(feature = "desktop")]
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;

pub mod api_v1;
pub mod auth;
pub mod backup;
pub mod inference;
pub mod ingest;
pub mod jobs;
pub mod reconcile;

/// Maximum size of a single EPUB resource we are willing to decompress.
/// A 50 MB resource inside an EPUB is almost certainly malformed or
/// adversarial; decompressing it without a cap risks OOM. Shared by
/// `load_book_resource` (decompresses the body) and `probe_book_resource`
/// (reads only the central-directory entry) so HEAD and GET agree on the
/// cutoff.
pub(crate) const EPUB_RESOURCE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// How long a terminal job (Completed or Failed) lingers in `job_status`
/// before the next sweep removes it. Long enough for the UI to display the
/// final state to the user through a normal working session; short enough
/// to bound the map growth. The Footer ticker (`/api/v1/jobs/summary`)
/// surfaces these counts; 15-minute retention dropped completed/failed
/// jobs out of the ticker mid-day, so the user opening the StatusBar at
/// 4pm saw nothing of an ingest that completed at 9am. 1-hour retention
/// covers a working session without unbounded growth (a 1000-job day at
/// 0.4ms/uuid + dozen-byte-status entry is well under 100KB resident).
pub const JOB_TTL_SECS: u64 = 60 * 60; // 1 hour

/// In-memory snapshot of the desktop shell's known libraries: the
/// path of the currently open library plus a most-recent-first
/// list (capped at 5, deduped) of paths the user has opened.
/// Mirrors the shape that lives durably in the Tauri shell's
/// `DesktopConfig`; the Tauri shell will push here on each library
/// switch (follow-up commit) so that the HTTP contract has a
/// server-side authoritative read path (`GET /api/v1/library/list`)
/// in addition to its existing command-bridge view. Persistence
/// stays Tauri-side until the full migration to a spine-srv-owned
/// store (option C, deferred).
#[derive(Debug, Default, Clone)]
pub struct RecentLibrariesState {
    pub recent: Vec<String>,
    pub current: Option<String>,
}

pub struct AppState {
    pub library: Mutex<CalibreLibrary>,
    pub store: Mutex<SpineStore>,
    /// Paths to both database files. Used to construct per-request
    /// `LibrarySession` instances for atomic cross-DB writes. Reads continue to
    /// go through `library` and `store`; writes go through a fresh session so
    /// each write is its own ATTACH + transaction + detach cycle.
    ///
    /// `None` when the server started without an open library (e.g. in tests
    /// that pass `:memory:` — ATTACH cannot share an in-memory connection).
    /// Handlers that need a session must return 503 when this is `None`.
    pub db_paths: Option<DualDbPaths>,
    /// LoC client, initialised lazily on first use.
    ///
    /// On mobile, `initCore` runs before any network is guaranteed to be
    /// available (cold boot, airplane mode). Constructing `reqwest::Client`
    /// eagerly calls `Client::builder().build()` which may fail if the TLS
    /// backend cannot initialise. Wrapping in `OnceLock<Option<…>>` defers
    /// that cost to the first `GET /api/v1/book/:id/candidates` call, when the
    /// device is more likely to have network. `None` inside the lock means
    /// "init was attempted and failed"; handlers receive `None` from
    /// `get_or_init_loc_client` and return 503. `Some(client)` means ready.
    ///
    /// On desktop, `main.rs` pre-populates the cell at startup so the lazy
    /// path is never taken; any startup failure is fatal there (as before).
    pub loc_client: Arc<std::sync::OnceLock<Option<spine_meta::LocClient>>>,
    pub job_queue: Arc<dyn jobs::JobQueue>,
    pub job_status: Mutex<std::collections::HashMap<uuid::Uuid, jobs::JobStatus>>,
    /// Timestamps recording when each job transitioned to a terminal state
    /// (Completed or Failed). Used by the TTL eviction sweep in `list_jobs`
    /// and `get_job_status` to bound the map size.
    pub job_terminal_at: Mutex<std::collections::HashMap<uuid::Uuid, std::time::Instant>>,
    /// Single-flight guard on `/api/v1/sync/calibre`. Set when a sync begins;
    /// cleared when it returns. A second concurrent request is rejected with
    /// 409 Conflict rather than stacking dispatches on the same book list.
    pub sync_in_progress: Arc<AtomicBool>,
    /// Most-recent-first deduped library paths + currently-open
    /// path. Mutated via `AppState::push_recent_library` from both
    /// the HTTP POST handler and (in a follow-up commit) the Tauri
    /// shell's `open_library` hook on every library switch.
    pub recent_libraries: Mutex<RecentLibrariesState>,
}

impl AppState {
    /// Remove terminal jobs (Completed / Failed) whose completion timestamp is
    /// older than `JOB_TTL_SECS`. Called on every `GET /api/v1/jobs` and
    /// `GET /api/v1/jobs/:id` request so the map cannot grow without bound.
    ///
    /// Callers must hold neither lock before calling — this acquires both
    /// internally in the order (job_terminal_at, job_status) and releases
    /// them before returning.
    pub async fn evict_expired_jobs(&self) {
        let cutoff = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(JOB_TTL_SECS))
            .unwrap_or(std::time::Instant::now());

        let mut timestamps = self.job_terminal_at.lock().await;
        let mut statuses = self.job_status.lock().await;

        let expired: Vec<uuid::Uuid> = timestamps
            .iter()
            .filter(|(_, &ts)| ts <= cutoff)
            .map(|(id, _)| *id)
            .collect();

        for id in &expired {
            timestamps.remove(id);
            statuses.remove(id);
        }
    }

    /// Record that a job has transitioned to a terminal state. Called by
    /// `LocalJobQueue` after each job completes or fails.
    pub async fn record_job_terminal(&self, id: uuid::Uuid) {
        let mut timestamps = self.job_terminal_at.lock().await;
        timestamps.insert(id, std::time::Instant::now());
    }

    /// Idempotent push of a library path into the recent-libraries
    /// snapshot. Most-recent-first after dedup; truncated to 5 to
    /// match the durable cap in the Tauri shell's `DesktopConfig`.
    /// Also sets `current` to this path so a single mutation covers
    /// the "user just opened library X" event end-to-end.
    pub async fn push_recent_library(&self, path: String) {
        let mut state = self.recent_libraries.lock().await;
        state.recent.retain(|existing| existing != &path);
        state.recent.insert(0, path.clone());
        state.recent.truncate(5);
        state.current = Some(path);
    }

    /// Return a reference to the `LocClient`, initialising it on first call.
    ///
    /// Returns `None` if `LocClient::new()` fails (TLS init failure, resource
    /// exhaustion). Handlers that receive `None` must return 503.
    ///
    /// The inner `OnceLock<Option<LocClient>>` stores `None` to record a
    /// failed init — `get_or_init` is only called once, so a failed init is
    /// permanent for the lifetime of this `AppState`. On mobile, the fix for a
    /// permanent failure is `shutdownCore` + `initCore` to rebuild state. On
    /// desktop, `main.rs` pre-populates with `Some(client)` so this path is
    /// never taken.
    pub fn get_or_init_loc_client(&self) -> Option<&spine_meta::LocClient> {
        self.loc_client
            .get_or_init(|| match spine_meta::LocClient::new() {
                Ok(c) => {
                    tracing::debug!("LocClient initialised on first use");
                    Some(c)
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "LocClient init failed; candidates endpoint will return 503"
                    );
                    None
                }
            })
            .as_ref()
    }

    /// Open a fresh `LibrarySession` for a single atomic write. Returns an
    /// error string if `db_paths` is not set (in-memory test state).
    pub fn library_session(&self) -> Result<LibrarySession, String> {
        let paths = self
            .db_paths
            .as_ref()
            .ok_or_else(|| "no library open — db_paths is None".to_string())?;
        let library_path = paths
            .calibre_db
            .as_str()
            .rsplit_once(['/', '\\'])
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_else(|| ".".to_string());
        LibrarySession::open(paths, library_path)
            .map_err(|e| format!("failed to open library session: {e}"))
    }
}

/// Canonical graph URI for a given calibre book UUID. Every caller that writes
/// or reads book triples must use this helper so the URI scheme stays in one
/// place. Diverging formats silently split a book's graph across two keys —
/// a failure mode we saw during the pre-hydration migration.
pub(crate) fn graph_uri_for(book_id: &uuid::Uuid) -> String {
    format!("urn:spine:graph:book:{}", book_id)
}

/// String overload of `graph_uri_for` for callers that already have the UUID
/// as a pre-formatted string (e.g. route path params).
pub(crate) fn graph_uri_for_str(book_id: &str) -> String {
    format!("urn:spine:graph:book:{}", book_id)
}

/// Pure axum wiring with no transport-specific layers beyond the universal
/// request-body limit. Mobile embedders (JNI / future Swift FFI) dispatch
/// directly into this router via `Router::call`; they have no CORS concept
/// because the frontend and the router share a process.
///
/// Desktop and standalone-server callers want CORS headers on top — use
/// `create_desktop_router` for that. See TECH_DEBT §4.1.
pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/v1/ping", get(ping))
        .route("/api/v1/storage", get(api_v1::get_storage_v1))
        .route("/api/v1/golden-record", get(golden_record))
        .route("/api/v1/book", get(api_v1::list_books_v1))
        .route(
            "/api/v1/reading-progress",
            get(api_v1::list_reading_progress_v1),
        )
        .route("/api/v1/book/ingest", post(api_v1::ingest_epub_v1))
        .route("/api/v1/book/:id", get(api_v1::get_book_v1))
        .route(
            "/api/v1/book/:id/progress",
            get(api_v1::get_book_progress_v1).post(api_v1::save_book_progress_v1),
        )
        // Deprecated compatibility aliases. New UI/API work should use /api/v1/book.
        .route("/api/v1/library/books", get(list_books))
        .route("/api/v1/library/books/:id", get(get_book))
        .route("/api/v1/jobs", get(api_v1::list_jobs))
        .route("/api/v1/jobs/summary", get(api_v1::get_jobs_summary_v1))
        .route("/api/v1/jobs/:id", get(api_v1::get_job_status))
        .route(
            "/api/v1/loc/cache_status",
            get(api_v1::get_loc_cache_status_v1),
        )
        .route(
            "/api/v1/library/backup",
            post(api_v1::start_library_backup_v1),
        )
        .route(
            "/api/v1/library/backup/last",
            get(api_v1::get_library_backup_last_v1),
        )
        .route(
            "/api/v1/loc/lcsh/suggest",
            get(api_v1::lcsh_suggest_v1),
        )
        .route(
            "/api/v1/library/recent",
            post(api_v1::add_recent_library_v1),
        )
        .route("/api/v1/library/list", get(api_v1::list_libraries_v1))
        .route("/api/v1/facet/:kind", get(api_v1::list_facet))
        .route("/api/v1/book/:id/cover", get(get_cover))
        .route("/api/v1/book/:id", delete(api_v1::delete_book_v1))
        .route(
            "/api/v1/book/:id/metadata/fields",
            put(api_v1::update_metadata_fields_v1),
        )
        .route("/api/v1/book/:id/export", post(api_v1::export_book_v1))
        .route("/api/v1/library/books/:id/cover", get(get_cover))
        .route(
            "/api/v1/reader/book/:id/resource/*path",
            get(get_resource).head(head_resource),
        )
        .route(
            "/api/v1/book/:id/resource/*path",
            get(get_resource).head(head_resource),
        )
        .route(
            "/api/v1/library/books/:id/resource/*path",
            get(get_resource).head(head_resource),
        )
        .route("/api/v1/book/:id/candidates", get(fetch_candidates))
        .route(
            "/api/v1/library/books/:id/candidates",
            get(fetch_candidates),
        )
        .route(
            "/api/v1/book/:id/metadata",
            post(update_metadata).put(api_v1::put_book_metadata_v1),
        )
        .route("/api/v1/library/books/:id/metadata", post(update_metadata))
        .route("/api/v1/sync/calibre", post(sync_calibre))
        // ADR 014 Phase C — write API endpoints (subjects + instances).
        .route(
            "/api/v1/book/:id/subject",
            post(api_v1::add_subject_v1).delete(api_v1::remove_subject_v1),
        )
        .route("/api/v1/book/:id/instance", post(api_v1::add_instance_v1))
        .route(
            "/api/v1/book/:id/instance/:instance_uuid/primary",
            axum::routing::patch(api_v1::set_primary_instance_v1),
        )
        // ADR 015 — reconcile drawer backend (Sprint 10).
        .route("/api/v1/reconcile/queue", get(reconcile::get_reconcile_queue))
        .route(
            "/api/v1/reconcile/:id/promote",
            post(reconcile::promote),
        )
        .route("/api/v1/reconcile/:id/skip", post(reconcile::skip))
        // ADR 016 — inferred-graph read + decide endpoints (Sprint 11).
        .route(
            "/api/v1/inference/book/:uuid",
            get(inference::get_inference_book),
        )
        .route(
            "/api/v1/inference/:inference_id/decide",
            post(inference::post_decide),
        )
        // 64 MB ceiling on all request bodies. Matches BRIDGE_MAX_BODY_BYTES in the
        // Tauri bridge so in-process and TCP-sidecar transports enforce the same limit.
        // The multipart ingest route has its own tighter per-field guard (256 MB is
        // the EPUB ceiling; this outer layer rejects anything above 64 MB before the
        // handler even runs, which is intentional — multipart metadata fields have no
        // business being larger than 64 MB either).
        .layer(RequestBodyLimitLayer::new(64 * 1024 * 1024))
        .with_state(state)
}

/// Desktop / standalone-server router: `create_router` plus the CORS allow-list
/// for the Tauri webview and the Vite dev server. Only built with the
/// `desktop` feature; mobile cdylib builds omit `tower-http`'s cors feature
/// entirely to save binary size.
#[cfg(feature = "desktop")]
pub fn create_desktop_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:1420"
                .parse::<axum::http::HeaderValue>()
                .unwrap(),
            "http://localhost:5173"
                .parse::<axum::http::HeaderValue>()
                .unwrap(),
            "tauri://localhost"
                .parse::<axum::http::HeaderValue>()
                .unwrap(),
        ])
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::HEAD,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    // Layer ordering: CORS wraps the whole stack (including the body-size
    // limit) so that preflight OPTIONS responses carry CORS headers even when
    // the underlying request would be rejected for size.
    create_router(state).layer(cors)
}

/// Initialise `log`/`tracing` output for the mobile embedder. On Android this
/// routes records to logcat under the `spine-core` tag; tracing's default
/// stderr writer is invisible to Android's log viewer.
///
/// The function is safe to call more than once — `android_logger::init_once`
/// is idempotent. Callers from JNI typically invoke this from `initCore`.
///
/// On non-Android targets (host `cargo check --features mobile`) this is a
/// no-op so the feature gate stays compilable on every platform.
#[cfg(feature = "mobile")]
pub fn init_mobile_logging() {
    #[cfg(target_os = "android")]
    {
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Info)
                .with_tag("spine-core"),
        );
    }
}

async fn ping() -> &'static str {
    "{\"status\": \"ok\", \"version\": \"0.1.0-alpha\"}"
}

async fn golden_record(State(state): State<Arc<AppState>>) -> Json<Option<Book>> {
    let lib = state.library.lock().await;
    let books = lib.list_books().unwrap_or_default();
    drop(lib);

    let mut book = books.into_iter().next();
    if let Some(ref mut b) = book {
        hydrate_book(&state, b).await;
    }
    Json(book)
}

async fn list_books(State(state): State<Arc<AppState>>) -> Json<Vec<Book>> {
    Json(list_enriched_books(&state).await)
}

pub(crate) async fn list_enriched_books(state: &AppState) -> Vec<Book> {
    let books = {
        let lib = state.library.lock().await;
        lib.list_books().unwrap_or_default()
    };

    if books.is_empty() {
        return books;
    }

    // Build the graph URIs for the whole library in one shot, then issue a
    // single batch query instead of one store lock-acquire + one SELECT per
    // book. O(N) lock acquisitions → O(1); N individual query round-trips →
    // one query regardless of library size.
    let graph_uris: Vec<String> = books.iter().map(|b| graph_uri_for(&b.id)).collect();
    let uri_refs: Vec<&str> = graph_uris.iter().map(String::as_str).collect();

    let triples_by_graph = {
        let store = state.store.lock().await;
        match store.get_triples_batch(&uri_refs) {
            Ok(map) => map,
            Err(e) => {
                // A failed batch hydration used to silently drop through
                // `unwrap_or_default`, returning books with empty graphs and
                // no trace of the failure. Log it loudly; the caller still
                // gets a usable (if un-hydrated) book list.
                tracing::error!(
                    error = %e,
                    book_count = books.len(),
                    "graph hydration failed in list_enriched_books; returning books without graphs"
                );
                std::collections::HashMap::new()
            }
        }
    };

    books
        .into_iter()
        .map(|mut book| {
            let graph_uri = graph_uri_for(&book.id);
            if let Some(triples) = triples_by_graph.get(&graph_uri) {
                book.bibliographic_graph =
                    spine_bf::triples_to_bibliographic_graph(&book.id.to_string(), triples);
            }
            book
        })
        .collect()
}

async fn get_book(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Json<Option<Book>> {
    Json(get_enriched_book(&state, &id).await)
}

pub(crate) async fn get_enriched_book(state: &AppState, id: &str) -> Option<Book> {
    let lib = state.library.lock().await;
    let mut book = lib.get_book_by_uuid(id).unwrap_or(None);
    drop(lib);

    if let Some(ref mut b) = book {
        hydrate_book(&state, b).await;
    }
    book
}

async fn fetch_candidates(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let lib = state.library.lock().await;
    let books = lib.list_books().unwrap_or_default();
    drop(lib);

    let book_opt = books.into_iter().find(|b| b.id.to_string() == id);

    let mut candidates = Vec::new();

    if let Some(book) = book_opt {
        if !book.authors.is_empty() {
            // debug level: title and author are PII and must not appear in
            // logcat by default (android_logger max level is Info).
            tracing::debug!(
                title = %book.title,
                author = %book.authors[0],
                "Fetching candidates"
            );
            let Some(loc_client) = state.get_or_init_loc_client() else {
                tracing::warn!("LocClient unavailable; returning empty candidates");
                return Json(serde_json::json!({"synthesized": null, "candidates": []}));
            };
            match loc_client
                .search_by_title_author(&book.title, &book.authors[0])
                .await
            {
                Ok(marcxml) => {
                    tracing::debug!(marcxml_len = marcxml.len(), "Got MARCXML");
                    match spine_marc::extract_marc_records(&marcxml) {
                        Ok(records) => {
                            tracing::info!(records_len = records.len(), "Extracted MARC records");
                            for rec in records.iter().take(5) {
                                // Extract LCCN (001)
                                if let Some(loc_id_field) =
                                    rec.control_fields.iter().find(|c| c.tag == "001")
                                {
                                    let loc_id = loc_id_field.value.trim();
                                    if !loc_id.is_empty() {
                                        tracing::debug!(loc_id = %loc_id, "Fetching JSON-LD");
                                        if let Ok(jsonld) =
                                            loc_client.fetch_bibframe_json(loc_id).await
                                        {
                                            if let Some(graph) =
                                                spine_meta::jsonld::parse_loc_jsonld(&jsonld)
                                            {
                                                candidates.push(graph);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => tracing::debug!(error = ?e, "Error extracting MARC records"),
                    }
                }
                Err(e) => tracing::debug!(error = ?e, "Error searching LoC"),
            }
        } else {
            tracing::debug!("Book has no authors, skipping lookup");
        }
    } else {
        tracing::debug!("Book not found in library");
    }

    // Rank signal vs noise
    candidates.sort_by(|a, b| {
        let score_a = score_candidate(a);
        let score_b = score_candidate(b);
        score_b.cmp(&score_a) // Descending
    });

    // Agentic Synthesis
    let synthesized = synthesize_golden_candidate(&candidates);

    // We return a wrapper object to the frontend now
    let response = serde_json::json!({
        "synthesized": synthesized.map(|(graph, reasoning)| {
            serde_json::json!({
                "graph": graph,
                "reasoning": reasoning
            })
        }),
        "candidates": candidates
    });

    Json(response)
}

fn score_candidate(graph: &BibliographicGraph) -> i32 {
    let mut score = 0;

    if graph.work.origin_date.is_some() {
        score += 10;
    }

    score += (graph.work.subjects.len() as i32) * 2;
    score += (graph.work.creators.len() as i32) * 2;

    for subject in &graph.work.subjects {
        let lower = subject.label.to_lowercase();
        if lower.contains("study guide")
            || lower.contains("examinations")
            || lower.contains("comic books")
        {
            score -= 20;
        }
    }

    score
}

fn synthesize_golden_candidate(
    candidates: &[BibliographicGraph],
) -> Option<(BibliographicGraph, String)> {
    if candidates.is_empty() {
        return None;
    }

    let mut best_date: Option<String> = None;
    let mut earliest_year = 9999;

    let mut best_title: Option<String> = None;
    let mut best_language: Option<String> = None;
    let mut best_lccn: Option<String> = None;
    let mut best_publisher: Option<String> = None;
    let mut best_isbn: Option<String> = None;
    let mut best_oclc: Option<String> = None;

    let mut subject_counts: std::collections::HashMap<String, (spine_api::AuthorityLink, usize)> =
        std::collections::HashMap::new();
    let mut creator_counts: std::collections::HashMap<String, (spine_api::AgentLink, usize)> =
        std::collections::HashMap::new();

    let mut _noisy_filtered = 0;

    for cand in candidates {
        if best_title.is_none() && cand.work.title.is_some() {
            best_title = cand.work.title.clone();
        }
        if best_language.is_none() && cand.work.language.is_some() {
            best_language = cand.work.language.clone();
        }
        if best_lccn.is_none() && cand.work.lccn.is_some() {
            best_lccn = cand.work.lccn.clone();
        }

        if let Some(inst) = cand.instances.first() {
            if best_publisher.is_none() && inst.publisher.is_some() {
                best_publisher = inst.publisher.clone();
            }
            if best_isbn.is_none() && inst.isbn.is_some() {
                best_isbn = inst.isbn.clone();
            }
            if best_oclc.is_none() && inst.oclc.is_some() {
                best_oclc = inst.oclc.clone();
            }
        }

        // Date Logic
        if let Some(date_str) = &cand.work.origin_date {
            let digits: String = date_str
                .chars()
                .filter(|c| c.is_digit(10))
                .take(4)
                .collect();
            if let Ok(year) = digits.parse::<i32>() {
                if year > 1000 && year < earliest_year {
                    earliest_year = year;
                    best_date = Some(date_str.clone());
                }
            }
        }

        // Subject Logic
        for subj in &cand.work.subjects {
            let lower = subj.label.to_lowercase();
            if lower.contains("study guide")
                || lower.contains("examinations")
                || lower.contains("comic books")
                || lower.contains("juvenile")
            {
                _noisy_filtered += 1;
                continue;
            }
            let entry = subject_counts.entry(lower).or_insert((subj.clone(), 0));
            entry.1 += 1;
        }

        // Creator Logic
        for creator in &cand.work.creators {
            let norm_name = clean_name(&creator.name);
            let lower = norm_name.to_lowercase();
            let mut c = creator.clone();
            c.name = norm_name;
            let entry = creator_counts.entry(lower).or_insert((c, 0));
            entry.1 += 1;
        }
    }

    let threshold = if candidates.len() > 2 { 2 } else { 1 };

    let final_subjects = subject_counts
        .into_values()
        .filter(|(_, count)| *count >= threshold)
        .map(|(s, _)| s)
        .collect();

    let final_creators = creator_counts
        .into_values()
        .filter(|(_, count)| *count >= threshold)
        .map(|(c, _)| c)
        .collect();

    // Mint exactly one UUID for the work and one for the instance, then
    // reuse them so `graph.work_uri == graph.work.uri` and
    // `graph.instance_uri == graph.instances[0].uri`. Previously this block
    // called `Uuid::new_v4()` four times and produced four divergent URIs,
    // which broke downstream SPARQL that joins by work URI.
    let work_uuid = uuid::Uuid::new_v4();
    let instance_uuid = uuid::Uuid::new_v4();
    let work_uri = format!("urn:spine:synthesized:work:{}", work_uuid);
    let instance_uri = format!("urn:spine:synthesized:instance:{}", instance_uuid);

    let synthesized_graph = BibliographicGraph {
        work_uri: work_uri.clone(),
        instance_uri: instance_uri.clone(),
        work: spine_api::Work {
            uri: work_uri,
            title: best_title,
            origin_date: best_date.clone(),
            subjects: final_subjects,
            creators: final_creators,
            language: best_language,
            lccn: best_lccn,
            ddc: None,
        },
        instances: vec![spine_api::Instance {
            uri: instance_uri,
            format: "Print".to_string(),
            publication_date: best_date.clone(),
            publisher: best_publisher,
            isbn: best_isbn,
            oclc: best_oclc,
        }],
    };

    let reasoning = format!(
        "Synthesized from {} Library of Congress records. Extracted the earliest authoritative origin date ({}) and consolidated consensus tags using frequency thresholding.",
        candidates.len(),
        best_date.as_deref().unwrap_or("Unknown")
    );

    Some((synthesized_graph, reasoning))
}

/// Lightweight metadata returned by `probe_book_resource`. Used by HEAD
/// requests so we can return correct headers without decompressing the entry.
#[derive(Debug)]
pub struct ResourceProbe {
    pub content_type: String,
    /// Uncompressed size in bytes as declared in the zip central directory.
    /// May diverge from the actual decompressed length if the zip was crafted
    /// maliciously, but for HEAD responses a declared size is the correct
    /// thing to return — GET will enforce the real cap via `take`.
    pub content_length: u64,
}

#[derive(Debug)]
pub struct BookResource {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ResourceError {
    #[error("invalid EPUB resource path")]
    InvalidPath,
    #[error("book or EPUB format not found")]
    MissingEpub,
    #[error("resource not found: {0}")]
    MissingResource(String),
    #[error("failed to read EPUB: {0}")]
    ReadFailed(String),
}

pub async fn load_book_resource(
    state: &AppState,
    id: &str,
    resource_path: &str,
) -> Result<BookResource, ResourceError> {
    let clean_path =
        normalize_epub_resource_path(resource_path).ok_or(ResourceError::InvalidPath)?;

    let epub_path = {
        let lib = state.library.lock().await;
        lib.get_format_path(id, "EPUB")
            .ok()
            .flatten()
            .ok_or(ResourceError::MissingEpub)?
    };

    let lookup_path = clean_path.clone();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ResourceError> {
        let file = std::fs::File::open(&epub_path)
            .map_err(|e| ResourceError::ReadFailed(e.to_string()))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| ResourceError::ReadFailed(e.to_string()))?;
        let target_file = archive
            .by_name(&lookup_path)
            .map_err(|e| ResourceError::MissingResource(e.to_string()))?;

        // Pre-check the declared uncompressed size to fail fast before
        // decompressing. `ZipFile::size()` returns the stored uncompressed
        // size; a malicious zip can lie, so the `take` below is the hard guard.
        if target_file.size() > EPUB_RESOURCE_MAX_BYTES {
            return Err(ResourceError::ReadFailed(format!(
                "Resource {} exceeds 50 MB cap (declared size: {} bytes)",
                lookup_path,
                target_file.size()
            )));
        }

        let mut buffer = Vec::new();
        // The `take` is the hard cap: even if the declared size was forged,
        // the actual bytes read cannot exceed EPUB_RESOURCE_MAX_BYTES.
        target_file
            .take(EPUB_RESOURCE_MAX_BYTES)
            .read_to_end(&mut buffer)
            .map_err(|e| ResourceError::ReadFailed(e.to_string()))?;
        Ok(buffer)
    })
    .await
    .map_err(|e| ResourceError::ReadFailed(e.to_string()))??;

    let content_type = mime_guess::from_path(&clean_path)
        .first_or_octet_stream()
        .to_string();

    Ok(BookResource {
        bytes,
        content_type,
    })
}

/// Returns headers-only metadata for an EPUB resource without decompressing
/// the entry body. On a 50 MB chapter file, `load_book_resource` decompresses
/// all 50 MB before discarding the bytes — this function reads only the zip
/// central-directory record, which is O(1) in entry size.
///
/// The `EPUB_RESOURCE_MAX_BYTES` cap from `load_book_resource` is mirrored
/// here so that a HEAD on an oversized entry returns the same error shape as a
/// GET would. That keeps HEAD/GET consistent for clients that probe before
/// fetching.
pub async fn probe_book_resource(
    state: &AppState,
    id: &str,
    resource_path: &str,
) -> Result<ResourceProbe, ResourceError> {
    let clean_path =
        normalize_epub_resource_path(resource_path).ok_or(ResourceError::InvalidPath)?;

    let epub_path = {
        let lib = state.library.lock().await;
        lib.get_format_path(id, "EPUB")
            .ok()
            .flatten()
            .ok_or(ResourceError::MissingEpub)?
    };

    let lookup_path = clean_path.clone();
    let probe = tokio::task::spawn_blocking(move || -> Result<ResourceProbe, ResourceError> {
        let file = std::fs::File::open(&epub_path)
            .map_err(|e| ResourceError::ReadFailed(e.to_string()))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| ResourceError::ReadFailed(e.to_string()))?;
        // `by_name` locates the entry via the central directory without
        // reading any compressed data.
        let entry = archive
            .by_name(&lookup_path)
            .map_err(|e| ResourceError::MissingResource(e.to_string()))?;

        let declared_size = entry.size();
        if declared_size > EPUB_RESOURCE_MAX_BYTES {
            return Err(ResourceError::ReadFailed(format!(
                "Resource {} exceeds 50 MB cap (declared size: {} bytes)",
                lookup_path, declared_size
            )));
        }

        let content_type = mime_guess::from_path(&lookup_path)
            .first_or_octet_stream()
            .to_string();

        Ok(ResourceProbe {
            content_type,
            content_length: declared_size,
        })
    })
    .await
    .map_err(|e| ResourceError::ReadFailed(e.to_string()))??;

    Ok(probe)
}

fn normalize_epub_resource_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    for part in path.split('/') {
        if part == ".." {
            return None;
        }
        if !part.is_empty() && part != "." {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn resource_error_response(error: ResourceError) -> Response {
    match error {
        ResourceError::InvalidPath => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        ResourceError::MissingEpub | ResourceError::MissingResource(_) => {
            (StatusCode::NOT_FOUND, error.to_string()).into_response()
        }
        ResourceError::ReadFailed(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

async fn get_resource(
    Path((id, resource_path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Response {
    match load_book_resource(&state, &id, &resource_path).await {
        Ok(resource) => {
            let content_length = resource.bytes.len().to_string();
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, resource.content_type),
                    (header::CONTENT_LENGTH, content_length),
                ],
                resource.bytes,
            )
                .into_response()
        }
        Err(error) => resource_error_response(error),
    }
}

async fn head_resource(
    Path((id, resource_path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Response {
    // probe_book_resource reads only the zip central-directory entry — no
    // decompression. Calling load_book_resource here would decompress the
    // entire file body and discard it, wasting up to EPUB_RESOURCE_MAX_BYTES
    // of CPU and memory on every HEAD request.
    match probe_book_resource(&state, &id, &resource_path).await {
        Ok(probe) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, probe.content_type),
                (header::CONTENT_LENGTH, probe.content_length.to_string()),
            ],
        )
            .into_response(),
        Err(error) => resource_error_response(error),
    }
}

async fn update_metadata(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    axum::extract::Json(graph): axum::extract::Json<BibliographicGraph>,
) -> Response {
    // TODO(TECH_DEBT §3.8): This handler still goes through `LibrarySession`
    // with an empty `BookUpdate`, meaning the BIBFRAME graph is updated
    // atomically with a no-op calibre leg. A proper implementation would
    // project the graph diff into a `BookUpdate` via `spine-bf`, keeping
    // calibre's surface fields in sync. That projection is `spine-bf`'s
    // responsibility and is deferred with the rest of §3.8.
    let mut session = match state.library_session() {
        Ok(s) => s,
        Err(_) => {
            // db_paths is None — mobile in-memory mode has no durable storage.
            // Silently falling back to a store-only write here caused data loss:
            // the user hit Save, the write succeeded against the in-memory store,
            // the app closed, and the data was gone. Return 503 explicitly so the
            // Kotlin caller can surface an error rather than fabricate success.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({
                    "error": "no library open",
                    "detail": "metadata writes require an open library; db_paths is None"
                })),
            )
                .into_response();
        }
    };
    let projection = calibre_db::BookUpdate::default();
    Json(session.apply_metadata_update(&id, &graph, &projection).is_ok()).into_response()
}

async fn get_cover(Path(id): Path<String>, State(state): State<Arc<AppState>>) -> String {
    let lib = state.library.lock().await;
    let cover_res = lib.get_cover_path(&id);
    drop(lib);

    if let Ok(Some(path)) = cover_res {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            let encoded = general_purpose::STANDARD.encode(&bytes);
            return format!("data:image/jpeg;base64,{}", encoded);
        }
    }
    String::new()
}

async fn hydrate_book(state: &AppState, book: &mut Book) {
    let graph_uri = graph_uri_for(&book.id);
    let store = state.store.lock().await;
    let triples_res = store.get_triples(&graph_uri);
    drop(store);

    if let Ok(triples) = triples_res {
        book.bibliographic_graph =
            spine_bf::triples_to_bibliographic_graph(&book.id.to_string(), &triples);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use spine_api::{AgentLink, AuthorityLink, BibliographicGraph, Instance, LegacyMetadata, Work};
    use uuid::Uuid;

    /// Build a pre-populated `OnceLock<Option<LocClient>>` for tests.
    fn test_loc_cell() -> Arc<std::sync::OnceLock<Option<spine_meta::LocClient>>> {
        let cell = std::sync::OnceLock::new();
        cell.set(Some(
            spine_meta::LocClient::with_base_url("http://localhost:0").unwrap(),
        ))
        .unwrap();
        Arc::new(cell)
    }

    async fn create_test_state() -> AppState {
        let library = CalibreLibrary::open(":memory:").expect("Failed to open memory library");
        let store = SpineStore::open(":memory:").expect("Failed to open memory store");
        AppState {
            library: Mutex::new(library),
            store: Mutex::new(store),
            db_paths: None,
            loc_client: test_loc_cell(),
            job_queue: Arc::new(crate::jobs::LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(AtomicBool::new(false)),
            recent_libraries: Mutex::new(crate::RecentLibrariesState::default()),
        }
    }

    fn create_test_book() -> Book {
        Book {
            id: Uuid::new_v4(),
            title: "Test Book".to_string(),
            authors: vec!["Test Author".to_string()],
            legacy_metadata: LegacyMetadata {
                publisher: None,
                pub_date: None,
                series: None,
                series_index: None,
                tags: vec![],
                description: None,
                has_cover: false,
            },
            bibliographic_graph: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_hydrate_book_error_query() {
        // Create a shared in-memory database to simulate a failure
        let uri = "file:errordb?mode=memory&cache=shared";
        let store = SpineStore::open(uri).expect("Failed to open shared memory store");

        let library = CalibreLibrary::open(":memory:").expect("Failed to open memory library");
        let state = AppState {
            library: Mutex::new(library),
            store: Mutex::new(store),
            db_paths: None,
            loc_client: test_loc_cell(),
            job_queue: Arc::new(crate::jobs::LocalJobQueue),
            job_status: Mutex::new(std::collections::HashMap::new()),
            job_terminal_at: Mutex::new(std::collections::HashMap::new()),
            sync_in_progress: Arc::new(AtomicBool::new(false)),
            recent_libraries: Mutex::new(crate::RecentLibrariesState::default()),
        };

        let mut book = create_test_book();

        // Drop the tables behind the scenes to force an error in get_triples
        {
            let conn = rusqlite::Connection::open(uri).unwrap();
            conn.execute("DROP TABLE triples", []).unwrap();
        }

        // This will encounter a rusqlite error but should not panic,
        // leaving the bibliographic_graph as None.
        hydrate_book(&state, &mut book).await;

        assert!(
            book.bibliographic_graph.is_none(),
            "Graph should be None when database query errors"
        );
    }

    #[tokio::test]
    async fn test_hydrate_book_empty_triples() {
        let state = create_test_state().await;
        let mut book = create_test_book();

        // Database is empty, so no triples will be found
        hydrate_book(&state, &mut book).await;

        assert!(
            book.bibliographic_graph.is_none(),
            "Graph should be None when no triples exist"
        );
    }

    #[tokio::test]
    async fn test_hydrate_book_with_triples() {
        let state = create_test_state().await;
        let mut book = create_test_book();

        let graph_uri = format!("urn:spine:graph:book:{}", book.id);
        let accepted_graph = BibliographicGraph {
            work_uri: format!("urn:spine:work:{}", book.id),
            instance_uri: format!("urn:spine:instance:{}", book.id),
            work: Work {
                uri: format!("urn:spine:work:{}", book.id),
                title: Some("The Book Title".to_string()),
                origin_date: Some("1999".to_string()),
                subjects: vec![AuthorityLink {
                    uri: "http://id.loc.gov/authorities/subjects/sh000000".to_string(),
                    label: "Test Subject".to_string(),
                    source: "LCSH".to_string(),
                }],
                creators: vec![AgentLink {
                    uri: "http://id.loc.gov/authorities/names/n000000".to_string(),
                    name: "Test Creator".to_string(),
                    role: "aut".to_string(),
                }],
                language: Some("eng".to_string()),
                lccn: Some("99000000".to_string()),
                ddc: Some("813.54".to_string()),
            },
            instances: vec![Instance {
                uri: format!("urn:spine:instance:{}", book.id),
                format: "Print".to_string(),
                publication_date: Some("2001".to_string()),
                publisher: Some("Test Publisher".to_string()),
                isbn: Some("9780000000000".to_string()),
                oclc: Some("123456".to_string()),
            }],
        };

        {
            let store = state.store.lock().await;
            store
                .insert_graph_triples(
                    &graph_uri,
                    &spine_bf::bibliographic_graph_to_triples(&accepted_graph),
                )
                .unwrap();
        }

        hydrate_book(&state, &mut book).await;

        assert!(
            book.bibliographic_graph.is_some(),
            "Graph should be populated"
        );

        let graph = book.bibliographic_graph.unwrap();

        assert_eq!(graph.work_uri, accepted_graph.work_uri);
        assert_eq!(graph.work.title, Some("The Book Title".to_string()));
        assert_eq!(graph.work.origin_date, Some("1999".to_string()));
        assert_eq!(graph.work.language, Some("eng".to_string()));
        assert_eq!(graph.work.lccn, Some("99000000".to_string()));
        assert_eq!(graph.work.ddc, Some("813.54".to_string()));
        assert_eq!(graph.work.creators.len(), 1);
        assert_eq!(graph.work.creators[0].name, "Test Creator");
        assert_eq!(graph.work.creators[0].role, "aut");
        assert_eq!(graph.work.subjects.len(), 1);
        assert_eq!(graph.work.subjects[0].label, "Test Subject");
        assert_eq!(graph.instances.len(), 1);
        assert_eq!(graph.instances[0].format, "Print");
        assert_eq!(
            graph.instances[0].publication_date,
            Some("2001".to_string())
        );
        assert_eq!(
            graph.instances[0].publisher,
            Some("Test Publisher".to_string())
        );
        assert_eq!(graph.instances[0].isbn, Some("9780000000000".to_string()));
        assert_eq!(graph.instances[0].oclc, Some("123456".to_string()));
    }

    #[test]
    fn synthesize_golden_candidate_unifies_work_and_instance_uris() {
        // When synthesize produces a graph, the four URI fields must collapse
        // onto exactly two UUIDs: one for the work, one for the instance.
        // Regression guard for the earlier bug where four Uuid::new_v4() calls
        // produced four divergent URIs and downstream SPARQL lost its joins.
        let candidate = BibliographicGraph {
            work_uri: "http://example.org/w/1".to_string(),
            instance_uri: "http://example.org/i/1".to_string(),
            work: Work {
                uri: "http://example.org/w/1".to_string(),
                title: Some("A Title".to_string()),
                origin_date: Some("1950".to_string()),
                subjects: vec![],
                creators: vec![AgentLink {
                    uri: "http://example.org/a/1".to_string(),
                    name: "Author".to_string(),
                    role: "aut".to_string(),
                }],
                language: Some("eng".to_string()),
                lccn: None,
                ddc: None,
            },
            instances: vec![Instance {
                uri: "http://example.org/i/1".to_string(),
                format: "Print".to_string(),
                publication_date: Some("1950".to_string()),
                publisher: None,
                isbn: None,
                oclc: None,
            }],
        };

        let (graph, _reasoning) = synthesize_golden_candidate(&[candidate])
            .expect("synthesize should produce a graph for a non-empty input");

        assert_eq!(
            graph.work_uri, graph.work.uri,
            "graph.work_uri must equal graph.work.uri"
        );
        assert!(!graph.instances.is_empty(), "synthesized graph must have at least one instance");
        assert_eq!(
            graph.instance_uri, graph.instances[0].uri,
            "graph.instance_uri must equal graph.instances[0].uri"
        );
        assert_ne!(
            graph.work_uri, graph.instance_uri,
            "work URI and instance URI must not collide"
        );
    }

    #[test]
    fn synthesize_golden_candidate_returns_none_on_empty_input() {
        assert!(synthesize_golden_candidate(&[]).is_none());
    }

    #[test]
    fn normalizes_epub_resource_paths_and_rejects_traversal() {
        assert_eq!(
            normalize_epub_resource_path("/OEBPS/chapter.xhtml"),
            Some("OEBPS/chapter.xhtml".to_string())
        );
        assert_eq!(
            normalize_epub_resource_path("OEBPS\\images\\cover.jpg"),
            Some("OEBPS/images/cover.jpg".to_string())
        );
        assert_eq!(
            normalize_epub_resource_path("./OEBPS//chapter.xhtml"),
            Some("OEBPS/chapter.xhtml".to_string())
        );

        assert!(normalize_epub_resource_path("").is_none());
        assert!(normalize_epub_resource_path("../secret.txt").is_none());
        assert!(normalize_epub_resource_path("OEBPS/../secret.txt").is_none());
    }
}

fn clean_name(name: &str) -> String {
    let cleaned = name
        .trim()
        .trim_matches(|c| c == '.' || c == '[' || c == ']' || c == ',');
    if cleaned.contains(',') {
        return cleaned.to_string();
    }
    let parts: Vec<&str> = cleaned.split_whitespace().collect();
    if parts.len() > 1 {
        let last = parts.last().unwrap();
        let firsts = parts[..parts.len() - 1].join(" ");
        return format!("{}, {}", last, firsts);
    }
    cleaned.to_string()
}

async fn sync_calibre(State(state): State<Arc<AppState>>) -> Response {
    // Single-flight guard. The user can mash the Sync button; two overlapping
    // syncs would double-dispatch ingest jobs for the same un-ingested books.
    // compare_exchange succeeds exactly once per concurrent wave; subsequent
    // callers see the true value and get 409.
    if state
        .sync_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Sync already in progress" })),
        )
            .into_response();
    }

    // RAII drop: release the flag no matter how the body exits.
    struct SyncGuard(Arc<AtomicBool>);
    impl Drop for SyncGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _guard = SyncGuard(state.sync_in_progress.clone());

    // Phase 1: hold the library lock only while collecting the data we need
    // from it (book list + epub paths). We collect everything into owned Vecs
    // so the library lock is dropped before we touch the store or the job
    // queue. Previously the library mutex was held across both inner
    // `state.store.lock().await` and `state.job_queue.dispatch(...).await`,
    // which (a) serialised the entire sync behind the library mutex and (b)
    // created a lock-order hazard: any future code path that takes
    // store → library would deadlock.
    struct BookEntry {
        graph_uri: String,
        epub_path: Option<std::path::PathBuf>,
    }

    let entries: Vec<BookEntry> = {
        let lib = state.library.lock().await;
        lib.list_books()
            .unwrap_or_default()
            .into_iter()
            .map(|book| {
                let book_id = book.id.to_string();
                let graph_uri = graph_uri_for_str(&book_id);
                let epub_path = lib
                    .get_format_path(&book_id, "EPUB")
                    .ok()
                    .flatten()
                    .map(std::path::PathBuf::from);
                BookEntry {
                    graph_uri,
                    epub_path,
                }
            })
            .collect()
        // library lock released here
    };

    // Phase 2: single store lock to batch-check which books lack graphs.
    let uri_refs: Vec<&str> = entries.iter().map(|e| e.graph_uri.as_str()).collect();
    let triples_by_graph = {
        let store = state.store.lock().await;
        store.get_triples_batch(&uri_refs).unwrap_or_default()
        // store lock released here
    };

    // Phase 3: dispatch jobs for un-ingested books. No locks held.
    let mut jobs_dispatched = 0;
    for entry in &entries {
        if !triples_by_graph.contains_key(&entry.graph_uri) {
            if let Some(epub_path) = &entry.epub_path {
                let job = crate::jobs::Job::IngestEpub {
                    path: epub_path.clone(),
                    cleanup: false,
                };
                if state.job_queue.dispatch(job, state.clone()).await.is_ok() {
                    jobs_dispatched += 1;
                }
            }
        }
    }

    Json(serde_json::json!({ "jobs_dispatched": jobs_dispatched })).into_response()
}
