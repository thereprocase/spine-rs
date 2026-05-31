package com.thereprocase.spine

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Top-level launcher activity. Hosts a tiny in-process navigation
 * stack (home / library) and routes inbound shares.
 *
 * What this activity owns:
 *
 *   - Cold-launch hydrate of [LibraryStore] + [ThemePrefs] + a sweep
 *     of `temp = true` / pre-copy ghost records via
 *     [LibraryStore.cleanupTempBooks].
 *   - Inbound `ACTION_VIEW` / `ACTION_SEND` / `ACTION_SEND_MULTIPLE`
 *     intent absorption into [pendingShares], drained by the Compose
 *     tree.
 *   - The home → library → reader navigation.
 *
 * What this activity does NOT own:
 *
 *   - The reader. ReaderActivity is launched via Intent so the
 *     WebView lifecycle is decoupled from the launcher's Compose
 *     tree.
 *   - Any per-book HTTP. SpineCore.callApi is the only path to
 *     spine-srv (and stays an explicit caller decision).
 */
class MainActivity : ComponentActivity() {

    private val pendingShares = MutableStateFlow<List<IncomingShare>>(emptyList())

    fun consumeShare(share: IncomingShare) {
        pendingShares.value = pendingShares.value.filterNot { it === share }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Sweep stale Read-once / pending-ghost records before any UI
        // sees the library state. Also sweep the inbox/ directory in
        // case a prior bulk import was killed mid-flight (process
        // death, task swipe, OOM reclaim) and left the staged ZIP +
        // tmp-*.epub orphans behind. (code review N1-N6 major #14.)
        lifecycleScope.launch {
            LibraryStore.cleanupTempBooks(applicationContext)
            SpineZip.sweepInbox(applicationContext)
            ThemePrefs.hydrate(applicationContext)
        }
        absorb(intent)
        setContent {
            val themeKey by ThemePrefs.state.collectAsState()
            val theme = resolveSpineTheme(themeKey.themeKey)
            SpineAppTheme(theme = theme) {
                AppRoot(
                    pendingShares = pendingShares.asStateFlow(),
                    onShareConsumed = ::consumeShare,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        absorb(intent)
    }

    private fun absorb(intent: Intent?) {
        val shares = extractShares(applicationContext, intent)
        if (shares.isEmpty()) return
        pendingShares.value = pendingShares.value + shares
    }
}

/**
 * Surface enum the launcher can be on. Persisted across rotation
 * via `rememberSaveable`. Kept narrow on purpose — settings is its
 * own activity-launchable composable in N4; for now we just toast
 * "settings coming in N4" if the user taps it.
 */
private enum class Surface { Home, Library, Settings }

@Composable
private fun AppRoot(
    pendingShares: StateFlow<List<IncomingShare>>,
    onShareConsumed: (IncomingShare) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var library by remember { mutableStateOf(LibraryStore.Library()) }
    // rememberSaveable so a rotation mid-dialog doesn't drop the share —
    // IntentDedup still holds the URI, so without this the recreated
    // activity has no path to re-show the dialog and the share is
    // silently lost. (code review N1-N6 finding #13.)
    var pendingDialogUri by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingDialogName by rememberSaveable { mutableStateOf<String?>(null) }
    var surface by rememberSaveable { mutableStateOf(Surface.Home) }
    val palette = LocalSpinePalette.current

    LaunchedEffect(Unit) {
        library = LibraryStore.load(context)
    }

    val shares by pendingShares.collectAsState()

    LaunchedEffect(shares) {
        if (shares.isEmpty()) return@LaunchedEffect
        if (pendingDialogUri != null) return@LaunchedEffect
        val next = shares.first()
        if (!IntentDedup.tryClaim(next.uri)) {
            onShareConsumed(next)
            // Tell the user their re-share was deduped instead of
            // silently swallowing it. (code review minor #18.)
            Toast.makeText(
                context,
                "Already importing that file",
                Toast.LENGTH_SHORT,
            ).show()
            return@LaunchedEffect
        }
        // Release synchronously — see the long-form rationale in N2's
        // commit message; coroutine cancellation can skip the body of
        // an unstarted launched coroutine, so any release in a
        // `finally` block down below would have a hole.
        when (next) {
            is IncomingShare.Zip -> {
                onShareConsumed(next)
                IntentDedup.release(next.uri)
                scope.launch {
                    try {
                        val res = BulkImport.importZip(context, next.uri)
                        library = LibraryStore.load(context)
                        // After a bulk import, default to the library
                        // view so the user can see what landed.
                        surface = Surface.Library
                        val msg = buildString {
                            append("Imported ${res.imported} of ${res.total}")
                            if (res.skipped.isNotEmpty()) {
                                append(" (")
                                append(res.skipped.size)
                                append(" failed)")
                            }
                        }
                        Toast.makeText(
                            context,
                            msg,
                            if (res.skipped.isEmpty()) Toast.LENGTH_SHORT else Toast.LENGTH_LONG,
                        ).show()
                    } catch (t: Throwable) {
                        Toast.makeText(
                            context,
                            "ZIP import failed: ${t.message ?: t.javaClass.simpleName}",
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                }
            }
            is IncomingShare.Epub -> {
                pendingDialogUri = next.uri.toString()
                pendingDialogName = next.displayName
                onShareConsumed(next)
            }
        }
    }

    pendingDialogUri?.let { uriStr ->
        val displayName = pendingDialogName ?: uriStr
        val uri = Uri.parse(uriStr)
        SingleEpubDialog(
            displayName = displayName,
            onChoice = { choice ->
                pendingDialogUri = null
                pendingDialogName = null
                IntentDedup.release(uri)
                scope.launch {
                    when (choice) {
                        SingleEpubChoice.Cancel -> {
                            // Nothing to import.
                        }
                        SingleEpubChoice.AddToLibrary -> {
                            val result = EpubImport.fromUri(context, uri, temp = false)
                            if (result != null) {
                                library = LibraryStore.load(context)
                                surface = Surface.Library
                                Toast.makeText(
                                    context,
                                    "Imported: ${result.entry.title}",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            } else {
                                Toast.makeText(context, "Import failed", Toast.LENGTH_SHORT)
                                    .show()
                            }
                        }
                        SingleEpubChoice.ReadOnce -> {
                            val result = EpubImport.fromUri(context, uri, temp = true)
                            if (result != null) {
                                library = LibraryStore.load(context)
                                openReader(context, result.entry, tempEntryId = result.entry.id)
                            } else {
                                Toast.makeText(context, "Import failed", Toast.LENGTH_SHORT)
                                    .show()
                            }
                        }
                    }
                }
            },
        )
    }

    // Back gesture on non-Home surfaces returns to Home.
    BackHandler(enabled = surface != Surface.Home) {
        surface = Surface.Home
    }
    Box(modifier = Modifier.fillMaxSize()) {
        when (surface) {
            Surface.Home -> HomeScreen(
                library = library,
                onResume = { entry ->
                    openReader(context, entry, tempEntryId = null)
                    scope.launch { LibraryStore.touchOpenedAt(context, entry.id) }
                },
                onEnterLibrary = { surface = Surface.Library },
                onOpenSettings = { surface = Surface.Settings },
            )
            Surface.Library -> LibraryScreen(
                library = library,
                onOpen = { entry ->
                    openReader(context, entry, tempEntryId = null)
                    scope.launch { LibraryStore.touchOpenedAt(context, entry.id) }
                },
                onImportPicked = { uri ->
                    scope.launch {
                        val result = EpubImport.fromUri(context, uri, temp = false)
                        if (result != null) {
                            library = LibraryStore.load(context)
                            Toast.makeText(
                                context,
                                "Imported: ${result.entry.title}",
                                Toast.LENGTH_SHORT,
                            ).show()
                        } else {
                            Toast.makeText(context, "Import failed", Toast.LENGTH_SHORT).show()
                        }
                    }
                },
                onDelete = { entry ->
                    scope.launch {
                        LibraryStore.removeBook(context, entry.id)
                        Annotations.removeForBook(context, entry.id)
                        library = LibraryStore.load(context)
                    }
                },
                onBack = { surface = Surface.Home },
                onOpenSettings = { surface = Surface.Settings },
            )
            Surface.Settings -> SettingsScreen(
                onBack = { surface = Surface.Home },
            )
        }
        // Floating import banner pinned to the top.
        ImportProgressBanner(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = 0.dp),
        )
    }
}

private fun openReader(
    context: android.content.Context,
    entry: LibraryStore.BookEntry,
    tempEntryId: String?,
) {
    val readerIntent = Intent(context, ReaderActivity::class.java).apply {
        putExtra(ReaderActivity.EXTRA_FILENAME, entry.filename)
        putExtra(ReaderActivity.EXTRA_TITLE, entry.title)
        // Always pass the library entry id so annotations can be
        // tied to it. For "Read once" shares the temp id is the
        // same value passed twice — the EXTRA_TEMP_BOOK_ID flag
        // tells ReaderActivity to also clean up the record on
        // exit, while EXTRA_BOOK_ID is the foreign key for the
        // (ephemeral) annotations created during the session.
        putExtra(ReaderActivity.EXTRA_BOOK_ID, entry.id)
        if (tempEntryId != null) {
            putExtra(ReaderActivity.EXTRA_TEMP_BOOK_ID, tempEntryId)
        }
        // Hand the saved reading position to the reader so the JS
        // host can call view.goTo(saved) after view.open(book) and
        // dump the user back at where they left off across process
        // death. (code review N1-N6 critical #7.)
        entry.lastLocator?.let { putExtra(ReaderActivity.EXTRA_START_LOCATOR, it) }
    }
    context.startActivity(readerIntent)
}

private enum class SingleEpubChoice { ReadOnce, AddToLibrary, Cancel }

/**
 * Three-way share dialog. "Add to library" is the recommended default
 * (rightmost / confirmButton slot per Material conventions). "Read
 * once" is the secondary choice and carries a one-line subtitle
 * spelling out what it does, since the verb alone is ambiguous.
 * (code review N1-N6 finding #9.)
 */
@Composable
private fun SingleEpubDialog(
    displayName: String,
    onChoice: (SingleEpubChoice) -> Unit,
) {
    AlertDialog(
        onDismissRequest = { onChoice(SingleEpubChoice.Cancel) },
        title = { Text("Open EPUB") },
        text = {
            Column {
                Text(
                    text = displayName,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = "Read once: opens without saving. The book is removed when you close it. Add to library keeps it for later.",
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onChoice(SingleEpubChoice.AddToLibrary) }) {
                Text("Add to library")
            }
        },
        dismissButton = {
            androidx.compose.foundation.layout.Row {
                TextButton(onClick = { onChoice(SingleEpubChoice.Cancel) }) {
                    Text("Cancel")
                }
                TextButton(onClick = { onChoice(SingleEpubChoice.ReadOnce) }) {
                    Text("Read once")
                }
            }
        },
    )
}
