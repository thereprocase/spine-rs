# Spine Alpha Ring — Android APK build log

Unsigned debug APKs for between-session Android testing. Install via
`adb install -r <path>` on a USB-connected device with USB debugging on.
Application ID is `com.thereprocase.spine.alpha`, co-resident with any
future stable `com.thereprocase.spine` install.

Version scheme matches the alpha MSI log: `0.YY.<DOY*10 + seq>`, monotonic
within a year, max 9 builds/day. APK sequence is independent of MSI
sequence on the same day (different artifact namespaces).

Note: `versionName` is hardcoded to `0.1.0-alpha` inside the APK itself
until Sprint 4 externalizes it via a Gradle property. The filename is
authoritative for version provenance until then.

| Date | Commit | Version | File |
|---|---|---|---|
| 20260424 | `e9c000f1c-dirty` | `0.26.1141` | `spine-alpha-20260424-e9c000f1c-dirty-1.apk` |
