# apps/mobile/android — Spine Android (pre-alpha)

Single-activity Jetpack Compose app that hosts the Spine Rust core via
JNI. `arm64-v8a` only for the pre-alpha ring. Sprint 2 compiles Kotlin;
Sprint 3 stages `libspine_jni.so` and produces a signed APK.

## Prerequisites

| Tool | Where |
|---|---|
| Android SDK + platform 35 + build-tools 35.0.0 | `~/android-sdk/` |
| Android NDK r27.1.12297006 | `~/android-sdk/ndk/27.1.12297006/` |
| JDK 17 | `$JAVA_HOME` |
| Rust target `aarch64-linux-android` + `cargo-ndk` | Sprint 3 only |
| `adb` for on-device install | `~/android/platform-tools/adb` |

## Environment (per shell)

The Gradle toolchain reads `ANDROID_HOME` and `ANDROID_NDK_HOME`; set
them before running any `./gradlew` target.

```
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
```

These are intentionally not persisted — the repo-level `direnv` /
`.envrc` pattern is the right layer, not a global shell rc edit.

## Sprint 2 gate (current)

```
./gradlew :app:compileDebugKotlin
```

Must be green. This is the full success signal for the Kotlin slice;
native linking happens in Sprint 3.

## Sprint 3 + beyond

```
./gradlew :app:assembleDebug
```

`assembleDebug` **will fail** until `libspine_jni.so` is staged under
`app/src/main/jniLibs/arm64-v8a/`. The workspace-root helper script
`scripts/build-apk.sh` (shipped in Sprint 3) cross-compiles the Rust
crate via `cargo ndk` and stages the library before invoking Gradle.

## Application ID — alpha vs. stable

`applicationId = "com.thereprocase.spine.alpha"` on this module. The
stable ring reserves `com.thereprocase.spine`. The two installs
co-exist on a device (different packages, different launcher icons,
different data dirs) — there is no silent upgrade path. Users migrate
from alpha → stable by hand by exporting their library and re-importing
on the stable install.

## compileSdk / targetSdk

Both pinned to 35 (Android 15). Preview platform 36 is installed on
the CI image but intentionally not targeted — previews move under us.
When upstream Android 15 becomes "current stable" on Play, the pin
stays at 35 until the Android 16 stable cycle lands.

`targetSdk = 35` enables Android 15's edge-to-edge enforcement. The
Compose activities (`MainActivity`, `ReaderActivity`) both use
`enableEdgeToEdge()` + `Scaffold(innerPadding)` — no manual inset
wiring required.

## Gradle configuration cache — fallback

`gradle.properties` enables the configuration cache
(`org.gradle.configuration-cache=true`). A handful of Android Gradle
plugin integrations and third-party plugins still emit opaque cache
misses or serialization errors under this flag.

If you hit a message like "configuration cache problems found" or a
cryptic task-graph rebuild loop, disable it for the invocation:

```
./gradlew --no-configuration-cache :app:compileDebugKotlin
```

If it reproduces without the cache, it's a real bug. If it only shows
under the cache, report which plugin mentioned in the error chain
triggered it — that's a `gradle.properties` pin question, not a
Spine-code question.

## Debug webview inspection

The WebView in `ReaderActivity` opts into
`WebView.setWebContentsDebuggingEnabled(true)` **only** under
`BuildConfig.DEBUG`. Connect Chrome on the host to
`chrome://inspect/#devices` with the device in USB debugging mode.
Release builds never expose this surface.

## Security rules — do not soften without a review

- `WebView.settings.allowFileAccess = false` — never flip to true.
  `file://` origins in a WebView that hosts EPUB content is a well-known
  CVE class (cross-origin reads against app-private files, including
  credentials). No dedicated `docs/TECH_DEBT.md` entry names it; see
  `docs/ADR_011_mobile_compose.md` for the decision context and
  `WebViewAssetLoader` (in `ReaderActivity.kt`) for the alternative we
  use instead — `https://appassets.androidplatform.net/` origins never
  expose `file://`.
- EPUB bytes travel `ContentResolver.openInputStream` →
  `filesDir/books/` only. They **never** route through
  `SpineCore.callApi` (TECH_DEBT §4.9, UTF-8 lossy bridge).
- `SpineCore.callApi` returns `String?`. Callers must handle the null
  branch as an unrecoverable bridge fault, not a user-facing error
  (TECH_DEBT §4.12).

See `core/spine-jni/README.md` for the JNI contract that the Kotlin
`SpineCore` object implements.
