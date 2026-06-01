<h1 align="center">Spine</h1>

<p align="center"><em>A Rust-core e-book library manager — for the desktop and the phone.</em></p>

<p align="center">
  <strong>Status: pre-alpha.</strong> The core works; the apps are coming together; there are bugs.
</p>

---

> **Heads up:** this is an in-progress project, parked mid-stream and then cleaned
> up for sharing. The latest of everything is at the **HEAD of `main`**. Some
> pieces are solid, some are proofs-of-concept with known bugs. The
> [component status](#component-status) table below is honest about which is which.

## What it is

**Spine** is an e-book library manager built around a Rust core, with modern,
split frontends that run on a desktop *or* an Android device. It keeps the parts
people love about a good library manager — a solid library model, real metadata
sources, a conversion pipeline — and builds them on a foundation designed from
day one to reach phones, not just laptops.

Two ideas make Spine different under the hood:

- **One backend, many frontends.** All the real work lives in a Rust core exposed
  through a single HTTP service (`spine-srv`). The desktop app, the Android app,
  and anything else talk to it over one generic bridge — `call_api(method, path,
  body)`. No frontend links the core directly. That's what makes the same engine
  ship on a phone.
- **BIBFRAME-native metadata.** Internally, metadata is **BIBFRAME 2.0** RDF, with
  identities reconciled against the Library of Congress (id.loc.gov) before
  anything is minted locally. MARC21, ONIX, EPUB OPF, and Dublin Core all map in
  and out. The on-disk library uses a standard `metadata.db`, so an existing
  library opens without conversion.

## Component status

| Component | Path | What it is | State |
|---|---|---|---|
| **Library engine** | `core/` (~24 crates) | library + BIBFRAME metadata store, format readers/writers | **Works.** Opens an existing library; reads/writes metadata; reconcile-first identity. The most mature part. |
| **Backend service** | `core/spine-srv` | axum HTTP API — the one interface to the core | **Exists, partial.** Library browse / search / edit / reconcile / backup endpoints are wired; the format-conversion pipeline is in progress. |
| **Desktop app** | `apps/desktop` | Tauri 2 + React | **Exists, partial.** Library browse, search, metadata inspector/editor, reconcile drawer, backup, settings. A real daily-driver shell, still missing features. |
| **Native Android app** | `apps/mobile/android` | Kotlin + Jetpack Compose, native EPUB reader | **Coming together — buggy.** The intended mobile future. Imports and renders EPUBs without loading the whole book into JS. Actively churning; expect rough edges. |
| **RN/Expo reader** | `apps/mobile-reader` | React Native + Expo proof-of-concept | **Retired POC.** Proved the branding, share/import flow, and reading UX nicely — but has JavaScript bugs and **will run out of memory on a large book** (it loads the whole EPUB in JS). Superseded by the native app; kept as a UI sandbox. |

See **[STATUS.md](STATUS.md)** for the detailed per-component breakdown and known
bugs, and **[TODO.md](TODO.md)** for what's next.

## Architecture at a glance

```
        Frontends (any platform)
   ┌───────────────┬───────────────────────┐
   │ Desktop       │ Android (native)      │   apps/desktop, apps/mobile/android
   │ Tauri+React   │ Kotlin+Compose        │
   └───────┬───────┴───────────┬───────────┘
           │  call_api(method, path, body)  (one bridge, HTTP contract)
           ▼                    ▼
        ┌──────────────────────────────┐
        │  spine-srv  (axum service)   │   core/spine-srv
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────────────────────┐
        │  Rust core (~24 crates)                       │
        │  spine-bf (BIBFRAME write API) · spine-fmt-*  │   core/
        │  metadata.db (library catalog)                │
        │  spine.db (BIBFRAME RDF sidecar)              │
        └───────────────────────────────────────────────┘
```

Design rationale lives in the **[ADRs](docs/)** (`docs/ADR_*.md`) and the
project plan in **[PLAN.md](PLAN.md)**. Architecture invariants are pinned in
[`CLAUDE.md`](CLAUDE.md); build/test/style conventions in [`AGENTS.md`](AGENTS.md).

## Build

Prerequisites: Rust (pinned in `rust-toolchain.toml`), Node + pnpm, and — for the
Android app — the Android SDK/NDK and JDK 17.

```bash
# Rust core + backend
cd core && cargo build
cargo run -p spine-srv          # start the service

# Desktop (Tauri + React)
pnpm install
pnpm dev:desktop                # dev app
pnpm dev:srv                    # service only

# Native Android
cd apps/mobile/android
./gradlew :app:compileDebugKotlin
./gradlew :app:assembleDebug    # needs libspine_jni.so staged (see apps/mobile/android/README.md)
```

Full command reference and engineering mandates: **[AGENTS.md](AGENTS.md)**.

## Repository layout

```
core/                Rust workspace (~24 crates) — library engine, spine-srv, spine-bf, spine-fmt-*
apps/desktop/        Tauri 2 + React desktop app
apps/mobile/android/ native Kotlin + Jetpack Compose app (current mobile path)
apps/mobile-reader/  Expo / React Native reader (retired proof-of-concept)
docs/                ADRs and reference docs
PLAN.md              the long-form project plan / roadmap
```

## License

GPL-3.0 — see [LICENSE](LICENSE). Spine ports algorithmic and format-specific
decisions from upstream [calibre](https://github.com/kovidgoyal/calibre) (also
GPL-3.0); per-area attribution lives alongside the relevant code. "Spine" is the
EPUB-spec term for a book's ordered content list.

## Acknowledgements

Built on the shoulders of [calibre](https://github.com/kovidgoyal/calibre) by
Kovid Goyal and contributors, the [foliate-js](https://github.com/johnfactotum/foliate-js)
viewer, and the Library of Congress [BIBFRAME](https://id.loc.gov/) vocabularies.
