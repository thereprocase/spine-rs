# ProGuard / R8 rules for the Spine alpha Android app.
#
# The pre-alpha does not enable minification (see app/build.gradle.kts
# `buildTypes.release.isMinifyEnabled = false`). These rules are staged
# ahead of the minify flip so that the moment R8 turns on, JNI externs
# are not silently stripped. A time-bomb we defuse today, not tomorrow.

# JNI bridge — every native method on SpineCore must survive R8.
-keep class com.thereprocase.spine.SpineCore { *; }
-keepclasseswithmembernames class * { native <methods>; }

# kotlinx.serialization — generated serializers for LibraryStore data
# classes use reflection on the @Serializable-annotated companion.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class com.thereprocase.spine.**$$serializer { *; }
-keepclassmembers class com.thereprocase.spine.** {
    *** Companion;
}
-keepclasseswithmembers class com.thereprocase.spine.** {
    kotlinx.serialization.KSerializer serializer(...);
}
