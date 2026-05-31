package com.thereprocase.spine

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Drives a single end-to-end ZIP-of-EPUBs bulk import:
 *
 *   1. Stage the inbound `content://...zip` URI to a stable file
 *      under `filesDir/inbox/` (so we can random-access it via
 *      [java.util.zip.ZipFile] across a process death).
 *   2. Enumerate every `.epub` entry in the staged ZIP.
 *   3. Push the count to [ImportState] so the [ImportProgressBanner]
 *      can render.
 *   4. Extract each entry one at a time to a temp `.epub` file under
 *      `filesDir/inbox/`, then call [EpubImport.fromUri] with a
 *      `file://` URI for the temp file. The library record + final
 *      `${id}.epub` location come out of that call; the temp file is
 *      deleted afterwards.
 *
 * Why staging instead of streaming directly from the original
 * `content://` URI: ZIP random-access via [java.util.zip.ZipFile]
 * needs a [File] handle, and the original URI may go stale (some
 * sharing apps revoke the permission once the receiving activity
 * returns, even though we haven't finished consuming the bytes).
 *
 * Why per-entry temp file instead of streaming straight to the
 * library: keeps the contract with [EpubImport.fromUri] — that
 * function only knows how to read from a URI — without inventing a
 * second import path. The temp file is small (one EPUB, not the
 * whole archive) and is deleted as soon as the import resolves.
 */
object BulkImport {

    /**
     * Sentinel thrown when [importZip] is called while another bulk
     * import is already active. The caller should surface this to
     * the user (Toast / banner copy) rather than queue or silently
     * drop the second import.
     */
    class BusyException : IllegalStateException("Another import is already running")

    /**
     * Outcome of a bulk import: how many records landed, how many
     * were attempted, and which entry names were skipped (with the
     * skip reason) so the launcher can surface a meaningful Toast
     * instead of just a count. (code review N1-N6 finding #18.)
     */
    data class BulkResult(
        val total: Int,
        val imported: Int,
        val skipped: List<Skipped> = emptyList(),
    ) {
        data class Skipped(val displayName: String, val reason: String)
    }

    /**
     * Run a bulk import. [outerZip] is the source URI (typically
     * `content://...zip`).
     *
     * Returns a [BulkResult] describing what landed and what didn't —
     * a single bad entry doesn't kill the whole batch (losing one of
     * 194 EPUBs to a corrupt entry shouldn't abort the other 193),
     * but the user does get told.
     *
     * Throws [BusyException] if a prior bulk import is still
     * running. Any other exception (failed staging, listing
     * failure, OutOfMemory) propagates after cleanup.
     */
    suspend fun importZip(ctx: Context, outerZip: Uri): BulkResult = withContext(Dispatchers.IO) {
        val staged = SpineZip.stageZipFromUri(ctx, outerZip)
        var startedImportState = false
        try {
            val entries = SpineZip.listEpubEntries(staged)
            startedImportState = ImportState.start(entries.size)
            if (!startedImportState) throw BusyException()
            var imported = 0
            var aggregateBytes = 0L
            val skipped = mutableListOf<BulkResult.Skipped>()
            for ((index, entry) in entries.withIndex()) {
                ImportState.advance(index, entry.displayName)
                // Aggregate-cap check: a zip-bomb shaped as N entries
                // each just under MAX_ENTRY_BYTES would pass the
                // per-entry cap but explode to N × 200 MB on disk.
                // Halt the loop entirely once the cap is breached —
                // anything after is also adversarial. (code review
                // N1-N6 major #12.)
                if (aggregateBytes + entry.size > SpineZip.MAX_TOTAL_BYTES) {
                    skipped.add(
                        BulkResult.Skipped(
                            entry.displayName,
                            "aggregate cap reached (${SpineZip.MAX_TOTAL_BYTES / (1024 * 1024)} MB)",
                        )
                    )
                    // All remaining entries skipped under the same cap.
                    for (j in (index + 1) until entries.size) {
                        skipped.add(
                            BulkResult.Skipped(
                                entries[j].displayName,
                                "aggregate cap reached",
                            )
                        )
                    }
                    break
                }
                val tempFile = File(SpineZip.inboxDir(ctx), "tmp-${UUID.randomUUID()}.epub")
                try {
                    SpineZip.extractEntry(ctx, staged, entry.rawName, tempFile)
                    aggregateBytes += tempFile.length()
                    val tempUri = Uri.fromFile(tempFile)
                    // Pass the ZIP entry's display name + size as
                    // overrides — `file://` URIs on API 29+ return
                    // null from ContentResolver.query so without these
                    // every imported book would be titled
                    // "Imported EPUB". (code review N1-N6
                    // critical #3.)
                    val result = EpubImport.fromUri(
                        ctx = ctx,
                        uri = tempUri,
                        temp = false,
                        displayNameOverride = entry.displayName,
                        sizeOverride = entry.size,
                    )
                    if (result != null) {
                        imported++
                    } else {
                        skipped.add(BulkResult.Skipped(entry.displayName, "import returned null"))
                    }
                } catch (e: Exception) {
                    // Single bad entry shouldn't kill the whole batch.
                    // Caught at Exception, not Throwable, so
                    // OutOfMemoryError / VirtualMachine errors
                    // propagate up to the coroutine (code review
                    // N2 #5).
                    val reason = "${e.javaClass.simpleName}: ${e.message ?: ""}"
                    android.util.Log.w(
                        "BulkImport",
                        "Skipped ${entry.displayName}: $reason",
                    )
                    skipped.add(BulkResult.Skipped(entry.displayName, reason))
                } finally {
                    tempFile.delete()
                }
            }
            // Final tick so the banner shows N of N before fading out.
            ImportState.advance(entries.size, null)
            BulkResult(total = entries.size, imported = imported, skipped = skipped.toList())
        } finally {
            SpineZip.deleteStaged(staged)
            // Only finish the singleton if we were the one who
            // started it. Otherwise we'd clear another concurrent
            // import's progress when this one bailed with
            // BusyException.
            if (startedImportState) ImportState.finish()
        }
    }
}
