package com.thereprocase.spine

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Settings screen. Currently a single section: theme picker. Six
 * theme cards in a 2-column grid; tap a card to apply. The active
 * theme has a check overlay and a thicker accent border. Selection
 * triggers a recomposition tree-wide because both [SpineAppTheme] and
 * the underlying screens read [ThemePrefs.state].
 *
 * Future N4 additions land here too: reader font size / line height
 * / margin (will be persisted in ThemePrefs alongside the themeKey).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs by ThemePrefs.state.collectAsState()
    val activeKey = prefs.themeKey
    Scaffold(
        containerColor = palette.bg,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "SETTINGS",
                        color = palette.text,
                        fontFamily = FontFamily.Serif,
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = palette.text,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.panel,
                    titleContentColor = palette.text,
                    navigationIconContentColor = palette.text,
                ),
            )
        },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "THEME",
                color = palette.accent,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 3.sp),
            )
            ThemeGrid(
                activeKey = activeKey,
                onPick = { theme ->
                    scope.launch { ThemePrefs.setTheme(ctx, theme) }
                },
            )
        }
    }
}

@Composable
private fun ThemeGrid(
    activeKey: String?,
    onPick: (SpineTheme) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 150.dp),
        modifier = Modifier.fillMaxSize(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(
            items = SPINE_THEME_ORDER,
            key = { it.key },
        ) { theme ->
            ThemeCard(
                theme = theme,
                active = theme.key == activeKey,
                onPick = { onPick(theme) },
            )
        }
    }
}

@Composable
private fun ThemeCard(
    theme: SpineTheme,
    active: Boolean,
    onPick: () -> Unit,
) {
    val current = LocalSpinePalette.current
    val palette = SPINE_PALETTES[theme]!!
    val borderColor = if (active) current.accent else current.border
    val borderWidth = if (active) 3.dp else 1.dp
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(current.panel)
            .border(borderWidth, borderColor, RoundedCornerShape(8.dp))
            .clickable(onClick = onPick)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Mini preview: bg + reader bg + accent dot, gives the user a
        // sense of the palette before committing.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clip(RoundedCornerShape(4.dp)),
        ) {
            Box(
                modifier = Modifier
                    .background(palette.bg)
                    .fillMaxSize()
                    .padding(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .background(palette.readerBg)
                        .fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "Aa",
                        color = palette.readerInk,
                        style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Serif,
                    )
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = theme.label,
                color = current.text,
                style = MaterialTheme.typography.titleSmall,
                fontFamily = FontFamily.Serif,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(
                    modifier = Modifier
                        .size(14.dp)
                        .clip(CircleShape)
                        .background(palette.accent),
                )
                if (active) {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = "Active theme",
                        tint = current.accent,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
        Text(
            text = if (active) "ACTIVE" else "TAP TO APPLY",
            color = if (active) current.accent else current.textDim,
            fontWeight = FontWeight.SemiBold,
            style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 2.sp),
            textAlign = TextAlign.Start,
        )
    }
}
