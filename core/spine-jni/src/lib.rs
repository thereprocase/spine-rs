//! Android JNI bridge for the Spine Rust core.
//!
//! This crate is the mobile analog of `apps/desktop/src-tauri/src/lib.rs`'s
//! `call_api` command: it exposes a single generic "send a method/path/body,
//! get a body string back" entrypoint and dispatches straight into the axum
//! router that `spine-srv` exports. All per-function bindings are rejected by
//! design (see `CLAUDE.md` — transport discipline).
//!
//! Scope for the pre-alpha M1 milestone:
//! - `initCore` — stands up an in-memory `AppState` with no library open; this
//!   is enough to answer `/api/v1/ping` and validate the cross-compile + JNI
//!   plumbing end-to-end.
//! - `callApi` — dispatches a request through the router and returns the body
//!   as a Java string. Non-2xx responses are surfaced as a JSON error envelope
//!   rather than thrown exceptions so the Kotlin side has one code path.
//! - `shutdownCore` — clears the global state. Present for test hygiene; not
//!   called in pre-alpha.
//!
//! Deferred to later sprints:
//! - Library open (blocked on Android SAF path resolution — TECH_DEBT §4.4).
//! - iOS Swift FFI (this whole crate is Android-only for now).
//! - A typed error envelope spec — today's shape is `{"error": "<message>",
//!   "status": <code>}` which Kotlin can JSON-parse.

use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use axum::Router;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use once_cell::sync::Lazy;
use spine_srv::{create_router, AppState};
use tokio::runtime::Runtime;
use tower::util::ServiceExt;

/// Mirror of the desktop bridge's body cap. A response larger than this is
/// almost certainly a bug; reading it fully into memory on a mobile device
/// would stall the UI and risk OOM.
const BRIDGE_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Maximum time a single `callApi` dispatch may take before the bridge returns
/// a 504 error envelope. Android ANR fires at 5 seconds on the main thread;
/// this cap is defense-in-depth — callers SHOULD be on a background thread
/// (see README), but a ceiling prevents an unresponsive handler from silently
/// blocking the JVM side forever.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Single tokio runtime for every JNI call. The JVM owns the calling thread,
/// so we cannot use `#[tokio::main]` or rely on an ambient runtime. Creating
/// a runtime per call would cost ~1ms and drop the thread pool on every
/// invocation, which is wasteful and would defeat connection pooling in any
/// future HTTP client usage.
///
/// Stored behind a `Mutex<Option<Runtime>>` (not a `Lazy`) so that a failed
/// first `Runtime::new()` call (resource exhaustion, Android thread-limit) does
/// not permanently poison the process. `get_or_init_runtime` retries on each
/// `callApi` invocation until the OS allows the creation to succeed.
static RUNTIME: Mutex<Option<Runtime>> = Mutex::new(None);

/// Bundled core state: the axum `Router` (built once, cheaply cloneable) and
/// the `AppState` it was built from. Building the router per-call allocates the
/// full layer stack and resets any stateful middleware; caching it here drops
/// that cost to a single `Clone` (one `Arc` bump) per `callApi` invocation.
/// The `state` field keeps the `AppState` alive independent of the router's
/// internal `Arc` clones, ensuring a clean drop when `shutdownCore` sets the
/// cell back to `None`.
struct MobileCore {
    // Retained to keep the AppState alive alongside the router. The router
    // holds its own Arc<AppState> clones internally; this field ensures the
    // original Arc is also released when shutdownCore drops the MobileCore,
    // rather than relying solely on whatever the router's internals hold.
    #[allow(dead_code)]
    state: Arc<AppState>,
    router: Router,
}

impl MobileCore {
    fn new(state: Arc<AppState>) -> Self {
        let router = create_router(Arc::clone(&state));
        MobileCore { state, router }
    }
}

/// Global core state. `None` until `initCore` runs; `Some` afterwards.
///
/// The `std::sync::Mutex` here guards the `Option` itself — the router is
/// cloned out under the lock (cheap: `Router` is internally `Arc`-backed) and
/// the lock is released before any `.await`. Lock is never held across I/O.
static CORE: Lazy<Mutex<Option<MobileCore>>> = Lazy::new(|| Mutex::new(None));

/// Obtain a reference to the tokio `Runtime`, initialising it on the first
/// successful call. Returns an error string if init fails; the next call will
/// retry.
///
/// Poison recovery: if a prior thread panicked while holding the mutex, we log
/// a warning and recover the inner value. The Runtime itself is still usable —
/// the panic was in our wrapper code, not inside tokio.
fn with_runtime<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Runtime) -> T,
{
    let mut guard = RUNTIME
        .lock()
        .unwrap_or_else(|poisoned| {
            tracing::warn!(
                "RUNTIME mutex was poisoned by a prior panic; recovering inner value"
            );
            poisoned.into_inner()
        });

    // Lazy-init: if None (either first call or a prior failed attempt), try now.
    if guard.is_none() {
        match Runtime::new() {
            Ok(rt) => {
                *guard = Some(rt);
            }
            Err(e) => {
                return Err(format!(
                    "tokio runtime failed to initialize; restart app ({})",
                    e
                ));
            }
        }
    }

    // Safe: we just ensured it is Some above.
    Ok(f(guard.as_ref().unwrap()))
}

/// Materialise a fresh in-memory `AppState` with no library attached.
/// Materialise a fresh in-memory `AppState` with no library attached.
///
/// `LocClient` is NOT initialised here — the `OnceLock` is left empty so the
/// first call to `GET /api/v1/book/:id/candidates` performs the lazy init.
/// This avoids any network-adjacent work during `initCore` on a device that
/// may be in airplane mode at cold boot. On desktop, `main.rs` pre-populates
/// the cell before this path is ever taken.
fn build_in_memory_state() -> Result<Arc<AppState>, String> {
    use calibre_db::CalibreLibrary;
    use spine_db::SpineStore;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Mutex as TokioMutex;

    let library = CalibreLibrary::open(":memory:")
        .map_err(|e| format!("failed to open in-memory calibre library: {}", e))?;
    let store = SpineStore::open(":memory:")
        .map_err(|e| format!("failed to open in-memory spine store: {}", e))?;

    Ok(Arc::new(AppState {
        library: TokioMutex::new(library),
        store: TokioMutex::new(store),
        db_paths: None,
        // Empty OnceLock: LocClient is constructed lazily on first candidates
        // request (see AppState::get_or_init_loc_client). This avoids any
        // network-adjacent work at initCore time on a cold-booting Android device.
        loc_client: Arc::new(std::sync::OnceLock::new()),
        job_queue: Arc::new(spine_srv::jobs::LocalJobQueue),
        job_status: TokioMutex::new(HashMap::new()),
        job_terminal_at: TokioMutex::new(HashMap::new()),
        sync_in_progress: Arc::new(AtomicBool::new(false)),
        recent_libraries: TokioMutex::new(spine_srv::RecentLibrariesState::default()),
    }))
}

/// Build a JSON error envelope string. Keeps the Kotlin side on one parsing
/// path — successes are JSON bodies from handlers, errors are JSON envelopes
/// from the bridge.
fn error_envelope(status: u16, message: &str) -> String {
    serde_json::json!({
        "error": message,
        "status": status,
    })
    .to_string()
}

/// Convert an owned Rust string into a Java string, returning a null jstring
/// on failure. Used at every return path so a JVM exception state is never
/// left dangling.
fn to_jstring(env: &mut JNIEnv, s: &str) -> jstring {
    match env.new_string(s) {
        Ok(jstr) => jstr.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Pull an owned `String` out of a Java string. Returns `None` if the handle
/// is null or the UTF-16 → UTF-8 conversion fails.
fn java_string_to_owned(env: &mut JNIEnv, jstr: &JString) -> Option<String> {
    if jstr.is_null() {
        return None;
    }
    env.get_string(jstr)
        .ok()
        .and_then(|s| s.to_str().ok().map(|s| s.to_owned()))
}

/// Initialise the core. Idempotent — a second call is a no-op and returns
/// success so Kotlin code that re-enters (config changes, activity recreation)
/// doesn't have to track state.
///
/// # Safety
/// Called from the JVM via JNI. All inputs are validated; panics are caught.
#[no_mangle]
pub extern "system" fn Java_com_thereprocase_spine_SpineCore_initCore(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    // Logging must be set up before we acquire the CORE mutex. init_mobile_logging
    // is idempotent (android_logger::init_once), so a second call from a
    // re-entering activity is safe. Previously this was inside the mutex
    // critical section, meaning every log emitted during the idempotent-reentry
    // path was silently dropped on targets where logging is not yet wired.
    spine_srv::init_mobile_logging();

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let mut guard = CORE
            .lock()
            .unwrap_or_else(|poisoned| {
                tracing::warn!(
                    "CORE mutex was poisoned by a prior panic; recovering inner value"
                );
                poisoned.into_inner()
            });
        if guard.is_some() {
            return Ok::<String, String>(
                serde_json::json!({"status": "ok", "already_initialised": true}).to_string(),
            );
        }

        let state = build_in_memory_state()?;
        *guard = Some(MobileCore::new(state));
        Ok(serde_json::json!({"status": "ok", "already_initialised": false}).to_string())
    }));

    match result {
        Ok(Ok(body)) => to_jstring(&mut env, &body),
        Ok(Err(e)) => to_jstring(&mut env, &error_envelope(500, &e)),
        Err(_) => to_jstring(
            &mut env,
            &error_envelope(500, "initCore panicked inside the Rust core"),
        ),
    }
}

/// Dispatch a request through the in-process axum router.
///
/// Arguments (all Java strings):
/// - `method`: HTTP method, e.g. `"GET"`.
/// - `path`: path + query, e.g. `"/api/v1/ping"`.
/// - `body`: request body; may be null (treated as empty).
///
/// Returns the response body as a Java string. On any failure (router error,
/// body too large, timeout, panic, un-initialised core) returns a JSON error
/// envelope. Callers MUST invoke this from a background thread — calling from
/// the Android main thread risks an ANR if the dispatch takes more than
/// DISPATCH_TIMEOUT. The timeout is defense-in-depth, not a substitute.
#[no_mangle]
pub extern "system" fn Java_com_thereprocase_spine_SpineCore_callApi(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
    path: JString,
    body: JString,
) -> jstring {
    let method_str = java_string_to_owned(&mut env, &method);
    let path_str = java_string_to_owned(&mut env, &path);
    let body_str = java_string_to_owned(&mut env, &body).unwrap_or_default();

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let method = method_str
            .ok_or_else(|| "method argument must not be null".to_string())?;
        let path = path_str
            .ok_or_else(|| "path argument must not be null".to_string())?;

        // Clone the router out of the mutex under the lock, then release the
        // lock before any async work. Router is Arc-backed; clone is O(1).
        let router: Router = {
            let guard = CORE
                .lock()
                .unwrap_or_else(|poisoned| {
                    tracing::warn!(
                        "CORE mutex was poisoned by a prior panic; recovering inner value"
                    );
                    poisoned.into_inner()
                });
            guard
                .as_ref()
                .ok_or_else(|| "core not initialised; call initCore first".to_string())?
                .router
                .clone()
        };

        let mut builder = Request::builder().method(method.as_str()).uri(&path);
        if !body_str.is_empty() {
            builder = builder.header(axum::http::header::CONTENT_TYPE, "application/json");
        }
        let request = builder
            .body(Body::from(body_str))
            .map_err(|e| format!("failed to build request: {}", e))?;

        with_runtime(|rt| {
            rt.block_on(async move {
                // 5-second ceiling: if the handler does not respond in time, we
                // return a 504 envelope rather than blocking the JVM thread
                // indefinitely (which would ANR on the main thread).
                let dispatch = async move {
                    let response = router
                        .oneshot(request)
                        .await
                        .map_err(|e| format!("router dispatch failed: {}", e))?;
                    let status = response.status();
                    let bytes =
                        axum::body::to_bytes(response.into_body(), BRIDGE_MAX_BODY_BYTES)
                            .await
                            .map_err(|e| {
                                if e.to_string().contains("body limit exceeded") {
                                    "response body exceeded 64 MB cap".to_string()
                                } else {
                                    format!("failed to read response body: {}", e)
                                }
                            })?;
                    Ok::<_, String>((status, String::from_utf8_lossy(&bytes).into_owned()))
                };

                match tokio::time::timeout(DISPATCH_TIMEOUT, dispatch).await {
                    Ok(Ok((status, body_string))) => {
                        if status.is_success() {
                            Ok(body_string)
                        } else {
                            // Non-2xx: wrap in the error envelope so Kotlin has a
                            // single shape to parse. Handler-produced bodies are
                            // preserved in the `detail` field.
                            let detail = spine_srv::api_v1::replace_paths(&body_string);
                            Ok(serde_json::json!({
                                "error": status.canonical_reason().unwrap_or("error"),
                                "status": status.as_u16(),
                                "detail": detail,
                            })
                            .to_string())
                        }
                    }
                    Ok(Err(e)) => Err(e),
                    Err(_elapsed) => Ok(serde_json::json!({
                        "error": "timeout",
                        "status": 504u16,
                        "detail": "request exceeded 5s",
                    })
                    .to_string()),
                }
            })
        })?
    }));

    match result {
        Ok(Ok(body)) => to_jstring(&mut env, &body),
        Ok(Err(e)) => to_jstring(&mut env, &error_envelope(500, &e)),
        Err(_) => to_jstring(
            &mut env,
            &error_envelope(500, "callApi panicked inside the Rust core"),
        ),
    }
}

/// Drop the core state. Present for test hygiene; not called in the pre-alpha
/// Android flow. Always returns success; clearing an already-empty core is a
/// no-op.
#[no_mangle]
pub extern "system" fn Java_com_thereprocase_spine_SpineCore_shutdownCore(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let mut guard = CORE
            .lock()
            .unwrap_or_else(|poisoned| {
                tracing::warn!(
                    "CORE mutex was poisoned by a prior panic; recovering inner value"
                );
                poisoned.into_inner()
            });
        *guard = None;
        serde_json::json!({"status": "ok"}).to_string()
    }));

    match result {
        Ok(body) => to_jstring(&mut env, &body),
        Err(_) => to_jstring(
            &mut env,
            &error_envelope(500, "shutdownCore panicked inside the Rust core"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_envelope_shape() {
        let envelope = error_envelope(503, "library not open");
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["error"], "library not open");
        assert_eq!(parsed["status"], 503);
    }

    #[test]
    fn build_in_memory_state_succeeds() {
        // The AppState scaffold must be able to stand up with no library
        // attached — this is the contract initCore relies on. Running this on
        // the host catches a schema regression before it reaches the device.
        let state = build_in_memory_state().expect("in-memory state must build");
        assert!(state.db_paths.is_none(), "db_paths must be None when no library is open");
    }
}
