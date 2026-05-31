#!/usr/bin/env bash
# Spine alpha-ring workflow.
#
# Commands:
#   pnpm alpha              build a new alpha MSI
#   pnpm alpha --install    build and install via msiexec (quiet)
#   pnpm alpha --clean      wipe bundle output first, then build
#   pnpm alpha --open       build, then open the artifact folder
#   pnpm alpha --latest     print path to most recent MSI, no build
#   pnpm alpha --list       show recent builds from BUILDS.md
#   pnpm alpha --uninstall  remove the installed Spine Alpha
#   pnpm alpha --help, -h   usage
#
# Requires Git Bash on Windows (or a Windows-native bash). Does NOT run
# under WSL2 — Tauri's MSI build drives Windows-native cargo.exe, which
# does not bridge cleanly across the WSL boundary (TECH_DEBT §6.9).
# From PowerShell: & "C:\Program Files\Git\bin\bash.exe" scripts/build-alpha.sh.
# CI runs this on windows-latest runners (non-WSL) — unaffected.

set -euo pipefail
export LANG=C

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

ARTIFACT_DIR="$REPO_ROOT/artifacts/alpha"
BUNDLE_DIR="$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle"
BUILDS_LOG="$ARTIFACT_DIR/BUILDS.md"
# --config path must be resolved by the Tauri CLI from its cwd. The CLI
# runs in apps/desktop/, so the relative form is src-tauri/tauri.alpha.json.
ALPHA_CONF_REL="src-tauri/tauri.alpha.json"
ALPHA_CONF_ABS="$REPO_ROOT/apps/desktop/$ALPHA_CONF_REL"
# Pinned WiX upgrade-code — load-bearing for the alpha upgrade chain.
# Do not regenerate; replacing it orphans every previously-installed alpha.
ALPHA_UPGRADE_CODE="8a42c966-066f-4b58-95d0-88ad63c73f45"
PRODUCT_NAME="Spine Alpha"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

# ── sub-commands that short-circuit before preflight / build ────────────
CMD="${1:-build}"
case "$CMD" in
  -h|--help|help)
    usage; exit 0 ;;
  --latest|latest)
    LATEST=$(ls -t "$ARTIFACT_DIR"/spine-alpha-*.msi 2>/dev/null | head -1 || true)
    if [ -z "$LATEST" ]; then
      echo "no alpha MSIs in $ARTIFACT_DIR — run 'pnpm alpha' to build one" >&2
      exit 1
    fi
    echo "$LATEST"
    exit 0 ;;
  --list|list)
    if [ -f "$BUILDS_LOG" ]; then
      tail -20 "$BUILDS_LOG"
    else
      echo "no builds yet — run 'pnpm alpha' to build one" >&2
      exit 1
    fi
    exit 0 ;;
  --uninstall|uninstall)
    if ! command -v powershell.exe >/dev/null 2>&1; then
      echo "!! --uninstall needs Windows PowerShell — use Settings → Apps & features → Spine Alpha" >&2
      exit 1
    fi
    echo ">> searching for installed $PRODUCT_NAME (may take ~30s)..."
    powershell.exe -NoProfile -Command "\$ErrorActionPreference='Stop'; \$p=Get-CimInstance -ClassName Win32_Product -Filter \"Name='Spine Alpha'\"; if(-not \$p){Write-Host 'no installed Spine Alpha found'; exit 1}; Write-Host (\">> uninstalling \"+\$p.Name+' ('+\$p.IdentifyingNumber+')'); [void]\$p.Uninstall(); Write-Host '>> uninstalled.'"
    exit $? ;;
  build|--install|install|--clean|clean|--open|open) ;;
  *)
    echo "unknown flag: $CMD" >&2
    usage
    exit 2 ;;
esac

# Parse flags (may be combined, e.g. --clean --install --open).
DO_CLEAN=0; DO_INSTALL=0; DO_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --clean|clean)     DO_CLEAN=1 ;;
    --install|install) DO_INSTALL=1 ;;
    --open|open)       DO_OPEN=1 ;;
    build)             ;;
    *)                 ;;  # already validated above
  esac
done

# Stale-config check doubles as a poor-man's mutex — if a previous alpha
# build crashed or a parallel invocation is live, bail instead of racing.
if [ -f "$ALPHA_CONF_ABS" ]; then
  echo "!! $ALPHA_CONF_ABS already exists — another alpha build running?" >&2
  echo "   if not, remove it and retry:  rm '$ALPHA_CONF_ABS'" >&2
  exit 1
fi

# ── preflight ──────────────────────────────────────────────────────────
if [ ! -d "$REPO_ROOT/apps/desktop/node_modules" ] || [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "!! 'pnpm install' has not been run (node_modules missing)" >&2
  exit 1
fi
# This script does not run under WSL2. The MSI build requires Windows-native
# cargo.exe (Tauri's MSI packaging drives WiX, which is Windows-only). From
# WSL:
#   - bash's `command -v cargo` does not resolve `cargo.exe` by bare name
#     (no PATHEXT equivalent), so preflight fails immediately.
#   - Node-on-Linux's `spawn("cargo")` from tauri-cli has the same gap —
#     even a cargo→cargo.exe shim fails downstream because tauri-cli passes
#     WSL POSIX paths to cargo.exe which cannot parse them.
#   - Linux cargo from ~/.cargo/env compiles but fails deep in gio-sys
#     (WSL lacks GTK dev libs).
# See docs/TECH_DEBT.md §6.9 for the investigation trail.
#
# Run from a Windows-side shell instead — Git Bash, PowerShell, or cmd.exe.
if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  cat >&2 <<'EOF'
!! scripts/build-alpha.sh cannot run under WSL2.
   The Windows MSI build requires Windows-native cargo.exe + Tauri
   toolchain, which do not bridge cleanly across the WSL boundary.

   Run from a Windows-side shell:
     Git Bash:    bash scripts/build-alpha.sh           (from the Git Bash
                                                          terminal on Windows)
     PowerShell:  & "C:\Program Files\Git\bin\bash.exe" scripts/build-alpha.sh
     cmd.exe:     "C:\Program Files\Git\bin\bash.exe" scripts/build-alpha.sh

   scripts/build-apk.sh (Android) runs fine from WSL — this restriction
   is specific to the desktop MSI path.

   See docs/TECH_DEBT.md §6.9 for the investigation + rationale.
EOF
  exit 1
fi
# On Git Bash / CI (windows-latest runner), auto-source ~/.cargo/env if
# cargo isn't on PATH. Don't shadow a custom toolchain setup.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
for bin in git cargo pnpm; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "!! required tool not on PATH: $bin" >&2
    exit 1
  fi
done

echo ">> preflight: cargo check (src-tauri)"
cargo check --manifest-path "$REPO_ROOT/apps/desktop/src-tauri/Cargo.toml" --quiet

# ── version ────────────────────────────────────────────────────────────
GIT_SHA=$(git rev-parse --short=9 HEAD)
GIT_BRANCH_RAW=$(git branch --show-current 2>/dev/null || true)
if [ -z "$GIT_BRANCH_RAW" ]; then
  GIT_BRANCH_RAW=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi
if [ -z "$GIT_BRANCH_RAW" ] || [ "$GIT_BRANCH_RAW" = "HEAD" ]; then
  GIT_BRANCH_RAW="detached"
fi
GIT_BRANCH=$(printf '%s' "$GIT_BRANCH_RAW" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g')
if [ -z "$GIT_BRANCH" ]; then
  GIT_BRANCH="branch"
fi
GIT_DIRTY=""
# Intentionally detects tracked modifications only, not untracked files.
# An untracked .epub or test artifact should not flip the tag to -dirty.
if ! git diff --quiet HEAD 2>/dev/null; then GIT_DIRTY="-dirty"; fi
BUILD_DATE=$(date +%Y%m%d)

# MSI ProductVersion is M.m.b with b capped at 65535. Encoding:
#   major = 0                              (reserved — pre-stable)
#   minor = YY          (two-digit year)
#   build = DOY * 10 + SEQ_TODAY           (max 366*10 + 9 = 3669; fits u16)
# Monotonic within a year; minor bumps on year rollover.
YY=$(date +%y)
DOY=$(date +%j)

mkdir -p "$ARTIFACT_DIR"
SEQ=$(find "$ARTIFACT_DIR" -maxdepth 1 -name "spine-alpha-${BUILD_DATE}-*.msi" 2>/dev/null | wc -l | tr -d ' ')
SEQ=$((SEQ + 1))
if [ "$SEQ" -gt 9 ]; then
  echo "!! already 9 builds today — either bump to a new day or drop old builds" >&2
  exit 1
fi
ALPHA_VERSION="0.${YY}.$((10#$DOY * 10 + SEQ))"

echo ">> Spine alpha build"
echo "   branch:  ${GIT_BRANCH_RAW} (${GIT_BRANCH})"
echo "   commit:  ${GIT_SHA}${GIT_DIRTY}"
echo "   version: ${ALPHA_VERSION}  (seq ${SEQ} of today)"
echo "   date:    ${BUILD_DATE}"

# ── optional clean ─────────────────────────────────────────────────────
if [ "$DO_CLEAN" -eq 1 ]; then
  echo ">> --clean: wiping bundle output"
  rm -rf "$BUNDLE_DIR"
fi

# ── generate override config ───────────────────────────────────────────
# `tauri build --config` merges this over tauri.conf.json. UpgradeCode
# pinned explicitly — Tauri has derived it from `identifier` historically,
# but the derivation algorithm has changed between Tauri versions.
# Clean up the override on any exit (success, error, SIGINT, SIGTERM, SIGHUP).
# Registered before the write so a disk-full mid-heredoc is also caught.
trap 'rm -f "$ALPHA_CONF_ABS"' EXIT INT TERM HUP
cat > "$ALPHA_CONF_ABS" <<EOF
{
  "\$schema": "https://schema.tauri.app/config/2",
  "productName": "${PRODUCT_NAME}",
  "version": "${ALPHA_VERSION}",
  "identifier": "com.thereprocase.spine-alpha",
  "app": {
    "windows": [
      { "title": "${PRODUCT_NAME}", "width": 1200, "height": 800 }
    ]
  },
  "bundle": {
    "targets": ["msi"],
    "windows": {
      "wix": {
        "upgradeCode": "${ALPHA_UPGRADE_CODE}"
      }
    }
  }
}
EOF

# ── build ──────────────────────────────────────────────────────────────
pushd "$REPO_ROOT/apps/desktop" > /dev/null
pnpm tauri build --config "$ALPHA_CONF_REL"
popd > /dev/null

# ── locate output ──────────────────────────────────────────────────────
# Tauri writes "Spine Alpha_<version>_<arch>_<locale>.msi". We key on the
# version string so stale MSIs from prior builds cannot be picked up.
SRC_MSI=$(ls -t "$BUNDLE_DIR/msi/${PRODUCT_NAME}_${ALPHA_VERSION}_"*.msi 2>/dev/null | head -1 || true)
if [ -z "$SRC_MSI" ]; then
  echo "!! MSI matching '${PRODUCT_NAME}_${ALPHA_VERSION}_*.msi' not found in $BUNDLE_DIR/msi" >&2
  ls -la "$BUNDLE_DIR/msi" 2>/dev/null || true
  exit 1
fi

DEST_MSI="$ARTIFACT_DIR/spine-alpha-${BUILD_DATE}-${GIT_BRANCH}-${GIT_SHA}${GIT_DIRTY}-${SEQ}.msi"
cp "$SRC_MSI" "$DEST_MSI"

# ── log ────────────────────────────────────────────────────────────────
if [ ! -f "$BUILDS_LOG" ]; then
  cat > "$BUILDS_LOG" <<'EOF'
# Spine Alpha Ring — build log

Unsigned MSIs for between-session desktop testing. Each build installs
as "Spine Alpha" and coexists with any future stable "Spine". A newer
alpha MSI upgrades the previous one in place — the WiX UpgradeCode is
pinned in `scripts/build-alpha.sh`, so upgrade chain survives Tauri
version bumps.

SmartScreen warns on first install: click "More info" → "Run anyway".
Unsigned binaries are a known limitation (`docs/TECH_DEBT.md` §6.2).

| Date | Branch | Commit | Version | File |
|---|---|---|---|---|
EOF
fi
echo "| ${BUILD_DATE} | \`${GIT_BRANCH_RAW}\` | \`${GIT_SHA}${GIT_DIRTY}\` | \`${ALPHA_VERSION}\` | \`$(basename "$DEST_MSI")\` |" >> "$BUILDS_LOG"

echo
echo ">> built:   $DEST_MSI"
echo ">> version: $ALPHA_VERSION"

# ── optional install ───────────────────────────────────────────────────
if [ "$DO_INSTALL" -eq 1 ]; then
  if command -v pgrep >/dev/null 2>&1 && pgrep -if "Spine Alpha" >/dev/null 2>&1; then
    echo "!! a running Spine Alpha process was detected — quit it before install" >&2
  fi

  # Translate the POSIX-ish path into a Windows path, if the tools are here.
  if command -v wslpath >/dev/null 2>&1; then
    DEST_WIN=$(wslpath -w "$DEST_MSI")
  elif command -v cygpath >/dev/null 2>&1; then
    DEST_WIN=$(cygpath -w "$DEST_MSI")
  else
    DEST_WIN="$DEST_MSI"
  fi
  echo ">> install: msiexec /i \"$DEST_WIN\" /qb"

  # Git Bash (MSYS) munges /i into C:/Program Files/Git/i unless disarmed
  # via MSYS_NO_PATHCONV and //-prefixed flags. WSL's bash has no such
  # munging and msiexec.exe expects literal /i + /qb.
  if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
    # WSL2 path.
    msiexec.exe /i "$DEST_WIN" /qb || {
      echo "!! install returned nonzero — check the log" >&2
      exit 1
    }
  else
    # Git Bash / MSYS path.
    MSYS_NO_PATHCONV=1 msiexec //i "$DEST_WIN" //qb || {
      echo "!! install returned nonzero — check the log" >&2
      exit 1
    }
  fi
fi

# ── optional open ──────────────────────────────────────────────────────
if [ "$DO_OPEN" -eq 1 ]; then
  if command -v wslpath >/dev/null 2>&1; then
    OPEN_WIN=$(wslpath -w "$ARTIFACT_DIR")
  elif command -v cygpath >/dev/null 2>&1; then
    OPEN_WIN=$(cygpath -w "$ARTIFACT_DIR")
  else
    OPEN_WIN="$ARTIFACT_DIR"
  fi
  if command -v explorer.exe >/dev/null 2>&1; then
    explorer.exe "$OPEN_WIN" || true
  elif command -v open >/dev/null 2>&1; then
    open "$ARTIFACT_DIR" || true
  else
    xdg-open "$ARTIFACT_DIR" || true
  fi
fi

echo ">> done."
