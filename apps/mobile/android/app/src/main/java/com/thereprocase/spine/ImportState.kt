package com.thereprocase.spine

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide, lifecycle-independent state for an active bulk
 * import.
 *
 * The demo bulk-import path lived in a Zustand store at
 * `apps/mobile-reader/src/store/library.ts` and was read by
 * [ImportProgressBanner] as `useLibrary((s) => s.importing)` /
 * `s.importProgress`. The native port keeps the same shape — a
 * boolean `running` flag plus a counted `current` / `total` pair —
 * but exposes it as a [StateFlow] backed by a singleton so the
 * banner can subscribe from any composition (home, library,
 * settings, even the reader) without wiring it through every screen.
 *
 * Concurrency: only one bulk import runs at a time. [start] is a
 * no-op if a previous import is still active; [advance] / [finish]
 * are tolerant of being called when nothing is running so a stray
 * cancellation cleanup is harmless.
 */
object ImportState {

    data class Snapshot(
        val running: Boolean = false,
        /** 0-based index of the entry currently being unpacked. */
        val current: Int = 0,
        /** Total entries in the active import. 0 means "no progress
         *  count is available yet" (e.g. enumerating the outer ZIP). */
        val total: Int = 0,
        /** Display name of the entry currently being unpacked, or
         *  null if the active phase doesn't have a per-entry label. */
        val label: String? = null,
    )

    private val _state = MutableStateFlow(Snapshot())

    val state: StateFlow<Snapshot> = _state.asStateFlow()

    /**
     * Begin a new bulk import.
     *
     * Returns true if the import claimed the singleton slot, false
     * if a prior import is still active. The caller is expected to
     * surface a "an import is already running" Toast in the false
     * case rather than silently absorb the second import (code review
     * N2 #3, N2 #6).
     *
     * Single-import-at-a-time is a deliberate alpha constraint —
     * not a bug. A queued multi-import is N5+ work.
     */
    fun start(total: Int): Boolean {
        if (_state.value.running) return false
        _state.value = Snapshot(running = true, current = 0, total = total)
        return true
    }

    /** Update the per-entry progress. Tolerates being called between
     *  imports — it just stamps the next snapshot. */
    fun advance(current: Int, label: String?) {
        val s = _state.value
        if (!s.running) return
        _state.value = s.copy(current = current, label = label)
    }

    /** Mark the active import complete. Idempotent. */
    fun finish() {
        if (!_state.value.running) return
        _state.value = Snapshot(running = false)
    }
}
