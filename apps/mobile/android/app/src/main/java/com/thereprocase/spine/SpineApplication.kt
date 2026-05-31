package com.thereprocase.spine

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Application-scoped state that survives configuration changes and
 * outlives any individual activity.
 *
 * Right now this exists for one reason: ReaderActivity's "Read once"
 * cleanup needs to fire after the activity is destroyed (so its
 * lifecycleScope is gone), but we don't want it on `GlobalScope`
 * with a `@OptIn(DelicateCoroutinesApi::class)` (code review N2 #4).
 * The application-scoped [applicationScope] is the Android-idiomatic
 * answer: it lives as long as the process and dies cleanly when the
 * app is killed.
 *
 * `SupervisorJob()` so a single failing cleanup doesn't cancel the
 * shared scope. `Dispatchers.IO` because every consumer here is
 * filesystem-bound — there's no UI work that should ever land on
 * this scope.
 */
class SpineApplication : Application() {

    /** Scope tied to the Application's lifetime. Use for fire-and-
     *  forget IO that must outlive an activity (e.g. temp-book
     *  cleanup on activity destroy). Do not use for UI work. */
    val applicationScope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.IO)
}

/** Shorthand to fetch [SpineApplication.applicationScope] from any
 *  Context. Asserts the Application class is wired in
 *  AndroidManifest.xml; the cast failure produces a clearer error
 *  message than a stack trace lookup three callers deep. */
val android.content.Context.spineApplicationScope: CoroutineScope
    get() {
        val app = applicationContext as? SpineApplication
            ?: error(
                "spineApplicationScope requires SpineApplication; " +
                    "check android:name in AndroidManifest.xml"
            )
        return app.applicationScope
    }
