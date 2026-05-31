package com.thereprocase.spine

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/**
 * Local JSON-backed annotation store: highlights + bookmarks per
 * book.
 *
 * **Architectural note (TECH_DEBT migration target).** The plan
 * (internal design notes §"N6 — annotations
 * via Spine-bf via callApi") calls for these to be persisted via
 * `POST /api/v1/book/{id}/highlight` / `POST
 * /api/v1/book/{id}/bookmark`, not local JSON. Those endpoints
 * don't yet exist in `core/spine-srv` (verified during the N3
 * pre-check). Rather than ship the affordances visibly broken
 * (which non-negotiable #4 forbids) or block on a server lane
 * we don't own, this slice mirrors the alpha demo's
 * locally-persisted Zustand store. When the server endpoints
 * land, [Annotations] is replaced wholesale with a `callApi`-backed
 * adapter; existing on-disk data must be migrated.
 *
 * **Locator-engine discriminator (sprint plan pin #2).** Every
 * persisted entry carries `engine` ("foliate") + `schema`
 * ("epubcfi" / "epubcfi-range") alongside the opaque [locator]
 * string. Today only foliate writes; the discriminator is baked
 * in now so a future Readium plugin can write its own engine
 * without reshaping the store.
 *
 * On-disk shape (`${filesDir}/annotations.json`):
 * ```json
 * {
 *   "schema_version": 1,
 *   "highlights": [
 *     { "id": "...", "bookId": "...", "engine": "foliate",
 *       "schema": "epubcfi-range", "locator": "epubcfi(...)",
 *       "anchorText": "the quick brown fox",
 *       "before": "before context",
 *       "after": "after context",
 *       "color": "yellow", "note": null,
 *       "createdAtMillis": 0 }
 *   ],
 *   "bookmarks": [
 *     { "id": "...", "bookId": "...", "engine": "foliate",
 *       "schema": "epubcfi", "locator": "epubcfi(...)",
 *       "anchorText": "...", "createdAtMillis": 0 }
 *   ]
 * }
 * ```
 *
 * Atomic-write pattern matches [LibraryStore]: stage to a `.tmp`
 * sibling, rename, fall back to overwrite + delete if rename
 * fails on a quirky filesystem.
 */
object Annotations {

    @Serializable
    data class Highlight(
        val id: String,
        val bookId: String,
        val engine: String,
        val schema: String,
        val locator: String,
        val anchorText: String,
        val before: String? = null,
        val after: String? = null,
        val color: String = "yellow",
        val note: String? = null,
        val createdAtMillis: Long,
    )

    @Serializable
    data class Bookmark(
        val id: String,
        val bookId: String,
        val engine: String,
        val schema: String,
        val locator: String,
        val anchorText: String? = null,
        val createdAtMillis: Long,
    )

    @Serializable
    data class Snapshot(
        val schema_version: Int = SCHEMA_VERSION,
        val highlights: List<Highlight> = emptyList(),
        val bookmarks: List<Bookmark> = emptyList(),
    )

    const val SCHEMA_VERSION = 1
    const val FOLIATE_ENGINE = "foliate"
    const val SCHEMA_CFI = "epubcfi"
    const val SCHEMA_CFI_RANGE = "epubcfi-range"

    private val mutex = Mutex()
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private fun storeFile(ctx: Context): File =
        File(ctx.filesDir, "annotations.json")

    suspend fun load(ctx: Context): Snapshot = mutex.withLock {
        withContext(Dispatchers.IO) {
            val f = storeFile(ctx)
            if (!f.exists()) return@withContext Snapshot()
            try {
                json.decodeFromString<Snapshot>(f.readText())
            } catch (_: Exception) {
                Snapshot()
            }
        }
    }

    private suspend fun update(
        ctx: Context,
        transform: (Snapshot) -> Snapshot,
    ): Snapshot = mutex.withLock {
        withContext(Dispatchers.IO) {
            val f = storeFile(ctx)
            val current = if (f.exists()) {
                try { json.decodeFromString<Snapshot>(f.readText()) }
                catch (_: Exception) { Snapshot() }
            } else Snapshot()
            val next = transform(current)
            val staging = File(f.parentFile, "annotations.json.tmp")
            staging.writeText(json.encodeToString(next))
            if (!staging.renameTo(f)) {
                f.writeText(staging.readText())
                staging.delete()
            }
            next
        }
    }

    suspend fun listHighlights(ctx: Context, bookId: String): List<Highlight> =
        load(ctx).highlights.filter { it.bookId == bookId }

    suspend fun listBookmarks(ctx: Context, bookId: String): List<Bookmark> =
        load(ctx).bookmarks.filter { it.bookId == bookId }

    suspend fun addHighlight(
        ctx: Context,
        bookId: String,
        engine: String,
        schema: String,
        locator: String,
        anchorText: String,
        before: String?,
        after: String?,
        color: String = "yellow",
        note: String? = null,
    ): Highlight {
        val entry = Highlight(
            id = UUID.randomUUID().toString(),
            bookId = bookId, engine = engine, schema = schema,
            locator = locator, anchorText = anchorText,
            before = before, after = after,
            color = color, note = note,
            createdAtMillis = System.currentTimeMillis(),
        )
        update(ctx) { it.copy(highlights = it.highlights + entry) }
        return entry
    }

    suspend fun removeHighlight(ctx: Context, id: String): Boolean {
        var removed = false
        update(ctx) { current ->
            val next = current.highlights.filterNot { it.id == id }
            if (next.size != current.highlights.size) removed = true
            current.copy(highlights = next)
        }
        return removed
    }

    suspend fun addBookmark(
        ctx: Context,
        bookId: String,
        engine: String,
        schema: String,
        locator: String,
        anchorText: String?,
    ): Bookmark {
        val entry = Bookmark(
            id = UUID.randomUUID().toString(),
            bookId = bookId, engine = engine, schema = schema,
            locator = locator, anchorText = anchorText,
            createdAtMillis = System.currentTimeMillis(),
        )
        update(ctx) { it.copy(bookmarks = it.bookmarks + entry) }
        return entry
    }

    suspend fun removeBookmark(ctx: Context, id: String): Boolean {
        var removed = false
        update(ctx) { current ->
            val next = current.bookmarks.filterNot { it.id == id }
            if (next.size != current.bookmarks.size) removed = true
            current.copy(bookmarks = next)
        }
        return removed
    }

    /**
     * Cascade-delete: drop every annotation tied to [bookId] when
     * the book itself is removed. Called by [LibraryStore.removeBook]
     * indirectly — the launcher invokes this from its own onDelete
     * coroutine to keep the dependency arrow one-way (this module
     * already imports nothing from LibraryStore).
     */
    suspend fun removeForBook(ctx: Context, bookId: String) {
        update(ctx) { current ->
            current.copy(
                highlights = current.highlights.filterNot { it.bookId == bookId },
                bookmarks = current.bookmarks.filterNot { it.bookId == bookId },
            )
        }
    }
}
