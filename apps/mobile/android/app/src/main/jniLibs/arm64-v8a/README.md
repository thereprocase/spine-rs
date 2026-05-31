# jniLibs/arm64-v8a — Sprint 3 populates `libspine_jni.so`

This directory is the APK's native-library staging area for the
`arm64-v8a` ABI. `app/build.gradle.kts` declares `abiFilters +=
"arm64-v8a"` in `defaultConfig.ndk{}`, so no other ABI is considered
for the pre-alpha.

**Sprint 2 (current):** empty directory held open by a `.gitkeep`. An
`assembleDebug` will fail at the native-library packaging step because
no `.so` is present; `:app:compileDebugKotlin` (the Sprint 2 gate) does
not care.

**Sprint 3:** `scripts/build-apk.sh` runs
`cargo ndk -t arm64-v8a build --release -p spine-jni` from the
workspace root, then copies the resulting
`core/target/aarch64-linux-android/release/libspine_jni.so` into this
directory before `./gradlew assembleDebug`. The `.so` is **not**
checked in — CI regenerates it each build.

The `packaging.jniLibs.excludes += "**/*.placeholder"` guard in
`app/build.gradle.kts` is belt-and-suspenders for a
developer-introduced placeholder convention — it is not a substitute
for populating a real library.
