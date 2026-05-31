package com.thereprocase.spine

import android.content.Context
import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipFile

/**
 * Native Kotlin port of the demo's `SpineZipModule` (formerly at
 * `apps/mobile-reader/android/.../SpineZipModule.kt`). The demo wired
 * each method through React Native's `@ReactMethod` / `Promise` shim;
 * here we drop the bridge entirely and call from Compose directly.
 *
 * Surface this module is responsible for:
 *
 *   1. Stage a `content://...zip` URI to a stable file under
 *      `${filesDir}/inbox/...` so we can random-access it via
 *      [ZipFile] (the original content URI is short-lived; copying once
 *      up front lets us unpack one entry at a time afterwards and
 *      survive process death).
 *   2. Enumerate `.epub` entries in a staged ZIP **without** extracting
 *      any of them — the bulk import path needs the count for progress
 *      reporting before it starts unpacking.
 *   3. Extract a single named entry to a destination path with a
 *      traversal guard and a zip-bomb cap. Both the entry name (which
 *      can come from a hostile ZIP carrying `..` segments) and the
 *      destination (which arrives from the caller) are validated.
 *
 * What this module is NOT responsible for: the per-EPUB resource
 * streaming inside the reader. That lives in
 * [EpubResourceHandler] and uses a long-lived [ZipFile] cache for
 * sub-archive reads. SpineZip's job is one-shot, "extract these EPUB
 * files out of this outer ZIP."
 *
 * Path-traversal / zip-bomb defenses (ported verbatim from the demo
 * because the threat surface is unchanged):
 *
 *   - `entryName` containing `..` or starting with `/` is rejected.
 *   - The resolved destination's canonical path must remain inside
 *     [Context.getFilesDir]; anything else throws [SecurityException].
 *   - Each entry is capped at [MAX_ENTRY_BYTES]. The partial file is
 *     deleted and `SecurityException` is thrown on overrun.
 */
object SpineZip {

    /** Per-entry uncompressed size cap. Anything bigger is treated as a
     *  zip-bomb candidate. EPUBs over 200 MB are vanishingly rare. */
    const val MAX_ENTRY_BYTES: Long = 200L * 1024 * 1024

    /** Aggregate uncompressed size across the whole bulk import. A
     *  zip bomb shaped as N entries each just under [MAX_ENTRY_BYTES]
     *  passes the per-entry cap but expands to N × 200 MB on disk —
     *  this catches the cumulative case. (code review N1-N6
     *  major #12.) */
    const val MAX_TOTAL_BYTES: Long = 4L * 1024 * 1024 * 1024

    /** Per-entry compression-ratio cap. A 1 KB compressed entry
     *  expanding to 200 MB has a 200,000:1 ratio — the classic quine
     *  shape — but might pass the per-entry cap on its own. Anything
     *  beyond this multiplier between compressed and uncompressed
     *  sizes is treated as adversarial. (code review N1-N6
     *  major #12.) */
    const val MAX_COMPRESSION_RATIO: Long = 200L

    /** Inbox directory for staged outer-ZIPs that arrive via
     *  `content://`. Lives under `filesDir/inbox/` to keep them inside
     *  the app sandbox; cleaned up by [deleteStaged] once the import
     *  loop completes. */
    fun inboxDir(ctx: Context): File =
        File(ctx.filesDir, "inbox").apply { if (!exists()) mkdirs() }

    /**
     * Cold-launch sweep of [inboxDir]. A bulk import killed mid-flight
     * (process death, task swipe, OOM reclaim) leaves the staged outer
     * ZIP and any in-flight `tmp-*.epub` orphans behind — potentially
     * hundreds of MB of disk. No active import can be running at cold
     * launch by definition, so unconditional `deleteRecursively` of
     * the inbox contents is safe. (code review N1-N6 major #14.)
     *
     * Returns the byte count freed.
     */
    fun sweepInbox(ctx: Context): Long {
        val dir = inboxDir(ctx)
        var freed = 0L
        val children = dir.listFiles() ?: return 0L
        for (f in children) {
            freed += f.length()
            f.delete()
        }
        return freed
    }

    /**
     * Description of a single zip entry surfaced to callers — the
     * name as it appears in the archive, the safe display name (i.e.
     * `File(rawName).name`, after stripping any leading directory
     * components), and the uncompressed size.
     */
    data class Entry(
        val rawName: String,
        val displayName: String,
        val size: Long,
    )

    /**
     * Copy the bytes addressed by [uri] into [inboxDir] under a
     * fresh UUID-based filename. Returns the staged file (caller is
     * responsible for [deleteStaged] once they're done with it).
     *
     * Throws on I/O failure; nothing is partially staged on disk if
     * the copy fails — the staging file is deleted before the
     * exception propagates.
     */
    fun stageZipFromUri(ctx: Context, uri: Uri): File {
        val staged = File(inboxDir(ctx), "${UUID.randomUUID()}.zip")
        try {
            openInput(ctx, uri).use { input ->
                FileOutputStream(staged).use { output ->
                    input.copyTo(output, DEFAULT_BUFFER_SIZE)
                }
            }
        } catch (t: Throwable) {
            staged.delete()
            throw t
        }
        return staged
    }

    /**
     * Enumerate `.epub` entries in [zipFile] without extracting any.
     * Skips directories, blank names, and anything not ending in
     * `.epub` (case-insensitive). Returns the list in archive order.
     */
    fun listEpubEntries(zipFile: File): List<Entry> {
        val out = ArrayList<Entry>()
        ZipFile(zipFile).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                if (entry.isDirectory) continue
                val raw = entry.name ?: continue
                val safe = File(raw).name
                if (safe.isBlank()) continue
                if (!safe.lowercase(Locale.US).endsWith(".epub")) continue
                out.add(Entry(rawName = raw, displayName = safe, size = entry.size))
            }
        }
        return out
    }

    /**
     * Extract [entryName] from [zipFile] to [dest]. The destination's
     * canonical path must remain under [Context.getFilesDir]; the
     * entry name must not contain `..` or a leading `/`. Each entry
     * is capped at [MAX_ENTRY_BYTES] and [MAX_COMPRESSION_RATIO];
     * the compressed→uncompressed ratio is checked against the
     * declared central-directory size before extraction. Returns the
     * number of bytes written.
     */
    fun extractEntry(ctx: Context, zipFile: File, entryName: String, dest: File): Long {
        // Traversal guard. Code review N2 #2 raised three concerns:
        //   - Backslash separators (some hostile zips store '\..').
        //     Normalise to forward-slash before checking.
        //   - URL-encoded `..` (`%2e%2e/...`) — ZipFile.getEntry()
        //     does not URL-decode, so it does its own byte-exact
        //     match; if no entry with that exact name exists the
        //     getEntry returns null and we throw IllegalArgument.
        //     We still reject the percent-encoded form here because
        //     a future ZipFile that DOES normalise would otherwise
        //     find a match.
        //   - The canonical-path destination check is the final
        //     backstop; it stays where it is.
        val normalized = entryName.replace('\\', '/')
        val lowered = normalized.lowercase(Locale.US)
        if (
            normalized.startsWith("/") ||
            normalized.contains("..") ||
            lowered.contains("%2e%2e")
        ) {
            throw SecurityException("entryName traversal: $entryName")
        }
        val destCanonical = dest.canonicalPath
        val filesRoot = ctx.filesDir.canonicalPath
        if (!destCanonical.startsWith("$filesRoot/") && destCanonical != filesRoot) {
            throw SecurityException("destPath escapes filesDir: $destCanonical")
        }
        dest.parentFile?.mkdirs()

        var written: Long = 0
        val buf = ByteArray(DEFAULT_BUFFER_SIZE)
        ZipFile(zipFile).use { zip ->
            val entry = zip.getEntry(entryName)
                ?: throw IllegalArgumentException("Entry not found: $entryName")
            // Pre-flight ratio check against the central-directory's
            // declared sizes. A hostile zip can still lie, in which
            // case the in-loop MAX_ENTRY_BYTES check below catches the
            // overrun — but rejecting suspicious ratios up front saves
            // us the partial-write IO. Compressed size of -1 means
            // "unknown" (stored entries); skip the check there.
            val compressed = entry.compressedSize
            if (compressed > 0 && entry.size / compressed > MAX_COMPRESSION_RATIO) {
                throw SecurityException(
                    "entry compression ratio exceeds cap " +
                        "(${MAX_COMPRESSION_RATIO}:1): $entryName " +
                        "(compressed=$compressed, declared=${entry.size})"
                )
            }
            zip.getInputStream(entry).use { input ->
                FileOutputStream(dest).use { output ->
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        // Check BEFORE writing — code review N2 #4
                        // flagged that the prior order let one buffer
                        // (~8 KB) past the cap land on disk before we
                        // noticed.
                        if (written + n > MAX_ENTRY_BYTES) {
                            output.close()
                            dest.delete()
                            throw SecurityException(
                                "entry exceeds zip-bomb cap " +
                                    "(${MAX_ENTRY_BYTES / (1024 * 1024)} MB): $entryName"
                            )
                        }
                        output.write(buf, 0, n)
                        written += n
                    }
                }
            }
        }
        return written
    }

    /** Delete a staged file under [inboxDir]. Caller-side cleanup
     *  helper: the bulk-import loop calls this once the unpack is
     *  done so the inbox doesn't accumulate stale outer-ZIPs. */
    fun deleteStaged(file: File): Boolean =
        if (file.exists()) file.delete() else true

    /** Open an input stream for either a `content://` / `file://` URI
     *  or a raw filesystem path. */
    private fun openInput(ctx: Context, uri: Uri) =
        when (uri.scheme) {
            "content", "file" ->
                ctx.contentResolver.openInputStream(uri)
                    ?: throw IllegalArgumentException("Could not open URI: $uri")
            null ->
                FileInputStream(File(uri.toString()))
            else ->
                throw IllegalArgumentException("Unsupported URI scheme: ${uri.scheme}")
        }
}
