# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm/Rust monorepo. Rust crates live in `core/` and are listed in
`core/Cargo.toml`; notable crates include `spine-srv` for the axum service,
`spine-cli`, metadata crates such as `spine-marc` and `spine-bf`, and per-format
crates under `spine-fmt-*`. The desktop app is in `apps/desktop/`, with
React/TypeScript source in `apps/desktop/src/` and Tauri Rust code in
`apps/desktop/src-tauri/`. The native Android app is in `apps/mobile/android/`;
the retired Expo reader is in `apps/mobile-reader/`. Project docs and ADRs are in
`docs/`. See `CLAUDE.md` for the load-bearing architecture invariants.

## Build, Test, and Development Commands

- `pnpm install` — install workspace JavaScript dependencies.
- `pnpm dev:desktop` — run the Tauri desktop app in development mode.
- `pnpm dev:srv` — run the Rust service with `cargo run -p spine-srv`.
- `cd core && cargo build` — build all Rust workspace crates.
- `pnpm build` — recursive pnpm builds, then build the Rust workspace.
- `pnpm test` — run package tests, then `cargo test` in `core/`.
- `cd core && cargo test -p spine-srv` — run one crate's tests while iterating.
- Android: `cd apps/mobile/android && ./gradlew :app:compileDebugKotlin` /
  `:app:assembleDebug`.

For Rust, prefer `cargo check -p <crate> --tests` before `cargo test -p <crate>`
so the test binaries compile once and are reused.

## Coding Style & Naming Conventions

Rust 2021 workspace conventions: four-space indentation, `snake_case`
modules/functions, `PascalCase` types, crate names matching the `spine-*`
pattern. Run `cargo fmt` before committing Rust changes and `cargo clippy
--workspace --all-targets` for lints. React components use `PascalCase`
filenames and exports; hooks/helpers use `camelCase`; styles stay near the
component unless a shared package is warranted.

## Testing Guidelines

Rust integration tests live in each crate's `tests/` directory (e.g.
`core/spine-srv/tests/router_test.rs`). Name tests after the behavior being
protected. Add focused fixtures under the owning crate when data is large or
shared. Desktop tests run under Vitest; validate visible UI changes with a local
Tauri/Vite run.

## Commit & Pull Request Guidelines

History uses Conventional Commits such as `feat(spine-srv): …`,
`fix(spine-bf): …`, `chore(desktop): …`. Keep the scope tied to the crate, app,
or subsystem changed. PRs should include a short behavior summary, the commands
run, linked issues or ADRs when relevant, and screenshots or recordings for
visible desktop UI changes.

## Engineering Mandates (non-negotiable)

1. **Never corrupt the sidecar.** When writing to `metadata.db`, register the
   custom SQLite collations (`calibre_collation`). Byte-compatibility with
   upstream calibre is a locked invariant.
2. **RDF integrity.** Never mutate the `triples` table in `spine.db` directly —
   always go through `SpineStore`'s dictionary-encoding paths via `spine-bf`.
   Blank nodes must be graph-scoped (`spine-bf::graph_scope_token`).
3. **Threading.** Use `tokio::sync::Mutex` for database connections inside
   `AppState`. The core must remain `Send + Sync`.
4. **API types.** All shared structs live in `spine-api`, decorated with
   `#[typeshare]` for TypeScript generation.
5. **Transport.** `spine-srv` is the only interface to the core. Frontends never
   link the core directly. No TCP loopback by default — enable only via
   `SPINE_TCP_LISTEN=1` + `SPINE_TCP_TOKEN=<hex>`.
6. **No `println!` in shipping code** — route through `tracing` so packaged
   builds retain logs.

## Security & Configuration Tips

Do not commit local databases, temporary repair scripts, or generated
patch/output files unless they are intentional fixtures. Treat files in
`apps/desktop/src-tauri/*.db` and scratch outputs as review-sensitive.
