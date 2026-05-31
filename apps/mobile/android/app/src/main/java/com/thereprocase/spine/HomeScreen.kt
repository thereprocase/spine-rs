package com.thereprocase.spine

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Branded home screen — the cold-launch landing page.
 *
 * Three blocks, vertical:
 *
 *   1. Wordmark + tagline at the top, padded for the status bar.
 *   2. Resume card: most recently opened book (by `lastOpenedAt`) or,
 *      if no book has ever been opened, the most-recently-imported
 *      one. Tap to open the reader. Mirrors the demo's
 *      `app/index.tsx:36-52` selector.
 *   3. "Enter library" button → cover grid.
 *   4. Bottom ribbon caption with an editions count.
 *
 * If the library is empty, the Resume card is replaced with a
 * "No books yet — share or open an EPUB to begin" copy. No
 * pretend-action cards.
 */
@Composable
fun HomeScreen(
    library: LibraryStore.Library,
    onResume: (LibraryStore.BookEntry) -> Unit,
    onEnterLibrary: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    val resume = resumeTarget(library)
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = palette.bg,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(WindowInsets.statusBars.asPaddingValues())
                .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            BrandHeader(palette = palette, onOpenSettings = onOpenSettings)
            if (resume != null) {
                ResumeCard(book = resume, onTap = { onResume(resume) })
            } else {
                EmptyResumeNote()
            }
            Spacer(Modifier.weight(1f))
            EnterLibraryButton(onClick = onEnterLibrary)
            BottomRibbon(library = library)
        }
    }
}

/** Resume target selector. Most-recently-opened wins; if nothing has
 *  ever been opened, fall back to most-recently-added. Returns null
 *  only when the library is empty. */
@Composable
private fun resumeTarget(library: LibraryStore.Library): LibraryStore.BookEntry? {
    val books = library.books
    if (books.isEmpty()) return null
    val opened = books.filter { it.lastOpenedAt != null }
        .maxByOrNull { it.lastOpenedAt!! }
    if (opened != null) return opened
    return books.maxByOrNull { it.addedAtMillis }
}

@Composable
private fun BrandHeader(
    palette: SpinePalette,
    onOpenSettings: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = "Spine",
                color = palette.text,
                fontFamily = FontFamily.Serif,
                fontSize = 44.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "READ. ANNOTATE. KEEP.",
                color = palette.accent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 4.sp),
            )
        }
        IconButton(onClick = onOpenSettings) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "Settings",
                tint = palette.textMid,
            )
        }
    }
}

@Composable
private fun ResumeCard(
    book: LibraryStore.BookEntry,
    onTap: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    Surface(
        color = palette.panel,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(width = 88.dp, height = 124.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(palette.canvas),
            ) {
                Cover.BookCover(book = book, modifier = Modifier.fillMaxSize())
            }
            Column(
                modifier = Modifier
                    .padding(start = 16.dp)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = if (book.lastOpenedAt != null) "RESUME" else "BEGIN READING",
                    color = palette.accent,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 3.sp),
                )
                Text(
                    text = book.title,
                    color = palette.text,
                    fontFamily = FontFamily.Serif,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                book.author?.let {
                    Text(
                        text = it,
                        color = palette.textMid,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyResumeNote() {
    val palette = LocalSpinePalette.current
    Surface(
        color = palette.panel,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = "No books yet",
                color = palette.text,
                fontFamily = FontFamily.Serif,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = "Share or open an EPUB from any file manager to begin.",
                color = palette.textMid,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun EnterLibraryButton(onClick: () -> Unit) {
    val palette = LocalSpinePalette.current
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp),
        shape = RoundedCornerShape(8.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = palette.accent,
            contentColor = palette.inkInvert,
        ),
    ) {
        Text(
            text = "ENTER LIBRARY",
            fontWeight = FontWeight.SemiBold,
            style = MaterialTheme.typography.labelLarge.copy(letterSpacing = 3.sp),
        )
    }
}

@Composable
private fun BottomRibbon(
    library: LibraryStore.Library,
) {
    // SETTINGS link removed in 0.1.1-alpha — the prior version pointed
    // at a Toast("coming soon"), violating non-negotiable #4 (no false
    // UI). When the N4 settings surface lands the link comes back.
    // (code review N1-N6 finding #10.)
    val palette = LocalSpinePalette.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = library.books.size.let {
                "$it book${if (it == 1) "" else "s"}"
            },
            color = palette.textDim,
            style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 2.sp),
        )
        Text(
            text = "0.4.0-α",
            color = palette.textDim,
            style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 2.sp),
        )
    }
}

