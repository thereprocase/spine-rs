# Contributing

Spine is pre-alpha and moves fast, but the conventions are stable. The short
version lives here; the full architecture invariants are in [`CLAUDE.md`](CLAUDE.md)
and the engineering mandates in [`AGENTS.md`](AGENTS.md).

## Getting set up

```bash
pnpm install                 # JS deps
cd core && cargo build       # Rust workspace (toolchain pinned in rust-toolchain.toml)
```

- Desktop: `pnpm dev:desktop` (Tauri) / `pnpm dev:srv` (service only).
- Android: `cd apps/mobile/android && ./gradlew :app:compileDebugKotlin`.

## Before you commit

- Rust: `cargo fmt` and `cargo clippy --workspace --all-targets`; add/extend tests
  in the crate's `tests/` dir.
- TypeScript/React: keep components `PascalCase`, hooks/helpers `camelCase`;
  desktop tests run under Vitest.
- Run the relevant tests: `cd core && cargo test -p <crate>` and `pnpm test`.

## Commits & PRs

- **Conventional Commits**, scope tied to the crate/app/subsystem:
  `feat(spine-srv): …`, `fix(spine-bf): …`, `chore(desktop): …`.
- PRs: short behavior summary, commands run, linked ADRs/issues when relevant,
  and screenshots/recordings for visible desktop UI changes.

## Architecture you must not regress

These are load-bearing (see `CLAUDE.md` for the why):

- Frontends never link the core — everything goes through `spine-srv` via
  `call_api(method, path, body)`. No UniFFI / per-function FFI.
- All triple writes go through `spine-bf`'s validated API. Never write triples
  directly.
- `metadata.db` stays byte-compatible with calibre; spine-specific data lives in
  the `spine.db` BIBFRAME sidecar.
- Asserted vs. inferred triples stay separate; promotion is an explicit user act.
- Use the `spine-` crate prefix (the sole `calibre-` crate is `calibre-db`).
