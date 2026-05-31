# Reader Transport

The desktop reader loads EPUB resources through the embedded Tauri bridge, not a loopback HTTP server. `Reader.tsx` calls `read_book_resource`, which returns base64 bytes, content type, and content length from the in-process `spine-srv` state.

Reader engines are replaceable frontends, not the Spine data boundary. See `docs/READER_FRONTENDS.md` for packaged defaults and plugin policy.

Server routes remain available for explicit HTTP deployments:

- Canonical reader route: `GET|HEAD /api/v1/reader/book/{id}/resource/{path}`
- Book resource alias: `GET|HEAD /api/v1/book/{id}/resource/{path}`
- Deprecated compatibility alias: `GET|HEAD /api/v1/library/books/{id}/resource/{path}`

All EPUB internal paths are normalized before ZIP lookup. Empty paths and parent-directory traversal are rejected before the calibre database is queried; leading slashes, repeated separators, backslashes, and current-directory segments are normalized.

Transport modes:

- **Embedded desktop:** use `read_book_resource`; this is the production desktop path.
- **Embedded mobile (v1):** Foliate JS hosted in a Compose `WebView` via `WebViewAssetLoader`, sharing the desktop reader bundle. The Android app is fully standalone — it embeds its own `spine-srv` axum router in-process via `libspine_jni.so`, owns its own `metadata.db` + `spine.db` in app-private storage, and resolves every `SpineCore.callApi(method, path, body)` request locally with no network requirement. Resources stream per spine item from `https://appassets.androidplatform.net/book/<filename>/`. Readium-as-engine slot reserved per internal design notes pin #1 once mobile plugin loading lights up.
- **Sidecar/server development:** use the canonical HTTP reader route only when a server is intentionally running.
- **Remote clients:** call the canonical HTTP reader route and rely on `Content-Type` and `Content-Length` headers for Foliate resource sizing.
