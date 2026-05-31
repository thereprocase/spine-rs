use axum::{extract::Request, middleware::{self, Next}};
use calibre_db::{CalibreLibrary, DualDbPaths};
use spine_db::SpineStore;
use spine_srv::{auth::bearer_auth, create_desktop_router, AppState};
use std::sync::Arc;
use tokio::sync::Mutex;

// Minimum token length enforced when TCP transport is enabled.
// Short tokens are trivially brute-forceable on a loopback socket.
const MIN_TCP_TOKEN_LEN: usize = 32;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    let lib_path = std::env::var("CALIBRE_DB_PATH")
        .unwrap_or_else(|_| "../test-lib/spine/metadata.db".to_string());
    let spine_db_path = std::env::var("SPINE_DB_PATH")
        .unwrap_or_else(|_| "../test-lib/spine/spine.db".to_string());

    let library = CalibreLibrary::open(&lib_path)
        .map_err(|e| format!("Failed to open calibre library at {}: {}", lib_path, e))?;
    let store = SpineStore::open(&spine_db_path)
        .map_err(|e| format!("Failed to open spine.db at {}: {}", spine_db_path, e))?;

    // Pre-populate the loc_client cell at startup on desktop so the lazy path
    // is never taken in handlers. Failure here is fatal — the desktop binary
    // cannot serve candidates without a working HTTP client.
    let loc_client_cell = std::sync::OnceLock::new();
    loc_client_cell
        .set(Some(
            spine_meta::LocClient::new()
                .map_err(|e| format!("Failed to construct LocClient: {}", e))?,
        ))
        .unwrap(); // unwrap: cell is fresh; set never fails on a fresh cell

    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: Some(DualDbPaths {
            calibre_db: lib_path.clone(),
            spine_db: spine_db_path.clone(),
        }),
        loc_client: Arc::new(loc_client_cell),
        job_queue: Arc::new(spine_srv::jobs::LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    // DEBT(transport): Named Pipe (Windows) and UDS (Unix) transports are not
    // yet wired to axum::serve. axum's serve helper requires a tokio TcpListener-
    // shaped acceptor; there is no stable first-party Hyper/axum acceptor for
    // named pipes or UDS in axum 0.7. Until that lands, the only available
    // transport is TCP/127.0.0.1 gated behind SPINE_TCP_LISTEN=1 + SPINE_TCP_TOKEN.
    //
    // The desktop app uses in-process dispatch (Router::call) and never touches
    // this binary. This binary is only used for the standalone sidecar/dev mode.
    // See TECH_DEBT.md C-IPC-TRANSPORT.

    let tcp_listen = std::env::var("SPINE_TCP_LISTEN")
        .map(|v| v == "1")
        .unwrap_or(false);
    let tcp_token = std::env::var("SPINE_TCP_TOKEN").ok();

    if !tcp_listen {
        return Err(
            "TCP transport disabled. Set SPINE_TCP_LISTEN=1 and SPINE_TCP_TOKEN=<hex> to override."
                .into(),
        );
    }

    let raw_token = match &tcp_token {
        Some(t) if t.len() >= MIN_TCP_TOKEN_LEN => t.as_str(),
        Some(t) => {
            return Err(format!(
                "SPINE_TCP_TOKEN is too short ({} chars); minimum is {} hex characters.",
                t.len(),
                MIN_TCP_TOKEN_LEN
            )
            .into());
        }
        None => {
            return Err(format!(
                "SPINE_TCP_LISTEN=1 set but SPINE_TCP_TOKEN is missing. \
                 Provide a hex token of at least {} characters.",
                MIN_TCP_TOKEN_LEN
            )
            .into());
        }
    };

    // Arc<str> so the middleware closure clones a pointer (one atomic increment)
    // rather than heap-allocating a new String on every request. At 1000 req/s
    // the old String::clone() produced 1000 heap allocs/s for a value that
    // never changes for the life of the process.
    let token: Arc<str> = Arc::from(raw_token);

    let app = create_desktop_router(state)
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let token = Arc::clone(&token);
            async move { bearer_auth(req, next, token).await }
        }));

    // Bind only to loopback; never to 0.0.0.0.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 3030));
    tracing::info!("spine-srv listening on {} (TCP, token-gated)", addr);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind TCP listener on {}: {}", addr, e))?;
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("axum serve terminated: {}", e))?;
    Ok(())
}

// bearer_auth, extract_bearer_token, and verify_bearer_token live in
// spine_srv::auth. Unit tests for those functions are in that module.
