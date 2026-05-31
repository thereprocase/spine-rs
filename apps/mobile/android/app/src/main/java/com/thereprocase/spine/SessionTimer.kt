package com.thereprocase.spine

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.CoroutineContext

/**
 * Per-book "active read time" timer with hybrid Kotlin+JS gating.
 *
 * The session timer is one of those things that looks trivial — count
 * seconds while the user is reading — and turns out to need three
 * different pieces of evidence to do correctly:
 *
 *  1. **Kotlin lifecycle** decides whether the activity is in the
 *     foreground at all. ReaderActivity calls [start] on `onResume`
 *     and [stop] on `onPause`. While stopped, no time accumulates.
 *
 *  2. **JS pings** decide whether the user is *actively reading*
 *     versus staring at a static page that they finished reading
 *     four hours ago and forgot to lock. spine-host.mjs calls
 *     [notePageEvent] on every relocate (page-turn, chapter jump,
 *     scrubber commit) and on every successful tap-zone tap. Each
 *     ping extends an "active deadline" by [ACTIVE_WINDOW_MS].
 *
 *  3. The **tick loop** runs once per second while [start] is in
 *     effect, but only accumulates a delta when `now < deadline`.
 *     If the user holds a page for longer than [ACTIVE_WINDOW_MS]
 *     without paging, the deadline lapses and the timer goes idle.
 *
 * Worst-case data loss: bounded by [PERSIST_INTERVAL_MS]. Process
 * death between two persistence flushes loses at most ~10 s of
 * accumulated time.
 *
 * Design rationale + alternatives considered in internal design notes
 * (N3–N5 bridge and data plan, §"Task 3").
 */
class SessionTimer(parent: CoroutineContext) {

    companion object {
        /** A page-event ping extends the "still active" deadline by
         *  this many milliseconds. Picked to be longer than a slow
         *  reader's typical page-dwell (~30–45 s for dense prose) but
         *  short enough that walking-away-from-phone doesn't
         *  accumulate stale time. */
        const val ACTIVE_WINDOW_MS = 60_000L

        /** Tick cadence. Once per second is fine; we don't need
         *  millisecond precision for "today's reading time." */
        const val TICK_INTERVAL_MS = 1_000L

        /** Flush accumulated delta to LibraryStore at most this often.
         *  Bounds worst-case process-death loss to roughly this value. */
        const val PERSIST_INTERVAL_MS = 10_000L
    }

    private val scope = CoroutineScope(parent + SupervisorJob())

    /** Per-book pending delta in milliseconds, not yet flushed. */
    private val pendingMs = AtomicLong(0L)

    /** Wall-clock millis past which the user is considered idle.
     *  Updated on every [notePageEvent] call. */
    @Volatile private var deadlineAtMs: Long = 0L

    /** The book id the timer is currently accumulating for. Null when
     *  no session is active. */
    @Volatile private var activeBookId: String? = null

    /** The tick + persist loop. Cancelled in [stop]. */
    private var loop: Job? = null

    /**
     * Begin a session for [bookId]. Idempotent — calling [start]
     * twice with the same id is a no-op; calling with a different
     * id stops the previous session (flushing any pending delta)
     * before starting the new one.
     *
     * The first ping is implicit: a fresh start arms the active
     * deadline so the first second of reading counts even before
     * the first relocate event fires.
     */
    fun start(ctx: Context, bookId: String) {
        if (bookId.isEmpty()) return
        if (activeBookId == bookId && loop?.isActive == true) return
        if (activeBookId != null) stop(ctx)
        activeBookId = bookId
        deadlineAtMs = System.currentTimeMillis() + ACTIVE_WINDOW_MS
        loop = scope.launch {
            var msSincePersist = 0L
            while (isActive) {
                delay(TICK_INTERVAL_MS)
                val now = System.currentTimeMillis()
                if (now < deadlineAtMs) {
                    pendingMs.addAndGet(TICK_INTERVAL_MS)
                    msSincePersist += TICK_INTERVAL_MS
                }
                if (msSincePersist >= PERSIST_INTERVAL_MS) {
                    msSincePersist = 0L
                    flush(ctx)
                }
            }
        }
    }

    /**
     * End the active session. Flushes any pending delta synchronously
     * (well, via the application scope — the activity may have
     * already been told to die, but `applicationContext.spineApplicationScope`
     * outlives it). Idempotent.
     */
    fun stop(ctx: Context) {
        loop?.cancel()
        loop = null
        flush(ctx)
        activeBookId = null
    }

    /**
     * Re-arm the active deadline. Called from spine-host.mjs's bridge
     * on every relocate and tap-zone tap. Cheap — atomic write to a
     * single volatile long.
     */
    fun notePageEvent() {
        if (activeBookId == null) return
        deadlineAtMs = System.currentTimeMillis() + ACTIVE_WINDOW_MS
    }

    /** Emit the accumulated delta to LibraryStore and reset the
     *  pending counter. Uses the application scope so a flush after
     *  [stop] still completes even if the activity is being torn
     *  down. */
    private fun flush(ctx: Context) {
        val delta = pendingMs.getAndSet(0L)
        if (delta <= 0L) return
        val id = activeBookId ?: return
        ctx.applicationContext.spineApplicationScope.launch {
            LibraryStore.touchActiveReadMs(ctx.applicationContext, id, delta)
        }
    }

    /** Tear-down for the rare case where the parent scope hasn't
     *  taken care of cancellation. ReaderActivity uses the activity
     *  lifecycleScope as its parent, so this is normally unnecessary. */
    fun dispose() {
        scope.cancel()
    }
}
