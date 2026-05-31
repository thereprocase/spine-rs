package com.thereprocase.spine

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Reader settings sheet — opened from the reader's top-bar Display
 * icon. Carries:
 *
 *   - Theme strip: six theme cards (compact horizontal variant of the
 *     SettingsScreen grid).
 *   - Typeface row: 3 buttons (Serif / Sans / Mono).
 *   - Font size slider (12..28 px).
 *   - Line height slider (1.1..2.0).
 *   - Margin slider (2..20% of viewport).
 *   - Brightness slider (0.30..1.0).
 *   - Warmth slider (0..1.0).
 *   - Reset button (clears every format field; theme survives).
 *
 * Every slider drag throttles its commit through [ThemePrefs] write,
 * which the in-iframe theme/format applier picks up via the
 * [ThemePrefs.state] flow.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderSettingsSheet(
    sheetState: SheetState,
    onDismiss: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs by ThemePrefs.state.collectAsState()
    var resetConfirmVisible by remember { mutableStateOf(false) }
    val activeThemeKey = prefs.themeKey
    val fontSize = (prefs.fontSizePx ?: ThemePrefs.DEFAULT_FONT_PX).toFloat()
    val lineHeight = prefs.lineHeight ?: ThemePrefs.DEFAULT_LINE_HEIGHT
    val margin = prefs.marginPct ?: ThemePrefs.DEFAULT_MARGIN
    val brightness = prefs.brightness ?: ThemePrefs.DEFAULT_BRIGHTNESS
    val warmth = prefs.warmth ?: ThemePrefs.DEFAULT_WARMTH
    val typeface = prefs.typeface ?: ThemePrefs.DEFAULT_TYPEFACE

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = palette.panel,
    ) {
        // verticalScroll so the Reset button is reachable on small
        // phones / landscape — the section stack is taller than a
        // partial-expanded sheet by design (design review
        // critical #4).
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionHeader("THEME", palette.accent)
            ThemeStrip(
                activeKey = activeThemeKey,
                onPick = { theme -> scope.launch { ThemePrefs.setTheme(ctx, theme) } },
            )

            SectionHeader("TYPEFACE", palette.accent)
            TypefaceRow(
                active = typeface,
                onPick = { key -> scope.launch { ThemePrefs.setTypeface(ctx, key) } },
            )

            LabeledSlider(
                label = "Font size",
                valueLabel = "${fontSize.toInt()}pt",
                value = fontSize,
                range = ThemePrefs.MIN_FONT_PX.toFloat()..ThemePrefs.MAX_FONT_PX.toFloat(),
                steps = (ThemePrefs.MAX_FONT_PX - ThemePrefs.MIN_FONT_PX - 1),
                onChange = { v -> scope.launch { ThemePrefs.setFontSize(ctx, v.toInt()) } },
            )
            LabeledSlider(
                label = "Line height",
                valueLabel = String.format("%.2f", lineHeight),
                value = lineHeight,
                range = ThemePrefs.MIN_LINE_HEIGHT..ThemePrefs.MAX_LINE_HEIGHT,
                steps = 17,
                onChange = { v -> scope.launch { ThemePrefs.setLineHeight(ctx, v) } },
            )
            LabeledSlider(
                label = "Margin",
                valueLabel = "${(margin * 100).toInt()}%",
                value = margin,
                range = ThemePrefs.MIN_MARGIN..ThemePrefs.MAX_MARGIN,
                steps = 17,
                onChange = { v -> scope.launch { ThemePrefs.setMargin(ctx, v) } },
            )

            SectionHeader("DISPLAY", palette.accent)
            LabeledSlider(
                label = "Brightness",
                valueLabel = "${(brightness * 100).toInt()}%",
                value = brightness,
                range = ThemePrefs.MIN_BRIGHTNESS..1.0f,
                steps = 13,
                onChange = { v -> scope.launch { ThemePrefs.setBrightness(ctx, v) } },
            )
            LabeledSlider(
                label = "Warmth",
                valueLabel = "${(warmth * 100).toInt()}%",
                value = warmth,
                range = 0f..ThemePrefs.MAX_WARMTH,
                steps = 19,
                onChange = { v -> scope.launch { ThemePrefs.setWarmth(ctx, v) } },
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(
                    onClick = { resetConfirmVisible = true },
                    colors = ButtonDefaults.textButtonColors(contentColor = palette.alert),
                ) { Text("Reset to defaults") }
            }
        }
    }
    if (resetConfirmVisible) {
        AlertDialog(
            onDismissRequest = { resetConfirmVisible = false },
            title = { Text("Reset reader formatting?") },
            text = {
                Text(
                    "Font, size, line height, margin, brightness, and warmth " +
                        "return to defaults. Theme is unchanged.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        resetConfirmVisible = false
                        scope.launch { ThemePrefs.resetFormatting(ctx) }
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = palette.alert),
                ) { Text("Reset") }
            },
            dismissButton = {
                TextButton(onClick = { resetConfirmVisible = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun SectionHeader(label: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text = label,
        color = color,
        fontWeight = FontWeight.SemiBold,
        style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 3.sp),
    )
}

@Composable
private fun ThemeStrip(
    activeKey: String?,
    onPick: (SpineTheme) -> Unit,
) {
    val current = LocalSpinePalette.current
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(SPINE_THEME_ORDER, key = { it.key }) { theme ->
            val palette = SPINE_PALETTES[theme]!!
            val active = theme.key == activeKey
            Column(
                modifier = Modifier
                    .size(width = 96.dp, height = 80.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(current.canvas)
                    .border(
                        if (active) 2.dp else 1.dp,
                        if (active) current.accent else current.border,
                        RoundedCornerShape(6.dp),
                    )
                    .clickable { onPick(theme) }
                    .padding(8.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(28.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(palette.readerBg),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "Aa",
                        color = palette.readerInk,
                        fontFamily = FontFamily.Serif,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = theme.label,
                        color = current.text,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(palette.accent),
                    )
                }
            }
        }
    }
}

@Composable
private fun TypefaceRow(active: String, onPick: (String) -> Unit) {
    val palette = LocalSpinePalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ThemePrefs.TYPEFACE_OPTIONS.forEach { (key, _) ->
            val isActive = key == active
            val font = when (key) {
                "Sans" -> FontFamily.SansSerif
                "Mono" -> FontFamily.Monospace
                else -> FontFamily.Serif
            }
            Box(
                modifier = Modifier
                    .height(44.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (isActive) palette.accent else palette.canvas)
                    .border(
                        1.dp,
                        if (isActive) palette.accent else palette.border,
                        RoundedCornerShape(6.dp),
                    )
                    .clickable { onPick(key) }
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = key,
                    color = if (isActive) palette.inkInvert else palette.text,
                    fontFamily = font,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun LabeledSlider(
    label: String,
    valueLabel: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    steps: Int,
    onChange: (Float) -> Unit,
) {
    val palette = LocalSpinePalette.current
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(label, color = palette.text, style = MaterialTheme.typography.bodyMedium)
            Text(
                valueLabel,
                color = palette.textMid,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Slider(
            value = value,
            onValueChange = onChange,
            valueRange = range,
            steps = steps,
            colors = SliderDefaults.colors(
                thumbColor = palette.accent,
                activeTrackColor = palette.accent,
                inactiveTrackColor = palette.border,
            ),
        )
    }
}
