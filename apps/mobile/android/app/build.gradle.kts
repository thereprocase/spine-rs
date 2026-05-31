// App module for Spine Android alpha (pre-alpha ring).
//
// Single-activity Jetpack Compose app that hosts the Rust core via JNI.
// arm64-v8a only for the pre-alpha; Sprint 3's cargo-ndk step populates
// `src/main/jniLibs/arm64-v8a/libspine_jni.so`. Until then the module ships
// only a `.gitkeep`, and the `jniLibs` packaging excludes any stray
// `*.placeholder` files so an incomplete local checkout cannot sneak a
// non-ELF file into the APK.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    kotlin("plugin.serialization") version "2.0.21"
}

android {
    namespace = "com.thereprocase.spine"
    // Android 15 stable. Build-tools 35.0.0 + platform android-35 are the
    // locally-installed pair. Preview (36) is avoided — don't pin to a
    // preview platform for the alpha ring.
    compileSdk = 35

    defaultConfig {
        // Alpha ring applicationId keeps the pre-alpha install co-resident
        // with a future stable build (`com.thereprocase.spine`). Documented
        // in apps/mobile/android/README.md; users migrate by hand.
        applicationId = "com.thereprocase.spine.alpha"
        minSdk = 24
        // targetSdk matches compileSdk. Android 15 enforces edge-to-edge
        // for targetSdk>=35; Compose activities handle it correctly as
        // long as content is wrapped in a windowInsetsPadding-aware
        // Scaffold or Surface — see MainActivity / ReaderActivity.
        targetSdk = 35
        // Version plumbing: scripts/build-apk.sh passes `-PappVersionName` +
        // `-PappVersionCode` derived from its DOY*10+seq scheme (matching the
        // filename version). Defaults below are fallbacks for direct
        // `./gradlew assembleDebug` invocations without the properties.
        // Tracked in docs/TECH_DEBT.md §6.6 as a previously-hardcoded value.
        versionCode = (project.findProperty("appVersionCode") as String?)?.toInt() ?: 50
        versionName = project.findProperty("appVersionName") as String? ?: "0.4.0-alpha"

        ndk {
            // Pre-alpha ships arm64-v8a only. x86_64 emulator support is a
            // Sprint 3+ concern once CI gets a connected device.
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        // Generated BuildConfig is required for the BuildConfig.DEBUG
        // gate in ReaderActivity (WebView debugging in debug builds
        // only). AGP 8+ defaults this to false.
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }

    packaging {
        jniLibs {
            // Belt-and-suspenders: even if a developer re-introduces a
            // `.placeholder` convention, it never lands in the APK.
            excludes += listOf("**/*.placeholder")
            useLegacyPackaging = false
        }
        resources {
            excludes += listOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1"
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")

    // Activity window themes (Theme.Material3.DayNight.NoActionBar)
    // live in the Views-based Material AAR. Compose's material3
    // artifact intentionally does NOT duplicate XML styles — the
    // activity still needs a window theme before Compose takes over
    // in setContent. AAPT fails to link our themes.xml without this.
    implementation("com.google.android.material:material:1.12.0")

    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // WebViewAssetLoader — the only sanctioned way to serve local assets to
    // a WebView without opening file:// origin CVEs.
    implementation("androidx.webkit:webkit:1.11.0")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
