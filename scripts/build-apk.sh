#!/usr/bin/env bash
# Spine Android APK build — Sprint 3.
#
# Commands:
#   pnpm apk              build a debug APK for arm64-v8a
#   pnpm apk --clean      wipe staged .so + gradle build dir first
#   pnpm apk --install    build, then adb install -r onto the default device
#   pnpm apk --latest     print path to the most recent APK, no build
#   pnpm apk --list       show recent builds from BUILDS.md
#   pnpm apk --help, -h   usage
#
# Pipeline:
#   1. cargo ndk cross-compiles spine-jni → core/target/aarch64-linux-android/release/libspine_jni.so
#   2. Stage the .so into apps/mobile/android/app/src/main/jniLibs/arm64-v8a/
#   3. ./gradlew :app:assembleDebug (retries with --no-configuration-cache on failure)
#   4. Copy APK to artifacts/apk/spine-alpha-<date>-<sha>-<seq>.apk + append BUILDS.md
#
# Requires:
#   - git, cargo, cargo-ndk
#   - rustup target aarch64-linux-android installed
#   - ANDROID_HOME (autodetects $HOME/android-sdk, then $HOME/Android/Sdk)
#   - ANDROID_NDK_HOME (autodetects newest dir under $ANDROID_HOME/ndk/)
#   - JDK 17+ on PATH (Gradle wrapper requirement)

set -euo pipefail
export LANG=C

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

ANDROID_DIR="$REPO_ROOT/apps/mobile/android"
JNI_CRATE="spine-jni"
JNI_LIB="libspine_jni.so"
ABI="arm64-v8a"
RUST_TARGET="aarch64-linux-android"
ARTIFACT_DIR="$REPO_ROOT/artifacts/apk"
BUILDS_LOG="$ARTIFACT_DIR/BUILDS.md"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

# ── sub-commands that short-circuit before preflight / build ────────────
CMD="${1:-build}"
case "$CMD" in
  -h|--help|help)
    usage; exit 0 ;;
  --latest|latest)
    LATEST=$(ls -t "$ARTIFACT_DIR"/spine-alpha-*.apk 2>/dev/null | head -1 || true)
    if [ -z "$LATEST" ]; then
      echo "no APKs in $ARTIFACT_DIR — run 'pnpm apk' to build one" >&2
      exit 1
    fi
    echo "$LATEST"
    exit 0 ;;
  --list|list)
    if [ -f "$BUILDS_LOG" ]; then
      tail -20 "$BUILDS_LOG"
    else
      echo "no builds yet — run 'pnpm apk' to build one" >&2
      exit 1
    fi
    exit 0 ;;
  build|--install|install|--clean|clean) ;;
  *)
    echo "unknown flag: $CMD" >&2
    usage
    exit 2 ;;
esac

DO_CLEAN=0; DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --clean|clean)     DO_CLEAN=1 ;;
    --install|install) DO_INSTALL=1 ;;
    build)             ;;
    *)                 ;;  # already validated above
  esac
done

# ── SDK / NDK autodetect ────────────────────────────────────────────────
if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in "$HOME/android-sdk" "$HOME/Android/Sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "!! ANDROID_HOME not set and no default found (tried ~/android-sdk, ~/Android/Sdk)" >&2
  exit 1
fi
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  # Newest NDK under $ANDROID_HOME/ndk/. `ls -v` sorts 27.1.x > 27.0.x correctly.
  NDK_LATEST=$(ls -v "$ANDROID_HOME/ndk" 2>/dev/null | tail -1 || true)
  if [ -n "$NDK_LATEST" ]; then
    export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_LATEST"
  fi
fi
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "!! ANDROID_NDK_HOME not set; no NDK under $ANDROID_HOME/ndk/" >&2
  exit 1
fi

# ── preflight: tools ────────────────────────────────────────────────────
# Some WSL/CI shells don't auto-source rustup's env; be helpful here, but only
# if the user hasn't already arranged for cargo to be on PATH (don't shadow a
# custom toolchain setup).
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
for bin in git cargo; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "!! required tool not on PATH: $bin" >&2
    exit 1
  fi
done
if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "!! cargo-ndk not installed — 'cargo install cargo-ndk'" >&2
  exit 1
fi
if ! rustup target list --installed 2>/dev/null | grep -q "^${RUST_TARGET}$"; then
  echo "!! Rust target missing — 'rustup target add ${RUST_TARGET}'" >&2
  exit 1
fi
if [ ! -x "$ANDROID_DIR/gradlew" ]; then
  echo "!! $ANDROID_DIR/gradlew not executable (chmod +x or verify scaffolding)" >&2
  exit 1
fi

# Parse compileSdk from app/build.gradle.kts and verify the platform is
# installed locally. Skipping this lets Gradle attempt an SDK-manager download
# mid-build, which surprises CI and obscures preflight failures.
GRADLE_FILE="$ANDROID_DIR/app/build.gradle.kts"
COMPILE_SDK=$(grep -oE 'compileSdk[[:space:]]*=[[:space:]]*[0-9]+' "$GRADLE_FILE" | grep -oE '[0-9]+' | head -1)
if [ -z "$COMPILE_SDK" ]; then
  echo "!! could not parse compileSdk from $GRADLE_FILE" >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/platforms/android-$COMPILE_SDK" ]; then
  echo "!! SDK platform missing: $ANDROID_HOME/platforms/android-$COMPILE_SDK" >&2
  echo "   install with: $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \"platforms;android-$COMPILE_SDK\"" >&2
  echo "   (installed platforms: $(ls "$ANDROID_HOME/platforms" 2>/dev/null | tr '\n' ' '))" >&2
  exit 1
fi

# ── version ─────────────────────────────────────────────────────────────
# Matches the alpha MSI scheme so a same-day MSI and APK share the encoding
# (different namespaces though: the APK sequence is independent of the MSI
# sequence for the day).
GIT_SHA=$(git rev-parse --short=9 HEAD)
GIT_DIRTY=""
if ! git diff --quiet HEAD 2>/dev/null; then GIT_DIRTY="-dirty"; fi
BUILD_DATE=$(date +%Y%m%d)
YY=$(date +%y)
DOY=$(date +%j)

mkdir -p "$ARTIFACT_DIR"
SEQ=$(find "$ARTIFACT_DIR" -maxdepth 1 -name "spine-alpha-${BUILD_DATE}-*.apk" 2>/dev/null | wc -l | tr -d ' ')
SEQ=$((SEQ + 1))
if [ "$SEQ" -gt 9 ]; then
  echo "!! already 9 APK builds today — drop old builds or roll over to a new day" >&2
  exit 1
fi
APK_VERSION="0.${YY}.$((10#$DOY * 10 + SEQ))"
# Android versionCode must be strictly monotonic across releases; using
# DOY*10+SEQ alone resets each year. YY*10000 + patch keeps it monotonic
# through year 2214 (Android versionCode is int32, max 2^31-1).
APK_VERSION_CODE=$((10#$YY * 10000 + 10#$DOY * 10 + SEQ))

echo ">> Spine APK build"
echo "   commit:  ${GIT_SHA}${GIT_DIRTY}"
echo "   version: ${APK_VERSION}  (versionCode ${APK_VERSION_CODE}, seq ${SEQ} of today)"
echo "   sdk:     ${ANDROID_HOME}"
echo "   ndk:     ${ANDROID_NDK_HOME}"

# ── optional clean ──────────────────────────────────────────────────────
if [ "$DO_CLEAN" -eq 1 ]; then
  echo ">> --clean: wiping staged .so and gradle build output"
  find "$ANDROID_DIR/app/src/main/jniLibs/${ABI}" -maxdepth 1 -name 'lib*.so' -delete 2>/dev/null || true
  rm -rf "$ANDROID_DIR/app/build" "$ANDROID_DIR/.gradle"
fi

# ── cross-compile spine-jni ─────────────────────────────────────────────
echo ">> cargo-ndk: cross-compile ${JNI_CRATE} for ${ABI}"
pushd "$REPO_ROOT/core" > /dev/null
# --platform 24 matches apps/mobile/android/app/build.gradle.kts minSdk=24.
cargo ndk --target "${ABI}" --platform 24 build --release -p "${JNI_CRATE}"
popd > /dev/null

SRC_SO="$REPO_ROOT/core/target/${RUST_TARGET}/release/${JNI_LIB}"
if [ ! -f "$SRC_SO" ]; then
  echo "!! ${JNI_LIB} not found at $SRC_SO after cargo-ndk build" >&2
  exit 1
fi

DEST_SO_DIR="$ANDROID_DIR/app/src/main/jniLibs/${ABI}"
mkdir -p "$DEST_SO_DIR"
cp "$SRC_SO" "$DEST_SO_DIR/${JNI_LIB}"
SO_SIZE=$(du -h "$SRC_SO" | cut -f1)
echo ">> staged:  $DEST_SO_DIR/${JNI_LIB} (${SO_SIZE})"

# ── gradle assemble ─────────────────────────────────────────────────────
echo ">> gradle: :app:assembleDebug"
pushd "$ANDROID_DIR" > /dev/null
# Configuration-cache is on by default via gradle.properties. Some AGP+plugin
# combinations throw opaque errors against it — fall back once with
# --no-configuration-cache before giving up.
GRADLE_VERSION_ARGS=(-PappVersionName="${APK_VERSION}" -PappVersionCode="${APK_VERSION_CODE}")
if ! ./gradlew :app:assembleDebug "${GRADLE_VERSION_ARGS[@]}"; then
  echo "!! gradle failed — retrying with --no-configuration-cache" >&2
  ./gradlew :app:assembleDebug --no-configuration-cache "${GRADLE_VERSION_ARGS[@]}"
fi
popd > /dev/null

# ── locate output ───────────────────────────────────────────────────────
SRC_APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$SRC_APK" ]; then
  echo "!! APK not found at $SRC_APK" >&2
  exit 1
fi

DEST_APK="$ARTIFACT_DIR/spine-alpha-${BUILD_DATE}-${GIT_SHA}${GIT_DIRTY}-${SEQ}.apk"
cp "$SRC_APK" "$DEST_APK"

# ── log ─────────────────────────────────────────────────────────────────
if [ ! -f "$BUILDS_LOG" ]; then
  cat > "$BUILDS_LOG" <<'EOF'
# Spine Alpha Ring — Android APK build log

Unsigned debug APKs for between-session Android testing. Install via
`adb install -r <path>` on a USB-connected device with USB debugging on.
Application ID is `com.thereprocase.spine.alpha`, co-resident with any
future stable `com.thereprocase.spine` install.

Version scheme matches the alpha MSI log: `0.YY.<DOY*10 + seq>`, monotonic
within a year, max 9 builds/day. APK sequence is independent of MSI
sequence on the same day (different artifact namespaces).

`versionName` and `versionCode` inside the APK manifest now match the
filename version via `-PappVersionName` / `-PappVersionCode` gradle
properties (scheme: `versionName = 0.YY.<DOY*10+seq>`, `versionCode =
YY*10000 + DOY*10 + seq`, monotonic through year 2214). Installing a
new build over an older one is a straight upgrade.

| Date | Commit | Version | File |
|---|---|---|---|
EOF
fi
echo "| ${BUILD_DATE} | \`${GIT_SHA}${GIT_DIRTY}\` | \`${APK_VERSION}\` | \`$(basename "$DEST_APK")\` |" >> "$BUILDS_LOG"

APK_SIZE=$(du -h "$DEST_APK" | cut -f1)
echo
echo ">> built:   $DEST_APK (${APK_SIZE})"
echo ">> version: $APK_VERSION"

# ── optional install ────────────────────────────────────────────────────
# Honors:
#   ADB=/path/to/adb        override the adb binary (default: $ANDROID_HOME/platform-tools/adb,
#                           with fallback to $(command -v adb))
#   ADB_REMOTE=host:port    wireless-ADB endpoint; if set, `adb connect`
#                           runs first so `install -r` can see the device.
#                           The connect is idempotent — subsequent invocations
#                           on the same running adb server are no-ops.
if [ "$DO_INSTALL" -eq 1 ]; then
  ADB="${ADB:-$ANDROID_HOME/platform-tools/adb}"
  if [ ! -x "$ADB" ]; then
    if command -v adb >/dev/null 2>&1; then
      ADB=$(command -v adb)
    else
      echo "!! adb not found — set ADB=/path/to/adb or install platform-tools" >&2
      exit 1
    fi
  fi
  if [ -n "${ADB_REMOTE:-}" ]; then
    echo ">> adb connect $ADB_REMOTE"
    "$ADB" connect "$ADB_REMOTE" || {
      echo "!! adb connect failed — check the endpoint is reachable (tailnet/LAN)" >&2
      exit 1
    }
  fi
  echo ">> adb install -r $DEST_APK"
  "$ADB" install -r "$DEST_APK"
fi

echo ">> done."
