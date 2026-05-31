# spine-jni

Android JNI bridge for the Spine Rust core. The mobile analog of the Tauri
`call_api` command in `apps/desktop/src-tauri/src/lib.rs` — one generic
`(method, path, body) -> body` entrypoint that dispatches straight into the
axum router exported by `spine-srv`. No per-function FFI.

## Public surface

Three JNI functions, all callable from a Kotlin class at
`com.thereprocase.spine.SpineCore`:

| Function | Purpose |
|---|---|
| `initCore()` | Stand up an in-memory `AppState` with no library open. Idempotent. |
| `callApi(method, path, body)` | Dispatch a request; return body as a string. |
| `shutdownCore()` | Drop the global state. For test hygiene only. |

All three return a Java string. Success shape is whatever the handler produced
(JSON in practice). Failure shape is:

```json
{ "error": "<message>", "status": <code>, "detail": "<optional handler body>" }
```

Kotlin parses one shape regardless of outcome.

## Consuming from Kotlin (Sprint 2)

```kotlin
object SpineCore {
    init { System.loadLibrary("spine_jni") }
    external fun initCore(): String
    /**
     * Returns null ONLY when the Rust side failed to allocate the response
     * string via `env.new_string` (OOM or JNI env corruption). In practice
     * every normal path — including handler errors — returns a non-null
     * JSON string. Callers MUST handle the null branch as an unrecoverable
     * bridge fault, not a user-facing error.
     */
    external fun callApi(method: String, path: String, body: String?): String?
    external fun shutdownCore()
}
```

**Nullability contract:** `callApi` returns `String?` — not `String`. This
matches `to_jstring` on the Rust side, which emits `std::ptr::null_mut()`
when `env.new_string` fails. `shutdownCore` returns `Unit` on Kotlin (the
Rust side returns `()`). Do not declare either differently; see TECH_DEBT
§4.12.

The Gradle build (Sprint 3) copies a `libspine_jni.so` per ABI from
`core/target/<triple>/release/` (workspace-root relative) into
`app/src/main/jniLibs/<abi>/`.

## Build

Host-side sanity (no NDK required):

```
cargo check --manifest-path core/Cargo.toml -p spine-jni
```

Cross-compile for Android (requires `$ANDROID_NDK_HOME` and `cargo-ndk`):

```
cargo ndk -t arm64-v8a build --release -p spine-jni
```

Not yet wired into CI — Sprint 3 handles that.

## What's deferred

- **Library open.** On Android, the Storage Access Framework returns content
  URIs, not filesystem paths, and every SQLite operation needs a real path.
  See TECH_DEBT §4.4 for the three fix options (app-private only, copy-on-open,
  JNI fd bridge). Until one is chosen, `initCore` creates an in-memory state
  with `db_paths: None`; handlers that need a library return 503.
- **iOS.** This crate is Android-only. A future `spine-swift` crate will
  mirror the same transport discipline with `extern "C"` and Swift bindings.
- **Error envelope spec.** The current `{error, status, detail}` shape is
  provisional. Once Kotlin starts consuming it in anger we may formalise it in
  `spine-api`.
- **Structured logging from Kotlin.** The `mobile` feature of `spine-srv`
  wires `android_logger` so Rust-side `tracing` records reach logcat under
  the `spine-core` tag. Kotlin-side tagging is Sprint 2's concern.

## Design notes

- The `Mutex<Option<Arc<AppState>>>` at module scope is intentional. A JVM
  calling thread is not a tokio-owned thread, so we cannot use
  `#[tokio::main]` or an ambient runtime. The runtime lives in a
  `Lazy<Runtime>` and every JNI call does `block_on` on it.
- `panic::catch_unwind` wraps every FFI body. A Rust panic crossing the JVM
  boundary aborts the process with no useful context.
- `create_router` (the pure axum wiring) is what we dispatch into — not
  `create_desktop_router`. Mobile has no CORS concept; the webview and the
  router share a process.
