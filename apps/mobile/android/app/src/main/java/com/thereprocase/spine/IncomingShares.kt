package com.thereprocase.spine

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat

/**
 * Shape of a single inbound URI extracted from an `ACTION_VIEW` /
 * `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent. The launcher
 * routes each share to either the bulk-import path (ZIP) or the
 * single-EPUB three-way dialog (EPUB) based on [kind].
 */
sealed class IncomingShare {
    abstract val uri: Uri
    abstract val displayName: String
    abstract val mimeType: String?

    data class Epub(
        override val uri: Uri,
        override val displayName: String,
        override val mimeType: String?,
    ) : IncomingShare()

    data class Zip(
        override val uri: Uri,
        override val displayName: String,
        override val mimeType: String?,
    ) : IncomingShare()
}

/**
 * Inspect [intent] and, if it looks like a file share / open-with,
 * build the list of [IncomingShare] descriptors. Returns an empty
 * list for non-share intents (e.g. the bare `ACTION_MAIN` launcher
 * tap) so the caller can short-circuit.
 *
 * Mirrors the demo's `_layout.tsx:165` MIME / filename heuristic:
 *
 *   - `application/zip` or `application/x-zip-compressed` or a
 *     filename ending in `.zip` → [IncomingShare.Zip].
 *   - `application/epub+zip` or filename ending in `.epub` →
 *     [IncomingShare.Epub].
 *   - Everything else is dropped on the floor.
 */
fun extractShares(ctx: Context, intent: Intent?): List<IncomingShare> {
    if (intent == null) return emptyList()
    val uris: List<Uri> = when (intent.action) {
        Intent.ACTION_VIEW -> listOfNotNull(intent.data)
        Intent.ACTION_SEND -> listOfNotNull(
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        )
        Intent.ACTION_SEND_MULTIPLE -> {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?.toList()
                ?: emptyList()
        }
        else -> emptyList()
    }
    if (uris.isEmpty()) return emptyList()

    val fallbackMime = intent.type
    return uris.mapNotNull { uri -> classify(ctx, uri, fallbackMime) }
}

private fun classify(ctx: Context, uri: Uri, fallbackMime: String?): IncomingShare? {
    val displayName = displayNameForUri(ctx, uri) ?: uri.lastPathSegment ?: ""
    val mime = ctx.contentResolver.getType(uri) ?: fallbackMime
    val lowerName = displayName.lowercase()
    val lowerMime = mime?.lowercase() ?: ""
    return when {
        lowerMime == "application/zip" ||
            lowerMime == "application/x-zip-compressed" ||
            lowerName.endsWith(".zip") ->
            IncomingShare.Zip(uri = uri, displayName = displayName, mimeType = mime)
        lowerMime == "application/epub+zip" || lowerName.endsWith(".epub") ->
            IncomingShare.Epub(uri = uri, displayName = displayName, mimeType = mime)
        else -> null
    }
}

private fun displayNameForUri(ctx: Context, uri: Uri): String? {
    return when (uri.scheme) {
        "content" -> ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
        }
        "file" -> uri.lastPathSegment
        else -> null
    }
}
