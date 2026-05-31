# ADR 011: Android UI Framework — Jetpack Compose over Classic Views

## Status
Accepted (2026-04-24, Sprint 2 implementation).

## Context
Sprint 2 of the Spine Android pre-alpha required picking a UI framework for the first real Kotlin surface (`MainActivity`, `ReaderActivity`, per-book overflow menus, library list). The WIP Gradle scaffolding in `apps/mobile/android/app/build.gradle.kts` pulled Compose BOM `2024.09.03` alongside Material3 and `androidx.activity:activity-compose`, but the choice itself had never been written down. A Round-2 pre-Sprint-2 review (warning #5) flagged this: "Compose vs Views needs a rationale doc so future contributors understand why the team did not use the framework their Android book from 2017 tells them to."

Spine's broader frontend architecture is **Option B** (per `docs/refs-other/responsive-universal-reference.md`): separate frontend apps (desktop Tauri + React, mobile Android + native UI toolkit), one shared Rust core served over the HTTP contract. Desktop and mobile diverge meaningfully — desktop is "manage a library", mobile is "read a book" — so we are deliberately not shipping one cross-platform UI. This ADR therefore scopes narrowly to the Android UI layer.

The mobile app is also deliberately minimal for the pre-alpha ring: one button to ping the Rust core, one button to import an EPUB via `ACTION_OPEN_DOCUMENT`, a library list, a reader activity that wraps a WebView. That scope fits comfortably in either Views or Compose; the decision is about the next 30 years, not the next 500 LOC.

## Decision
**Jetpack Compose, single-activity.** `MainActivity` and `ReaderActivity` use `setContent { … }`; all screens are `@Composable` functions. Material3 is the design-system baseline. No XML layouts ship beyond the launcher icon, FileProvider paths, theme values, and manifest.

### Ancillary decisions that fell out of this
1. **Kotlin DSL for Gradle** (`build.gradle.kts` not `build.gradle`). Not strictly forced by Compose — but the Compose compiler plugin, Kotlin serialization, and Compose BOM all read more naturally in the Kotlin DSL. The Groovy DSL's deprecation path is visible enough that starting in it in 2026 would be strictly backward-looking.
2. **Single `MainActivity` + `ReaderActivity`.** Two activities, not one, because `ReaderActivity` has meaningfully different lifecycle concerns (WebView suspension, back-button to close the book without tearing down the library, potential future screen-lock keep-awake during reading). Each activity hosts its own composition. This is Compose-idiomatic; multi-activity Compose is normal, not an anti-pattern.
3. **`enableEdgeToEdge()`** from `androidx.activity:activity-compose` in both `MainActivity.onCreate` and `ReaderActivity.onCreate` to satisfy the `targetSdk=35` edge-to-edge enforcement (Android 15). This is the modern replacement for the older `WindowCompat.setDecorFitsSystemWindows(window, false)` pattern. The real inset-wiring work happens downstream in `Scaffold(innerPadding) { ... }` — Compose's `Scaffold` consumes `WindowInsets.systemBars` and hands a `PaddingValues` to the content slot, so individual composables don't need to thread insets themselves. WebView bottom-inset handling in `ReaderActivity` falls out of this automatically via `Modifier.padding(inner)` on the `AndroidView`.

## Consequences

### Pros
- **Single source of truth for UI state.** State lives in Kotlin `State`/`MutableStateFlow`; no XML `findViewById` wiring, no `ViewBinding` generation, no `Fragment` lifecycle mismatches with the underlying view hierarchy. This is the class of bug that produces "works on my phone but crashes on rotation" reports and consumes weeks of triage time.
- **The JNI boundary fits.** `SpineCore.callApi(...)` returns `String?` and is called from coroutines; the result updates a `remember { mutableStateOf(...) }` and the UI recomposes. No adapter pattern between "Rust returned a value" and "the UI reflects it." Compare to Views, where the idiomatic path is RecyclerView + adapter + DiffUtil for something as simple as a library list.
- **Future reader-UI work is cheaper.** Sprint 3 adds real reader bundle integration, Sprint 4+ adds an annotation overlay, a progress scrubber, typography controls. All of these are composable overlays in Compose; in Views they would be `FrameLayout`s with `Visibility` gymnastics or a motion layout XML file.
- **Matches where the ecosystem is headed.** Google has stopped investing in new Views-only primitives since ~2022. New Material3 components ship Compose-first; some (e.g. `PullToRefreshBox`) have no Views equivalent. Choosing Views today means choosing a frozen surface.
- **Preview/tooling story is strictly better.** `@Preview` annotations render straight in Android Studio with no emulator spin-up. For a project where UI iteration is a known cost (this is a reader app; typography and spacing matter), that's real time saved.

### Cons
- **Learning curve.** Compose demands a mental model shift — recomposition, state hoisting, `remember`, `LaunchedEffect`, `DisposableEffect`. A contributor who grew up on Views can and will write code that recomposes 60 times per second and looks fine locally but drains battery on a real phone.
- **Tooling maturity uneven around WebView.** `AndroidView { WebView(context) }` is the interop escape hatch, and it works, but the Compose-native WebView story (`accompanist-webview`) was deprecated without a replacement. `ReaderActivity` uses `AndroidView(factory = ..., onRelease = { it.destroy() })` to own the WebView's lifecycle explicitly — `AndroidView`'s default `onRelease` is a no-op, which for a WebView means the JavaScript engine + `JavascriptInterface` bridges leak on every exit from the composition. Naming `onRelease = { it.destroy() }` is the non-obvious part that keeps this correct.
- **Compose BOM cadence is fast.** We pinned `2024.09.03`; Google ships a BOM roughly every two months. Upgrades are usually clean but occasionally surface deprecation churn (e.g. `LazyRow.items(...)` signatures changing between minor versions). Accept this as operating cost; do not try to avoid it.
- **APK size.** Compose adds ~2-3 MB to the APK over a pure-Views baseline. The first Sprint 2 + 3 APK measured 30 MB total (`spine-alpha-20260424-e9c000f1c-dirty-1.apk`) — the bulk of that is Material3 + `material-icons-extended` (~10 MB uncompressed alone) + `kotlinx-serialization` + `androidx.webkit` + the Kotlin runtime, not Compose itself. The marginal Compose cost is invisible at this scale. For a pre-alpha sideload app, absolute size is also invisible. For a future F-Droid listing, it is a cost we have consciously absorbed.

### Locked-in downstream implications
- `androidx.compose.material:material-icons-extended` (~10 MB uncompressed) is pulled alongside `-core`. Acceptable for pre-alpha; prune to `-core` only + a small curated set before any release ring beyond alpha. Tracked in `docs/TECH_DEBT.md` at the Sprint 2 closeout pass.
- Any future "bring a desktop contributor across to mobile" onboarding cost includes a week of Compose reading. Cheaper than asking them to learn the Views lifecycle in 2026.

## Alternatives Considered

### (A) Classic Views (XML + `setContentView`)
Rejected. The scope-fit argument cuts the other way — for an app this small, Views would have been marginally faster to type out. But the 30-year horizon is the wrong axis to pinch pennies on. We would be starting on a surface Google has stopped evolving, and every future screen would be paid for twice.

### (B) Compose Multiplatform (Android + iOS from one Kotlin codebase)
Rejected **for now**, not **forever**. CMP's iOS story matured meaningfully in 2025 but is still not where its Android story is. Spine's Option B architecture says "separate frontends"; iOS is not even on today's roadmap. If and when iOS becomes a goal, CMP is the serious candidate and this ADR gets revisited. For the pre-alpha, writing an Android-specific Compose surface carries the same maintenance cost as a CMP-Android surface, and leaves the iOS decision open.

### (C) React Native + Expo (sharing UI code with a hypothetical mobile React frontend)
Rejected. Two reasons. First, Spine's desktop is Tauri + React; React Native is a different runtime with different primitives, different navigation, different gesture handlers. The notion that "we can share components" between desktop React and React Native is known to be aspirational — in practice the sharable surface is utility functions and type definitions, not UI. Second, the Rust-bridge story under React Native requires a TurboModule (or the older JNI-via-JS-bridge path), which is strictly more complicated than Kotlin calling `SpineCore.callApi(...)` directly. The architecture brief explicitly rejected UniFFI-per-function bindings; it did not explicitly reject React Native, but the reasoning transfers: one generic `call_api(method, path, body)` native module per platform, and the Android platform's native module is written in Kotlin against Compose.

### (D) Flutter
Not seriously considered. Different runtime, different language (Dart), no Rust-bridge ergonomic advantage, and the team's existing skill set. Listed only for completeness so a future reader does not ask.

## Review trail
- **2026-04-24**: Sprint 2 paused with no UI code but with the Gradle surface landed (Compose BOM already pulled). R2 warning #5 filed against the missing ADR.
- **2026-04-24**: This document drafted to remove the blocker before Lane 3 (MainActivity + ReaderActivity) lands.
- **2026-04-24**: Read-review after Lane A landed. Found one real bug (`setDecorFitsSystemWindows` pattern did not exist in the code — modern `enableEdgeToEdge()` was used instead) and three framing gaps (`remember` holder didn't match `onRelease`-owned lifecycle; APK size cons bullet was marginal-only without absolute context; edge-to-edge hand-waved over `Scaffold`'s inset wiring). All four corrected in a follow-up commit per the no-amends discipline. Compose BOM vs JNI contract revisit trigger added.

## Revisit triggers
- iOS is added to the roadmap → revisit Compose Multiplatform.
- Compose's WebView interop story regresses further → revisit whether `ReaderActivity` should drop back to a Views-based shell around the WebView while everything else stays Compose. (Partial fallback is allowed.)
- APK size becomes a user-visible concern → prune material-icons-extended and audit the Compose dependency graph.
- **Compose BOM drift vs JNI contract.** Low-probability, high-blast-radius: if a BOM minor bump ever changes coroutine semantics at the JNI call site (`SpineCore.callApi(...)` dispatched on `Dispatchers.IO`) or nullability handling around `String?` returns, the `IO`-dispatcher + nullable-return contract from `core/spine-jni/README.md` has to be re-verified. Compose does not own the JNI boundary, but it owns the coroutine scope that wraps it in our code. Name-it-to-notice-it.
