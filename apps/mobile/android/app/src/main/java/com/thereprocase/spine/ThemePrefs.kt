package com.thereprocase.spine

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Tiny JSON-backed key-value store for app-level preferences that
 * need to survive a process restart but are too small to justify
 * SharedPreferences ceremony.
 *
 * Right now this only persists the active app-chrome theme name
 * (one of [SpineTheme] keys). N4 will add reader font / size /
 * line-height; the same store handles those.
 *
 * On-disk path: `${filesDir}/prefs.json`. Atomic writes via
 * `library.json.tmp` rename; same pattern as [LibraryStore].
 */
object ThemePrefs {

    @Serializable
    data class Snapshot(
        val themeKey: String? = null,
        /** Reader font size in CSS px. Null = use default. Range
         *  [MIN_FONT_PX, MAX_FONT_PX]. */
        val fontSizePx: Int? = null,
        /** Reader line height as a CSS unitless multiplier. Null =
         *  default. Range [MIN_LINE_HEIGHT, MAX_LINE_HEIGHT]. */
        val lineHeight: Float? = null,
        /** Reader horizontal margin as a fraction of viewport width.
         *  Null = default. Range [MIN_MARGIN, MAX_MARGIN]. */
        val marginPct: Float? = null,
        /** Reader typeface family. Null = default ("serif"). One of
         *  the [TYPEFACE_OPTIONS] keys. */
        val typeface: String? = null,
        /** Brightness multiplier on the reader content. 1.0 = normal,
         *  lower values darken via a black overlay (does not touch
         *  the chrome). Range [MIN_BRIGHTNESS, 1.0]. */
        val brightness: Float? = null,
        /** Warmth (sepia overlay) strength, 0..1. 0 = none, 1 = full
         *  warm filter. Range [0, MAX_WARMTH]. */
        val warmth: Float? = null,
        /** CSS `text-align: justify` toggle for reader paragraphs.
         *  Null = use [DEFAULT_JUSTIFY]. (Sprint N3.5.) */
        val justify: Boolean? = null,
        /** CSS `hyphens: auto` toggle for reader paragraphs. Null =
         *  use [DEFAULT_HYPHENATE]. (Sprint N3.5.) */
        val hyphenate: Boolean? = null,
        /** First-letter `::first-letter` drop-cap on the opening
         *  paragraph of each chapter. Null = use [DEFAULT_DROPCAP].
         *  (Sprint N3.5.) */
        val dropCap: Boolean? = null,
        /** Reader flow mode — one of [READER_MODE_PAGINATED] or
         *  [READER_MODE_SCROLL]. Null = use [DEFAULT_READER_MODE].
         *  Maps to foliate's `view.renderer.flow`. (Sprint N3.5.) */
        val readerMode: String? = null,
    )

    const val DEFAULT_FONT_PX: Int = 18
    const val MIN_FONT_PX: Int = 12
    const val MAX_FONT_PX: Int = 28

    const val DEFAULT_LINE_HEIGHT: Float = 1.5f
    const val MIN_LINE_HEIGHT: Float = 1.1f
    const val MAX_LINE_HEIGHT: Float = 2.0f

    const val DEFAULT_MARGIN: Float = 0.03f
    const val MIN_MARGIN: Float = 0.0f
    const val MAX_MARGIN: Float = 0.20f

    const val DEFAULT_BRIGHTNESS: Float = 1.0f
    /** Minimum brightness multiplier. 0.50 means the dimmest setting
     *  is a 50%-alpha black overlay; below that the page becomes
     *  unreadable on every theme (design review warning #5). */
    const val MIN_BRIGHTNESS: Float = 0.50f

    const val DEFAULT_WARMTH: Float = 0.0f
    const val MAX_WARMTH: Float = 1.0f
    /** Peak alpha applied for warmth = 1.0. Bumped from 0.35 → 0.55
     *  so the slider has a visible effect on Dark theme; on Light
     *  theme the warmer end becomes a real sepia tint instead of a
     *  whisper (design review warning #6). */
    const val WARMTH_PEAK_ALPHA: Float = 0.55f

    /** Display label → CSS font-family stack. Keys are the values
     *  persisted in [Snapshot.typeface]; values are dropped into the
     *  iframe CSS as `font-family: <value>`. */
    val TYPEFACE_OPTIONS: List<Pair<String, String>> = listOf(
        "Serif" to "Georgia, 'Times New Roman', Times, serif",
        "Sans" to "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        "Mono" to "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
    )
    const val DEFAULT_TYPEFACE: String = "Serif"

    /** Default for [Snapshot.justify]. Matches proto312. */
    const val DEFAULT_JUSTIFY: Boolean = true
    /** Default for [Snapshot.hyphenate]. Matches proto312. */
    const val DEFAULT_HYPHENATE: Boolean = true
    /** Default for [Snapshot.dropCap]. Matches proto312. */
    const val DEFAULT_DROPCAP: Boolean = true

    /** Reader flow mode — paginated columns. Default. */
    const val READER_MODE_PAGINATED: String = "paginated"
    /** Reader flow mode — vertical scroll. */
    const val READER_MODE_SCROLL: String = "scroll"
    val READER_MODE_OPTIONS: List<String> = listOf(READER_MODE_PAGINATED, READER_MODE_SCROLL)
    const val DEFAULT_READER_MODE: String = READER_MODE_PAGINATED

    private val mutex = Mutex()
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val _state = MutableStateFlow(Snapshot())

    /** Current snapshot. Compose readers can `collectAsState` or
     *  use [resolveSpineTheme] which already takes the stored
     *  themeKey. */
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    private fun prefsFile(ctx: Context): File =
        File(ctx.filesDir, "prefs.json")

    /** Cold-launch hydrate. Idempotent. */
    suspend fun hydrate(ctx: Context) = mutex.withLock {
        withContext(Dispatchers.IO) {
            val f = prefsFile(ctx)
            if (!f.exists()) return@withContext
            try {
                _state.value = json.decodeFromString<Snapshot>(f.readText())
            } catch (_: Exception) {
                // Bad file → fall back to defaults; the file stays on
                // disk for inspection until the next save rewrites it.
            }
        }
    }

    /** Persist a new theme choice. The Compose tree picks up the
     *  change via [state] and recomposes immediately; the disk
     *  write happens on Dispatchers.IO. */
    suspend fun setTheme(ctx: Context, theme: SpineTheme) =
        write(ctx) { it.copy(themeKey = theme.key) }

    suspend fun setFontSize(ctx: Context, px: Int) =
        write(ctx) { it.copy(fontSizePx = px.coerceIn(MIN_FONT_PX, MAX_FONT_PX)) }

    suspend fun setLineHeight(ctx: Context, lh: Float) =
        write(ctx) { it.copy(lineHeight = lh.coerceIn(MIN_LINE_HEIGHT, MAX_LINE_HEIGHT)) }

    suspend fun setMargin(ctx: Context, m: Float) =
        write(ctx) { it.copy(marginPct = m.coerceIn(MIN_MARGIN, MAX_MARGIN)) }

    suspend fun setTypeface(ctx: Context, key: String) =
        write(ctx) { it.copy(typeface = key) }

    suspend fun setBrightness(ctx: Context, b: Float) =
        write(ctx) { it.copy(brightness = b.coerceIn(MIN_BRIGHTNESS, 1.0f)) }

    suspend fun setWarmth(ctx: Context, w: Float) =
        write(ctx) { it.copy(warmth = w.coerceIn(0f, MAX_WARMTH)) }

    suspend fun setJustify(ctx: Context, on: Boolean) =
        write(ctx) { it.copy(justify = on) }

    suspend fun setHyphenate(ctx: Context, on: Boolean) =
        write(ctx) { it.copy(hyphenate = on) }

    suspend fun setDropCap(ctx: Context, on: Boolean) =
        write(ctx) { it.copy(dropCap = on) }

    suspend fun setReaderMode(ctx: Context, mode: String) =
        write(ctx) {
            val coerced = if (mode in READER_MODE_OPTIONS) mode else DEFAULT_READER_MODE
            it.copy(readerMode = coerced)
        }

    /** Reset every reader-format field to defaults. Theme survives. */
    suspend fun resetFormatting(ctx: Context) =
        write(ctx) {
            it.copy(
                fontSizePx = null,
                lineHeight = null,
                marginPct = null,
                typeface = null,
                brightness = null,
                warmth = null,
                justify = null,
                hyphenate = null,
                dropCap = null,
                readerMode = null,
            )
        }

    private suspend fun write(ctx: Context, mutate: (Snapshot) -> Snapshot) = mutex.withLock {
        val next = mutate(_state.value)
        _state.value = next
        withContext(Dispatchers.IO) {
            val target = prefsFile(ctx)
            val staging = File(target.parentFile, "prefs.json.tmp")
            staging.writeText(json.encodeToString(next))
            if (!staging.renameTo(target)) {
                target.writeText(staging.readText())
                staging.delete()
            }
        }
    }
}
