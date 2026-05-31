package com.thereprocase.spine

import android.net.Uri
import java.util.concurrent.ConcurrentHashMap

/**
 * Process-scoped guard that prevents the same incoming
 * `ACTION_VIEW` / `ACTION_SEND` URI from being handled twice on
 * back-to-back lifecycle events (rotation, recreation,
 * `onNewIntent` arriving while the import for the previous intent
 * is still in flight).
 *
 * Originally ported from the demo's single-slot
 * `lastHandledUri.current` ref pattern in
 * `apps/mobile-reader/app/_layout.tsx`. The single-slot version had
 * a two-URI race (code review N2 #2): URI A in flight; URI B
 * arrives, replaces the slot; URI A's `release(A)` then no-ops, and
 * URI B's slot is never released so any re-share of B is permanently
 * blocked for the process lifetime. The fix is a *set* of in-flight
 * URIs instead of a single slot — each claim and release operates on
 * its own URI without stomping the others.
 *
 * Semantics:
 *   - [tryClaim] returns true if [uri] was added to the in-flight
 *     set (caller proceeds), false if a matching URI was already in
 *     the set (caller drops this delivery).
 *   - [release] removes [uri] from the in-flight set. Tolerates
 *     being called for a URI that isn't actually held — the call is
 *     a no-op in that case.
 *
 * Always pair `tryClaim` with `release` in a `finally` block. A
 * deliberate re-share of the same file moments later is *expected*
 * to surface another prompt; without the release, only the first
 * share of that URI per process lifetime would be honored.
 */
object IntentDedup {

    /** ConcurrentHashMap.newKeySet returns a thread-safe Set view.
     *  ConcurrentHashMap-backed so add / remove are atomic. */
    private val held: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** Try to claim [uri]. Returns true if claimed (caller proceeds
     *  with processing), false if a matching URI is already in
     *  flight (caller should drop this delivery). */
    fun tryClaim(uri: Uri): Boolean {
        // Set.add() returns true if the element was NOT already
        // present, which is exactly the "claim succeeded" semantic.
        return held.add(uri.toString())
    }

    /** Remove [uri] from the in-flight set. No-op if not held. */
    fun release(uri: Uri) {
        held.remove(uri.toString())
    }
}
