# Spine Alpha Ring — build log

Unsigned MSIs for between-session desktop testing. Each build installs
as "Spine Alpha" and coexists with any future stable "Spine". A newer
alpha MSI upgrades the previous one in place — the WiX UpgradeCode is
pinned in `scripts/build-alpha.sh`, so upgrade chain survives Tauri
version bumps.

SmartScreen warns on first install: click "More info" → "Run anyway".
Unsigned binaries are a known limitation (`docs/TECH_DEBT.md` §6.2).

| Date | Commit | Version | File |
|---|---|---|---|
| 20260424 | `19260c26a` | `0.26.1141` | `spine-alpha-20260424-19260c26a-1.msi` |
| 20260424 | `61c400532` | `0.26.1142` | `spine-alpha-20260424-61c400532-2.msi` — **[SUPERSEDED — built off empty-merge tree `61c4005`; pre-sprint app content.]** |
| 20260424 | `dc4f5aaef-dirty` | `0.26.1143` | `spine-alpha-20260424-dc4f5aaef-dirty-3.msi` |
| 20260425 | `45550254e-dirty` | `0.26.1151` | `spine-alpha-20260425-45550254e-dirty-1.msi` |
| 20260425 | `542b0b1e6` | `0.26.1152` | `spine-alpha-20260425-542b0b1e6-2.msi` — sha256 `6eb614b21af0b383fd43e6bb802e8de3927ca5bebb36e09dc9861f466f924933` — Sprint 8 close — ADR 014 + multi-select + light theme + LCSH UI + EDTF regex fix |
| 20260425 | `f48193fdb-dirty` | `0.26.1153` | `spine-alpha-20260425-f48193fdb-dirty-3.msi` |
