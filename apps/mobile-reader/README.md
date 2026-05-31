# Spine Mobile Reader (demo, retired)

**Status as of 2026-04-26:** this Expo / React Native app is demo-only. It
proved branding, share/import flow, and reader interaction ideas, but it is no
longer the production mobile path. Native work continues in
`apps/mobile/android/` per `docs/ADR_011_mobile_compose.md`.

A standalone Expo / React Native EPUB reader for handing out to friends as an
APK. Lives next to the desktop app under `apps/mobile-reader/` in the Spine
monorepo, on branch `mvp-mobile-reader`. Not intended to merge to `main` — this
is a side track to validate branding and core reading UX before the full
BIBFRAME-native mobile app gets built against `spine-srv`.

## Scope

What it does, in order:

1. **Ingest** EPUBs via `expo-document-picker` (Downloads, iCloud Drive,
   Google Drive, Files app — anywhere the OS picker can reach).
2. **Persist** the picked file by copying it into
   `expo-file-system.documentDirectory/books/<uuid>.epub`. The picker URI
   would not survive an app restart.
3. **Parse** title, author (first creator), language, and cover image from the
   OPF inside the zip — pure-TS via `jszip` + `fast-xml-parser`.
4. **Display** a cover grid library, with imported books surviving relaunch.
5. **Read** the book in a fully themed reader (dark/sepia/light), with font
   size, typeface, justify, hyphenate, drop cap, and paginated/scroll mode
   controls — `epubjs` rendered inside `react-native-webview`.

What it explicitly does not do (per the brief):

- No cloud sync, accounts, or auth
- No annotations, highlights, bookmarks
- No collections, tags, search, sort, filters
- No reading-progress sync across devices
- No sharing, export, format conversion
- No reuse of desktop UI components — the desktop app uses Tauri + foliate-js
  in a WebView; the React tree is not portable to RN

## Status

- [x] Scaffolded on Expo SDK 54 / RN 0.81 / React 19 / Expo Router 6
- [x] Branding wired — logo 02 (three pixel spines on a shelf) generated to all
      icon slots from `scripts/build-icons.py`
- [x] Theme tokens (dark/light/sepia) ported from
      internal design notes (spine-mobile-tokens.jsx)
- [x] EPUB ingestion + OPF metadata parser + cover extraction
- [x] AsyncStorage-backed library index, FileSystem-backed blob storage
- [x] Library home (cover grid, long-press to delete, FAB to import)
- [x] Reader — `epubjs` in `react-native-webview`, themed via injected CSS,
      tap-zone gestures, chrome + display sheet matching mockups 09/10
- [x] Local Gradle APK build (debug-signed for sideloading)

## Decisions

### Reuse from `spine`

Surveyed the desktop and core. The relevant bits and what we did with them:

| Source | Reused as-is? | Notes |
|---|---|---|
| `core/spine-fmt-epub/*.rs` (OPF parser) | No | Rust + `quick-xml` + `zip`. Logic was readable but not portable. Rewrote in pure TS as `src/parser/epub.ts`. |
| `core/spine-oeb/src/metadata.rs` (Metadata struct) | Conceptually | Translated to TS as `BookRecord` in `src/types.ts`, flattened (single title, single author) — alpha doesn't need BIBFRAME yet. |
| `apps/desktop/src/tokens.ts` | No | Desktop tokens reference CSS variables — useless in RN. |
| `docs/.../spine-mobile-tokens.jsx` (`SPINE_THEMES`) | Yes | Lifted color values verbatim to `src/themes.ts`. Component definitions in the JSX (`MobileCover`, `AppBar`, etc.) were ported by hand to RN primitives. |
| `docs/.../spine-logos.jsx` (L02ThreeSpines) | Yes | Pixel grid replicated in `scripts/build-icons.py` using PIL. |

### EPUB rendering — `epubjs` in `react-native-webview`

Confirmed at the user checkpoint. Three options were on the table:

- **`react-native-readium`** — Wraps the **Readium Web Toolkit** in native
  modules. Better than epubjs but still WebView-backed underneath. Adds a
  Gradle / new-arch surface for limited gain.
- **`epubjs` in a WebView** — Pure-JS, zero native modules. CSS theming maps
  directly to the mockup token system. Picked.
- **Custom paginator** — Out of scope for the alpha.

The decision was framed against the documented long-term direction in the
Spine planning workspace: the eventual production mobile app is **native
Readium Mobile inside a Kotlin/Compose Android app**, not React Native
(`READER_FRONTENDS.md:8`,
`MVP_DESKTOP_MOBILE_PLAN.md:118`). That makes this entire React Native
codebase throwaway scope — RN itself is the dead-end, not the engine choice
within it. So we picked the engine that ships the cleanest APK in the least
time: `epubjs` in `react-native-webview`.

`scripts/build-reader-html.mjs` bundles `epub.min.js` + `jszip.min.js` + the
bootstrap (`scripts/reader-bootstrap.js`) and a token-aware CSS shell
(`scripts/reader.css`) into a single self-contained `assets/reader.html`,
plus a base64-encoded TS module at `src/reader/html.ts` that Metro can import
directly. The reader screen feeds the EPUB bytes over `injectJavaScript` and
listens for `postMessage` envelopes — see `src/reader/messages.ts` for the
typed protocol.

### Local storage

- **EPUB blobs**: `expo-file-system.documentDirectory/books/<uuid>.epub`. Files
  are copied on import (the picker URI is ephemeral on Android). Direct
  filesystem reads from `react-native-webview` need either a `file://` URL or
  a chunked-base64 channel — both are workable, decision belongs in the
  reader implementation.
- **Cover images**: `documentDirectory/covers/<uuid>.<ext>`. Rendered by
  `expo-image` from the local file URI.
- **Metadata index**: `@react-native-async-storage/async-storage` keyed by
  `spine.library.v1` (JSON-serialized array). Justification: alpha audience
  is five friends with at most a few dozen books each — fits comfortably
  under AsyncStorage's soft 6 MB cap on Android, no native module required.
  If the population grows past ~500 entries we'd switch to `expo-sqlite`.
- **Preferences**: AsyncStorage, key `spine.prefs.v1`.

### State

`zustand` (`useLibrary`, `usePrefs`). Lightweight, hooks-friendly, no provider
plumbing. AsyncStorage hydration runs once from the root layout's `useEffect`.

### Build

`pnpm install` from the worktree root. The workspace's `pnpm-workspace.yaml`
sets `nodeLinker: hoisted` because Expo's Metro resolver is finicky with
pnpm's nested `node_modules`.

`pnpm --filter @spine/mobile-reader build:icons` regenerates icon variants
from the logo 02 pixel spec.

`pnpm --filter @spine/mobile-reader build:reader` regenerates the inlined
reader HTML + base64-encoded TS module after upgrading `epubjs` or editing
the bootstrap.

#### Local Android APK (the alpha workflow)

1. `npx expo prebuild --platform android --no-install --clean` — generates
   `android/`. Already done; the folder is gitignored.
2. Set `ANDROID_HOME` to your Android SDK path. On this workstation:
   `export ANDROID_HOME=/c/Users/$USER/android/Sdk`. The repo's
   `android/local.properties` also pins `sdk.dir`.
3. `cd android && ./gradlew :app:assembleRelease`. First build pulls Gradle
   distribution + NDK + Hermes engine — expect 15–30 minutes.
4. Output APK lands at `android/app/build/outputs/apk/release/app-release.apk`.

#### Windows-specific build pitfalls (what bit us)

Two real problems on Windows + pnpm-workspace + Expo SDK 54 that aren't on
the official Expo monorepo guide:

1. **`File.cliPath(base)` makes the entry path relative on Windows.** The
   React Native gradle plugin (`@react-native/gradle-plugin/shared/.../Os.kt`,
   the `cliPath` extension) returns the relative form on Windows and the
   absolute form on Unix. With pnpm hoisted to the workspace root and Expo's
   `expo export:embed` defaulting `--project-root` to `process.cwd()`, the
   relative entry path resolves against the wrong root and Metro fails with
   `Unable to resolve module ./index.js`. Fix in `android/app/build.gradle`:
   override `extraPackagerArgs = ["--entry-file", file("../../index.js").absolutePath]`
   so the absolute entry wins via reverse arg parsing in the Expo CLI.

2. **Windows MAX_PATH (260) blocks CMake/ninja codegen output.** CMake encodes
   each source file's absolute path into the corresponding `.o` filename
   under `<build>/CMakeFiles/<target>.dir/<encoded-path>.cpp.o`. With the
   project at a long path such as `C:\Users\<user>\projects\spine\apps\mobile-reader\`,
   the resulting object paths exceed 260 characters and ninja fails with
   `Filename longer than 260 characters`. Fix: build from a junction at a
   short root, e.g.

   ```
   cmd /c "mklink /J C:\spine C:\Users\<user>\projects\spine"
   cd C:\spine\apps\mobile-reader\android && ./gradlew :app:assembleRelease
   ```

   The junction is reversible (`rmdir C:\spine`) and doesn't move any files.
   Enabling `LongPathsEnabled=1` in the registry would also work but requires
   admin and changes Windows-wide behavior — junction is the surgical fix.

The `index.js` shim at the package root (importing `expo-router/entry`) is a
small belt-and-suspenders that side-steps a separate edge case where the
embed step can't resolve a node-modules path without touching its `main`
field. Keep it.

The release APK is signed with the auto-generated debug keystore — fine for
sideloading to friends, **not** for store distribution. To rotate to a
dedicated release key later, regenerate `android/app/release.keystore` and
update the `signingConfigs.release` block in `android/app/build.gradle`.

Sideload by copying the APK to the phone and tapping it (Android will prompt
to allow installs from unknown sources for the file manager that opens it).

#### EAS cloud build (alternative)

`pnpm --filter @spine/mobile-reader build:apk` runs `eas build -p android
--profile preview --non-interactive`. Requires an authenticated EAS account
(`eas login`) and a `projectId` in `app.json`'s `extra.eas` block, set by
`eas init` on first run.

## Layout

```
apps/mobile-reader/
├── app.json                   Expo config
├── eas.json                   Build profiles (preview = sideload APK)
├── package.json
├── tsconfig.json              strict, noUncheckedIndexedAccess
├── scripts/
│   └── build-icons.py         renders logo 02 at all required sizes
├── assets/images/             generated icons + splash
├── app/
│   ├── _layout.tsx            Stack root, theme + hydration
│   ├── index.tsx              Library home
│   └── reader/[id].tsx        Reader (stub — checkpoint gated)
└── src/
    ├── themes.ts              SPINE_THEMES dark / light / sepia
    ├── types.ts               BookRecord, ParsedEpub
    ├── storage.ts             FileSystem + AsyncStorage helpers
    ├── parser/epub.ts         pure-TS OPF metadata extractor
    ├── store/library.ts       zustand: imported books
    ├── store/prefs.ts         zustand: app theme + reader settings
    └── ui/
        ├── Cover.tsx          embedded image OR generated paperboard cover
        └── useTheme.ts        useAppTheme / useReaderTheme hooks
```
