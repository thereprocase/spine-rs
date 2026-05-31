# Spine Alpha Ring

Between-session testing builds. Produce and manage with:

| Command | Does |
|---|---|
| `pnpm alpha` | Build a new alpha MSI |
| `pnpm alpha --install` | Build then install via `msiexec /qb` |
| `pnpm alpha --open` | Build then open this folder |
| `pnpm alpha --clean` | Wipe Tauri bundle output first |
| `pnpm alpha --latest` | Print the newest MSI path (no build) |
| `pnpm alpha --list` | Tail of `BUILDS.md` |
| `pnpm alpha --uninstall` | Remove the installed Spine Alpha |

Flags combine: `pnpm alpha --clean --install --open`.

Each build:
- Versions the MSI `0.<YY>.<DOY*10+seq>` — monotonic within a year,
  up to 9 builds per day.
- Uses identifier `com.thereprocase.spine-alpha` + a pinned WiX
  `UpgradeCode` so the upgrade chain survives Tauri version bumps and
  never collides with a future stable Spine.
- Drops the MSI here as `spine-alpha-<YYYYMMDD>-<branch>-<commit>-<seq>.msi`.
- Appends a row to `BUILDS.md`.

## Install

Double-click the `.msi` in Explorer (or use `pnpm alpha --install`).
Windows SmartScreen will warn because we don't code-sign yet — click
*More info* → *Run anyway*. Installs as "Spine Alpha" in the Start
menu.

## Uninstall

Any of:
- `pnpm alpha --uninstall` (slow — queries WMI; ~30s)
- Start → *Settings* → *Apps* → *Spine Alpha* → *Uninstall*
- `msiexec /x <ProductCode>` if you know the code

## Why it's separate from the stable ring

When a stable Spine ships it will use `com.thereprocase.spine`. That's
a different Windows product code, so both can install side-by-side.
Useful when you want to diff behavior between rings without wiping
state.

## Gotchas

- `metadata.db` and `spine.db` are per-library, not per-install, so all
  Spine builds (alpha and stable, when it exists) share the same
  library data. That is intentional — you're testing the app, not the
  library.
- Packaged builds disable the Vite dev server — reloads and source
  maps are gone; this is the shipped user experience.
- Alpha builds are unsigned. Don't distribute outside your own
  machines without signing (see `docs/TECH_DEBT.md` §6.2).
