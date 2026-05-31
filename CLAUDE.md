# CLAUDE.md

Architecture pins and conventions for working in this repository. These are the
durable, load-bearing decisions the codebase references by name; treat them as
invariants, not suggestions.

## Project in one paragraph

Spine is a ground-up rewrite of [calibre](https://github.com/kovidgoyal/calibre):
a cross-platform e-book library manager with a **Rust core** (`core/`, ~24
crates), split frontends for **desktop** (Tauri 2 + React, `apps/desktop/`) and
**Android** (Kotlin + Jetpack Compose, `apps/mobile/android/`), and a foliate-js
viewer hosted in a WebView. The library database stays **byte-compatible with
upstream calibre's `metadata.db`**. Internal metadata truth is **BIBFRAME 2.0**,
stored as RDF triples in a `spine.db` sidecar — every other format (MARC21, ONIX,
EPUB OPF, Dublin Core) maps in and out via `spine-bf`. Frontends never link the
core: they talk to `spine-srv` (axum) over a single generic bridge
`call_api(method, path, body)`. No UniFFI, no per-function FFI.

## Architecture non-negotiables

These have been debated and decided. Don't regress them without an ADR.

- **One transport.** `spine-srv` is the only interface to the core. Frontends
  never link the core library directly. The bridge is one
  `call_api(method, path, body)` dispatching into the in-process axum router.
  Don't propose UniFFI, direct FFI, or per-function Rust→Kotlin bindings.
- **No TCP by default.** Embedded mode is in-process; local-sidecar mode is UDS /
  Named Pipe. TCP loopback is opt-in only, paired with TLS and token auth
  (`SPINE_TCP_LISTEN=1` + `SPINE_TCP_TOKEN=<hex>`).
- **`spine-bf` is the sole write path for triples.** Every graph mutation flows
  through its validated API so SHACL shapes and `bf:AdminMetadata` provenance
  stay consistent. Never write triples directly from a frontend or from Kotlin.
- **`metadata.db` schema is frozen.** Byte-compatibility with upstream calibre is
  a locked invariant; custom SQLite collations (`calibre_collation`) must be
  registered before any write. Spine-specific richness lives only in `spine.db`,
  one named RDF graph per book keyed by `books.uuid`.
- **BIBFRAME 2.0 is primary.** Don't "simplify" it into Dublin Core or back to
  MARC21 as the primary model, or swap a custom schema in.
- **Reconcile-first identity.** Identities reconcile against id.loc.gov first;
  local minting is only for entities LoC has no record of. Don't normalize
  titles/authors without bumping the `normalization_rules` version —
  deterministic URI hashes depend on frozen rules.
- **Asserted vs inferred is a hard separation.** LLM-/heuristic-inferred triples
  live in the inferred graph with `spine:confidence` / `spine:inferredBy` /
  `spine:inferredAt`; promotion to the asserted graph requires explicit user
  action. Inferred triples never land in the asserted graph directly.
- **Crate naming.** Use the `spine-` prefix for everything. The only `calibre-`
  crate is `calibre-db`, already named and locked.
- **Logging.** No `println!` in shipping code — route through `tracing` so
  packaged builds retain logs.

## Layout

| Path | What |
|---|---|
| `core/` | Rust workspace, ~24 crates (see `core/Cargo.toml`) |
| `core/spine-srv/` | axum HTTP service — the one interface to the core |
| `core/spine-bf/` | BIBFRAME write API (validated, sole triple-write path) |
| `core/spine-fmt-*/` | per-format readers/writers (epub, mobi, pdf, docx, …) |
| `apps/desktop/` | Tauri 2 + React desktop app |
| `apps/mobile/android/` | native Kotlin + Jetpack Compose app (current mobile path) |
| `apps/mobile-reader/` | Expo / React Native reader (retired proof-of-concept) |
| `docs/` | ADRs and reference docs |

## Mobile (`apps/mobile/android/`) reader pins

The native reader has a few hard rules that protect memory and security:

1. **No whole-EPUB JS bridge.** EPUB bytes never cross `call_api`,
   `JavascriptInterface`, or any JS layer as base64 / string / `ArrayBuffer`.
2. **No `file://` WebView origin.** `allowFileAccess`, `allowContentAccess`,
   `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs` stay `false`.
3. **One resource authority.** Book resources are read from app-private storage
   through a narrow path handler rooted at
   `https://appassets.androidplatform.net/book/...`.
4. **No false UI.** Until the native reader can render a book, the reader screen
   states exactly what works.
5. **Progress belongs to Spine.** The engine may emit locators, but Spine
   persists and owns them.

## Build

- Rust workspace: `cd core && cargo build` (toolchain pinned in
  `rust-toolchain.toml`). Per-crate: `cargo check -p <crate> --tests` then
  `cargo test -p <crate>`.
- Desktop: `pnpm install` then `pnpm dev:desktop` (Tauri) / `pnpm dev:srv`
  (service only).
- Android: `cd apps/mobile/android && ./gradlew :app:compileDebugKotlin` /
  `:app:assembleDebug` (needs `libspine_jni.so` from `core/spine-jni/` staged
  under `app/src/main/jniLibs/<abi>/`).

See `AGENTS.md` for the full command list, coding style, and engineering mandates.
