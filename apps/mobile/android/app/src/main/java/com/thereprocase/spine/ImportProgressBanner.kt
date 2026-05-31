package com.thereprocase.spine

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Top-of-screen progress banner shown while a bulk ZIP import is
 * running. Subscribes to [ImportState.state] so the banner is alive
 * regardless of which screen is in front.
 *
 * The compact variant (a single thin progress strip) is intended for
 * the reader, where the full banner row would yank the user out of
 * immersive mode for an import they already kicked off. The full
 * variant is meant for the launcher / library list / settings.
 *
 * Ported from `apps/mobile-reader/src/ui/ImportProgressBanner.tsx`.
 */
@Composable
fun ImportProgressBanner(
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val snapshot by ImportState.state.collectAsState()
    if (!snapshot.running) return

    val ratio = if (snapshot.total > 0) {
        (snapshot.current.toFloat() / snapshot.total.toFloat()).coerceIn(0f, 1f)
    } else {
        null
    }

    if (compact) {
        Box(
            modifier = modifier
                .fillMaxWidth()
                .height(2.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            if (ratio != null) {
                LinearProgressIndicator(
                    progress = { ratio },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
        }
        return
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
            Column(modifier = Modifier.padding(start = 12.dp)) {
                val title = if (snapshot.total > 0) {
                    "Importing ${snapshot.current} of ${snapshot.total}"
                } else {
                    "Importing…"
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.bodyMedium,
                )
                snapshot.label?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (ratio != null) {
            LinearProgressIndicator(
                progress = { ratio },
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }
}
