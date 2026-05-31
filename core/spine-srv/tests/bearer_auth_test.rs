/// Integration tests for the bearer-token middleware at the HTTP layer.
///
/// These tests construct a minimal axum router with the bearer layer applied —
/// mirroring the wiring in main.rs — and drive it through
/// `tower::ServiceExt::oneshot`. They verify the middleware's HTTP contract
/// independently of the rest of the router, and independently of the unit
/// tests for the underlying helper functions (those live in
/// spine_srv::auth's #[cfg(test)] block).
use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::get,
    Router,
};
use spine_srv::auth::bearer_auth;
use std::sync::Arc;
use tower::ServiceExt;

/// Token used throughout all tests. 32 chars satisfies MIN_TCP_TOKEN_LEN.
const TEST_TOKEN: &str = "correct-token-32-chars-xxxxxxxxx";

/// Builds a router with a single probe endpoint and the bearer middleware
/// attached, using the provided expected token.
fn router_with_bearer(expected: &str) -> Router {
    let token: Arc<str> = Arc::from(expected);
    Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(middleware::from_fn(move |req: Request<Body>, next: middleware::Next| {
            let token = Arc::clone(&token);
            async move { bearer_auth(req, next, token).await }
        }))
}

/// Helper: fire a GET /probe with an optional Authorization header.
async fn probe(app: Router, auth_header: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().uri("/probe").method("GET");
    if let Some(h) = auth_header {
        builder = builder.header(axum::http::header::AUTHORIZATION, h);
    }
    let req = builder.body(Body::empty()).unwrap();
    app.oneshot(req).await.unwrap().status()
}

#[tokio::test]
async fn bearer_missing_header_returns_401() {
    let status = probe(router_with_bearer(TEST_TOKEN), None).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "request with no Authorization header must return 401"
    );
}

#[tokio::test]
async fn bearer_wrong_scheme_basic_returns_401() {
    // "Basic ..." is a different auth scheme; must not be accepted even if the
    // base64-decoded value happens to equal the expected token.
    let status = probe(
        router_with_bearer(TEST_TOKEN),
        Some("Basic Y29ycmVjdC10b2tlbi0zMi1jaGFycy14eHh4eHh4eHg="),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "Basic scheme must be rejected"
    );
}

#[tokio::test]
async fn bearer_valid_token_reaches_handler() {
    let header = format!("Bearer {}", TEST_TOKEN);
    let status = probe(router_with_bearer(TEST_TOKEN), Some(&header)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "correct Bearer token must reach the handler and return 200"
    );
}

#[tokio::test]
async fn bearer_invalid_token_of_correct_length_returns_401() {
    // Same length as TEST_TOKEN, all bytes different — exercises the
    // constant-time path where ct_eq walks every byte.
    let wrong = "wrong-token--32-chars-xxxxxxxxxx";
    assert_eq!(
        wrong.len(),
        TEST_TOKEN.len(),
        "test data error: wrong token must be the same length as the expected token"
    );
    let header = format!("Bearer {}", wrong);
    let status = probe(router_with_bearer(TEST_TOKEN), Some(&header)).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "wrong token of equal length must return 401"
    );
}

#[tokio::test]
async fn bearer_empty_token_returns_401() {
    // "Bearer " with nothing after the space — extract_bearer_token returns
    // Some(""), verify_bearer_token("", expected) is false.
    let status = probe(router_with_bearer(TEST_TOKEN), Some("Bearer ")).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "empty token after 'Bearer ' must return 401"
    );
}

#[tokio::test]
async fn bearer_lowercase_scheme_accepted() {
    // RFC 6750 §2.1: the auth-scheme is case-insensitive.
    let header = format!("bearer {}", TEST_TOKEN);
    let status = probe(router_with_bearer(TEST_TOKEN), Some(&header)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "lowercase 'bearer' scheme must be accepted"
    );
}

#[tokio::test]
async fn bearer_uppercase_scheme_accepted() {
    let header = format!("BEARER {}", TEST_TOKEN);
    let status = probe(router_with_bearer(TEST_TOKEN), Some(&header)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "uppercase 'BEARER' scheme must be accepted"
    );
}

/// Structural test: `bearer_auth` layer can be applied to the full app router
/// produced by `create_router`. This catches type-level regressions if
/// `create_router`'s return type changes in a way that breaks layer stacking.
#[tokio::test]
async fn layer_stacks_on_full_app_router() {
    use calibre_db::CalibreLibrary;
    use spine_db::SpineStore;
    use spine_srv::{create_router, AppState};
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Mutex;

    let library = CalibreLibrary::open(":memory:").expect("in-memory library");
    let store = SpineStore::open(":memory:").expect("in-memory spine.db");
    let state = Arc::new(AppState {
        library: Mutex::new(library),
        store: Mutex::new(store),
        db_paths: None,
        loc_client: { let c = std::sync::OnceLock::new(); c.set(Some(spine_meta::LocClient::with_base_url("http://localhost:0").unwrap())).unwrap(); std::sync::Arc::new(c) },
        job_queue: Arc::new(spine_srv::jobs::LocalJobQueue),
        job_status: Mutex::new(std::collections::HashMap::new()),
        job_terminal_at: Mutex::new(std::collections::HashMap::new()),
        sync_in_progress: Arc::new(AtomicBool::new(false)),
        recent_libraries: Mutex::new(spine_srv::RecentLibrariesState::default()),
    });

    let token: Arc<str> = Arc::from(TEST_TOKEN);
    let token_clone = Arc::clone(&token);
    let app = create_router(state).layer(middleware::from_fn(
        move |req: Request<Body>, next: middleware::Next| {
            let t = Arc::clone(&token_clone);
            async move { bearer_auth(req, next, t).await }
        },
    ));

    // Unauthenticated request must be rejected even on the full router.
    let req = Request::builder()
        .uri("/api/v1/ping")
        .body(Body::empty())
        .unwrap();
    let status = app.oneshot(req).await.unwrap().status();
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "full router with bearer layer must reject unauthenticated requests"
    );
}
