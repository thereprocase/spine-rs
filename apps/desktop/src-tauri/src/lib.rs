use axum::body::Body;
use axum::Router;
use base64::{engine::general_purpose, Engine as _};
use calibre_db::{CalibreLibrary, DualDbPaths, LibraryError};
use http::Request;
use spine_db::SpineStore;
use spine_srv::{create_desktop_router, AppState as SrvAppState};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tower::util::ServiceExt;
use tracing;

// Cap on the in-process bridge response body. A response larger than this is
// almost certainly a bug or an attack; reading it fully into memory would stall
// the UI and risk OOM on constrained devices.
const BRIDGE_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct DesktopSession {
    router: Router,
    srv_state: Arc<SrvAppState>,
    metadata_db_path: String,
}

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    current_library: Option<String>,
    recent_libraries: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStateSnapshot {
    current_library: Option<String>,
    recent_libraries: Vec<String>,
}

struct AppState {
    session: Mutex<Option<DesktopSession>>,
    config: Mutex<DesktopConfig>,
    config_path: PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BookResourceResponse {
    content_type: String,
    /// Size of the decoded (raw) resource bytes. This is what foliate-js's
    /// `getSize` actually wants — the logical resource size, not the
    /// transport envelope size.
    decoded_length: usize,
    /// Size of the base64-encoded `data_base64` string in bytes. Roughly 1.33×
    /// `decoded_length`; provided so callers that budget IPC buffers by the
    /// wire size have the honest number instead of inferring it.
    encoded_length: usize,
    data_base64: String,
}

/// HTTP methods the in-process bridge is permitted to forward. This is a belt
/// on top of the axum router's own route definitions: an attacker-controlled
/// method string could craft a request that matches no route (returning 405)
/// but still exercises method-dispatch overhead or triggers unexpected
/// behaviour in middleware. Limiting to known-good methods here is cheap.
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "HEAD"];

#[tauri::command]
async fn call_api(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    // Validate method before it reaches Request::builder. An arbitrary method
    // string like `CONNECT` or a crafted value with embedded whitespace could
    // behave unexpectedly in HTTP parsing code.
    let method_upper = method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method_upper.as_str()) {
        return Err(format!("Unsupported HTTP method: {method}"));
    }

    let session = current_session(&state).await?;
    tracing::debug!(method = %method, path = %path, ">>> Bridge Request");

    let mut request = Request::builder().method(method_upper.as_str()).uri(path);
    let request_body = body.unwrap_or_default();
    if !request_body.is_empty() {
        request = request.header(axum::http::header::CONTENT_TYPE, "application/json");
    }
    let req = request.body(Body::from(request_body)).map_err(|e| {
        tracing::error!("Request Builder Error: {}", e);
        e.to_string()
    })?;

    let router = session.router;

    let response = router.oneshot(req).await.map_err(|e| {
        tracing::error!("Router Execution Error: {}", e);
        e.to_string()
    })?;

    let status = response.status();
    tracing::debug!(status = %status, "<<< Bridge Response Status");

    let body_bytes = axum::body::to_bytes(response.into_body(), BRIDGE_MAX_BODY_BYTES)
        .await
        .map_err(|e| {
            tracing::error!("Body Read Error: {}", e);
            // to_bytes returns an error when the body exceeds the limit.
            if e.to_string().contains("body limit exceeded") {
                return "Response body exceeded 64 MB cap".to_string();
            }
            e.to_string()
        })?;

    let res_string = String::from_utf8_lossy(&body_bytes).to_string();
    if !status.is_success() {
        let detail = if res_string.is_empty() {
            status.to_string()
        } else {
            format!("{}: {}", status, res_string)
        };
        return Err(detail);
    }

    Ok(res_string)
}

#[tauri::command]
async fn read_book_resource(
    state: State<'_, AppState>,
    book_id: String,
    path: String,
) -> Result<BookResourceResponse, String> {
    let session = current_session(&state).await?;
    let resource = spine_srv::load_book_resource(&session.srv_state, &book_id, &path)
        .await
        .map_err(|e| e.to_string())?;

    let decoded_length = resource.bytes.len();
    let data_base64 = general_purpose::STANDARD.encode(&resource.bytes);
    let encoded_length = data_base64.len();
    Ok(BookResourceResponse {
        content_type: resource.content_type,
        decoded_length,
        encoded_length,
        data_base64,
    })
}

/// Cap the export-zip write to something sensible so a runaway library can't
/// accidentally drop a 10 GB file on the user's disk when they meant to save
/// a single book. 2 GB is the conservative ceiling; the export endpoint's
/// own book-size is bounded by the bridge response cap (64 MB) — but a
/// separate safeguard here makes the intent explicit.
const EXPORT_MAX_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// Validate a `dest_path` for `export_book_to_disk`. Returns `Ok(())` when the
/// path is safe to write to, or an error string describing the specific
/// violation.
///
/// Rules (in order):
/// 1. No null bytes — they truncate paths silently in C-layer APIs.
/// 2. Must be absolute — relative paths are ambiguous and indicate a caller
///    error; the save dialog always produces an absolute path.
/// 3. No `..` components — defence-in-depth against traversal past the
///    save-dialog root.
/// 4. Must end with `.zip` — the export produces a zip archive; any other
///    extension indicates a caller error.
fn validate_dest_path(dest_path: &str) -> Result<(), String> {
    if dest_path.contains('\0') {
        return Err("dest_path contains a null byte".to_string());
    }
    if !std::path::Path::new(dest_path).is_absolute() {
        return Err(format!(
            "dest_path '{}' is not an absolute path; export requires an absolute path",
            dest_path
        ));
    }
    for component in std::path::Path::new(dest_path).components() {
        if component == std::path::Component::ParentDir {
            return Err(
                "dest_path contains a '..' component; path traversal not allowed".to_string(),
            );
        }
    }
    let dest_lower = dest_path.to_ascii_lowercase();
    if !dest_lower.ends_with(".zip") {
        return Err(format!(
            "dest_path '{}' does not end with .zip; export produces a zip archive",
            dest_path
        ));
    }
    Ok(())
}

/// Exports a single book's format files + OPF to a user-selected zip path.
///
/// Thin wrapper around `POST /api/v1/book/:id/export`: calls the endpoint
/// through the in-process router (same path a remote frontend would take),
/// then writes the returned zip bytes to the chosen path. Keeping the write
/// in Rust avoids shuttling a potentially large zip body through two IPC
/// hops (backend → JS → Tauri). The backend's error codes are surfaced
/// verbatim so the UI can map 404/503/other consistently.
#[tauri::command]
async fn export_book_to_disk(
    state: State<'_, AppState>,
    book_id: String,
    dest_path: String,
) -> Result<(), String> {
    // Validate book_id is a well-formed UUID before it reaches the router
    // path interpolation. An arbitrary string here could produce a path like
    // `/api/v1/book/../something/export` if not validated.
    uuid::Uuid::parse_str(&book_id).map_err(|_| {
        format!("book_id '{}' is not a valid UUID", book_id)
    })?;

    validate_dest_path(&dest_path).map_err(|e| e)?;

    let session = current_session(&state).await?;
    let path = format!("/api/v1/book/{}/export", book_id);
    let request = Request::builder()
        .method("POST")
        .uri(&path)
        .body(Body::empty())
        .map_err(|e| e.to_string())?;

    let response = session
        .router
        .oneshot(request)
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let body = axum::body::to_bytes(response.into_body(), BRIDGE_MAX_BODY_BYTES)
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&body).to_string();
        // Preserve status prefix in the error so the frontend can branch on it.
        return Err(format!("{}: {}", status.as_u16(), text));
    }

    let body = axum::body::to_bytes(response.into_body(), EXPORT_MAX_BYTES)
        .await
        .map_err(|e| {
            if e.to_string().contains("body limit exceeded") {
                "Export exceeded 2 GB cap".to_string()
            } else {
                e.to_string()
            }
        })?;

    // tokio::fs so we don't block the async runtime on a slow disk.
    tokio::fs::write(&dest_path, &body)
        .await
        .map_err(|e| format!("Failed to write {}: {}", dest_path, e))?;
    Ok(())
}

/// List EPUB files in a directory (non-recursive). Returns canonicalized
/// absolute paths. Used by the "Add a folder of EPUBs" first-run entry
/// point: the frontend passes each returned path to `dispatch_ingest_local`.
///
/// Non-recursive is intentional — `calibre Library/` on disk nests author
/// and book subfolders, and we don't want to ingest every EPUB under a
/// pre-existing calibre library if the user accidentally picks it here.
#[tauri::command]
async fn list_epubs_in_dir(dir: String) -> Result<Vec<String>, String> {
    let trimmed = dir.trim().trim_matches(|c| c == '"' || c == '\'');
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!(
            "'{}' is not a directory",
            path.to_string_lossy()
        ));
    }
    let entries = fs::read_dir(&path)
        .map_err(|e| format!("Failed to read '{}': {}", path.to_string_lossy(), e))?;

    let mut epubs = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let is_epub = entry_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("epub"))
            .unwrap_or(false);
        if !is_epub {
            continue;
        }
        match fs::canonicalize(&entry_path) {
            Ok(canon) => epubs.push(strip_verbatim_prefix(&canon).to_string_lossy().to_string()),
            Err(_) => continue,
        }
    }
    epubs.sort();
    Ok(epubs)
}

#[tauri::command]
async fn dispatch_ingest_local(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let session = current_session(&state).await?;
    tracing::info!(path = %path, "Dispatching Ingest Job");
    let job = spine_srv::jobs::Job::IngestEpub {
        path: std::path::PathBuf::from(path),
        cleanup: false,
    };
    let job_id = session
        .srv_state
        .job_queue
        .dispatch(job, session.srv_state.clone())
        .await
        .map_err(|e| format!("Failed to dispatch job: {}", e))?;

    Ok(job_id.0.to_string())
}

/// Resolve the bundled welcome.epub, copy it to a per-library stable
/// location, and dispatch an ingest job against it. Called by the frontend
/// after a fresh `create_library` so the user lands in a non-empty library
/// with something to read.
///
/// The file is copied into the library directory before ingest because the
/// ingest pipeline expects the source file to remain readable for the life
/// of the job, and the resource path inside an installed MSI is read-only
/// and opaque.
#[tauri::command]
async fn seed_welcome_book(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let session = current_session(&state).await?;

    let welcome_resource = app
        .path()
        .resolve(
            "resources/welcome/welcome.epub",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to locate welcome book resource: {}", e))?;

    if !welcome_resource.exists() {
        return Err(format!(
            "Bundled welcome.epub missing at '{}'. This is a packaging bug.",
            welcome_resource.to_string_lossy()
        ));
    }

    let library_dir = Path::new(&session.metadata_db_path)
        .parent()
        .ok_or_else(|| "Library path has no parent directory".to_string())?;
    let staged = library_dir.join("welcome.epub");

    if !staged.exists() {
        fs::copy(&welcome_resource, &staged).map_err(|e| {
            format!(
                "Failed to stage welcome.epub in library: {}",
                e
            )
        })?;
    }

    let job = spine_srv::jobs::Job::IngestEpub {
        path: staged,
        cleanup: false,
    };
    let job_id = session
        .srv_state
        .job_queue
        .dispatch(job, session.srv_state.clone())
        .await
        .map_err(|e| format!("Failed to dispatch welcome-book ingest: {}", e))?;

    Ok(job_id.0.to_string())
}

#[tauri::command]
async fn get_desktop_state(state: State<'_, AppState>) -> Result<DesktopStateSnapshot, String> {
    let current_library = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| session.metadata_db_path.clone());
    let config = state.config.lock().await.clone();
    Ok(DesktopStateSnapshot {
        current_library,
        recent_libraries: config.recent_libraries,
    })
}

/// Copy the bundled calibre template into `dir_path` as `metadata.db`, rotate
/// the `library_id.uuid` to a fresh v4 so every Spine library has a unique
/// identity, then open the new library as the active session.
///
/// Intended for the first-run bootstrap "Start a new library" path. Rejects
/// if `dir_path` already contains a `metadata.db` to avoid clobbering an
/// existing library.
#[tauri::command]
async fn create_library(
    app: AppHandle,
    state: State<'_, AppState>,
    dir_path: String,
) -> Result<DesktopStateSnapshot, String> {
    let template_path = app
        .path()
        .resolve(
            "resources/calibre-template.db",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to locate bundled calibre template: {}", e))?;

    let target_db = seed_library_at(&dir_path, &template_path)?;

    // Reuse the same build_session path as open_library so new and existing
    // libraries have identical runtime shape from here on.
    let session = build_session(&target_db.to_string_lossy())?;

    {
        let mut active_session = state.session.lock().await;
        *active_session = Some(session.clone());
    }

    let snapshot = {
        let mut config = state.config.lock().await;
        remember_library(&mut config, &session.metadata_db_path);
        save_config(&state.config_path, &config)?;
        DesktopStateSnapshot {
            current_library: Some(session.metadata_db_path.clone()),
            recent_libraries: config.recent_libraries.clone(),
        }
    };

    // Mirror the recent_libraries mutation into spine-srv's in-memory
    // snapshot so GET /api/v1/library/list returns the same data the
    // desktop UI sees via desktopState.recentLibraries. Tauri shell
    // stays the durable store (DesktopConfig persistence); this is
    // option B push-down per CLAUDE.md "Server-first, HTTP-contract
    // architecture is locked." Lock contention is negligible — no
    // concurrent caller can hit the same path between the config
    // block above and this push on one user action.
    session
        .srv_state
        .push_recent_library(session.metadata_db_path.clone())
        .await;

    Ok(snapshot)
}

#[tauri::command]
async fn open_library(
    state: State<'_, AppState>,
    metadata_db_path: String,
) -> Result<DesktopStateSnapshot, String> {
    let session = build_session(&metadata_db_path)?;

    {
        let mut active_session = state.session.lock().await;
        *active_session = Some(session.clone());
    }

    let snapshot = {
        let mut config = state.config.lock().await;
        remember_library(&mut config, &session.metadata_db_path);
        save_config(&state.config_path, &config)?;
        DesktopStateSnapshot {
            current_library: Some(session.metadata_db_path.clone()),
            recent_libraries: config.recent_libraries.clone(),
        }
    };

    session
        .srv_state
        .push_recent_library(session.metadata_db_path.clone())
        .await;

    Ok(snapshot)
}

/// Initialize tracing with both stderr and a daily-rolling file under the
/// platform's user data directory (`%APPDATA%\Spine\logs\` on Windows,
/// `~/.local/share/Spine/logs/` on Linux, `~/Library/Application Support/
/// Spine/logs/` on macOS). The packaged Windows MSI has no attached console,
/// so stderr is `/dev/null` for release users — without the file sink, bug
/// reports arrive with zero evidence.
///
/// The non-blocking writer's guard is intentionally leaked. Dropping the
/// guard stops its worker thread and may discard buffered records; the app
/// owns this writer for the full process lifetime so leaking it is the
/// correct shape, not a bug.
fn init_logging() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let file_layer = dirs::data_dir().and_then(|base| {
        let log_dir = base.join("Spine").join("logs");
        if let Err(error) = std::fs::create_dir_all(&log_dir) {
            eprintln!(
                "Spine: failed to create log dir {}: {error}",
                log_dir.display()
            );
            return None;
        }
        let appender = tracing_appender::rolling::daily(&log_dir, "spine.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        Box::leak(Box::new(guard));
        Some(fmt::layer().with_writer(writer).with_ansi(false))
    });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(file_layer)
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!("Initializing Spine Core (In-Process)");

    let config_path = default_config_path();
    let mut config = load_config(&config_path);
    let initial_library = std::env::var("CALIBRE_DB_PATH")
        .ok()
        .or_else(|| config.current_library.clone());
    let session = initial_library
        .as_deref()
        .and_then(|path| match build_session(path) {
            Ok(session) => {
                remember_library(&mut config, &session.metadata_db_path);
                if let Err(error) = save_config(&config_path, &config) {
                    tracing::error!(error = %error, "Failed to persist desktop config");
                }
                Some(session)
            }
            Err(error) => {
                tracing::warn!(path = %path, error = %error, "Failed to restore desktop library");
                None
            }
        });

    // Hydrate spine-srv's recent_libraries snapshot from the durable
    // Tauri DesktopConfig store so GET /api/v1/library/list returns the
    // full recent list on cold boot, not just whatever was auto-opened.
    // push_recent_library inserts at index 0 and dedups, so iterating
    // .rev() preserves the original most-recent-first ordering once
    // every entry lands. Skipped when no session — no srv_state to
    // push to until a library opens.
    if let Some(ref s) = session {
        let srv_state = s.srv_state.clone();
        let recents: Vec<String> = config.recent_libraries.iter().rev().cloned().collect();
        tauri::async_runtime::block_on(async move {
            for path in recents {
                srv_state.push_recent_library(path).await;
            }
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            session: Mutex::new(session),
            config: Mutex::new(config),
            config_path,
        })
        .invoke_handler(tauri::generate_handler![
            call_api,
            read_book_resource,
            dispatch_ingest_local,
            export_book_to_disk,
            get_desktop_state,
            open_library,
            create_library,
            list_epubs_in_dir,
            seed_welcome_book
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn current_session(state: &State<'_, AppState>) -> Result<DesktopSession, String> {
    state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "No library selected. Open a calibre metadata.db first.".to_string())
}

/// Maps rusqlite open errors to human-readable English messages shown in the UI.
///
/// Raw rusqlite error strings include low-level SQLite detail that is not
/// meaningful to a user. The two codes we translate here cover the two most
/// common failure modes when the user picks the wrong file.
///
/// User-facing messages show only the filename (basename), not the full path.
/// Full paths after canonicalize can include OS usernames and home-directory
/// structure that the user did not consent to share if the message appears in
/// a log or a bug report. The full path is logged at `tracing::error!` for
/// local debugging but never returned to the frontend.
/// Translate a `calibre_db::LibraryError` from `CalibreLibrary::open` into a
/// user-facing string. The S8.5 typed-errors hot-fix added two new variants
/// (`Uninitialized`, `WrongDatabaseFile`) that distinguish "this file opens
/// but is empty / wrong shape" from low-level SQLite errors. Surface them
/// with actionable messages; fall through to the existing rusqlite mapper
/// for the wrapped `Sqlite` variant so the CannotOpen / NotADatabase
/// translations still apply.
fn map_library_open_error(e: &LibraryError, path: &str) -> String {
    let basename = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("metadata.db");
    match e {
        LibraryError::Uninitialized { .. } => {
            tracing::error!(path = %path, error = %e, "Calibre library schema missing");
            format!(
                "Library at '{}' is empty — open the folder once with calibre to populate the schema, then retry",
                basename
            )
        }
        LibraryError::WrongDatabaseFile { .. } => {
            tracing::error!(path = %path, error = %e, "File is SQLite but not a calibre library");
            format!(
                "'{}' is a SQLite database but not a calibre library — pick a different file",
                basename
            )
        }
        LibraryError::Sqlite { source, .. } => map_rusqlite_open_error(source, path),
    }
}

fn map_rusqlite_open_error(e: &rusqlite::Error, path: &str) -> String {
    use rusqlite::ErrorCode;
    let basename = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("metadata.db");
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = e {
        match ffi_err.code {
            ErrorCode::CannotOpen => {
                tracing::error!(path = %path, error = %e, "Failed to open calibre db (CannotOpen)");
                return format!(
                    "Library file could not be opened — it may be in use or permissions are wrong ({})",
                    basename
                );
            }
            ErrorCode::NotADatabase => {
                tracing::error!(path = %path, error = %e, "Failed to open calibre db (NotADatabase)");
                return format!(
                    "The file '{}' is not a valid SQLite database",
                    basename
                );
            }
            _ => {}
        }
    }
    // For all other codes: show the user a generic message and log the raw
    // detail. Do not surface the raw rusqlite string to the UI — it can
    // contain filesystem paths and internal detail the user cannot act on.
    tracing::error!(path = %path, error = %e, "Failed to open calibre db");
    "Failed to open library database — check the logs for details".to_string()
}

fn build_session(metadata_db_path: &str) -> Result<DesktopSession, String> {
    let metadata_db = canonical_metadata_db_path(metadata_db_path)?;
    let spine_db_path = metadata_db
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("spine.db");
    let library = CalibreLibrary::open(&metadata_db.to_string_lossy())
        .map_err(|e| map_library_open_error(&e, &metadata_db.to_string_lossy()))?;
    let store = SpineStore::open(&spine_db_path.to_string_lossy())
        .map_err(|e| format!("Failed to open spine db: {}", e))?;

    // Pre-populate the loc_client cell at library-open time on desktop.
    // Failure here is surfaced to the user immediately rather than deferred.
    let loc_client_cell = std::sync::OnceLock::new();
    loc_client_cell
        .set(Some(
            spine_meta::LocClient::new()
                .map_err(|e| format!("Failed to initialize metadata client: {}", e))?,
        ))
        .unwrap(); // unwrap: cell is fresh; set never fails on a fresh cell

    let srv_state = Arc::new(SrvAppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: metadata_db.to_string_lossy().to_string(),
            spine_db: spine_db_path.to_string_lossy().to_string(),
        }),
        loc_client: Arc::new(loc_client_cell),
        job_queue: Arc::new(spine_srv::jobs::LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    Ok(DesktopSession {
        router: create_desktop_router(srv_state.clone()),
        srv_state,
        metadata_db_path: metadata_db.to_string_lossy().to_string(),
    })
}

/// Sync helper behind `create_library`. Resolves the target directory,
/// rejects a pre-existing `metadata.db` (non-destructive), copies the
/// template into place, and rotates the library UUID. Returns the path to
/// the seeded `metadata.db` on success. Unit-testable; does not depend on
/// `AppHandle`.
fn seed_library_at(dir_path: &str, template_path: &Path) -> Result<PathBuf, String> {
    let target_dir = canonical_new_library_dir(dir_path)?;
    let target_db = target_dir.join("metadata.db");

    if target_db.exists() {
        return Err(format!(
            "A library already exists at '{}'. Open it instead of creating a new one.",
            target_dir.to_string_lossy()
        ));
    }

    if !template_path.exists() {
        return Err(format!(
            "Bundled calibre template missing at '{}'. This is a packaging bug.",
            template_path.to_string_lossy()
        ));
    }

    fs::copy(template_path, &target_db).map_err(|e| {
        format!(
            "Failed to seed new library at '{}': {}",
            target_db.to_string_lossy(),
            e
        )
    })?;

    rotate_library_uuid(&target_db).map_err(|e| {
        // Roll back the half-created library so the user can retry.
        let _ = fs::remove_file(&target_db);
        format!(
            "Failed to initialize library identity at '{}': {}",
            target_db.to_string_lossy(),
            e
        )
    })?;

    Ok(target_db)
}

/// Strip Windows verbatim prefixes (`\\?\C:\…`, `\\?\UNC\server\share\…`)
/// produced by `fs::canonicalize`. The verbatim form is correct for the
/// filesystem APIs that emit it but renders ugly in the UI and breaks tools
/// (sqlite, foliate, browser file inputs) that don't strip it themselves.
///
/// Apply at every boundary where a canonicalized path crosses into a string
/// surfaced to the frontend or persisted to config. Non-verbatim paths and
/// non-Windows targets pass through unchanged.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            // \\?\UNC\server\share\rest  →  \\server\share\rest
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            // \\?\C:\rest  →  C:\rest
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Validate a user-chosen directory for a *new* library and return its
/// canonical path. Inverts the existence semantics of
/// `canonical_metadata_db_path`: the target directory may or may not exist,
/// but if it does exist it must be a directory (not a file), and the caller
/// will reject a pre-existing `metadata.db` inside it separately.
///
/// Creates the directory if it does not exist. Strips surrounding whitespace
/// and quote characters for parity with paste-from-Explorer ergonomics.
fn canonical_new_library_dir(dir_path: &str) -> Result<PathBuf, String> {
    let trimmed = dir_path.trim().trim_matches(|c| c == '"' || c == '\'');

    if trimmed.is_empty() {
        return Err("Library directory cannot be empty".to_string());
    }

    let dir = PathBuf::from(trimmed);

    if dir.exists() && !dir.is_dir() {
        return Err(format!(
            "'{}' exists but is not a directory",
            dir.to_string_lossy()
        ));
    }

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| {
            format!(
                "Failed to create library directory '{}': {}",
                dir.to_string_lossy(),
                e
            )
        })?;
    }

    fs::canonicalize(&dir)
        .map(|p| strip_verbatim_prefix(&p))
        .map_err(|e| {
            format!(
                "Failed to resolve library directory '{}': {}",
                dir.to_string_lossy(),
                e
            )
        })
}

/// Rotate the `library_id.uuid` row in a freshly-copied template metadata.db
/// to a new v4 UUID. The checked-in template carries the UUID calibre minted
/// when it generated the seed; if we skipped this every new Spine library
/// would share identity, which breaks any BIBFRAME-side identifier that
/// depends on the library UUID.
fn rotate_library_uuid(metadata_db: &Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(metadata_db)?;
    let fresh = uuid::Uuid::new_v4().to_string();
    let updated = conn.execute("UPDATE library_id SET uuid = ?", [fresh])?;
    if updated == 0 {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::Unknown,
                extended_code: 0,
            },
            Some("library_id row missing in template metadata.db".to_string()),
        ));
    }
    Ok(())
}

fn canonical_metadata_db_path(metadata_db_path: &str) -> Result<PathBuf, String> {
    // Strip surrounding whitespace, then surrounding quote characters that
    // Windows users commonly add when pasting paths from Explorer.
    let trimmed = metadata_db_path.trim().trim_matches(|c| c == '"' || c == '\'');

    if trimmed.is_empty() {
        return Err("Library path cannot be empty".to_string());
    }

    let mut metadata_db = PathBuf::from(trimmed);

    // Track whether we auto-appended metadata.db so the missing-file error
    // can tell the user they pointed at a folder rather than a file.
    let mut came_from_folder: Option<String> = None;

    // If the user pointed at a directory, auto-append metadata.db so they
    // can drag-drop a library folder instead of hunting for the file.
    if metadata_db.is_dir() {
        came_from_folder = Some(metadata_db.to_string_lossy().into_owned());
        metadata_db = metadata_db.join("metadata.db");
    }

    if metadata_db.file_name().and_then(|name| name.to_str()) != Some("metadata.db") {
        return Err("Library path must point to a calibre metadata.db file".to_string());
    }
    if !metadata_db.exists() {
        if let Some(folder_display) = came_from_folder {
            return Err(format!(
                "Folder '{}' does not contain a calibre metadata.db file",
                folder_display
            ));
        }
        return Err(format!(
            "Library file does not exist: {}",
            metadata_db.to_string_lossy()
        ));
    }
    fs::canonicalize(&metadata_db)
        .map(|p| strip_verbatim_prefix(&p))
        .map_err(|e| {
            format!(
                "Failed to resolve library path '{}': {}",
                metadata_db.to_string_lossy(),
                e
            )
        })
}

fn remember_library(config: &mut DesktopConfig, metadata_db_path: &str) {
    config.current_library = Some(metadata_db_path.to_string());
    config
        .recent_libraries
        .retain(|existing| existing != metadata_db_path);
    config
        .recent_libraries
        .insert(0, metadata_db_path.to_string());
    config.recent_libraries.truncate(5);
}

// Reject config files larger than 1 MB. A legitimate desktop-state.json only
// holds a handful of recent library paths; anything larger is either corrupted
// or an attempt to force a large deserialization allocation.
const CONFIG_MAX_BYTES: u64 = 1024 * 1024;

fn load_config(path: &Path) -> DesktopConfig {
    let size_ok = fs::metadata(path)
        .map(|m| m.len() <= CONFIG_MAX_BYTES)
        .unwrap_or(true); // missing file is fine — we'll return the default
    if !size_ok {
        tracing::warn!(path = %path.display(), "Desktop config exceeds 1 MB and was ignored");
        return DesktopConfig::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(path: &Path, config: &DesktopConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let body = serde_json::to_vec_pretty(config)
        .map_err(|e| format!("Failed to serialize desktop config: {}", e))?;
    fs::write(path, body).map_err(|e| format!("Failed to write desktop config: {}", e))
}

fn default_config_path() -> PathBuf {
    let app_dir = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Spine")
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Library")
            .join("Application Support")
            .join("Spine")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .unwrap_or_else(std::env::temp_dir)
            .join("spine")
    };

    app_dir.join("desktop-state.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- call_api method allow-list ---

    fn is_method_allowed(method: &str) -> bool {
        let upper = method.to_ascii_uppercase();
        ALLOWED_METHODS.contains(&upper.as_str())
    }

    #[test]
    fn allowed_methods_accepted() {
        for method in &["GET", "POST", "PUT", "DELETE", "HEAD"] {
            assert!(is_method_allowed(method), "{method} should be allowed");
        }
        // Case-insensitive: lowercase variants must also pass.
        for method in &["get", "post", "put", "delete", "head"] {
            assert!(is_method_allowed(method), "lowercase {method} should be allowed");
        }
    }

    #[test]
    fn trace_rejected() {
        assert!(!is_method_allowed("TRACE"), "TRACE must be rejected");
        assert!(!is_method_allowed("trace"), "trace must be rejected");
    }

    #[test]
    fn connect_rejected() {
        assert!(!is_method_allowed("CONNECT"), "CONNECT must be rejected");
    }

    #[test]
    fn arbitrary_string_rejected() {
        assert!(!is_method_allowed("FOOBAR"), "arbitrary method must be rejected");
        assert!(!is_method_allowed(""), "empty string must be rejected");
    }

    // --- map_rusqlite_open_error path elision ---

    #[test]
    fn cannot_open_shows_basename_not_full_path() {
        let full_path = "/home/alice/Documents/My Library/metadata.db";
        let ffi_err = rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::CannotOpen,
            extended_code: 0,
        };
        let e = rusqlite::Error::SqliteFailure(ffi_err, None);
        let msg = map_rusqlite_open_error(&e, full_path);
        assert!(
            msg.contains("metadata.db"),
            "message should contain the filename"
        );
        assert!(
            !msg.contains("/home/alice"),
            "message must not contain the full path with username"
        );
    }

    #[test]
    fn not_a_database_shows_basename_not_full_path() {
        let full_path = "/home/alice/Documents/My Library/metadata.db";
        let ffi_err = rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::NotADatabase,
            extended_code: 0,
        };
        let e = rusqlite::Error::SqliteFailure(ffi_err, None);
        let msg = map_rusqlite_open_error(&e, full_path);
        assert!(
            msg.contains("metadata.db"),
            "message should contain the filename"
        );
        assert!(
            !msg.contains("/home/alice"),
            "message must not contain the full path with username"
        );
    }

    // --- map_library_open_error (typed LibraryError → user message) ---

    #[test]
    fn uninitialized_library_message_is_actionable() {
        let full_path = "/home/alice/Documents/Empty Library/metadata.db";
        let e = LibraryError::Uninitialized {
            path: full_path.to_string(),
        };
        let msg = map_library_open_error(&e, full_path);
        assert!(msg.contains("metadata.db"), "message should include filename");
        assert!(
            msg.to_lowercase().contains("empty") || msg.to_lowercase().contains("uninitialized"),
            "message should explain the file is uninitialized: {msg}"
        );
        assert!(
            !msg.contains("/home/alice"),
            "message must not leak the full path with username"
        );
    }

    #[test]
    fn wrong_database_file_message_is_actionable() {
        let full_path = "/home/alice/Documents/random.sqlite";
        let e = LibraryError::WrongDatabaseFile {
            path: full_path.to_string(),
        };
        let msg = map_library_open_error(&e, full_path);
        assert!(msg.contains("random.sqlite"), "message should include filename");
        assert!(
            msg.to_lowercase().contains("not a calibre"),
            "message should say it's not a calibre library: {msg}"
        );
        assert!(
            !msg.contains("/home/alice"),
            "message must not leak the full path with username"
        );
    }

    #[test]
    fn library_error_sqlite_delegates_to_rusqlite_mapper() {
        let full_path = "/home/alice/Documents/My Library/metadata.db";
        let ffi_err = rusqlite::ffi::Error {
            code: rusqlite::ErrorCode::CannotOpen,
            extended_code: 0,
        };
        let source = rusqlite::Error::SqliteFailure(ffi_err, None);
        let e = LibraryError::Sqlite {
            path: full_path.to_string(),
            source,
        };
        let msg = map_library_open_error(&e, full_path);
        // Same surface as map_rusqlite_open_error for CannotOpen.
        assert!(msg.contains("metadata.db"));
        assert!(!msg.contains("/home/alice"));
    }

    // --- validate_dest_path ---

    #[test]
    fn dest_path_absolute_zip_accepted() {
        // A clean absolute path ending in .zip must pass all checks.
        #[cfg(unix)]
        assert!(
            validate_dest_path("/home/alice/exports/book.zip").is_ok(),
            "absolute .zip path must be accepted on Unix"
        );
        #[cfg(windows)]
        assert!(
            validate_dest_path("C:\\Users\\alice\\exports\\book.zip").is_ok(),
            "absolute .zip path must be accepted on Windows"
        );
    }

    #[test]
    fn dest_path_relative_rejected() {
        assert!(
            validate_dest_path("exports/book.zip").is_err(),
            "relative path must be rejected"
        );
        assert!(
            validate_dest_path("book.zip").is_err(),
            "bare filename (relative) must be rejected"
        );
    }

    #[test]
    fn dest_path_non_zip_extension_rejected() {
        #[cfg(unix)]
        assert!(
            validate_dest_path("/home/alice/exports/book.tar").is_err(),
            ".tar extension must be rejected"
        );
        #[cfg(windows)]
        assert!(
            validate_dest_path("C:\\Users\\alice\\exports\\book.tar").is_err(),
            ".tar extension must be rejected on Windows"
        );
    }

    #[test]
    fn dest_path_null_byte_rejected() {
        assert!(
            validate_dest_path("/home/alice/book\0evil.zip").is_err(),
            "null byte in path must be rejected"
        );
    }

    #[test]
    fn dest_path_dotdot_component_rejected() {
        // An absolute path with ".." can traverse outside the save-dialog root.
        #[cfg(unix)]
        assert!(
            validate_dest_path("/home/alice/../root/book.zip").is_err(),
            "'..' component must be rejected even in absolute path"
        );
        #[cfg(windows)]
        assert!(
            validate_dest_path("C:\\Users\\alice\\..\\Administrator\\book.zip").is_err(),
            "'..' component must be rejected on Windows"
        );
    }

    // --- canonical_new_library_dir ---

    #[test]
    fn new_library_dir_empty_rejected() {
        assert!(canonical_new_library_dir("").is_err());
        assert!(canonical_new_library_dir("   ").is_err());
        assert!(canonical_new_library_dir("\"\"").is_err());
    }

    #[test]
    fn new_library_dir_creates_if_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "spine-test-create-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(!tmp.exists());
        let canonical = canonical_new_library_dir(tmp.to_str().unwrap())
            .expect("should create fresh dir");
        assert!(canonical.exists());
        assert!(canonical.is_dir());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn new_library_dir_rejects_file() {
        let tmp = std::env::temp_dir().join(format!(
            "spine-test-notdir-{}.txt",
            uuid::Uuid::new_v4()
        ));
        fs::write(&tmp, b"hi").unwrap();
        let err = canonical_new_library_dir(tmp.to_str().unwrap())
            .expect_err("file-at-path must be rejected");
        assert!(err.to_lowercase().contains("not a directory"), "{}", err);
        let _ = fs::remove_file(&tmp);
    }

    // --- strip_verbatim_prefix ---

    #[test]
    fn strip_passthrough_for_plain_path() {
        let p = Path::new("/tmp/foo");
        assert_eq!(strip_verbatim_prefix(p), PathBuf::from("/tmp/foo"));
    }

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_disk_prefix() {
        let p = Path::new(r"\\?\C:\Users\alice\Library\metadata.db");
        assert_eq!(
            strip_verbatim_prefix(p),
            PathBuf::from(r"C:\Users\alice\Library\metadata.db")
        );
    }

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_unc_prefix() {
        let p = Path::new(r"\\?\UNC\server\share\Books\metadata.db");
        assert_eq!(
            strip_verbatim_prefix(p),
            PathBuf::from(r"\\server\share\Books\metadata.db")
        );
    }

    #[cfg(windows)]
    #[test]
    fn strip_passthrough_for_already_clean_windows_path() {
        let p = Path::new(r"C:\Users\alice\Library\metadata.db");
        assert_eq!(
            strip_verbatim_prefix(p),
            PathBuf::from(r"C:\Users\alice\Library\metadata.db")
        );
    }

    // --- seed_library_at (exercises the full copy + rotate path) ---

    fn template_path_for_tests() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/calibre-template.db")
    }

    #[test]
    fn seed_into_empty_dir_succeeds() {
        let dir = std::env::temp_dir().join(format!(
            "spine-test-seed-empty-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();

        let target = seed_library_at(dir.to_str().unwrap(), &template_path_for_tests())
            .expect("empty dir must accept a fresh library");
        assert!(target.exists(), "metadata.db must be written");
        assert_eq!(target.file_name().unwrap(), "metadata.db");

        // UUID is rotated (not equal to the seed UUID recorded in
        // docs/CALIBRE_TEMPLATE_DB.md).
        let conn = rusqlite::Connection::open(&target).unwrap();
        let uuid: String = conn
            .query_row("SELECT uuid FROM library_id", [], |r| r.get(0))
            .unwrap();
        assert_ne!(uuid, "7f71ade3-eb11-4d0b-ad22-f45f31e40d5d");
        drop(conn);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_into_dir_with_epubs_succeeds() {
        // "Add a folder of EPUBs" is the primary path — the dir WILL have
        // files in it. The helper must not reject that.
        let dir = std::env::temp_dir().join(format!(
            "spine-test-seed-epubs-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("alice.epub"), b"PK\x03\x04fake-epub").unwrap();
        fs::write(dir.join("README.txt"), b"hello").unwrap();

        let target = seed_library_at(dir.to_str().unwrap(), &template_path_for_tests())
            .expect("dir with user files must accept a fresh library");
        assert!(target.exists());

        // Pre-existing files are untouched.
        assert!(dir.join("alice.epub").exists());
        assert!(dir.join("README.txt").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_rejects_existing_metadata_db() {
        let dir = std::env::temp_dir().join(format!(
            "spine-test-seed-reject-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        // Pre-populate a "library" to simulate a returning user pointing
        // the New dialog at their existing library by accident.
        fs::write(dir.join("metadata.db"), b"pre-existing content").unwrap();

        let err = seed_library_at(dir.to_str().unwrap(), &template_path_for_tests())
            .expect_err("pre-existing metadata.db must prevent clobbering");
        assert!(
            err.to_lowercase().contains("already exists"),
            "error must name the collision: {}",
            err
        );

        // The pre-existing file was NOT overwritten.
        let body = fs::read(dir.join("metadata.db")).unwrap();
        assert_eq!(body, b"pre-existing content");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_creates_missing_parent_dir() {
        // User typed a path that doesn't exist yet (default: ~/Documents/Spine Library
        // with the Spine Library subdir absent). mkdir-if-missing path.
        let dir = std::env::temp_dir().join(format!(
            "spine-test-seed-mkdir-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(!dir.exists(), "precondition: dir must be absent");

        let target = seed_library_at(dir.to_str().unwrap(), &template_path_for_tests())
            .expect("helper must mkdir and seed");
        assert!(target.exists());
        assert!(dir.exists() && dir.is_dir());

        let _ = fs::remove_dir_all(&dir);
    }

    // --- rotate_library_uuid ---
    //
    // Exercises against the real checked-in template so the test closes the
    // loop: if someone regenerates the template without the library_id row,
    // this test fails immediately.

    #[test]
    fn rotate_uuid_against_checked_in_template() {
        // Locate the template relative to the Cargo manifest dir so the test
        // works regardless of where cargo was invoked from.
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let template = manifest_dir.join("resources/calibre-template.db");
        assert!(
            template.exists(),
            "checked-in template missing at {}",
            template.display()
        );

        // Copy to a scratch file; rotate_library_uuid mutates in place.
        let scratch = std::env::temp_dir().join(format!(
            "spine-test-rotate-{}.db",
            uuid::Uuid::new_v4()
        ));
        fs::copy(&template, &scratch).unwrap();

        // Read seed UUID before rotation.
        let conn = rusqlite::Connection::open(&scratch).unwrap();
        let before: String = conn
            .query_row("SELECT uuid FROM library_id", [], |r| r.get(0))
            .unwrap();
        drop(conn);

        rotate_library_uuid(&scratch).expect("rotation must succeed");

        let conn = rusqlite::Connection::open(&scratch).unwrap();
        let after: String = conn
            .query_row("SELECT uuid FROM library_id", [], |r| r.get(0))
            .unwrap();
        drop(conn);

        assert_ne!(before, after, "UUID must change after rotation");
        uuid::Uuid::parse_str(&after).expect("rotated UUID must be valid");

        let _ = fs::remove_file(&scratch);
    }

    #[test]
    fn dest_path_case_insensitive_zip_extension_accepted() {
        // .ZIP (all-caps, e.g. from some Windows dialogs) must also be accepted.
        #[cfg(unix)]
        assert!(
            validate_dest_path("/home/alice/exports/book.ZIP").is_ok(),
            ".ZIP (uppercase) must be accepted"
        );
        #[cfg(windows)]
        assert!(
            validate_dest_path("C:\\Users\\alice\\exports\\book.ZIP").is_ok(),
            ".ZIP (uppercase) must be accepted on Windows"
        );
    }
}
