package com.thereprocase.spine

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Helper for outbound ACTION_SEND of EPUB files to other apps (Kindle,
 * Play Books, Dropbox, mail, ...). Produces a content:// URI via the
 * FileProvider declared in `AndroidManifest.xml` with authority
 * `${applicationId}.fileprovider`, and grants read permission to any
 * resolving activity.
 *
 * The provided [file] **must** live under [LibraryStore.booksDir], since
 * that is the only directory exposed by `res/xml/file_paths.xml`.
 * Passing a file outside that tree throws
 * [IllegalArgumentException] from FileProvider with the path it could
 * not match — treat that as a programmer error, not a user-facing one.
 */
object ShareIntents {

    private const val EPUB_MIME = "application/epub+zip"

    /**
     * Build (but do not start) a share chooser Intent for [file].
     * Caller is responsible for wrapping with `Intent.createChooser` and
     * calling `Context.startActivity`.
     */
    fun epubSendIntent(ctx: Context, file: File): Intent {
        val authority = "${ctx.packageName}.fileprovider"
        val uri = FileProvider.getUriForFile(ctx, authority, file)
        return Intent(Intent.ACTION_SEND).apply {
            type = EPUB_MIME
            putExtra(Intent.EXTRA_STREAM, uri)
            // FLAG_GRANT_READ_URI_PERMISSION propagates to EXTRA_STREAM
            // on API 21+ when combined with a properly-declared
            // FileProvider. minSdk is 24 — no legacy ClipData dance
            // needed.
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /**
     * Convenience: wrap [epubSendIntent] in a chooser and fire it.
     *
     * @param title shown above the share-sheet list.
     */
    fun startEpubShare(ctx: Context, file: File, title: CharSequence) {
        val chooser = Intent.createChooser(epubSendIntent(ctx, file), title)
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(chooser)
    }
}
