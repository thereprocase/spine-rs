package com.thereprocase.spine

/**
 * JNI bridge to the Spine Rust core.
 *
 * One generic (method, path, body) entrypoint that dispatches into the
 * axum router exported by `spine-srv`. This is the mobile analog of the
 * Tauri `call_api` command in `apps/desktop/src-tauri/src/lib.rs` —
 * no per-function FFI, no UniFFI.
 *
 * The matching Rust surface is `core/spine-jni/src/lib.rs`. Keep the
 * signatures in lockstep: nullability on [callApi] is load-bearing
 * (TECH_DEBT §4.12).
 *
 * ## Error shape
 *
 * Every normal path returns a non-null JSON string. Failures from the
 * Rust side (handler 4xx/5xx, panic-catch-unwind) arrive as:
 *
 * ```json
 * { "error": "<message>", "status": <code>, "detail": "<optional body>" }
 * ```
 *
 * Callers parse one shape regardless of outcome.
 *
 * A null return from [callApi] indicates the Rust side failed to allocate
 * the response string via `env.new_string` — OOM or JNI env corruption.
 * Callers must treat null as an **unrecoverable bridge fault**, not a
 * user-facing error.
 */
object SpineCore {
    init { System.loadLibrary("spine_jni") }

    /**
     * Stand up an in-memory instance of the Rust core's AppState with
     * no library open. Idempotent — safe to call multiple times; a
     * second call is a no-op with the existing state (TECH_DEBT §4.11
     * tracks the argument-drop behaviour once [initCore] takes
     * parameters).
     *
     * Returns a JSON status blob.
     */
    external fun initCore(): String

    /**
     * Dispatch one HTTP-shaped request into the in-process axum router.
     *
     * @param method uppercase verb (GET/POST/PUT/DELETE/...)
     * @param path router path, e.g. `/api/v1/book`
     * @param body optional request body as UTF-8 string. **Never** route
     *   binary bytes (EPUB, cover images, etc.) through this parameter —
     *   the bridge is UTF-8 lossy and will corrupt non-text payloads
     *   (TECH_DEBT §4.9). Kotlin-side handling via `ContentResolver` +
     *   `InputStream` is the correct path for binary content in Sprint 2.
     *
     * @return JSON string. Null only on unrecoverable bridge fault
     *   (see class doc).
     */
    external fun callApi(method: String, path: String, body: String?): String?

    /**
     * Drop the global [AppState]. Intended for test hygiene; normal app
     * teardown leaves state in place and relies on process death.
     */
    external fun shutdownCore()
}
