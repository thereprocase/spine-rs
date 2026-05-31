# Dev Workflow

Two stages, each tuned for a different cadence.

## Stage 1 — Alpha ring (between-session testing)

Goal: ship yourself a packaged build that behaves like a real
installed app. Between coding sessions, install the latest alpha and
use Spine as a user for a while. Regressions that only surface under
real install paths (file associations, AppData, startup time, update
semantics) show up here, not in `tauri dev`.

### Quick reference

| Command | What it does |
|---|---|
| `pnpm alpha` | Build a new alpha MSI |
| `pnpm alpha --install` | Build, then install via `msiexec /qb` |
| `pnpm alpha --open` | Build, then open the artifact folder |
| `pnpm alpha --clean` | Wipe bundle output first, then build |
| `pnpm alpha --latest` | Print the path of the newest MSI (no build) |
| `pnpm alpha --list` | Show recent builds from `BUILDS.md` |
| `pnpm alpha --uninstall` | Remove the currently installed Spine Alpha |
| `pnpm alpha --help` | Usage |

Flags combine: `pnpm alpha --clean --install --open` wipes, rebuilds,
installs, and opens the folder.

### Output

Produces an MSI at
`artifacts/alpha/spine-alpha-<YYYYMMDD>-<sha>-<seq>.msi`. Version
format is `0.<YY>.<DOY*10 + seq>` — monotonic within a year, up to
9 builds per day. First install goes through SmartScreen (unsigned);
later versions upgrade in place because the WiX `UpgradeCode` is
pinned in the build script.

Each alpha installs as "Spine Alpha" under identifier
`com.thereprocase.spine-alpha`, so it coexists with any future stable
Spine. Library data is shared — both rings read the same
`metadata.db` and `spine.db`.

### Shell requirement

`pnpm alpha` needs **Git Bash** (or WSL2). PowerShell does not run
`bash` by default. From a pwsh prompt:

```
bash scripts/build-alpha.sh [flags]
```

### See also

`artifacts/alpha/README.md` for install/uninstall detail.

## Stage 2 — Inner loop (fast iteration)

Goal: keep the code ↔ screen feedback loop under a few seconds.

```
pnpm dev
```

(Alias for `pnpm dev:desktop` — runs `tauri dev`.) Vite hot-reloads
React and CSS without restarting. Edits to `apps/desktop/src-tauri/`
trigger a Tauri restart automatically.

### Frontend-only iteration

If the current task is pure React / CSS / Tauri-independent API work,
run the frontend against a standalone Rust server in a second
terminal for a slightly tighter loop (skips the Tauri shell boot
entirely):

```
# terminal 1
pnpm dev:srv

# terminal 2
pnpm dev:frontend
```

Point the frontend at `http://localhost:<srv-port>` via env or the
existing dev config.

### Core-crate iteration

Changes under `core/` (e.g., `spine-srv`, `calibre-db`, `spine-db`)
are NOT automatically picked up by `tauri dev`, because `core/` is a
separate cargo workspace from `apps/desktop/src-tauri/`. Options:

- **Run the server directly**: `pnpm dev:srv`, then exercise it via
  `curl`, `hurl`, or `httpie`. Tightest loop for pure backend work.
- **Restart `pnpm dev`**: `Ctrl+C` and re-run after a core change.
  Tauri's build will pick up the new crate artifacts via Cargo.
- **Unit tests**: `cd core && cargo test -p <crate>` — fastest loop
  when the change is testable in isolation.

### Gotcha — `pnpm dev` and `pnpm alpha` share cargo target

Both use `apps/desktop/src-tauri/target/`. Cargo takes a file lock,
so the second invocation **blocks** until the first releases. If
`pnpm alpha` looks hung, check whether `pnpm dev` is still running in
another terminal.

## Gates before committing

Per `AGENTS.md`:

- `pnpm test` — recursive vitest + `cargo test` in `core/`.
- `pnpm --filter appsdesktop build` — type-check the frontend.
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` —
  verify the Tauri shell compiles.

CI enforcement is not wired yet (`docs/TECH_DEBT.md` §6.1).

## What each stage catches

| Issue class | Catches in stage 1 | Catches in stage 2 |
|---|---|---|
| Logic bug in a React component | late | immediate |
| Rust compile error | late | immediate |
| CSS / layout regression | late | immediate |
| MSI packaging / icon regression | **only here** | missed |
| First-run behavior without dev server | **only here** | missed |
| File association / shell integration | **only here** | missed |
| Startup time perf | **only here** | missed |
| Bundle size change | **only here** | missed |
| SmartScreen / Defender interactions | **only here** | missed |

Stage 2 is your compile-time safety net. Stage 1 is your runtime
safety net.
