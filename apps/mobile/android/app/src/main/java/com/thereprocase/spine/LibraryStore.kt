package com.thereprocase.spine

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/**
 * Per-install JSON catalogue of imported EPUBs.
 *
 * This is a **Sprint 2 placeholder** — the intended long-term store is
 * SQLite inside a `spine.db` sidecar (TECH_DEBT §4.4). JSON was picked
 * here so the alpha ring ships without porting the SQLite bootstrap path
 * to Android's scoped-storage model first.
 *
 * On-disk shape (`${filesDir}/library.json`, current `schema_version`
 * is [SCHEMA_VERSION] — kept in sync with the constant below):
 * ```json
 * {
 *   "schema_version": 1,
 *   "books": [
 *     { "id": "...", "title": "...", "author": "...", "filename": "...",
 *       "addedAtMillis": 0, "sizeBytes": 0, "temp": false }
 *   ]
 * }
 * ```
 *
 * **Migration note for the eventual `spine.db` SQLite move
 * (TECH_DEBT §4.4):** `temp = true` entries are *ephemeral* — they
 * are reader-session scratchpad records, not durable library state.
 * The migration tool should drop them on the floor rather than
 * port them across. (code review N2 #2.)
 *
 * EPUB files live under `${filesDir}/books/` with a `.epub` extension
 * and filenames keyed by [BookEntry.id]. The FileProvider config at
 * `res/xml/file_paths.xml` exposes exactly this directory for
 * Share-intent URI grants.
 *
 * Thread safety: every read/write goes through a [Mutex] and runs on
 * [Dispatchers.IO]. Writes are atomic — data is staged in a `.tmp`
 * sibling and renamed, so a crash mid-write leaves the previous library
 * intact.
 */
object LibraryStore {

    @Serializable
    data class BookEntry(
        val id: String,
        val title: String,
        val author: String? = null,
        val filename: String,
        val addedAtMillis: Long,
        val sizeBytes: Long,
        /**
         * True when this entry was created by a "Read once" share —
         * the bytes are staged into the library directory so the
         * reader can stream from them, but the record + on-disk file
         * are deleted on reader exit and again at next cold-launch
         * via [cleanupTempBooks] (covers the process-death-mid-read
         * gap the demo's `_layout.tsx` had).
         */
        val temp: Boolean = false,
        /**
         * Most-recent open timestamp in epoch millis; null if the
         * book has never been opened (just imported). The home
         * screen's Resume card prefers entries with a non-null
         * `lastOpenedAt`; if none exist, it falls back to the
         * most-recently-added entry so a fresh user always sees
         * something on the card. Mirrors the demo's
         * `app/index.tsx:36-52` selector.
         */
        val lastOpenedAt: Long? = null,
        /**
         * Most-recent reader locator (foliate-emitted CFI string —
         * `epubcfi(/...)`) for this book. Null when the book has never
         * been opened. Restored by ReaderActivity after `view.open(book)`
         * so process death mid-read doesn't dump the user back at
         * chapter 1. (code review N1-N6 critical #7.)
         */
        val lastLocator: String? = null,
        /**
         * Most-recent reading progress as a 0..1 fraction (foliate's
         * `relocate.detail.fraction`). 0 when never opened. Drives the
         * home Resume card progress bar and BookPanel "% read" row.
         * Updated alongside [lastLocator] on every relocate event.
         * (Sprint N3.5.)
         */
        val progress: Float = 0f,
        /**
         * Cumulative active read time in milliseconds across all
         * sessions for this book. Tracked by [SessionTimer]; persisted
         * at most once per 10s while a reader is active. Drives the
         * BookPanel "today" stat and SessionPanel pace metrics.
         * (Sprint N3.5.)
         */
        val activeReadMs: Long = 0L,
        /**
         * Cumulative characters read (sum of section length × progress
         * delta) for this book. Coarse pace input for words-per-minute
         * estimation; not exact. (Sprint N3.5.)
         */
        val charsRead: Long = 0L,
        /**
         * Total character count for the book. Null until `metrics`
         * fires from spine-host (and may stay null for very large books
         * — foliate skips `book.locations.generate()` past a size
         * threshold to avoid memory pinning). Null means "pace ETA
         * unavailable." (Sprint N3.5.)
         */
        val totalChars: Long? = null,
        /**
         * Freeform tags. Sourced from EPUB `<dc:subject>` at import time
         * initially; user-edit / BIBFRAME-derived in later sprints
         * (N12). Empty list when unset. (Sprint N3.5.)
         */
        val tags: List<String> = emptyList(),
    )

    @Serializable
    data class Library(
        @SerialName("schema_version") val schemaVersion: Int = SCHEMA_VERSION,
        val books: List<BookEntry> = emptyList(),
    )

    /**
     * Schema versioning for the on-disk library JSON.
     *
     * v0: initial — id, title, author, filename, addedAtMillis,
     *     sizeBytes (Sprint 2).
     * v1: + `temp: Boolean` for "Read once" share entries (N2).
     * v2: + `lastOpenedAt: Long?` for the home Resume card (N3).
     * v3: + `lastLocator: String?` for reader-position persistence
     *     across process death (N6.5 review fix-pass).
     * v4: + `progress: Float`, `activeReadMs: Long`, `charsRead: Long`,
     *     `totalChars: Long?`, `tags: List<String>` for BookPanel /
     *     SessionPanel reading metrics and tag filtering (N3.5).
     *
     * Unknown fields are tolerated by the deserializer so an older
     * binary reading a newer file does not crash; a newer binary
     * reading an older file picks up the per-version defaults
     * (`temp = false`, `lastOpenedAt = null`, `lastLocator = null`,
     * `progress = 0f`, `activeReadMs = 0L`, `charsRead = 0L`,
     * `totalChars = null`, `tags = []`) for every entry, which is
     * the correct semantics — none of those entries were ever marked
     * temporary, opened, had a saved reading position, or had any
     * reading-metrics state recorded.
     */
    const val SCHEMA_VERSION = 4

    private val mutex = Mutex()
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private fun libraryFile(ctx: Context): File =
        File(ctx.filesDir, "library.json")

    /**
     * Returns the `${filesDir}/books/` directory, creating it if needed.
     * Matches the path exposed by the FileProvider config.
     */
    fun booksDir(ctx: Context): File =
        File(ctx.filesDir, "books").apply { if (!exists()) mkdirs() }

    suspend fun load(ctx: Context): Library = mutex.withLock {
        withContext(Dispatchers.IO) {
            loadLocked(ctx)
        }
    }

    suspend fun save(ctx: Context, library: Library): Unit = mutex.withLock {
        withContext(Dispatchers.IO) {
            saveLocked(ctx, library)
        }
    }

    /**
     * Atomic read-modify-write under the same mutex acquisition.
     * [transform] receives the current library and returns a new
     * one; the new value is persisted before the lock releases.
     *
     * Two callers racing through `load` then `save` independently
     * would lose updates — code review N2 #3. Use this helper
     * whenever the new value depends on the prior value (everywhere
     * except the addBook bootstrap).
     */
    suspend fun update(ctx: Context, transform: (Library) -> Library): Library = mutex.withLock {
        withContext(Dispatchers.IO) {
            val current = loadLocked(ctx)
            val next = transform(current)
            saveLocked(ctx, next)
            next
        }
    }

    /** Internal: same I/O as [load] but assumes the mutex is already
     *  held by the caller. Lets [update] do read-modify-write
     *  atomically. */
    private fun loadLocked(ctx: Context): Library {
        val f = libraryFile(ctx)
        if (!f.exists()) return Library()
        return try {
            json.decodeFromString<Library>(f.readText())
        } catch (_: Exception) {
            Library()
        }
    }

    /** Internal: same I/O as [save] but assumes the mutex is already
     *  held by the caller. */
    private fun saveLocked(ctx: Context, library: Library) {
        val target = libraryFile(ctx)
        val staging = File(target.parentFile, "library.json.tmp")
        staging.writeText(json.encodeToString(library))
        if (!staging.renameTo(target)) {
            // Rename can fail on some filesystems; fall back to
            // overwrite + delete so a transient failure doesn't
            // leak a stale `.tmp` forever.
            target.writeText(staging.readText())
            staging.delete()
        }
    }

    /**
     * Append a book. Generates a fresh v4 UUID for [BookEntry.id] and
     * returns the persisted entry. Caller is responsible for actually
     * copying the EPUB bytes into [booksDir] at `${id}.epub`.
     */
    suspend fun addBook(
        ctx: Context,
        title: String,
        author: String?,
        filename: String,
        sizeBytes: Long,
        temp: Boolean = false,
    ): BookEntry {
        val entry = BookEntry(
            id = UUID.randomUUID().toString(),
            title = title,
            author = author,
            filename = filename,
            addedAtMillis = System.currentTimeMillis(),
            sizeBytes = sizeBytes,
            temp = temp,
        )
        update(ctx) { it.copy(books = it.books + entry) }
        return entry
    }

    /**
     * Stamp [lastOpenedAt] for [id] with the current wall clock.
     * Called by ReaderActivity on open; drives the home Resume card.
     * No-op if [id] is not in the library.
     */
    suspend fun touchOpenedAt(ctx: Context, id: String) {
        val now = System.currentTimeMillis()
        update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == id) it.copy(lastOpenedAt = now) else it
                },
            )
        }
    }

    /**
     * Persist [locator] (and optionally [progress]) as the most-recent
     * reading position for [id]. Called by ReaderActivity on every
     * relocate event (with activity-side throttling to avoid a write
     * per page-turn). The full library JSON is rewritten — at 1000
     * books and 1+ writes per page-turn this becomes hot, but for the
     * alpha ring with realistic library sizes (10-100 books) the
     * overhead is below the noise floor. SQLite migration is filed
     * in TECH_DEBT.md. No-op if [id] is not in the library.
     *
     * [progress] is 0..1 (clamped). When null, only the locator is
     * updated and the existing progress value is preserved — useful
     * for the rare relocate event whose foliate detail does not
     * carry a fraction (older bundles, scroll mode mid-stream).
     */
    suspend fun touchLastLocator(
        ctx: Context,
        id: String,
        locator: String,
        progress: Float? = null,
    ) {
        val clamped = progress?.coerceIn(0f, 1f)
        update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == id) {
                        if (clamped != null) it.copy(lastLocator = locator, progress = clamped)
                        else it.copy(lastLocator = locator)
                    } else it
                },
            )
        }
    }

    /**
     * Add [deltaMs] to [id]'s [BookEntry.activeReadMs]. Called by
     * [SessionTimer] roughly every 10 seconds while a reader session
     * is active. Negative or zero deltas are dropped. No-op if [id]
     * is not in the library.
     */
    suspend fun touchActiveReadMs(ctx: Context, id: String, deltaMs: Long) {
        if (deltaMs <= 0L) return
        update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == id) it.copy(activeReadMs = it.activeReadMs + deltaMs) else it
                },
            )
        }
    }

    /**
     * Set [id]'s [BookEntry.totalChars] if it is currently null.
     * Called by ReaderActivity when spine-host emits a `metrics`
     * event with the document char count. Idempotent — once set the
     * value is not overwritten (it's a property of the EPUB, not the
     * session). No-op if [id] is not in the library.
     */
    suspend fun touchTotalChars(ctx: Context, id: String, total: Long) {
        if (total <= 0L) return
        update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == id && it.totalChars == null) it.copy(totalChars = total) else it
                },
            )
        }
    }

    /**
     * Replace [id]'s [BookEntry.tags] list. Called from
     * [EpubImport] at import time (with `<dc:subject>` entries) and
     * from BookPanel's tag editor (later sprint). No-op if [id] is
     * not in the library.
     */
    suspend fun setTags(ctx: Context, id: String, tags: List<String>) {
        update(ctx) { current ->
            current.copy(
                books = current.books.map {
                    if (it.id == id) it.copy(tags = tags) else it
                },
            )
        }
    }

    /**
     * Cold-launch sweep: remove every `temp = true` book from the
     * library and delete its on-disk EPUB from [booksDir].
     *
     * Called from `MainActivity.onCreate` before the launcher renders.
     * Closes the gap where process death between
     * `ReaderActivity.onPause` and the temp-cleanup callback would
     * leave the staged file dangling.
     *
     * Returns the number of records cleaned up — useful for log /
     * smoke notes but the launcher does not surface this to the user.
     */
    suspend fun cleanupTempBooks(ctx: Context): Int {
        var sweepFilenames: List<String> = emptyList()
        update(ctx) { current ->
            // Sweep two classes of detritus:
            //   1. `temp = true` "Read once" records whose
            //      ReaderActivity onDestroy didn't run (process death,
            //      task swipe, system reclaim).
            //   2. Pre-copy ghost records — `filename == "pending.epub"`
            //      means EpubImport.fromUri created a row but the byte
            //      copy never finished (process killed mid-copy). The
            //      bookkeeping ghost has nothing on disk to delete but
            //      it shouldn't appear in the library list either.
            //   See code review N2 #3.
            val (sweep, keep) = current.books.partition {
                it.temp || it.filename == PENDING_FILENAME
            }
            sweepFilenames = sweep.map { it.filename }
            current.copy(books = keep)
        }
        val books = booksDir(ctx)
        for (name in sweepFilenames) {
            if (name == PENDING_FILENAME) continue  // No on-disk file to delete.
            File(books, name).delete()
        }
        return sweepFilenames.size
    }

    /** Sentinel filename for the bookkeeping placeholder created by
     *  [EpubImport] before the byte copy succeeds. The two-phase
     *  commit patches this to the real `${id}.epub` on success and
     *  is swept by [cleanupTempBooks] on failure. */
    const val PENDING_FILENAME = "pending.epub"

    /**
     * Remove a book by id. Also deletes the on-disk EPUB under
     * [booksDir] if present. Returns true if an entry was removed.
     */
    suspend fun removeBook(ctx: Context, id: String): Boolean {
        var removedFilename: String? = null
        update(ctx) { current ->
            val match = current.books.firstOrNull { it.id == id }
                ?: return@update current
            removedFilename = match.filename
            current.copy(books = current.books.filterNot { it.id == id })
        }
        val name = removedFilename ?: return false
        File(booksDir(ctx), name).delete()
        // Cover cache lives at booksDir/.covers/${id}.bin — delete
        // alongside the book record so a re-import with a different
        // cover doesn't render a stale image (code review N3 #7).
        File(File(booksDir(ctx), ".covers"), "$id.bin").delete()
        return true
    }
}
