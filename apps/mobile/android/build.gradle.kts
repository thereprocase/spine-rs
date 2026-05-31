// Top-level build file. Plugin versions are declared here and applied per
// module so the module build files stay version-free.
//
// AGP 8.7 / Kotlin 2.0 baseline. Bumping these in lockstep is the sanest
// practice — AGP and Kotlin compiler versions interact and mismatches surface
// as opaque compile errors.

plugins {
    id("com.android.application") version "8.7.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
