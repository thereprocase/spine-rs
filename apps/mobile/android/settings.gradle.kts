// Android project settings for Spine mobile pre-alpha.
//
// This is a standalone Gradle project deliberately decoupled from the pnpm
// workspace. The Rust core it consumes lives at repo-root `core/` and is
// cross-compiled separately (Sprint 3's build script will stage the
// resulting libspine_jni.so into app/src/main/jniLibs/<abi>/).

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "spine-alpha"
include(":app")
