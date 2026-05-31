package com.thereprocase.spine

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Native port of `apps/mobile-reader/src/themes.ts`. Six themes,
 * verbatim hex tokens, mapped onto Compose's `ColorScheme`. The
 * tokens themselves come from
 * internal design notes (spine-mobile-tokens.jsx) — transcription only.
 *
 * Three things this file owns:
 *
 *   1. [SpineTheme] enum — the six theme names. Mirrors the demo's
 *      `ThemeName` union literal.
 *   2. [SpinePalette] — the full token set (chrome + reader colors).
 *      Compose's `ColorScheme` doesn't have slots for everything we
 *      use (panel-vs-canvas-vs-canvasAlt, oxblood, etc.), so the
 *      [LocalSpinePalette] composition-local exposes them alongside
 *      `MaterialTheme.colorScheme`.
 *   3. [SpineAppTheme] composable — wraps content with both the
 *      Material3 ColorScheme and the LocalSpinePalette so any
 *      Composable can read either.
 */
enum class SpineTheme(val key: String, val label: String) {
    Dark("dark", "Dark"),
    Sepia("sepia", "Sepia"),
    Light("light", "Light"),
    Midnight("midnight", "Midnight"),
    Noir("noir", "Noir"),
    Stark("stark", "Stark");

    companion object {
        fun fromKey(key: String?): SpineTheme =
            entries.firstOrNull { it.key == key } ?: Dark
    }
}

/** Full Spine token set — chrome + reader. Mirrors the demo's
 *  `Theme` interface field-for-field. */
data class SpinePalette(
    val name: SpineTheme,
    val bg: Color,
    val panel: Color,
    val canvas: Color,
    val canvasAlt: Color,
    val surface: Color,
    val surfaceHi: Color,
    val border: Color,
    val borderSoft: Color,
    val borderHi: Color,
    val text: Color,
    val textMid: Color,
    val textDim: Color,
    val textFaint: Color,
    val inkInvert: Color,
    val accent: Color,
    val accentHi: Color,
    val accentDim: Color,
    val oxblood: Color,
    val ok: Color,
    val warn: Color,
    val alert: Color,
    val link: Color,
    val statusDark: Boolean,
    val readerBg: Color,
    val readerInk: Color,
    val readerDim: Color,
    val readerRule: Color,
)

private fun hex(s: String): Color = Color(android.graphics.Color.parseColor(s))

/** Static lookup of [SpinePalette] by [SpineTheme]. */
val SPINE_PALETTES: Map<SpineTheme, SpinePalette> = mapOf(
    SpineTheme.Dark to SpinePalette(
        name = SpineTheme.Dark,
        bg = hex("#17171a"), panel = hex("#1e1e22"),
        canvas = hex("#232328"), canvasAlt = hex("#1a1a1e"),
        surface = hex("#2a2a30"), surfaceHi = hex("#34343b"),
        border = hex("#34343b"), borderSoft = hex("#2a2a30"), borderHi = hex("#45454d"),
        text = hex("#ebeae7"), textMid = hex("#b0afac"),
        textDim = hex("#7c7b77"), textFaint = hex("#5a5955"),
        inkInvert = hex("#17171a"),
        accent = hex("#c8a15a"), accentHi = hex("#e4b84f"), accentDim = hex("#6b5430"),
        oxblood = hex("#a83040"),
        ok = hex("#8ab07a"), warn = hex("#d4a85a"), alert = hex("#d07060"),
        link = hex("#94b0c4"),
        statusDark = false,
        readerBg = hex("#1a1a1c"), readerInk = hex("#d8d6d2"),
        readerDim = hex("#7f7e7a"), readerRule = hex("#2a2a2e"),
    ),
    SpineTheme.Sepia to SpinePalette(
        name = SpineTheme.Sepia,
        bg = hex("#e5d6b8"), panel = hex("#eddfc3"),
        canvas = hex("#e1d0ad"), canvasAlt = hex("#e9dab8"),
        surface = hex("#d8c69e"), surfaceHi = hex("#cfbb8e"),
        border = hex("#cfbb8e"), borderSoft = hex("#d8c69e"), borderHi = hex("#a89469"),
        text = hex("#3a2e1e"), textMid = hex("#5e4d33"),
        textDim = hex("#7f6a4a"), textFaint = hex("#a08a66"),
        inkInvert = hex("#eddfc3"),
        accent = hex("#7a5a1e"), accentHi = hex("#a8802d"), accentDim = hex("#c9a969"),
        oxblood = hex("#8a2838"),
        ok = hex("#4a6823"), warn = hex("#96701a"), alert = hex("#a3341e"),
        link = hex("#3e5a74"),
        statusDark = true,
        readerBg = hex("#e5d6b8"), readerInk = hex("#2e2514"),
        readerDim = hex("#7a6a48"), readerRule = hex("#c8b687"),
    ),
    SpineTheme.Light to SpinePalette(
        name = SpineTheme.Light,
        bg = hex("#ebe8e1"), panel = hex("#f3f0e8"),
        canvas = hex("#e6e2d8"), canvasAlt = hex("#efebe1"),
        surface = hex("#dcd7ca"), surfaceHi = hex("#cec8b8"),
        border = hex("#cec8b8"), borderSoft = hex("#dcd7ca"), borderHi = hex("#a8a292"),
        text = hex("#23211c"), textMid = hex("#55524a"),
        textDim = hex("#7a766c"), textFaint = hex("#a29d90"),
        inkInvert = hex("#f3f0e8"),
        accent = hex("#8a6a2e"), accentHi = hex("#a8802d"), accentDim = hex("#d9c9a8"),
        oxblood = hex("#8a2838"),
        ok = hex("#55782f"), warn = hex("#a87a1a"), alert = hex("#a83a28"),
        link = hex("#3d5a78"),
        statusDark = true,
        readerBg = hex("#ece8de"), readerInk = hex("#2a2720"),
        readerDim = hex("#7a756a"), readerRule = hex("#d4ceba"),
    ),
    SpineTheme.Midnight to SpinePalette(
        name = SpineTheme.Midnight,
        bg = hex("#0e151c"), panel = hex("#13202c"),
        canvas = hex("#162534"), canvasAlt = hex("#0f1820"),
        surface = hex("#1c2c3c"), surfaceHi = hex("#243648"),
        border = hex("#243648"), borderSoft = hex("#1c2c3c"), borderHi = hex("#365066"),
        text = hex("#dde6ef"), textMid = hex("#a3b3c4"),
        textDim = hex("#6f8094"), textFaint = hex("#4d5d70"),
        inkInvert = hex("#0e151c"),
        accent = hex("#7aa3c4"), accentHi = hex("#a0c2dd"), accentDim = hex("#3a5a78"),
        oxblood = hex("#a44a5c"),
        ok = hex("#7ea884"), warn = hex("#c4a268"), alert = hex("#cc6e6e"),
        link = hex("#9bbed8"),
        statusDark = false,
        readerBg = hex("#0e151c"), readerInk = hex("#c8d3df"),
        readerDim = hex("#6e8094"), readerRule = hex("#1f2e3e"),
    ),
    SpineTheme.Noir to SpinePalette(
        name = SpineTheme.Noir,
        bg = hex("#000000"), panel = hex("#0a0a0c"),
        canvas = hex("#0d0d10"), canvasAlt = hex("#000000"),
        surface = hex("#15151a"), surfaceHi = hex("#1f1f25"),
        border = hex("#1f1f25"), borderSoft = hex("#15151a"), borderHi = hex("#2e2e36"),
        text = hex("#f0e7c8"), textMid = hex("#bfae7c"),
        textDim = hex("#86764e"), textFaint = hex("#5d5237"),
        inkInvert = hex("#000000"),
        accent = hex("#e6b84f"), accentHi = hex("#f7cf6a"), accentDim = hex("#7a5e2a"),
        oxblood = hex("#9c2030"),
        ok = hex("#92ae6f"), warn = hex("#e0b258"), alert = hex("#d96448"),
        link = hex("#a7c0d2"),
        statusDark = false,
        readerBg = hex("#000000"), readerInk = hex("#e6c07b"),
        readerDim = hex("#86724a"), readerRule = hex("#1c1812"),
    ),
    SpineTheme.Stark to SpinePalette(
        name = SpineTheme.Stark,
        bg = hex("#000000"), panel = hex("#0a0a0a"),
        canvas = hex("#0d0d0d"), canvasAlt = hex("#000000"),
        surface = hex("#161616"), surfaceHi = hex("#202020"),
        border = hex("#202020"), borderSoft = hex("#161616"), borderHi = hex("#303030"),
        text = hex("#ffffff"), textMid = hex("#cccccc"),
        textDim = hex("#888888"), textFaint = hex("#5a5a5a"),
        inkInvert = hex("#000000"),
        accent = hex("#ffffff"), accentHi = hex("#ffffff"), accentDim = hex("#888888"),
        oxblood = hex("#cc3344"),
        ok = hex("#88dd88"), warn = hex("#ddcc66"), alert = hex("#ff5544"),
        link = hex("#88aaff"),
        statusDark = false,
        readerBg = hex("#000000"), readerInk = hex("#ffffff"),
        readerDim = hex("#888888"), readerRule = hex("#202020"),
    ),
)

/** Default app theme. Demo defaulted to dark, matches desktop. */
val DEFAULT_SPINE_THEME = SpineTheme.Dark

/** Display order used by the (eventual) settings theme picker;
 *  matches the demo's THEME_ORDER. */
val SPINE_THEME_ORDER: List<SpineTheme> = listOf(
    SpineTheme.Dark,
    SpineTheme.Sepia,
    SpineTheme.Light,
    SpineTheme.Midnight,
    SpineTheme.Noir,
    SpineTheme.Stark,
)

/**
 * Composition-local with the active palette. Defaults to Dark so
 * any preview / test composition that forgets the wrapper still
 * renders something coherent.
 */
val LocalSpinePalette = compositionLocalOf {
    SPINE_PALETTES[DEFAULT_SPINE_THEME]!!
}

/**
 * Wraps [content] with both [MaterialTheme] (so Material3 widgets
 * pick up the right ColorScheme) and [LocalSpinePalette] (so
 * Spine-specific tokens are reachable).
 *
 * The Material3 ColorScheme is derived from the SpinePalette by
 * mapping our richer set onto the closest Material slots — there
 * is no clean 1-to-1, so a few choices are arbitrary (e.g.
 * `tertiary` reuses `accent`). When in doubt, prefer reading from
 * `LocalSpinePalette.current` rather than `MaterialTheme.colorScheme`.
 */
@Composable
fun SpineAppTheme(
    theme: SpineTheme,
    content: @Composable () -> Unit,
) {
    val palette = SPINE_PALETTES[theme]!!
    val colorScheme = if (palette.statusDark) {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.inkInvert,
            secondary = palette.accentDim,
            onSecondary = palette.text,
            tertiary = palette.accent,
            background = palette.bg,
            onBackground = palette.text,
            surface = palette.surface,
            onSurface = palette.text,
            surfaceVariant = palette.canvas,
            onSurfaceVariant = palette.textMid,
            outline = palette.border,
            error = palette.alert,
            onError = palette.inkInvert,
        )
    } else {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.inkInvert,
            secondary = palette.accentDim,
            onSecondary = palette.text,
            tertiary = palette.accent,
            background = palette.bg,
            onBackground = palette.text,
            surface = palette.surface,
            onSurface = palette.text,
            surfaceVariant = palette.canvas,
            onSurfaceVariant = palette.textMid,
            outline = palette.border,
            error = palette.alert,
            onError = palette.inkInvert,
        )
    }
    CompositionLocalProvider(LocalSpinePalette provides palette) {
        MaterialTheme(colorScheme = colorScheme, content = content)
    }
}

/** Convenience for "use whatever the user last picked, falling
 *  back to the system dark/light if no preference is set." Wired
 *  through [ThemePrefs]; this composable just resolves the string
 *  into a [SpineTheme] enum value. */
@Composable
fun resolveSpineTheme(stored: String?): SpineTheme {
    if (stored != null) return SpineTheme.fromKey(stored)
    val isDark = isSystemInDarkTheme()
    return if (isDark) SpineTheme.Dark else SpineTheme.Light
}
