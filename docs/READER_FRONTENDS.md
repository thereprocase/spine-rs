# Reader Frontends

Spine supports multiple reader frontends as plugins or integrations, but each packaged application should ship with one default reader that feels native on that platform.

## Packaged Defaults

- **Desktop:** Foliate JS is the packaged reader frontend for Tauri desktop. It is MIT licensed, already works with the embedded `read_book_resource` bridge, and fits the current React/Tauri shell.
- **Mobile (v1):** Foliate JS hosted in a Compose `WebView` via `WebViewAssetLoader`, sharing the desktop reader bundle. The Android app is fully standalone — it embeds its own `spine-srv` axum router in-process via `libspine_jni.so`, owns its own `metadata.db` + `spine.db` in app-private storage, and resolves every `SpineCore.callApi(method, path, body)` request locally with no network requirement. Resources are streamed per spine item under `https://appassets.androidplatform.net/book/<filename>/` — no whole-archive load into JavaScript, no `file://` origin. Readium Mobile is reserved as a future `ReaderEngine` plugin (`docs/ADR_023_plugin_architecture.md` §2) once mobile plugin loading lights up. See internal design notes for the full pivot rationale and slice plan.
- **Server or web clients:** use the canonical HTTP reader resource routes and choose their own reader frontend.

## Plugin Contract

Reader plugins must integrate through Spine contracts rather than direct library paths:

- Resolve book resources through `read_book_resource` in embedded mode or `GET|HEAD /api/v1/reader/book/{id}/resource/{path}` in HTTP mode.
- Report reading location through a future progress API using stable identifiers such as EPUB CFI or Readium locator JSON.
- Emit annotations and highlights as Spine-owned records, not reader-private storage.
- Declare supported formats explicitly. A frontend must not imply support for MOBI, PDF, or fixed-layout EPUB unless the packaged integration is tested.
- Keep engine-specific state behind an adapter so readers can be replaced without changing the core BIBFRAME or book APIs.

## Integration Policy

Additional readers can be offered as integrations when they provide a real advantage: e-ink hardware, accessibility, specialized PDF behavior, or user preference. They should feel native in their host environment, but the packaged default remains the support target for each platform.

The API boundary is still Spine. Reader engines render books; Spine owns metadata, resource access, progress, annotations, and sync semantics.
