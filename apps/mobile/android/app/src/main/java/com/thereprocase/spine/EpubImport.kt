package com.thereprocase.spine

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream

/**
 * One-shot import of an EPUB referenced by a `content://` or
 * `file://` URI. Copies the bytes into [LibraryStore.booksDir] under
 * `${uuid}.epub` and records a [LibraryStore.BookEntry].
 *
 * Pulled out of `MainActivity` so it can be reused by the ZIP
 * bulk-import path (which extracts each EPUB to a temp file then
 * calls this with a `file://` URI) without the launcher's
 * Compose-only context.
 *
 * The boolean [temp] marks the entry as a "Read once" share — the
 * record is auto-deleted by [LibraryStore.cleanupTempBooks] on next
 * cold-launch and by [ReaderActivity] on exit. Bytes still go to
 * the same on-disk location; the difference is ownership, not
 * storage.
 */
object EpubImport {

    /** Result of an import: the persisted entry plus enough metadata
     *  for the caller to route the user (open the reader, replace
     *  to library, etc). Null indicates a failure (logged via the
     *  caller's UI surface — Toast in the launcher). */
    data class Imported(
        val entry: LibraryStore.BookEntry,
        val displayName: String,
        val mimeType: String?,
    )

    /**
     * @param displayNameOverride if non-null, used instead of the
     *  ContentResolver query result. Required for `file://` URIs on
     *  API 29+ where `resolver.query` returns null and the fallback
     *  would otherwise stamp every imported book with the title
     *  "Imported EPUB". (code review N1-N6 critical #3.) The bulk
     *  import path passes the ZIP entry's filename here; the
     *  single-EPUB share path leaves it null and lets the resolver
     *  query do its thing.
     * @param sizeOverride matching override for the byte count.
     */
    suspend fun fromUri(
        ctx: Context,
        uri: Uri,
        temp: Boolean = false,
        displayNameOverride: String? = null,
        sizeOverride: Long? = null,
    ): Imported? = withContext(Dispatchers.IO) {
        val resolver = ctx.contentResolver
        val (queriedName, queriedSize) = resolver.query(uri, null, null, null, null).use { c ->
            if (c == null || !c.moveToFirst()) {
                null to null
            } else {
                val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                val name = if (nameIdx >= 0) c.getString(nameIdx) else null
                val s = if (sizeIdx >= 0) c.getLong(sizeIdx) else null
                name to s
            }
        }
        val displayName = displayNameOverride ?: queriedName ?: "Imported EPUB"
        val size = sizeOverride ?: queriedSize ?: 0L
        val mimeType = resolver.getType(uri)

        val entry = LibraryStore.addBook(
            ctx = ctx,
            title = displayName.removeSuffix(".epub"),
            author = null,
            filename = LibraryStore.PENDING_FILENAME,
            sizeBytes = size,
            temp = temp,
        )
        val persistedFilename = "${entry.id}.epub"
        val target = File(LibraryStore.booksDir(ctx), persistedFilename)
        val bytesCopied = try {
            openInput(resolver, uri).use { input ->
                target.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
        } catch (t: Throwable) {
            target.delete()
            LibraryStore.removeBook(ctx, entry.id)
            return@withContext null
        }

        // Phase-2 patch: replace the placeholder filename + size with
        // the real ones. Atomic read-modify-write under
        // LibraryStore's mutex so a parallel ZIP-import entry
        // committing simultaneously can't lose this update
        // (code review N2 #3).
        val patched = LibraryStore.update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == entry.id) {
                        it.copy(filename = persistedFilename, sizeBytes = bytesCopied)
                    } else it
                },
            )
        }
        val finalEntry = patched.books.first { it.id == entry.id }
        Imported(entry = finalEntry, displayName = displayName, mimeType = mimeType)
    }

    private fun openInput(resolver: android.content.ContentResolver, uri: Uri): InputStream {
        return resolver.openInputStream(uri)
            ?: throw IllegalArgumentException("Could not open URI: $uri")
    }
}
