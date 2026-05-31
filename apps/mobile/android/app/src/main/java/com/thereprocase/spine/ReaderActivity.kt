package com.thereprocase.spine

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.shape.GenericShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.navigationBarsIgnoringVisibility
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsIgnoringVisibility
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.NavigateBefore
import androidx.compose.material.icons.automirrored.filled.NavigateNext
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipFile

/**
 * WebView host for the foliate-js reader bundle.
 *
 * As of N6 (2026-04-27), this activity carries:
 *
 *   - The locked-down WebView that loads `assets/foliate/index.html`
 *     and routes `/book/<filename>/...` to [EpubResourceHandler] for
 *     per-zip-entry streaming, and `/assets/...` to
 *     [WebViewAssetLoader.AssetsPathHandler].
 *   - A narrow [SpineBridge] JS interface — strings only, never
 *     bytes. Carries: getEpubFilename / getBookUrl, plus the
 *     N6 selection bridge (onSelection / onLocator / onAnnotationTap
 *     / requestHighlights).
 *   - Reader chrome: top app bar (back + title + bookmark toggle +
 *     annotations sheet button), [SelectionBar] floating bar that
 *     appears when the user has a non-empty selection, and the
 *     [AnnotationsSheet] modal bottom sheet listing the book's
 *     highlights + bookmarks.
 *
 * No `file://` origin is exposed (CLAUDE.md non-negotiable #2). EPUB
 * bytes never cross the JS bridge as a single payload (#1). The
 * intent contract validates filename at the boundary
 * ([sanitizeBookFilename]) and again inside the path handler.
 *
 * **Annotation persistence** lives in [Annotations] (local JSON),
 * NOT through `SpineCore.callApi` to a `spine-srv` endpoint. The
 * eventual `POST /api/v1/book/{id}/highlight` endpoint is filed in
 * `TECH_DEBT.md` — when it lands, [Annotations]'s API is replaced
 * wholesale with a callApi adapter; existing on-disk data must
 * migrate.
 */
class ReaderActivity : ComponentActivity() {

    companion object {
        const val EXTRA_FILENAME = "com.thereprocase.spine.EXTRA_FILENAME"
        const val EXTRA_TITLE = "com.thereprocase.spine.EXTRA_TITLE"

        /** Library-entry id whose record + on-disk EPUB should be
         *  cleaned up when this activity finishes. Set by the
         *  three-way "Read once" share path in MainActivity. */
        const val EXTRA_TEMP_BOOK_ID = "com.thereprocase.spine.EXTRA_TEMP_BOOK_ID"

        /** Library-entry id used as the `bookId` foreign key on
         *  highlights / bookmarks persisted via [Annotations]. */
        const val EXTRA_BOOK_ID = "com.thereprocase.spine.EXTRA_BOOK_ID"

        /** Saved reading position (foliate CFI string) restored by
         *  the JS host after `view.open(book)`. Null on first open. */
        const val EXTRA_START_LOCATOR = "com.thereprocase.spine.EXTRA_START_LOCATOR"

        /** Throttle window between persisted locator writes. Reader
         *  emits one CFI per page-turn; rewriting the whole library
         *  JSON on every tap would be wasteful, so coalesce to once
         *  per N millis. The window is small enough that even a
         *  rapid back-button kill loses at most ~3s of progress.
         *  (code review N1-N6 critical #7.) */
        private const val LOCATOR_PERSIST_WINDOW_MS = 3_000L

        /** Cap on how many TOC entries we accept from the JS bridge.
         *  A 100k-entry NCX from a hostile EPUB would otherwise OOM
         *  the LazyColumn backing list at parse time. (code review
         *  N4/N5 warning #3.) Realistic upper bound for any human
         *  book is well under this. */
        const val MAX_TOC_ENTRIES = 5_000

        /** Cap on how many `<dc:subject>` tags we accept per book.
         *  Realistic EPUBs ship 1–10; the cap exists so a hostile
         *  one shipping 10k subjects can't pin LibraryStore I/O.
         *  (Sprint N3.5.) */
        const val MAX_TAGS = 64
    }

    private var tempBookId: String? = null
    private var bookId: String = ""
    private var startLocator: String? = null

    /** Wall-clock millis of the last persisted locator. Compared to
     *  [System.currentTimeMillis] to throttle write rate. */
    @Volatile private var lastLocatorPersistAtMs: Long = 0L

    /** Most recent selection payload published by spine-host.mjs.
     *  Null means "no selection." Keyed off the active doc; if the
     *  user pages forward, the selection is implicitly cleared and
     *  this resets to null via the JS bridge. */
    private val selectionFlow = MutableStateFlow<SelectionPayload?>(null)

    /** Most recent CFI for "where the reader is right now." Drives
     *  the bookmark toggle in the top bar. */
    private val locatorFlow = MutableStateFlow<LocatorPayload?>(null)

    /** Pulse-style flow: every annotation tap publishes the tapped
     *  locator. Compose subscribes via collectAsState and resolves
     *  to a "show this annotation" sheet entry. */
    private val annotationTapFlow = MutableStateFlow<String?>(null)

    /** TOC entries published by spine-host.mjs after view.open(book).
     *  Drives the bottom-bar TOC button and the [TocSheet] modal.
     *  Empty until the JS side has emitted (`publishToc`). */
    private val tocFlow = MutableStateFlow<List<TocItem>>(emptyList())

    /** Chrome (top + bottom bar) visibility. Activity-scoped so JS
     *  taps in the middle tap-zone can flip it via SpineBridge. */
    private val chromeFlow = MutableStateFlow(true)

    /** Cached WebView reference for evaluateJavascript pushes from
     *  the activity. Captured on AndroidView factory; cleared on
     *  release. */
    private var webViewRef: WebView? = null

    /** Hybrid Kotlin+JS session timer. Started on [onResume],
     *  stopped on [onPause]. Re-armed by [SpineBridge.notePageEvent]
     *  on every relocate / tap. See [SessionTimer] kdoc for the full
     *  rationale. (Sprint N3.5.) */
    private val sessionTimer: SessionTimer by lazy {
        SessionTimer(lifecycleScope.coroutineContext)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        applyImmersive()
        watchThemeChanges()
        val rawFilename = intent.getStringExtra(EXTRA_FILENAME)
        val filename = sanitizeBookFilename(rawFilename)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: filename ?: "Book"
        tempBookId = intent.getStringExtra(EXTRA_TEMP_BOOK_ID)
        bookId = intent.getStringExtra(EXTRA_BOOK_ID) ?: ""
        startLocator = intent.getStringExtra(EXTRA_START_LOCATOR)
        // Pre-flight: refuse to open a book whose backing file is no
        // longer on disk (deleted, SD card pulled, app data partially
        // cleared). Without this the JS-side fetch returns 404 and the
        // user sees "Malformed or unsupported EPUB" — a misleading
        // error since the book itself is fine. (code review N1-N6
        // critical #8.)
        val onDiskFile = if (filename != null) File(LibraryStore.booksDir(this), filename) else null
        val fileMissing = filename != null && (onDiskFile == null || !onDiskFile.isFile)
        setContent {
            val themeKey by ThemePrefs.state.collectAsState()
            val theme = resolveSpineTheme(themeKey.themeKey)
            SpineAppTheme(theme = theme) {
                // Pin the outer Surface to the palette's panel color
                // so any compose transitions / system insets / window
                // chrome that bleeds through during recompose all
                // come up the same shade as the Scaffold + bars +
                // iframe bg. Pulling from MaterialTheme.colorScheme
                // .background was leaking palette.bg through during
                // chrome show/hide animations.
                Surface(color = LocalSpinePalette.current.panel) {
                    when {
                        filename == null -> UnopenableBookScreen(rawFilename)
                        fileMissing -> MissingBookScreen(
                            title = title,
                            onRemoveAndClose = {
                                applicationContext.spineApplicationScope.launch {
                                    if (bookId.isNotEmpty()) {
                                        LibraryStore.removeBook(applicationContext, bookId)
                                        Annotations.removeForBook(applicationContext, bookId)
                                    }
                                    finish()
                                }
                            },
                            onClose = { finish() },
                        )
                        else -> ReaderRoot(
                            title = title,
                            filename = filename,
                            bookId = bookId,
                            selectionFlow = selectionFlow.asStateFlow(),
                            locatorFlow = locatorFlow.asStateFlow(),
                            annotationTapFlow = annotationTapFlow.asStateFlow(),
                            tocFlow = tocFlow.asStateFlow(),
                            chromeFlow = chromeFlow.asStateFlow(),
                            // Use update{} for atomic toggle — direct
                            // value = !value can lose toggles under
                            // concurrent JS taps (code review N4/N5 #3).
                            onChromeToggle = { chromeFlow.update { !it } },
                            onChromeShow = { chromeFlow.value = true },
                            onWebViewReady = { wv -> webViewRef = wv },
                            onSelectionConsumed = { selectionFlow.value = null },
                            onAnnotationTapConsumed = { annotationTapFlow.value = null },
                            onClose = { finish() },
                            pushHighlights = ::pushHighlightsToJs,
                            clearSelectionInJs = ::clearSelectionInJs,
                            jumpToLocator = ::jumpToLocator,
                            goToHref = ::goToHrefInJs,
                            pageNext = ::pageNextInJs,
                            pagePrev = ::pagePrevInJs,
                            makeBridge = ::makeBridge,
                        )
                    }
                }
            }
        }
    }

    /**
     * Throttled locator-persistence side-channel. Called from the JS
     * bridge's onLocator callback (already on a non-Main thread) every
     * time the reader emits a new CFI; the throttle drops anything
     * faster than [LOCATOR_PERSIST_WINDOW_MS] so a fast pager doesn't
     * burn through library.json rewrites. Last-write wins on activity
     * teardown is fine — losing a few seconds of progress is the
     * worst case. Skipped entirely for "Read once" shares since
     * those records die on activity close anyway.
     */
    private fun persistLocatorThrottled(locator: String, progress: Float?) {
        if (bookId.isEmpty()) return
        if (tempBookId != null) return
        val now = System.currentTimeMillis()
        if (now - lastLocatorPersistAtMs < LOCATOR_PERSIST_WINDOW_MS) return
        lastLocatorPersistAtMs = now
        applicationContext.spineApplicationScope.launch {
            LibraryStore.touchLastLocator(applicationContext, bookId, locator, progress)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        webViewRef = null
        if (!isFinishing) return
        val id = tempBookId ?: return
        applicationContext.spineApplicationScope.launch {
            LibraryStore.removeBook(applicationContext, id)
            Annotations.removeForBook(applicationContext, id)
        }
    }

    override fun onResume() {
        super.onResume()
        // Code review N4/N5 #5: applyImmersive only-in-onCreate misses
        // the case where the activity returns from a stopped state
        // (e.g. share sheet dismissed, foreground regained). Re-hide
        // every resume so bars stay gone.
        applyImmersive()
        // SessionTimer is keyed on bookId — temp "Read once" books
        // don't accumulate (they're discarded on close anyway, so
        // there's nothing to persist into). (Sprint N3.5.)
        if (bookId.isNotEmpty() && tempBookId == null) {
            sessionTimer.start(applicationContext, bookId)
        }
    }

    override fun onPause() {
        super.onPause()
        // Stop accumulating immediately on background; flush any
        // pending delta to LibraryStore via the application scope
        // (which outlives the activity). (Sprint N3.5.)
        sessionTimer.stop(applicationContext)
    }

    private fun applyImmersive() {
        // Full-screen immersive: hide system status + nav bars while
        // reading. BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE means a
        // swipe from the edge brings the bars back briefly without
        // dismissing immersive mode.
        val insets = androidx.core.view.WindowCompat
            .getInsetsController(window, window.decorView)
        insets.systemBarsBehavior = androidx.core.view
            .WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insets.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
    }

    private fun makeBridge(filename: String, bookId: String): SpineBridge =
        SpineBridge(
            filename = filename,
            bookId = bookId,
            startLocator = startLocator,
            appContext = applicationContext,
            selectionFlow = selectionFlow,
            locatorFlow = locatorFlow,
            annotationTapFlow = annotationTapFlow,
            tocFlow = tocFlow,
            pushHighlights = ::pushHighlightsToJs,
            onLocatorPersist = ::persistLocatorThrottled,
            onChromeToggle = { chromeFlow.update { !it } },
            // Each ping re-arms SessionTimer's "still active" deadline.
            // Hits per-relocate + per-tap-zone-tap; cheap. (N3.5.)
            onPageEvent = sessionTimer::notePageEvent,
        )

    private fun goToHrefInJs(href: String) {
        val webView = webViewRef ?: return
        val argLiteral = Json.encodeToString(href)
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.goToHref($argLiteral)",
                null,
            )
        }
    }

    private fun pageNextInJs() {
        val webView = webViewRef ?: return
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.pageNext()",
                null,
            )
        }
    }

    private fun pagePrevInJs() {
        val webView = webViewRef ?: return
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.pagePrev()",
                null,
            )
        }
    }

    /**
     * Seek to a 0..1 fraction of the book. Wired up here so the
     * future N5 chapter scrubber (drag-release commit) can call into
     * a single typed Kotlin entrypoint instead of constructing JS
     * strings per-callsite. Out-of-range inputs are accepted — the
     * JS side clamps. (Sprint N3.5.)
     */
    @Suppress("unused")
    private fun seekInJs(fraction: Float) {
        val webView = webViewRef ?: return
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.seek($fraction)",
                null,
            )
        }
    }

    private fun pushHighlightsToJs(list: List<Annotations.Highlight>) {
        val webView = webViewRef ?: return
        val payload: List<Map<String, String>> =
            list.map { mapOf("locator" to it.locator, "color" to it.color) }
        // Two layers of JSON encoding: the inner string is what the
        // JS side passes to JSON.parse; the outer encoding wraps it
        // as a string literal in the evaluateJavascript expression.
        val inner = Json.encodeToString(payload)
        val argLiteral = Json.encodeToString(inner)
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.applyHighlights($argLiteral)",
                null,
            )
        }
    }

    private fun clearSelectionInJs() {
        val webView = webViewRef ?: return
        webView.post {
            webView.evaluateJavascript("window.spineHost && window.spineHost.clearSelection()", null)
        }
    }

    private fun jumpToLocator(locator: String) {
        val webView = webViewRef ?: return
        val argLiteral = Json.encodeToString(locator)
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.goTo($argLiteral)",
                null,
            )
        }
    }

    /** Push the current reader theme colors into the WebView. Called
     *  once after view.open (via spine-host.mjs pulling) and again
     *  whenever ThemePrefs changes while the reader is open. */
    private fun pushReaderThemeToJs() {
        val webView = webViewRef ?: return
        webView.post {
            webView.evaluateJavascript(
                "window.spineHost && window.spineHost.applyReaderTheme()",
                null,
            )
        }
    }

    /**
     * Watch ThemePrefs and re-skin the open WebView when the user
     * picks a new theme in Settings. Started from onCreate; cancelled
     * automatically when the activity is destroyed.
     *
     * Throttled via collectLatest + a small debounce: dragging a
     * slider on the settings sheet emits one Snapshot per step.
     * Without throttling that becomes 17+ evaluateJavascript JNI
     * round-trips per drag (code review N4/N5 critical #2). collectLatest
     * cancels the in-flight body when a new value arrives, so only
     * the terminal value of a drag fires the JS push.
     */
    private fun watchThemeChanges() {
        lifecycleScope.launch {
            ThemePrefs.state.collectLatest { _ ->
                kotlinx.coroutines.delay(80)
                pushReaderThemeToJs()
            }
        }
    }
}

/** Bridge surface for spine-host.mjs. Methods are called on the JS
 *  thread (not Main), so each writes to a flow rather than touching
 *  Compose state directly. Top-level (not an inner class of
 *  ReaderActivity) so a Composable factory can construct it without
 *  needing a labelled `this@ReaderActivity`. */
class SpineBridge(
    private val filename: String,
    private val bookId: String,
    private val startLocator: String?,
    private val appContext: android.content.Context,
    private val selectionFlow: MutableStateFlow<SelectionPayload?>,
    private val locatorFlow: MutableStateFlow<LocatorPayload?>,
    private val annotationTapFlow: MutableStateFlow<String?>,
    private val tocFlow: MutableStateFlow<List<TocItem>>,
    private val pushHighlights: (List<Annotations.Highlight>) -> Unit,
    private val onLocatorPersist: (String, Float?) -> Unit,
    private val onChromeToggle: () -> Unit,
    private val onPageEvent: () -> Unit,
) {
    @JavascriptInterface
    fun getEpubFilename(): String = filename

    @JavascriptInterface
    fun getBookUrl(): String =
        "https://$ASSETS_HOST$BOOK_PREFIX$filename/"

    /** Saved reading position for this book; null on first open.
     *  spine-host.mjs calls this after view.open(book) and, when
     *  non-null, jumps the reader there. */
    @JavascriptInterface
    fun getStartLocator(): String? = startLocator

    @JavascriptInterface
    fun onSelection(json: String?) {
        selectionFlow.value = parseSelection(json)
    }

    @JavascriptInterface
    fun onLocator(json: String?) {
        val parsed = parseLocator(json)
        locatorFlow.value = parsed
        // Side-channel: persist the reading position. Activity-side
        // throttling drops everything inside the per-book persist
        // window so a fast pager doesn't burn library.json rewrites.
        // The percentage is forwarded so progress lands in the same
        // write as the locator (N3.5).
        if (parsed != null) onLocatorPersist(parsed.locator, parsed.percentage)
    }

    /**
     * Re-arm SessionTimer's active deadline. Called from spine-host.mjs
     * on every relocate and on every successful tap-zone tap — the
     * events that prove the user is actively paging through the book.
     * Cheap; just bumps a volatile deadline. (Sprint N3.5.)
     */
    @JavascriptInterface
    fun notePageEvent() {
        onPageEvent()
    }

    @JavascriptInterface
    fun onAnnotationTap(cfi: String?) {
        if (!cfi.isNullOrBlank()) annotationTapFlow.value = cfi
    }

    @JavascriptInterface
    fun requestHighlights() {
        // The activity's lifecycleScope may already be cancelling
        // by the time the JS thread gets here; application-scoped
        // is the right home for "load the persisted highlights
        // and hand them to JS."
        appContext.spineApplicationScope.launch {
            val list = Annotations.listHighlights(appContext, bookId)
            pushHighlights(list)
        }
    }

    /** Receive the book TOC (flat or nested) as a JSON-serialised
     *  list. Called once after view.open(book). The shape comes from
     *  spine-host.mjs's toc-flatten helper. Capped at MAX_TOC_ENTRIES
     *  to defend against a malicious EPUB shipping a 100k-entry NCX
     *  that would OOM Compose's LazyColumn backing list (code review
     *  N4/N5 warning #3). */
    @JavascriptInterface
    fun publishToc(json: String?) {
        val parsed = parseTocJson(json) ?: return
        tocFlow.value = parsed.take(ReaderActivity.MAX_TOC_ENTRIES)
    }

    /** Receive the book's `<dc:subject>` entries (deduped, normalised)
     *  as a JSON-serialised list of strings. Called once after
     *  view.open(book). Capped at MAX_TAGS to defend against a
     *  hostile EPUB shipping a 10k-tag list. The list replaces any
     *  prior tag set for [bookId] — proto312 had no tag editor and
     *  this is the single source of truth for the alpha. (Sprint
     *  N3.5.) */
    @JavascriptInterface
    fun publishTags(json: String?) {
        if (bookId.isEmpty()) return
        if (json.isNullOrBlank() || json == "null") return
        val parsed: List<String> = try {
            Json.decodeFromString<List<String>>(json)
        } catch (_: Exception) {
            return
        }
        val capped = parsed.take(ReaderActivity.MAX_TAGS)
        appContext.spineApplicationScope.launch {
            LibraryStore.setTags(appContext, bookId, capped)
        }
    }

    /** Tap on the middle of the reader (handled JS-side in
     *  spine-host.mjs's tap-zone router). Flips the chrome
     *  visibility state on the Compose side. */
    @JavascriptInterface
    fun toggleChrome() {
        onChromeToggle()
    }

    /** Return the current reader theme colors AND format settings as
     *  a single JSON object the spine-host consumes to set in-iframe
     *  CSS. Read at call time so live theme/format switches see the
     *  next-most-recent value. */
    @JavascriptInterface
    fun getReaderThemeJson(): String {
        val snapshot = ThemePrefs.state.value
        val theme = SpineTheme.fromKey(snapshot.themeKey)
        val palette = SPINE_PALETTES[theme]!!
        fun hex(c: androidx.compose.ui.graphics.Color): String {
            val argb = c.toArgb()
            return String.format("#%06x", argb and 0xFFFFFF)
        }
        val typefaceKey = snapshot.typeface ?: ThemePrefs.DEFAULT_TYPEFACE
        val typefaceCss = ThemePrefs.TYPEFACE_OPTIONS
            .firstOrNull { it.first == typefaceKey }?.second
            ?: ThemePrefs.TYPEFACE_OPTIONS.first().second
        return Json.encodeToString(
            mapOf(
                // Single source of truth for the page color: same as
                // the outer Compose Box and the WebView's intrinsic
                // letterbox. Anything else and a seam shows when the
                // chromes hide. (0.3.22 unified Compose-side; 0.4.2
                // unified the iframe CSS to match.)
                "bg" to hex(palette.bg),
                "ink" to hex(palette.readerInk),
                "dim" to hex(palette.readerDim),
                "rule" to hex(palette.readerRule),
                "link" to hex(palette.link),
                "fontSizePx" to (snapshot.fontSizePx ?: ThemePrefs.DEFAULT_FONT_PX).toString(),
                "lineHeight" to (snapshot.lineHeight ?: ThemePrefs.DEFAULT_LINE_HEIGHT).toString(),
                "marginPct" to (snapshot.marginPct ?: ThemePrefs.DEFAULT_MARGIN).toString(),
                "fontFamily" to typefaceCss,
                // Reader-formatting toggles. spine-host's CSS apply
                // gates each rule on these (`true` only — anything
                // else is treated as off). UI to flip them lives in
                // a follow-up sprint; the prefs and bridge are wired
                // here so feature flags can ship without UI churn.
                // (Sprint N3.5.)
                "justify" to (snapshot.justify ?: ThemePrefs.DEFAULT_JUSTIFY).toString(),
                "hyphenate" to (snapshot.hyphenate ?: ThemePrefs.DEFAULT_HYPHENATE).toString(),
                "dropCap" to (snapshot.dropCap ?: ThemePrefs.DEFAULT_DROPCAP).toString(),
                "readerMode" to (snapshot.readerMode ?: ThemePrefs.DEFAULT_READER_MODE),
            ),
        )
    }
}

@Serializable
data class SelectionPayload(
    val engine: String,
    val schema: String,
    val locator: String,
    val anchorText: String,
    val before: String? = null,
    val after: String? = null,
)

@Serializable
data class LocatorPayload(
    val engine: String,
    val schema: String,
    val locator: String,
    /** 0..1 fraction of the book represented by this locator.
     *  Sourced from foliate's `relocate.detail.fraction` (or
     *  `percentage` on older bundles). Null when the spine-host
     *  side could not derive a fraction — Kotlin should suppress
     *  the % UI rather than display "0%". (Sprint N3.5.) */
    val percentage: Float? = null,
    val sectionLabel: String? = null,
    val sectionIndex: Int? = null,
    val totalSections: Int? = null,
)

/**
 * Flat representation of a TOC entry. Nested foliate-js TOC nodes are
 * flattened on the JS side with a `depth` counter so the Kotlin sheet
 * can render them as indented rows without rewalking the tree.
 */
@Serializable
data class TocItem(
    val label: String,
    val href: String,
    val depth: Int = 0,
)

private fun parseTocJson(json: String?): List<TocItem>? {
    if (json.isNullOrBlank() || json == "null") return null
    return try {
        Json.decodeFromString<List<TocItem>>(json)
    } catch (_: Exception) { null }
}

private fun parseSelection(json: String?): SelectionPayload? {
    if (json.isNullOrBlank() || json == "null") return null
    return try {
        Json.decodeFromString<SelectionPayload>(json)
    } catch (_: Exception) { null }
}

private fun parseLocator(json: String?): LocatorPayload? {
    if (json.isNullOrBlank() || json == "null") return null
    return try {
        Json.decodeFromString<LocatorPayload>(json)
    } catch (_: Exception) { null }
}

/**
 * Validates that [name] is a safe local filename for a book file.
 */
internal fun sanitizeBookFilename(name: String?): String? {
    if (name.isNullOrEmpty()) return null
    if (name == "." || name == "..") return null
    if (name.startsWith(".")) return null
    for (ch in name) {
        if (ch == '/' || ch == '\\' || ch == ' ') return null
        if (ch.code < 0x20) return null
    }
    if (name.contains("..")) return null
    if (!name.endsWith(".epub", ignoreCase = true)) return null
    return name
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ReaderRoot(
    title: String,
    filename: String,
    bookId: String,
    selectionFlow: StateFlow<SelectionPayload?>,
    locatorFlow: StateFlow<LocatorPayload?>,
    annotationTapFlow: StateFlow<String?>,
    tocFlow: StateFlow<List<TocItem>>,
    chromeFlow: StateFlow<Boolean>,
    onChromeToggle: () -> Unit,
    onChromeShow: () -> Unit,
    onWebViewReady: (WebView) -> Unit,
    onSelectionConsumed: () -> Unit,
    onAnnotationTapConsumed: () -> Unit,
    onClose: () -> Unit,
    pushHighlights: (List<Annotations.Highlight>) -> Unit,
    clearSelectionInJs: () -> Unit,
    jumpToLocator: (String) -> Unit,
    goToHref: (String) -> Unit,
    pageNext: () -> Unit,
    pagePrev: () -> Unit,
    makeBridge: (filename: String, bookId: String) -> SpineBridge,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val palette = LocalSpinePalette.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val selection by selectionFlow.collectAsState()
    val locator by locatorFlow.collectAsState()
    val annotationTap by annotationTapFlow.collectAsState()
    val toc by tocFlow.collectAsState()
    val prefs by ThemePrefs.state.collectAsState()
    var bookmarks by remember { mutableStateOf<List<Annotations.Bookmark>>(emptyList()) }
    var highlights by remember { mutableStateOf<List<Annotations.Highlight>>(emptyList()) }
    var sheetVisible by remember { mutableStateOf(false) }
    var tocSheetVisible by remember { mutableStateOf(false) }
    var displaySheetVisible by remember { mutableStateOf(false) }
    var helpVisible by remember { mutableStateOf(false) }
    // Chrome auto-hide: visible on entry, fades out after 4 s of no
    // taps, JS-side tap-zone-middle flips it via SpineBridge.toggleChrome
    // → onChromeToggle. Demo's 0.2.x behaviour.
    //
    // chromeInteractTick is bumped by every chrome control tap; we
    // re-key the LaunchedEffect on it so the 4s timer restarts when
    // the user fiddles with bookmark/TOC/display. The timer also
    // re-keys on every sheet visibility flip — sheet open suspends
    // the auto-hide; sheet close re-arms it. (design review
    // criticals #2 and #3.)
    val chromeVisible by chromeFlow.collectAsState()
    var chromeInteractTick by remember { mutableStateOf(0) }
    val onChromeInteract: () -> Unit = { chromeInteractTick++ }
    LaunchedEffect(chromeVisible, sheetVisible, tocSheetVisible, displaySheetVisible, chromeInteractTick) {
        if (!chromeVisible) return@LaunchedEffect
        if (sheetVisible || tocSheetVisible || displaySheetVisible) return@LaunchedEffect
        kotlinx.coroutines.delay(4000)
        // Re-check guard at fire time in case a sheet opened during
        // the delay (LaunchedEffect doesn't auto-cancel on guard
        // change once we're past the suspension).
        if (!sheetVisible && !tocSheetVisible && !displaySheetVisible) {
            onChromeToggle()
        }
    }

    LaunchedEffect(bookId) {
        if (bookId.isEmpty()) return@LaunchedEffect
        bookmarks = Annotations.listBookmarks(ctx, bookId)
        highlights = Annotations.listHighlights(ctx, bookId)
    }

    val isCurrentBookmarked = remember(bookmarks, locator) {
        val l = locator ?: return@remember false
        bookmarks.any { it.locator == l.locator }
    }

    LaunchedEffect(annotationTap) {
        val cfi = annotationTap ?: return@LaunchedEffect
        // Tap on an existing highlight surfaces it via the sheet.
        sheetVisible = true
        onAnnotationTapConsumed()
        // The highlight remains visible in-flow; nothing else to
        // do here. (A future N6.1 adds an Edit / Remove popover.)
        @Suppress("UNUSED_VARIABLE") val keep = cfi
    }

    // Box-stacked overlay layout. Chrome bars draw OVER the WebView via
    // `Modifier.align(...)`, consuming zero layout space. The WebView's
    // viewport never changes when chrome toggles, so foliate's
    // ResizeObserver doesn't re-columnize the page.
    //
    // 0.3.22: bg used everywhere (outer Box, WebView intrinsic, chrome
    // gradient). Previously chrome used palette.panel and book used
    // palette.bg — visible color seam. Reader is one continuous surface.
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.bg),
    ) {
        // The EpubResourceHandler caches open ZipFile handles per book
        // filename for the WebView's lifetime. Without an explicit close
        // path the file descriptors leak across activity teardown — a
        // budget device hitting the 1024-fd limit after ~10 reader opens.
        val resourceHandler = remember(filename) {
            EpubResourceHandler(LibraryStore.booksDir(ctx))
        }
        DisposableEffect(resourceHandler) {
            onDispose { resourceHandler.close() }
        }
        // Camera-cutout treatment is theme-dependent. The cutout itself
        // sits at y∈[cutoutTop, cutoutBottom] in screen coords, where
        // displayCutout's top inset is cutoutBottom (i.e., the smallest
        // y where it's safe to draw). On dark pages the camera-hole
        // disappears against palette.bg with no extra effort. On light
        // pages it's a visible "hole" in a bright margin — so we draw a
        // pure-black band over the cutout zone, hiding the hole behind
        // matching device-chassis colour.
        //
        // We always pad the WebView top by cutoutBottom + a tiny ergo
        // gap, regardless of theme — that keeps text out of the cutout
        // even when the band is invisible. The black band only adds
        // visual treatment for light themes; the layout doesn't change.
        val cutoutTopPad = WindowInsets.displayCutout.asPaddingValues().calculateTopPadding()
        val ergoPadDp = 2.dp
        val webViewTopPad = cutoutTopPad + ergoPadDp
        // Luminance threshold: palette.bg.luminance() returns 0..1
        // perceived luminance (BT.709). Dark themes (Dark/Midnight/
        // Noir/Stark, all ≤0.1) blend the cutout naturally; light
        // themes (Sepia ~0.7, Light ~0.85) need the black backdrop.
        val isDarkPage = palette.bg.luminance() < 0.5f
        // Device's rounded-corner radius (API 31+). Used to round the
        // page-surface's TOP corners on light themes so the top of the
        // screen mirrors the visual treatment of the bottom — chassis
        // (black) curving into the page surface.
        val view = LocalView.current
        val density = LocalDensity.current
        val cornerRadiusPx = if (android.os.Build.VERSION.SDK_INT >= 31) {
            view.rootWindowInsets
                ?.getRoundedCorner(android.view.RoundedCorner.POSITION_BOTTOM_LEFT)
                ?.radius
                ?: 0
        } else 0
        val cornerRadiusDp = with(density) { cornerRadiusPx.toDp() }
        androidx.compose.foundation.layout.BoxWithConstraints(
            modifier = Modifier.fillMaxSize(),
        ) {
            // Use bg (book page color) for the WebView's intrinsic
            // letterbox so the iframe-and-around region is one color.
            val panelArgb = palette.bg.toArgb()
            // Light-theme cutout cover: flat black band extending from
            // y=0 to the WebView's top. No rounded corners, no clipping
            // of the WebView. The device's hardware screen-corner mask
            // does the only rounding that's actually safe.
            if (!isDarkPage) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .fillMaxWidth()
                        .height(webViewTopPad)
                        .background(androidx.compose.ui.graphics.Color.Black),
                )
            }
            // Horizontal margin lives inside the iframe (foliate's
            // `margin` renderer attribute), not as a Compose padding,
            // so the page-turn animation slides text past the screen
            // edge instead of being clipped by the gutter. The bridge
            // delivers marginPct via getReaderThemeJson; spine-host
            // converts it to a percentage and feeds foliate.
            AndroidView(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(top = webViewTopPad),
                factory = { ctx ->
                    val wv = buildFoliateWebView(
                        context = ctx,
                        filename = filename,
                        bridge = makeBridge(filename, bookId),
                        resourceHandler = resourceHandler,
                    )
                    wv.setBackgroundColor(panelArgb)
                    onWebViewReady(wv)
                    wv
                },
                update = { wv -> wv.setBackgroundColor(panelArgb) },
                onRelease = { it.destroy() },
            )
            // Warmth + brightness overlays sit ABOVE the WebView but
            // BELOW the chrome bars, so the chrome's gradient is not
            // tinted by warmth and stays at its declared opacity.
            val warmthAlpha = (prefs.warmth ?: ThemePrefs.DEFAULT_WARMTH)
                .coerceIn(0f, ThemePrefs.MAX_WARMTH)
            if (warmthAlpha > 0f) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            androidx.compose.ui.graphics.Color(0xFFD9A55C)
                                .copy(alpha = warmthAlpha * ThemePrefs.WARMTH_PEAK_ALPHA),
                        ),
                )
            }
            val brightness = (prefs.brightness ?: ThemePrefs.DEFAULT_BRIGHTNESS)
                .coerceIn(ThemePrefs.MIN_BRIGHTNESS, 1f)
            if (brightness < 1f) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            androidx.compose.ui.graphics.Color.Black
                                .copy(alpha = 1f - brightness),
                        ),
                )
            }
            // Selection bar floats above brightness/warmth at the
            // bottom of the reader area.
            selection?.let { sel ->
                SelectionBar(
                    palette = palette,
                    text = sel.anchorText,
                    onHighlight = {
                        scope.launch {
                            Annotations.addHighlight(
                                ctx = ctx,
                                bookId = bookId,
                                engine = sel.engine,
                                schema = sel.schema,
                                locator = sel.locator,
                                anchorText = sel.anchorText,
                                before = sel.before,
                                after = sel.after,
                                color = "#f6c343",
                            )
                            highlights = Annotations.listHighlights(ctx, bookId)
                            pushHighlights(highlights)
                            onSelectionConsumed()
                            clearSelectionInJs()
                        }
                    },
                    onCopy = {
                        clipboard.setText(AnnotatedString(sel.anchorText))
                        clearSelectionInJs()
                        onSelectionConsumed()
                    },
                    onDismiss = {
                        clearSelectionInJs()
                        onSelectionConsumed()
                    },
                )
            }
        }

        // Top chrome bar — proto 312 layout: 4 cells, space-between row,
        // 48dp icon-button + caption stacks. Content-row sits below
        // statusBars inset so the camera notch stays clear; the gradient
        // backdrop only paints below the inset (soft fade, no Kindle
        // bleed-through).
        OverlayTopBar(
            modifier = Modifier.align(Alignment.TopCenter),
            visible = chromeVisible,
            palette = palette,
        ) {
            ProtoTopBar(
                palette = palette,
                bookTitle = title,
                bookmarked = isCurrentBookmarked,
                hasLocator = locator != null,
                onBack = onClose,
                onToggleBookmark = {
                    onChromeInteract()
                    val l = locator ?: return@ProtoTopBar
                    scope.launch {
                        if (isCurrentBookmarked) {
                            val match = bookmarks.firstOrNull { it.locator == l.locator }
                            if (match != null) Annotations.removeBookmark(ctx, match.id)
                        } else {
                            Annotations.addBookmark(
                                ctx = ctx,
                                bookId = bookId,
                                engine = l.engine,
                                schema = l.schema,
                                locator = l.locator,
                                anchorText = null,
                            )
                        }
                        bookmarks = Annotations.listBookmarks(ctx, bookId)
                    }
                },
                onHelp = { onChromeInteract(); helpVisible = true },
            )
        }

        // Bottom chrome bar — proto 312 layout: handle pill, caption row
        // (chapter | "Loc · pct" + version), action row (Prev | TOC |
        // Display | Notes | Next). Scrubber + SessionPanel deferred.
        OverlayBottomBar(
            modifier = Modifier.align(Alignment.BottomCenter),
            visible = chromeVisible,
            palette = palette,
        ) {
            ProtoBottomBar(
                palette = palette,
                locator = locator,
                tocAvailable = toc.isNotEmpty(),
                onPrevChapter = { onChromeInteract(); pagePrev() },
                onNextChapter = { onChromeInteract(); pageNext() },
                onOpenToc = { onChromeInteract(); tocSheetVisible = true },
                onOpenDisplay = { onChromeInteract(); displaySheetVisible = true },
                onOpenNotes = { onChromeInteract(); sheetVisible = true },
            )
        }
    }

    // Tap-zone help overlay — proto 312 had this on the "?" button.
    // Translucent full-screen visualization of left/center/right zones.
    if (helpVisible) {
        TapZoneHelpOverlay(
            palette = palette,
            onDismiss = { helpVisible = false },
        )
    }

    if (sheetVisible) {
        AnnotationsSheet(
            highlights = highlights,
            bookmarks = bookmarks,
            sheetState = rememberModalBottomSheetState(),
            onDismiss = { sheetVisible = false },
            onJump = { locatorString ->
                jumpToLocator(locatorString)
                sheetVisible = false
            },
            onRemoveHighlight = { id ->
                scope.launch {
                    Annotations.removeHighlight(ctx, id)
                    highlights = Annotations.listHighlights(ctx, bookId)
                    pushHighlights(highlights)
                }
            },
            onRemoveBookmark = { id ->
                scope.launch {
                    Annotations.removeBookmark(ctx, id)
                    bookmarks = Annotations.listBookmarks(ctx, bookId)
                }
            },
        )
    }
    if (tocSheetVisible) {
        TocSheet(
            entries = toc,
            currentSectionIndex = locator?.sectionIndex,
            sheetState = rememberModalBottomSheetState(),
            onDismiss = { tocSheetVisible = false },
            onPick = { href ->
                goToHref(href)
                tocSheetVisible = false
            },
        )
    }
    if (displaySheetVisible) {
        ReaderSettingsSheet(
            sheetState = rememberModalBottomSheetState(),
            onDismiss = { displaySheetVisible = false },
        )
    }
}

/**
 * Top chrome overlay slot. Wraps `content` in an AnimatedVisibility +
 * a vertical-gradient backdrop. The gradient bleeds edge-to-edge from
 * y=0 (so it visually flows behind the camera-notch area in immersive
 * mode), but `content()` itself is padded by the statusBars inset so
 * the readable text and icons sit below the cutout.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OverlayTopBar(
    modifier: Modifier = Modifier,
    visible: Boolean,
    palette: SpinePalette,
    content: @Composable () -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn() + slideInVertically(initialOffsetY = { -it }),
        exit = fadeOut() + slideOutVertically(targetOffsetY = { -it }),
        modifier = modifier,
    ) {
        // Chrome BG extends edge-to-edge from y=0 (the AnimatedVisibility
        // slide-in origin), so the bar visibly slides out from the top
        // of the screen rather than appearing decapitated. CONTENT is
        // padded down by the camera/status-bar inset so icons and title
        // sit below the punch-hole.
        //
        // Android reports the exact cutout dimensions per device via
        // `WindowInsets.displayCutout` — derived from the device's
        // hardware cutout config, not estimated. The .union below
        // takes the max of cutout vs status-bar height so we clear
        // both. (0.4.1 fix: dropped a 32dp hardcoded floor that was
        // pushing chrome content well below the actual punch-hole on
        // Pixel 9 Pro and similar small-cutout devices. The floor
        // dated to a pre-immersive build where insets sometimes
        // collapsed; current Android honors the cutout consistently.)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.bg),
        ) {
            // Tuck chrome content up against the cutout (or against the
            // screen top on no-cutout devices) — whichever is lower.
            // Dropping statusBarsIgnoringVisibility from the union: on
            // cutout phones the status bar reports its own buffer below
            // the cutout (~60dp on Pixel 9 Pro vs 50dp cutout), which
            // pushed chrome content ~10dp lower than necessary.
            Box(
                modifier = Modifier
                    .windowInsetsPadding(WindowInsets.displayCutout),
            ) {
                content()
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(androidx.compose.ui.unit.Dp.Hairline)
                    .background(palette.border)
            )
        }
    }
}

/**
 * Bottom chrome overlay slot. Mirrors `OverlayTopBar` — gradient runs
 * the other way (transparent at top, opaque at bottom) and the inset
 * padding is `WindowInsets.navigationBars` so the content row sits
 * above the gesture-nav strip.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OverlayBottomBar(
    modifier: Modifier = Modifier,
    visible: Boolean,
    palette: SpinePalette,
    content: @Composable () -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn() + slideInVertically(initialOffsetY = { it }),
        exit = fadeOut() + slideOutVertically(targetOffsetY = { it }),
        modifier = modifier,
    ) {
        // BG to bottom edge for slide-in continuity; content padded by
        // navigationBarsIgnoringVisibility so it clears the gesture
        // strip even in immersive.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.bg),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(androidx.compose.ui.unit.Dp.Hairline)
                    .background(palette.border)
            )
            Box(
                modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBarsIgnoringVisibility),
            ) {
                content()
            }
        }
    }
}

/**
 * Reusable icon-button + caption stack matching proto 312's IconBtn.
 * Used in the top bar (48dp width) and bottom action row (flex-1).
 */
@Composable
private fun ChromeIconBtn(
    palette: SpinePalette,
    glyph: String,
    caption: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    glyphSize: androidx.compose.ui.unit.TextUnit = 18.sp,
    accentGlyph: Boolean = false,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = modifier
            .padding(vertical = 6.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.32f),
    ) {
        Text(
            text = glyph,
            color = if (accentGlyph) palette.accent else palette.text,
            fontFamily = FontFamily.Serif,
            fontSize = glyphSize,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = caption,
            color = palette.textDim,
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp,
            letterSpacing = 0.6.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

/**
 * Proto 312 top bar: 4 cells, space-between row.
 *   [▦ Back] [book title (italic serif) + "Tap for book ▾"] [★/☆ Mark] [? Help]
 */
@Composable
private fun ProtoTopBar(
    palette: SpinePalette,
    bookTitle: String,
    bookmarked: Boolean,
    hasLocator: Boolean,
    onBack: () -> Unit,
    onToggleBookmark: () -> Unit,
    onHelp: () -> Unit,
) {
    // Faithful proto 312 single-row layout, scaled 2× to satisfy
    // user-requested visual presence: 64dp icon cells (was 48), 28sp
    // glyphs (was 22), 16dp vertical padding (was 6+10), 10sp captions
    // (was 8). Title scales to 18sp italic-serif (was 13).
    // Title is screen-centered via Box absolute-alignment, so a 1-vs-2
    // button asymmetry on either side doesn't bias it left of centre.
    // Buttons sit at CenterStart / CenterEnd; title column at Center
    // with horizontal padding equal to the wider button cluster so its
    // text never overlaps the icons.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 16.dp),
    ) {
        ChromeIconBtn(
            palette = palette,
            glyph = "▦",
            caption = "BACK",
            onClick = onBack,
            glyphSize = 28.sp,
            modifier = Modifier
                .align(Alignment.CenterStart)
                .size(width = 64.dp, height = 64.dp),
        )
        Column(
            modifier = Modifier
                .align(Alignment.Center)
                // Reserve space for the wider right cluster (2× 64dp
                // buttons + small gap = ~136dp) on both sides so the
                // title's centre-of-mass is screen centre.
                .padding(horizontal = 144.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = bookTitle,
                color = palette.text,
                fontFamily = FontFamily.Serif,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "TAP FOR BOOK ▾",
                color = palette.textDim,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                letterSpacing = 0.8.sp,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Row(
            modifier = Modifier.align(Alignment.CenterEnd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
        ChromeIconBtn(
            palette = palette,
            glyph = if (bookmarked) "★" else "☆",
            caption = "MARK",
            onClick = onToggleBookmark,
            enabled = hasLocator,
            glyphSize = 26.sp,
            accentGlyph = bookmarked,
            modifier = Modifier.size(width = 64.dp, height = 64.dp),
        )
        ChromeIconBtn(
            palette = palette,
            glyph = "?",
            caption = "HELP",
            onClick = onHelp,
            glyphSize = 28.sp,
            modifier = Modifier.size(width = 64.dp, height = 64.dp),
        )
        }
    }
}

/**
 * Proto 312 bottom bar: stacked sub-rows.
 *   1. Handle pill (visual)
 *   2. Caption row (chapter | "Loc · NN%" + version)
 *   3. Action row (Prev | TOC | Display | Notes | Next)
 * Scrubber + SessionPanel handle gesture deferred until backing JS bridge
 * lands.
 */
@Composable
private fun ProtoBottomBar(
    palette: SpinePalette,
    locator: LocatorPayload?,
    tocAvailable: Boolean,
    onPrevChapter: () -> Unit,
    onNextChapter: () -> Unit,
    onOpenToc: () -> Unit,
    onOpenDisplay: () -> Unit,
    onOpenNotes: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp)) {
        // Handle pill
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(width = 56.dp, height = 4.dp)
                    .background(palette.textDim.copy(alpha = 0.5f), RoundedCornerShape(2.dp)),
            )
        }
        // Scrubber — visual placeholder only. JS bridge for goToFraction
        // lands in a follow-up; the fill width tracks section progress
        // but the user can't drag yet. Track + fill, no thumb head for
        // simplicity (proto 312 had a thumb but it's the most fragile
        // bit to port without the seek hookup).
        run {
            val sectionIndex = locator?.sectionIndex
            val totalSections = locator?.totalSections
            val fraction = if (sectionIndex != null && totalSections != null && totalSections > 0) {
                ((sectionIndex + 1).toFloat() / totalSections.toFloat()).coerceIn(0f, 1f)
            } else 0f
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(palette.border, RoundedCornerShape(2.dp)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction.coerceAtLeast(0.001f))
                            .height(4.dp)
                            .background(palette.accent, RoundedCornerShape(2.dp)),
                    )
                }
            }
        }
        // Caption row
        val sectionLabel = locator?.sectionLabel
        val sectionIndex = locator?.sectionIndex
        val totalSections = locator?.totalSections
        val captionText = when {
            sectionLabel != null -> sectionLabel
            sectionIndex != null && totalSections != null && totalSections > 0 ->
                "Section ${sectionIndex + 1} of $totalSections"
            else -> "READING"
        }
        val pct = if (sectionIndex != null && totalSections != null && totalSections > 0) {
            ((sectionIndex + 1) * 100) / totalSections
        } else null
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = captionText.uppercase(),
                color = palette.textDim,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                letterSpacing = 0.8.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 8.dp),
            )
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = if (pct != null) "Sec ${sectionIndex!! + 1} · $pct%" else "—",
                    color = palette.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "v${com.thereprocase.spine.BuildConfig.VERSION_NAME}",
                    color = palette.textDim.copy(alpha = 0.55f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp,
                    letterSpacing = 0.6.sp,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        // Hairline divider
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 6.dp)
                .height(androidx.compose.ui.unit.Dp.Hairline)
                .background(palette.textDim.copy(alpha = 0.2f)),
        )
        // Action row — 5 cells, evenly spaced. Bigger padding + bigger
        // glyphs to push the bar to ~2× proto 312 height.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChromeIconBtn(palette, "⟨", "PREV", onPrevChapter, glyphSize = 24.sp, modifier = Modifier.weight(1f))
            ChromeIconBtn(palette, "☰", "TOC", onOpenToc, glyphSize = 24.sp, modifier = Modifier.weight(1f), enabled = tocAvailable)
            ChromeIconBtn(palette, "Aa", "DISPLAY", onOpenDisplay, glyphSize = 22.sp, modifier = Modifier.weight(1f))
            ChromeIconBtn(palette, "✎", "NOTES", onOpenNotes, glyphSize = 22.sp, modifier = Modifier.weight(1f))
            ChromeIconBtn(palette, "⟩", "NEXT", onNextChapter, glyphSize = 24.sp, modifier = Modifier.weight(1f))
        }
    }
}

/**
 * Tap-zone help overlay — proto 312 visualization. Three-column band:
 * left third = prev, center = chrome toggle, right = next. Tap anywhere
 * to dismiss.
 */
@Composable
private fun TapZoneHelpOverlay(
    palette: SpinePalette,
    onDismiss: () -> Unit,
) {
    val ink = palette.text
    val accent = palette.accent
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.panel.copy(alpha = 0.85f))
            .clickable(onClick = onDismiss),
    ) {
        Row(modifier = Modifier.fillMaxSize()) {
            HelpZone(
                modifier = Modifier.weight(1f).fillMaxSize(),
                fill = accent.copy(alpha = 0.18f),
                ink = ink,
                bigGlyph = "‹",
                title = "Previous page",
                subtitle = "Tap left third",
            )
            HelpZone(
                modifier = Modifier.weight(1f).fillMaxSize(),
                fill = ink.copy(alpha = 0.10f),
                ink = ink,
                bigGlyph = "•••",
                title = "Show / hide chrome",
                subtitle = "Tap center",
            )
            HelpZone(
                modifier = Modifier.weight(1f).fillMaxSize(),
                fill = accent.copy(alpha = 0.18f),
                ink = ink,
                bigGlyph = "›",
                title = "Next page",
                subtitle = "Tap right third",
            )
        }
    }
}

@Composable
private fun HelpZone(
    modifier: Modifier,
    fill: androidx.compose.ui.graphics.Color,
    ink: androidx.compose.ui.graphics.Color,
    bigGlyph: String,
    title: String,
    subtitle: String,
) {
    Column(
        modifier = modifier.background(fill),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = bigGlyph,
            color = ink,
            fontFamily = FontFamily.Serif,
            fontSize = 80.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = title,
            color = ink,
            fontFamily = FontFamily.Serif,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 12.dp),
        )
        Text(
            text = subtitle,
            color = ink.copy(alpha = 0.7f),
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            letterSpacing = 0.6.sp,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

/**
 * Bottom navigation bar for the reader: prev page | chapter label /
 * progress | next page | TOC. Uses the chrome palette so it sits over
 * the reader content as a frame; tapping a button calls into JS via
 * `spineHost.pagePrev / pageNext / goToHref`.
 */
@Composable
private fun ReaderBottomBar(
    palette: SpinePalette,
    locator: LocatorPayload?,
    tocAvailable: Boolean,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onOpenToc: () -> Unit,
) {
    val sectionLabel = locator?.sectionLabel
    val sectionIndex = locator?.sectionIndex
    val totalSections = locator?.totalSections
    val progressLine = when {
        sectionLabel != null -> sectionLabel
        sectionIndex != null && totalSections != null && totalSections > 0 ->
            "Section ${sectionIndex + 1} of $totalSections"
        else -> ""
    }
    Surface(
        color = palette.panel,
        tonalElevation = 4.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.NavigateBefore,
                    contentDescription = "Previous page",
                    tint = palette.text,
                )
            }
            Box(
                modifier = Modifier.weight(1f),
                contentAlignment = androidx.compose.ui.Alignment.Center,
            ) {
                Text(
                    text = progressLine,
                    color = palette.textMid,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onNext) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.NavigateNext,
                    contentDescription = "Next page",
                    tint = palette.text,
                )
            }
            IconButton(onClick = onOpenToc, enabled = tocAvailable) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.List,
                    contentDescription = "Table of contents",
                    tint = if (tocAvailable) palette.accent else palette.textDim,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TocSheet(
    entries: List<TocItem>,
    currentSectionIndex: Int?,
    sheetState: androidx.compose.material3.SheetState,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val palette = LocalSpinePalette.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = palette.panel,
    ) {
        if (entries.isEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp),
            ) {
                Text(
                    text = "No table of contents",
                    color = palette.textMid,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            return@ModalBottomSheet
        }
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            item {
                Text(
                    text = "TABLE OF CONTENTS",
                    color = palette.accent,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            items(entries, key = { "${it.depth}|${it.href}" }) { entry ->
                TocRow(entry = entry, onPick = onPick)
            }
        }
    }
}

@Composable
private fun TocRow(
    entry: TocItem,
    onPick: (String) -> Unit,
) {
    val palette = LocalSpinePalette.current
    val indent = (entry.depth.coerceIn(0, 5) * 12).dp
    TextButton(
        onClick = { onPick(entry.href) },
        modifier = Modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 12.dp + indent,
            end = 12.dp,
            top = 6.dp,
            bottom = 6.dp,
        ),
    ) {
        Text(
            text = entry.label,
            color = palette.text,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SelectionBar(
    palette: SpinePalette,
    text: String,
    onHighlight: () -> Unit,
    onCopy: () -> Unit,
    onDismiss: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(bottom = 24.dp, start = 16.dp, end = 16.dp),
        contentAlignment = androidx.compose.ui.Alignment.BottomCenter,
    ) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = palette.panel,
            tonalElevation = 4.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    text = if (text.length > 80) text.take(78) + "…" else text,
                    color = palette.textMid,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SelectionAction(
                        icon = Icons.Filled.Brush,
                        label = "Highlight",
                        tint = palette.accent,
                        onClick = onHighlight,
                    )
                    SelectionAction(
                        icon = Icons.Filled.ContentCopy,
                        label = "Copy",
                        tint = palette.text,
                        onClick = onCopy,
                    )
                    androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismiss) { Text("Close", color = palette.textMid) }
                }
            }
        }
    }
}

@Composable
private fun SelectionAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    TextButton(onClick = onClick) {
        Icon(imageVector = icon, contentDescription = label, tint = tint)
        Text(text = label, color = tint, modifier = Modifier.padding(start = 6.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AnnotationsSheet(
    highlights: List<Annotations.Highlight>,
    bookmarks: List<Annotations.Bookmark>,
    sheetState: androidx.compose.material3.SheetState,
    onDismiss: () -> Unit,
    onJump: (String) -> Unit,
    onRemoveHighlight: (String) -> Unit,
    onRemoveBookmark: (String) -> Unit,
) {
    val palette = LocalSpinePalette.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = palette.panel,
    ) {
        // LazyColumn so a book with hundreds of highlights doesn't
        // measure / lay out / draw every row on sheet open. The
        // previous Column { items.forEach { ... } } walked the full
        // list eagerly on first composition, jank-spiking sheet open.
        // (code review N1-N6 warning #21.)
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(
                    text = "ANNOTATIONS",
                    color = palette.accent,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            if (highlights.isEmpty() && bookmarks.isEmpty()) {
                item {
                    Text(
                        text = "No highlights or bookmarks yet. Long-press text to highlight; tap the bookmark icon at the top to mark a page.",
                        color = palette.textMid,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            if (bookmarks.isNotEmpty()) {
                item {
                    Text(
                        text = "BOOKMARKS",
                        color = palette.textDim,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                items(bookmarks, key = { it.id }) { bm ->
                    AnnotationRow(
                        primary = "Bookmark",
                        secondary = bm.anchorText ?: bm.locator.take(40),
                        onTap = { onJump(bm.locator) },
                        onRemove = { onRemoveBookmark(bm.id) },
                    )
                }
            }
            if (highlights.isNotEmpty()) {
                item {
                    Text(
                        text = "HIGHLIGHTS",
                        color = palette.textDim,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                items(highlights, key = { it.id }) { h ->
                    AnnotationRow(
                        primary = h.anchorText.take(80),
                        secondary = if (h.anchorText.length > 80) "…" else null,
                        onTap = { onJump(h.locator) },
                        onRemove = { onRemoveHighlight(h.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun AnnotationRow(
    primary: String,
    secondary: String?,
    onTap: () -> Unit,
    onRemove: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(end = 8.dp),
        ) {
            TextButton(
                onClick = onTap,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            ) {
                Text(
                    text = primary,
                    color = palette.text,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (secondary != null) {
                Text(
                    text = secondary,
                    color = palette.textDim,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        TextButton(onClick = onRemove) {
            Text("Remove", color = palette.alert, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun UnopenableBookScreen(rawFilename: String?) {
    val palette = LocalSpinePalette.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
    ) {
        Text(
            text = "Cannot open book",
            color = palette.text,
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            text = "This book's filename is not safe to open in the reader.",
            color = palette.textMid,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 12.dp),
        )
        Text(
            text = "Filename: ${rawFilename ?: "<missing>"}",
            color = palette.textDim,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/**
 * Shown when the reader was launched for a library entry whose
 * backing `.epub` is no longer on disk (deleted, SD card pulled,
 * partial app-data clear). Honest copy + a clean exit instead of the
 * reader's "Malformed or unsupported EPUB" error which is misleading
 * — the book itself is fine; the file is gone.
 * (code review N1-N6 critical #8.)
 */
@Composable
private fun MissingBookScreen(
    title: String,
    onRemoveAndClose: () -> Unit,
    onClose: () -> Unit,
) {
    val palette = LocalSpinePalette.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Book not on this device",
            color = palette.text,
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            text = "\"$title\" is no longer on this device. The library still has the entry, but the file is gone — possibly deleted by another app, removed from the SD card, or cleared.",
            color = palette.textMid,
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            text = "You can remove the entry from your library, or close this screen and try again later.",
            color = palette.textDim,
            style = MaterialTheme.typography.bodySmall,
        )
        Button(
            onClick = onRemoveAndClose,
            colors = ButtonDefaults.buttonColors(
                containerColor = palette.alert,
                contentColor = palette.inkInvert,
            ),
        ) { Text("Remove from library") }
        TextButton(onClick = onClose) { Text("Close", color = palette.text) }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun buildFoliateWebView(
    context: android.content.Context,
    filename: String,
    bridge: SpineBridge,
    resourceHandler: EpubResourceHandler,
): WebView {
    val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    if (BuildConfig.DEBUG) {
        WebView.setWebContentsDebuggingEnabled(true)
    }

    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )

        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
        }

        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url
                val path = url.encodedPath ?: ""
                if (url.host == ASSETS_HOST && path.startsWith(BOOK_PREFIX)) {
                    val sub = path.removePrefix(BOOK_PREFIX)
                    val response = resourceHandler.handle(sub, request.method)
                    android.util.Log.d(
                        "ReaderWeb",
                        "intercept book ${request.method} $sub → ${if (response == null) "null (404)" else "ok"}",
                    )
                    return response
                }
                if (url.host == ASSETS_HOST) {
                    android.util.Log.d("ReaderWeb", "intercept asset ${request.method} $path")
                }
                return assetLoader.shouldInterceptRequest(url)
            }

            // Block every top-frame navigation that doesn't target the
            // appassets host. Without this, malicious JS inside an EPUB
            // can navigate the WebView to `intent://...`, `market://`,
            // `javascript:`, or another origin, escaping the resource
            // sandbox and potentially launching arbitrary activities.
            // (code review N1-N6 critical #2.)
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val scheme = url.scheme?.lowercase()
                val host = url.host
                // Allow only https://appassets.androidplatform.net/...
                if (scheme == "https" && host == ASSETS_HOST) return false
                android.util.Log.w(
                    "ReaderActivity",
                    "blocked navigation to ${request.url} (scheme=$scheme host=$host)",
                )
                return true
            }
        }

        // Block popup windows entirely — onCreateWindow returning null
        // tells WebView "do not create a new window for this request,"
        // which neutralises window.open() and target="_blank" links
        // from inside an EPUB. Also forward JS console output to
        // logcat under tag "ReaderWebJS" so a real-device smoke can
        // be debugged via `adb logcat -s ReaderWebJS:V` without
        // attaching chrome devtools.
        webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?,
            ): Boolean = false

            override fun onConsoleMessage(
                msg: android.webkit.ConsoleMessage,
            ): Boolean {
                val level = when (msg.messageLevel()) {
                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> "E"
                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> "W"
                    android.webkit.ConsoleMessage.MessageLevel.LOG -> "I"
                    android.webkit.ConsoleMessage.MessageLevel.DEBUG -> "D"
                    else -> "I"
                }
                android.util.Log.println(
                    when (level) {
                        "E" -> android.util.Log.ERROR
                        "W" -> android.util.Log.WARN
                        "D" -> android.util.Log.DEBUG
                        else -> android.util.Log.INFO
                    },
                    "ReaderWebJS",
                    "[$level] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})",
                )
                return true
            }
        }

        addJavascriptInterface(bridge, "SpineBridge")

        // Cache-bust by versionCode so WebView's disk cache always picks
        // up the freshly-vendored spine-host.mjs / paginator.js / etc
        // after every APK install. Without this, foliate JS edits can
        // ship in the APK but stay invisible until the user clears app
        // data. (0.3.22 added this after a banner-suppression patch
        // was masked by stale cached JS.)
        val v = com.thereprocase.spine.BuildConfig.VERSION_CODE
        loadUrl("https://appassets.androidplatform.net/assets/foliate/index.html?v=$v")
    }
}

private const val ASSETS_HOST = "appassets.androidplatform.net"
private const val BOOK_PREFIX = "/book/"

internal class EpubResourceHandler(
    private val booksDir: File,
) {

    private val zipCache = ConcurrentHashMap<String, ZipFile>()

    /**
     * Drain the cache, closing every cached [ZipFile]. Idempotent;
     * tolerates being called more than once. Wired through a
     * [DisposableEffect] in the reader composable so descriptors are
     * released when the WebView leaves the composition (config
     * change recreation, activity finish, navigation away).
     * (code review N1-N6 critical #4.)
     */
    fun close() {
        val snapshot = zipCache.values.toList()
        zipCache.clear()
        for (zip in snapshot) {
            try { zip.close() } catch (_: Exception) {}
        }
    }

    fun handle(path: String, method: String): WebResourceResponse? {
        val slashIdx = path.indexOf('/')
        if (slashIdx <= 0) {
            android.util.Log.w("EpubRes", "reject: no slash in '$path'")
            return notFound()
        }
        val filename = path.substring(0, slashIdx)
        val resourcePath = path.substring(slashIdx + 1)
        if (filename.contains("..") || resourcePath.contains("..")) {
            android.util.Log.w("EpubRes", "reject: traversal in '$path'")
            return notFound()
        }
        if (!filename.endsWith(".epub")) {
            android.util.Log.w("EpubRes", "reject: not .epub '$filename'")
            return notFound()
        }

        val zip = getOrOpenZip(filename) ?: run {
            android.util.Log.w("EpubRes", "reject: getOrOpenZip null for '$filename' (booksDir=${booksDir.absolutePath})")
            return notFound()
        }
        val entry = zip.getEntry(resourcePath) ?: run {
            android.util.Log.d("EpubRes", "404: zip entry missing '$resourcePath' in '$filename'")
            return notFound()
        }
        val mime = guessMimeType(resourcePath)

        val size = entry.size
        val headers: MutableMap<String, String> = mutableMapOf(
            "Cache-Control" to "no-store",
        )
        if (size >= 0) {
            headers["Content-Length"] = size.toString()
        }

        val isHead = method.equals("HEAD", ignoreCase = true)
        val body = if (isHead) {
            ByteArrayInputStream(ByteArray(0))
        } else {
            zip.getInputStream(entry)
        }

        return WebResourceResponse(
            mime,
            null,
            200,
            "OK",
            headers,
            body,
        )
    }

    private fun getOrOpenZip(filename: String): ZipFile? {
        zipCache[filename]?.let { return it }
        val file = File(booksDir, filename)
        if (!file.isFile) {
            android.util.Log.w(
                "EpubRes",
                "open: file not found ${file.absolutePath} (exists=${file.exists()}, length=${file.length()})",
            )
            return null
        }
        val opened = try {
            ZipFile(file)
        } catch (e: Exception) {
            android.util.Log.w(
                "EpubRes",
                "open: ZipFile threw on ${file.absolutePath}: ${e.javaClass.simpleName}: ${e.message}",
            )
            return null
        }
        val existing = zipCache.putIfAbsent(filename, opened)
        return if (existing == null) {
            android.util.Log.d("EpubRes", "open: cached new ZipFile $filename")
            opened
        } else {
            opened.close()
            existing
        }
    }

    /**
     * Synthetic 404 response for missing zip entries / invalid paths.
     * Returning null from [handle] would make WebView raise a hard
     * `TypeError: Failed to fetch` on the JS side, which foliate-js
     * can't distinguish from "the network is down." A proper
     * `WebResourceResponse(status=404)` resolves the fetch with
     * `r.ok=false, r.status=404`, which the JS loadText handles
     * gracefully by returning null (the EPUB spec idiom for optional
     * files like META-INF/encryption.xml).
     */
    private fun notFound(): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            404,
            "Not Found",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )

    private fun guessMimeType(path: String): String =
        when (path.substringAfterLast('.', "").lowercase()) {
            "xhtml", "html", "htm" -> "application/xhtml+xml"
            "xml", "opf", "ncx" -> "application/xml"
            "css" -> "text/css"
            "js", "mjs" -> "application/javascript"
            "json" -> "application/json"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "webp" -> "image/webp"
            "otf" -> "font/otf"
            "ttf" -> "font/ttf"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
}
