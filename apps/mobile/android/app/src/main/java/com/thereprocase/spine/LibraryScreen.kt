package com.thereprocase.spine

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Cover-grid library screen, ported from the demo's
 * `apps/mobile-reader/app/library.tsx`. Layout:
 *
 *   - Top app bar with the screen title.
 *   - LazyVerticalGrid of book covers (3 columns at phone width).
 *   - Tap a cover → onOpen.
 *   - Long-press a cover → confirm-and-delete dialog.
 *   - FAB for OPEN_DOCUMENT EPUB import.
 *
 * The reader chrome (TOC, settings sheet, theme toggle) lives in
 * the reader itself and lands in N5; this screen is just "the
 * shelf."
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    library: LibraryStore.Library,
    onOpen: (LibraryStore.BookEntry) -> Unit,
    onImportPicked: (android.net.Uri) -> Unit,
    onDelete: (LibraryStore.BookEntry) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    var pendingDelete by remember { mutableStateOf<LibraryStore.BookEntry?>(null) }
    val importLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri: android.net.Uri? ->
        if (uri != null) onImportPicked(uri)
    }
    Scaffold(
        containerColor = palette.bg,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "LIBRARY",
                        color = palette.text,
                        fontFamily = FontFamily.Serif,
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                navigationIcon = {
                    androidx.compose.material3.IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = palette.text,
                        )
                    }
                },
                actions = {
                    androidx.compose.material3.IconButton(onClick = onOpenSettings) {
                        Icon(
                            imageVector = Icons.Filled.Settings,
                            contentDescription = "Settings",
                            tint = palette.textMid,
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
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { importLauncher.launch(arrayOf("application/epub+zip")) },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Import") },
                containerColor = palette.accent,
                contentColor = palette.inkInvert,
            )
        },
    ) { inner ->
        if (library.books.isEmpty()) {
            EmptyShelfNote(padding = inner)
        } else {
            CoverGrid(
                padding = inner,
                books = library.books,
                onTap = onOpen,
                onLongPress = { pendingDelete = it },
            )
        }
    }
    pendingDelete?.let { book ->
        DeleteConfirmDialog(
            book = book,
            onDismiss = { pendingDelete = null },
            onConfirm = {
                pendingDelete = null
                onDelete(book)
            },
        )
    }
}

@Composable
private fun CoverGrid(
    padding: PaddingValues,
    books: List<LibraryStore.BookEntry>,
    onTap: (LibraryStore.BookEntry) -> Unit,
    onLongPress: (LibraryStore.BookEntry) -> Unit,
) {
    val palette = LocalSpinePalette.current
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 110.dp),
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(horizontal = 16.dp),
        contentPadding = PaddingValues(vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        items(books, key = { it.id }) { book ->
            BookTile(
                book = book,
                palette = palette,
                onTap = { onTap(book) },
                onLongPress = { onLongPress(book) },
            )
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun BookTile(
    book: LibraryStore.BookEntry,
    palette: SpinePalette,
    onTap: () -> Unit,
    onLongPress: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onTap, onLongClick = onLongPress),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(0.7f)
                .clip(RoundedCornerShape(4.dp))
                .background(palette.canvas),
        ) {
            Cover.BookCover(book = book, modifier = Modifier.fillMaxSize())
        }
        Text(
            text = book.title,
            color = palette.text,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Serif,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        book.author?.let {
            Text(
                text = it,
                color = palette.textDim,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun EmptyShelfNote(padding: PaddingValues) {
    val palette = LocalSpinePalette.current
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "The shelf is empty.\nTap Import to add an EPUB.",
            color = palette.textMid,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

@Composable
private fun DeleteConfirmDialog(
    book: LibraryStore.BookEntry,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete book?") },
        text = {
            Text(
                text = "Remove \"${book.title}\" from the library? " +
                    "The on-disk EPUB will be deleted.",
            )
        },
        confirmButton = {
            // Destructive action gets error-tinted text so a
            // reflexive tap of the rightmost button doesn't read
            // as a neutral confirm (code review N3 #3).
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) { Text("Delete") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
