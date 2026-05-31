// Reader screen — epubjs-in-WebView. The bytes are read from disk as base64,
// shipped to the WebView via injectJavaScript, rendered by epubjs. Theme +
// font + pagination settings are pushed down whenever prefs change. Tap-zones
// in the WebView decide left/center/right; center toggles chrome, edges page.

import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  type AppStateStatus,
  Dimensions,
  NativeModules,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  PinchGestureHandler,
  State as GHState,
  type PinchGestureHandlerGestureEvent,
  type PinchGestureHandlerStateChangeEvent,
} from "react-native-gesture-handler";

import { useLibrary } from "../../src/store/library";
import { usePrefs } from "../../src/store/prefs";
import { BOOKS_DIR, bookFilePath } from "../../src/storage";
import { FONTS } from "../../src/themes";
import { shareFileName } from "../../src/util/shareFileName";

interface SpineNativeShare {
  shareFile?: (
    path: string,
    mimeType: string,
    title: string,
    displayName?: string | null,
  ) => Promise<boolean>;
  setNavBarHidden?: (hidden: boolean) => Promise<boolean>;
}
const SpineZip = NativeModules.SpineZip as SpineNativeShare | undefined;

// Local shareFileName helper extracted to src/util/shareFileName.ts in 0.2.19;
// the prior in-file regex had a malformed character range that ate hyphens.
import { useReaderTheme } from "../../src/ui/useTheme";
import { READER_HTML_BASE64 } from "../../src/reader/html";
import {
  buildInjectScript,
  settingsToPayload,
  type SelectionRect,
  type TocItem,
  type WebToNative,
} from "../../src/reader/messages";
import { ReaderChrome } from "../../src/reader/ReaderChrome";
import { ReaderSettingsSheet } from "../../src/reader/ReaderSettingsSheet";
import { TocSheet } from "../../src/reader/TocSheet";
import { BookPanel } from "../../src/reader/BookPanel";
import { SessionPanel } from "../../src/reader/SessionPanel";
import { TapZoneHelpOverlay } from "../../src/reader/TapZoneHelpOverlay";
import { SelectionBar } from "../../src/reader/SelectionBar";
import { AnnotationsSheet } from "../../src/reader/AnnotationsSheet";
import { DictionarySheet } from "../../src/reader/DictionarySheet";
import { exportAnnotationsJson } from "../../src/storage/export";

// RN Hermes ships globalThis.atob since 0.74+. The reader HTML is ASCII so a
// straight atob is enough — no UTF-8 decoding needed.
const READER_HTML = globalThis.atob(READER_HTML_BASE64);
const LARGE_BOOK_BYTES = 35 * 1024 * 1024;
const MAX_EAGER_OPEN_BYTES = 120 * 1024 * 1024;

export default function ReaderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useReaderTheme();
  const { id, temp } = useLocalSearchParams<{ id: string; temp?: string }>();
  // `temp=1` means this book was created by a single-EPUB share intent
  // where the user picked "Read once" — we keep the record in the
  // library only for the duration of the read, then delete it on
  // unmount so it never appears in the grid.
  const isTemporary = temp === "1";
  const book = useLibrary((s) => s.books.find((b) => b.id === id));
  const setProgress = useLibrary((s) => s.setProgress);
  const setReadingPosition = useLibrary((s) => s.setReadingPosition);
  const deleteBook = useLibrary((s) => s.deleteBook);
  const settings = usePrefs((s) => s.reader);
  const patchReader = usePrefs((s) => s.patchReader);
  const lastHighlightColor = usePrefs((s) => s.lastHighlightColor);
  const setLastHighlightColor = usePrefs((s) => s.setLastHighlightColor);
  const addHighlight = useLibrary((s) => s.addHighlight);
  const updateHighlight = useLibrary((s) => s.updateHighlight);
  const removeHighlight = useLibrary((s) => s.removeHighlight);
  const toggleBookmark = useLibrary((s) => s.toggleBookmark);
  const removeBookmark = useLibrary((s) => s.removeBookmark);
  // CRITICAL: select the WHOLE arrays from the store with a stable
  // identity, then filter via useMemo. Returning `s.highlights.filter(...)`
  // directly from the selector creates a fresh array reference every
  // render — Zustand's Object.is equality treats that as a state
  // change, the component re-renders, the selector runs again, fresh
  // array, re-render — an infinite loop that prevents the WebView
  // from ever firing its boot event. Same pattern for bookmarks.
  const allHighlights = useLibrary((s) => s.highlights);
  const allBookmarks = useLibrary((s) => s.bookmarks);
  const bookHighlights = useMemo(
    () => (book ? allHighlights.filter((h) => h.bookId === book.id) : []),
    [allHighlights, book?.id],
  );
  const bookBookmarks = useMemo(
    () => (book ? allBookmarks.filter((b) => b.bookId === book.id) : []),
    [allBookmarks, book?.id],
  );

  const webRef = useRef<WebView>(null);
  const booted = useRef(false);
  const opened = useRef(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [bookPanelOpen, setBookPanelOpen] = useState(false);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [annotationsTab, setAnnotationsTab] = useState<"highlights" | "bookmarks">(
    "highlights",
  );
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryWord, setDictionaryWord] = useState<string | null>(null);
  // Active text selection state. Posted by reader-bootstrap.js whenever
  // the user drag-selects or long-presses a word. Drives the upcoming
  // SelectionBar (P3) and dictionary lookup (P7). When non-null, the
  // PanResponder yields so the WebView can extend the selection without
  // the page-turn handler stealing the gesture.
  interface ActiveSelection {
    text: string;
    cfiRange: string;
    textBefore: string;
    textAfter: string;
    rect: SelectionRect | null;
    /** "drag" = user dragged a range, "longpress" = single word from
     * a hold-down (the bootstrap programmatically selected it). The
     * SelectionBar shows the same buttons either way; downstream
     * (P7's dictionary sheet) cares because longpress on a single
     * word is the canonical lookup gesture. */
    source: "drag" | "longpress";
  }
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);
  // Debug instrumentation kept compiled-out: when DEBUG_LONGPRESS is
  // true the green overlay returns and bootstrap `debug` events are
  // surfaced. Flip this to chase the next gesture-stack bug; flip
  // back to false before any user-facing build.
  const DEBUG_LONGPRESS = false;
  const pushDebug = useCallback((_m: string) => {
    // no-op when DEBUG_LONGPRESS=false. The bootstrap still emits
    // `debug` messages — they're routed to onMessage which calls
    // pushDebug — but they end here. No runtime cost beyond a fn
    // call.
  }, []);
  const selectionActiveRef = useRef(false);
  selectionActiveRef.current = activeSelection !== null;
  // Cheat-up: when the active selection lives in the lower half of
  // the viewport, the SelectionBar's bottom-pinned UI would obscure
  // the very text the user is trying to act on. Push the iframe up
  // by enough to put the selection top in the upper half. Restore
  // on dismiss. Effect is keyed off activeSelection's rect.
  useEffect(() => {
    const { height: H } = Dimensions.get("window");
    const rect = activeSelection?.rect;
    // Heuristic: if selection STARTS below 45% of viewport, slide
    // up by the amount needed to bring its top to ~30% of viewport.
    // Capped so we never push the top of the page off the screen.
    let delta = 0;
    if (rect) {
      const triggerY = H * 0.45;
      const targetY = H * 0.3;
      if (rect.top > triggerY) {
        delta = Math.min(rect.top - targetY, H * 0.4);
      }
    }
    try {
      webRef.current?.injectJavaScript(
        buildInjectScript({ type: "cheatUp", delta }),
      );
    } catch {
      /* swallow */
    }
    // No cleanup — the next effect run (rect change OR cleared
    // selection) will send delta=0 if appropriate, and unmount
    // doesn't need to restore since the WebView is going away too.
  }, [activeSelection]);

  // Clear selection on the RN side AND ask the WebView to drop its
  // visible selection. Used by the SelectionBar's ✕, chrome toggle,
  // page turn, AppState→background, hardware back. Centralised so
  // every dismissal path stays in sync.
  const dismissSelection = useCallback(() => {
    if (!selectionActiveRef.current) return;
    setActiveSelection(null);
    try {
      webRef.current?.injectJavaScript(
        buildInjectScript({ type: "clearSelection" }),
      );
    } catch {
      /* swallow */
    }
  }, []);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [percentage, setPercentage] = useState(book?.progress ?? 0);
  // Latest CFI as reported by the rendition. Used to compute the
  // "bookmarked" state on the top-chrome bookmark button + dog-ear
  // pin. Distinct from book.lastCfi because book is from the store
  // snapshot, which may lag the bootstrap by one event.
  const [currentCfi, setCurrentCfi] = useState<string | null>(book?.lastCfi ?? null);
  // Bookmark match: strict CFI equality for v1. Note that
  // font-size changes can shift CFIs, so this WILL miss after a
  // formatting toggle — Bookmark roundtrips OK across app restarts
  // (CFIs persist), but a re-flow can desync the glyph until the
  // user re-bookmarks. Tolerant matching is a v2 task.
  const isBookmarked = useMemo(
    () => !!currentCfi && bookBookmarks.some((b) => b.cfi === currentCfi),
    [currentCfi, bookBookmarks],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [pageMarker, setPageMarker] = useState<{
    label: string;
    dir: "prev" | "next";
  } | null>(null);
  const turnOffset = useRef(0);
  // Initialise to mount-time so the very first quick double-tap-back
  // shows the marker. Starting at 0 made shouldShow=false on tap #1
  // (because now - 0 was always > the 2s window).
  const lastTurnAt = useRef(Date.now());
  const lastPageCommandAt = useRef(0);
  const pageMarkerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pace tracking. Filter the dwell so:
  //   - dwell < 3s → user was skimming past, ignore for both active time
  //     and chars-read (otherwise rapid back-skim inflates charsRead and
  //     distorts WPM).
  //   - dwell > 60s → cap at 60s. The user might have been reading
  //     slowly OR been away from the device. Capping splits the
  //     difference: slow readers still get credit, lock-time outliers
  //     don't ruin the rate.
  const PARTIAL_PAGE_MS = 3000;
  const AWAY_PAGE_MS = 60000;
  const OPEN_TIMEOUT_MS = book?.size && book.size > LARGE_BOOK_BYTES ? 90000 : 45000;
  const bookOpenedAt = useRef(Date.now());
  const pageEnteredAt = useRef(Date.now());
  const chapterEnteredAt = useRef(Date.now());
  const lastChapterHref = useRef<string | null>(null);
  const lastPercentage = useRef(book?.progress ?? 0);
  // Frozen anchor for the within-session ETA fallback. lastPercentage
  // updates every page event so it's useless as a "session start"
  // reference. This one is set once at mount and never moves.
  const sessionStartPct = useRef(book?.progress ?? 0);
  const totalCharsRef = useRef<number | null>(book?.totalChars ?? null);
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paceTick, setPaceTick] = useState(0);
  // Re-render once a second ONLY when a panel is open that actually
  // displays a live counter (Session shows pace, Book shows reading).
  // Previously this ran on a permanent 1Hz interval and forced a full
  // ReaderScreen re-render every second behind a fully-closed UI.
  useEffect(() => {
    if (!sessionPanelOpen && !bookPanelOpen) return;
    const t = setInterval(() => setPaceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sessionPanelOpen, bookPanelOpen]);

  // Temporary-read cleanup. When the user picked "Read once" on a
  // single-EPUB share intent, we routed here with ?temp=1 and the
  // book record was added to the library so the reader could find
  // it. On unmount (back, library nav, app close-and-reopen happens
  // to mount fresh), tear the record down so it never lingers in
  // the grid. Effect runs cleanup once on unmount; capturing `id`
  // and `deleteBook` in closure is fine because they don't change
  // for a given screen instance.
  useEffect(() => {
    if (!isTemporary || !id) return;
    return () => {
      void deleteBook(id);
    };
  }, [isTemporary, id, deleteBook]);

  // AppState listener: pause page/chapter dwell tracking when the app
  // backgrounds. RN's JS thread suspends, but Date.now() is wall-clock
  // — without this guard, the next location event after resume would
  // credit the entire background interval (capped to 60s) as "active
  // reading" on a page nobody was looking at.
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        if (backgroundedAt !== null) {
          const offset = Date.now() - backgroundedAt;
          // Slide the dwell anchors forward by the time we were away
          // so resumed-page dwell starts from "now" instead of from
          // the moment we left.
          pageEnteredAt.current += offset;
          chapterEnteredAt.current += offset;
          bookOpenedAt.current += offset;
          backgroundedAt = null;
        }
      } else if (state === "background" || state === "inactive") {
        if (backgroundedAt === null) backgroundedAt = Date.now();
        // Drop any stale floating selection — edge case: user
        // taps Look up, gets a notification, returns, finds the
        // SelectionBar floating over a different page.
        dismissSelection();
      }
    });
    return () => sub.remove();
  }, [dismissSelection]);

  const payload = useMemo(() => settingsToPayload(settings), [settings]);

  // Auto-hide chrome after 5s of no center-tap. Cleared whenever the user
  // re-shows the chrome or opens any sheet/panel.
  useEffect(() => {
    if (!chromeVisible) return;
    if (
      sheetVisible ||
      tocOpen ||
      bookPanelOpen ||
      sessionPanelOpen ||
      annotationsOpen ||
      dictionaryOpen
    )
      return;
    const timer = setTimeout(() => setChromeVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [chromeVisible, sheetVisible, tocOpen, bookPanelOpen, sessionPanelOpen]);

  // Hide the Android system navigation bar (the gesture-pill at the
  // bottom) while the user is mid-page. Bring it back whenever chrome
  // or any panel is on screen so they can navigate away. Restore on
  // unmount so other screens get the normal nav bar.
  useEffect(() => {
    const showNavBar =
      chromeVisible ||
      sheetVisible ||
      tocOpen ||
      bookPanelOpen ||
      sessionPanelOpen ||
      annotationsOpen ||
      dictionaryOpen;
    void SpineZip?.setNavBarHidden?.(!showNavBar);
  }, [
    chromeVisible,
    sheetVisible,
    tocOpen,
    bookPanelOpen,
    sessionPanelOpen,
    annotationsOpen,
    dictionaryOpen,
  ]);
  useEffect(() => {
    return () => {
      void SpineZip?.setNavBarHidden?.(false);
    };
  }, []);

  // Push the current book's highlights into the WebView whenever
  // they change (or once on first ready, via opened.current). The
  // bootstrap diffs against its attached set so this is cheap to
  // call on every store update.
  useEffect(() => {
    if (!opened.current || !webRef.current) return;
    try {
      webRef.current.injectJavaScript(
        buildInjectScript({
          type: "setHighlights",
          highlights: bookHighlights.map((h) => ({
            id: h.id,
            cfiRange: h.cfiRange,
            color: h.color,
          })),
        }),
      );
    } catch {
      /* swallow */
    }
  }, [bookHighlights]);

  // Push settings updates while the book is open.
  useEffect(() => {
    if (!opened.current || !webRef.current) return;
    webRef.current.injectJavaScript(buildInjectScript({ type: "settings", settings: payload }));
  }, [payload]);

  useEffect(
    () => () => {
      if (pageMarkerTimer.current) clearTimeout(pageMarkerTimer.current);
      if (openTimeoutRef.current) clearTimeout(openTimeoutRef.current);
    },
    [],
  );

  const notePageTurn = useCallback((dir: "prev" | "next") => {
    const now = Date.now();
    const shouldShow = now - lastTurnAt.current <= 2000;
    lastTurnAt.current = now;
    // If the user paused for >2s the marker has long since faded — start a
    // fresh delta count from this tap rather than accumulating onto a stale
    // value (otherwise the next rapid burst surfaces "+9" out of nowhere).
    if (!shouldShow) turnOffset.current = 0;
    turnOffset.current += dir === "next" ? 1 : -1;
    if (shouldShow) {
      const offset = turnOffset.current;
      setPageMarker({ label: `PAGE ${offset >= 0 ? "+" : ""}${offset}`, dir });
      if (pageMarkerTimer.current) clearTimeout(pageMarkerTimer.current);
      pageMarkerTimer.current = setTimeout(() => {
        setPageMarker(null);
        turnOffset.current = 0;
      }, 1500);
    }
  }, []);

  const issuePageTurn = useCallback(
    (dir: "prev" | "next") => {
      const now = Date.now();
      // 130ms gate — gives epubjs's rendition time to settle a turn
      // before queueing the next, while leaving room for ~7 turns/sec
      // when the user wants to skim back through pages quickly. The
      // earlier 180ms gate was capping that skim too hard.
      if (now - lastPageCommandAt.current < 130) return;
      lastPageCommandAt.current = now;
      notePageTurn(dir);
      // A page turn dismisses any floating selection — the rect we
      // captured no longer points at anything visible after the turn.
      dismissSelection();
      webRef.current?.injectJavaScript(buildInjectScript({ type: dir }));
    },
    [notePageTurn, dismissSelection],
  );

  // Push the EPUB once the bootstrap reports it's ready. baseUrl on the
  // WebView is the books/ directory so a fetch of the absolute file://
  // path is same-origin; allowUniversalAccessFromFileURLs covers the case
  // where the WebView still treats it as cross-scheme.
  const sendOpen = useCallback(() => {
    if (!book || opened.current) return;
    const size = Number.isFinite(book.size) ? book.size : null;
    if (size && size > MAX_EAGER_OPEN_BYTES) {
      setBusy(false);
      setError(
        "This EPUB imported, but it is too large for this reader build. The native chapter-streaming reader is needed for books this large.",
      );
      opened.current = true;
      return;
    }
    webRef.current?.injectJavaScript(
      buildInjectScript({
        type: "open",
        url: bookFilePath(book.filename),
        sizeBytes: size,
        settings: payload,
        startAt: book.lastCfi,
      }),
    );
    if (openTimeoutRef.current) clearTimeout(openTimeoutRef.current);
    openTimeoutRef.current = setTimeout(() => {
      setBusy(false);
      setError(
        size && size > LARGE_BOOK_BYTES
          ? "This large EPUB is taking too long to open in the current reader. It imported successfully, but the native chapter-streaming reader is needed for reliable large-book support."
          : "This EPUB is taking too long to open. It may be malformed or too large for this reader build.",
      );
    }, OPEN_TIMEOUT_MS);
    opened.current = true;
  }, [book, payload, OPEN_TIMEOUT_MS]);

  // Refs so the cached PanResponder always sees the latest closures from
  // React render — populated below this block once issuePageTurn is
  // defined.
  const issuePageTurnRef = useRef<(dir: "prev" | "next") => void>(() => {});
  const setChromeVisibleRef = useRef<React.Dispatch<React.SetStateAction<boolean>>>(
    () => {},
  );
  // Long-press fire: PanResponder owns the gesture, so we detect the
  // long-press ourselves (timer + tolerance) and inject a
  // requestLongPress message into the WebView. The bootstrap iterates
  // iframes by elementFromPoint, runs wordAtPoint, and posts back a
  // `longpress` event the existing onMessage path handles.
  // ref-routed pushDebug so PanResponder closure (frozen at first
  // render) always sees the live setter.
  const pushDebugRef = useRef<(m: string) => void>(() => {});
  pushDebugRef.current = pushDebug;
  const fireLongPressRef = useRef<(x: number, y: number) => void>(() => {});
  fireLongPressRef.current = (x: number, y: number) => {
    try {
      const adjY = y - insets.top;
      pushDebug(`fire screen=${x.toFixed(0)},${y.toFixed(0)} -> doc=${x.toFixed(0)},${adjY.toFixed(0)}`);
      const ok = !!webRef.current;
      if (!ok) pushDebug("fire NO webRef");
      webRef.current?.injectJavaScript(
        buildInjectScript({
          type: "requestLongPress",
          x,
          y: adjY,
        }),
      );
    } catch (e) {
      pushDebug("fire threw " + (e instanceof Error ? e.message : String(e)));
    }
  };
  // Per-gesture long-press timer + start coords. Held in refs so the
  // PanResponder callbacks (frozen-in-time closures) can mutate them.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  // Sticks for the rest of the gesture once the long-press has fired.
  // Used by onPanResponderRelease to SUPPRESS the tap-zone path —
  // without this, a hold-then-release in the center column would
  // long-press (showing the SelectionBar) and then immediately tap-zone
  // (calling dismissSelection + toggling chrome), so the bar would
  // flash and vanish before the user could see it.
  const longPressFiredRef = useRef(false);
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_TOL = 8;
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  };
  // Page-stuck-to-finger: we drive the WebView wrapper's translateX from
  // a plain useState so each PanResponder.move call forces a React
  // re-render with the new transform. Animated.Value through PanResponder
  // wasn't actually translating the WebView — the bridge desynced
  // somewhere between JS and the native side.
  const [dragX, setDragX] = useState(0);
  issuePageTurnRef.current = issuePageTurn;
  setChromeVisibleRef.current = setChromeVisible;
  // RN gesture overlay. The setDragX call forces a React re-render on
  // each move event so the WebView wrapper's transform updates inline
  // and the page tracks the thumb. setDragXRef indirects through a
  // ref so the PanResponder closure (created once via useRef) always
  // sees the current setter.
  const setDragXRef = useRef(setDragX);
  setDragXRef.current = setDragX;
  // springBack increment counter — each new gesture bumps it; in-flight
  // RAF chains check their captured generation against the live value
  // and stop iterating if a newer gesture has started. Prevents two
  // concurrent spring-back animations from stomping each other when
  // the user swipes again before the previous spring settles.
  const springGenRef = useRef(0);
  const screenGestures = useRef(
    PanResponder.create({
      // COOPERATIVE responder. The PanResponder NEVER claims on
      // start — every touch falls through to the WebView so Android
      // engages its NATIVE long-press selection (with system drag
      // handles + extend-by-drag). Bootstrap detects taps and
      // posts {type:"tap"} → RN tap-zone-routes them. The PanResponder
      // ONLY takes over mid-gesture when the user starts a horizontal
      // drag — that's a page-turn swipe, the WebView can't handle it.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        !selectionActiveRef.current &&
        Math.abs(g.dx) > 12 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderTerminationRequest: () => true,
      onPanResponderGrant: () => {
        // Responder JUST claimed (always mid-gesture, since
        // onStartShouldSet returns false). Cancel any in-flight
        // spring-back from the previous gesture.
        springGenRef.current += 1;
        setDragXRef.current(0);
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) > Math.abs(g.dy)) {
          setDragXRef.current(g.dx);
        }
      },
      onPanResponderRelease: (_, g) => {
        // Responder is only ever granted mid-gesture (horizontal
        // drag past 12px). So this fires only on the tail end of a
        // page-turn swipe — no tap-zone path needed; bootstrap
        // posts taps from the iframe.
        const { width: W, height: H } = Dimensions.get("window");
        const dx = g.dx;
        const dy = g.dy;
        // Spring-back animation. Without this the WebView translateX
        // snaps to 0 instantly — fine when there's nothing behind the
        // page, but with the continuous manager rendering the adjacent
        // page underneath you saw a 1-frame jump-cut. Use a JS-thread
        // animation over ~140ms with eased decel so the page settles.
        const springBack = (from: number) => {
          springGenRef.current += 1;
          const myGen = springGenRef.current;
          const start = Date.now();
          const dur = 140;
          const tick = () => {
            // Bail if a newer gesture (or a fresh spring) has taken over.
            if (springGenRef.current !== myGen) return;
            const t = Math.min(1, (Date.now() - start) / dur);
            const eased = 1 - Math.pow(1 - t, 3);
            setDragXRef.current(from * (1 - eased));
            if (t < 1) requestAnimationFrame(tick);
            else setDragXRef.current(0);
          };
          requestAnimationFrame(tick);
        };
        // Animate the slide back to 0 — both for swipes that crossed
        // the threshold (page turn fired, slide settles to 0) and for
        // taps/short drags (slide eases back without a page turn).
        // Continuous manager keeps the adjacent page rendered, so an
        // instant snap was producing a visible 1-frame jump-cut.
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
          issuePageTurnRef.current(dx > 0 ? "prev" : "next");
          springBack(dx);
          return;
        }
        if (Math.abs(dx) > 0) springBack(dx);
        else setDragXRef.current(0);
        // No tap-zone fallback — bootstrap posts {type:"tap"} from
        // the iframe; this responder only runs for swipes that
        // didn't cross the threshold (drift), where we just settle
        // back to 0. void H to keep its dead-code-elimination
        // hint without TS unused-var noise.
        void W; void H; void dy;
      },
      onPanResponderTerminate: () => {
        setDragXRef.current(0);
      },
    }),
  ).current;

  const seekTo = useCallback((ratio: number) => {
    webRef.current?.injectJavaScript(
      buildInjectScript({ type: "seek", percentage: ratio }),
    );
  }, []);

  const gotoHref = useCallback((href: string) => {
    webRef.current?.injectJavaScript(
      buildInjectScript({ type: "goto", target: href }),
    );
  }, []);

  const flatTocHrefs = useMemo(() => {
    const out: string[] = [];
    const walk = (items: TocItem[]) => {
      for (const item of items) {
        if (item.href) out.push(item.href);
        if (item.subitems?.length) walk(item.subitems);
      }
    };
    walk(toc);
    return out;
  }, [toc]);

  const jumpChapter = useCallback(
    (dir: "prev" | "next") => {
      if (flatTocHrefs.length === 0) return;
      // Guard against the location event not having fired yet — without
      // this, the optional-chain returns undefined and the trailing
      // .split("/") crashed if the user tapped Prev/Next chapter before
      // the first relocated event landed.
      let cur: string | null = null;
      if (currentHref) {
        const stripped = currentHref.split("#")[0];
        cur = stripped ? (stripped.split("/").pop() ?? null) : null;
      }
      const idx = cur
        ? flatTocHrefs.findIndex((h) => {
            const stripped = h.split("#")[0];
            const base = stripped ? (stripped.split("/").pop() ?? h) : h;
            return base === cur;
          })
        : -1;
      const targetIdx =
        dir === "next"
          ? Math.min(flatTocHrefs.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      const target = flatTocHrefs[targetIdx];
      if (target) gotoHref(target);
    },
    [currentHref, flatTocHrefs, gotoHref],
  );

  const pace = useMemo(() => {
    void paceTick; // keep memo recomputing each second
    const now = Date.now();
    const fmt = (ms: number) => {
      if (!isFinite(ms) || ms < 0) ms = 0;
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ${sec % 60}s`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ${min % 60}m`;
      return `${Math.floor(hr / 24)}d ${hr % 24}h`;
    };
    const thisPage = fmt(now - pageEnteredAt.current);
    const chapter = fmt(now - chapterEnteredAt.current);

    const total = totalCharsRef.current ?? book?.totalChars ?? 0;
    const cumActive = book?.activeReadMs ?? 0;
    const cumChars = book?.charsRead ?? 0;
    const remainingChars = total > 0 ? total * (1 - percentage) : 0;

    // Two paths to charsPerMs:
    //  (1) Cumulative book-wide counters once we have ≥30s of credited
    //      reading time. Most accurate for a returning reader.
    //  (2) Within-session fallback using sessionStartPct (frozen at
    //      mount) so a fresh book's ETA can populate before the
    //      cumulative path qualifies. The previous code anchored
    //      against lastPercentage which got rewritten every page event,
    //      making sessionChars unconditionally 0.
    let charsPerMs = 0;
    if (cumActive > 30000 && cumChars > 0) {
      charsPerMs = cumChars / cumActive;
    } else if (total > 0) {
      const sessionMs = now - bookOpenedAt.current;
      const sessionChars = Math.max(0, percentage - sessionStartPct.current) * total;
      if (sessionMs > 30000 && sessionChars > 0) {
        charsPerMs = sessionChars / sessionMs;
      }
    }
    let bookEta = "—";
    if (remainingChars > 0 && charsPerMs > 0) {
      bookEta = fmt(remainingChars / charsPerMs);
    }

    // WPM ≈ chars/ms × 60_000 ÷ 5 chars/word
    const wpm = charsPerMs > 0 ? Math.round(charsPerMs * 60000 / 5) : 0;

    // Locations: ~50 words per location, ~5 chars per word → 250 chars
    // per location. User-facing "Location 1234 of 5678" Kindle-style.
    const totalLocations = total > 0 ? Math.max(1, Math.round(total / 250)) : 0;
    const currentLocation =
      totalLocations > 0
        ? Math.max(1, Math.min(totalLocations, Math.round(percentage * totalLocations) || 1))
        : 1;

    return { thisPage, chapter, bookEta, wpm, currentLocation, totalLocations };
  }, [paceTick, percentage, book?.activeReadMs, book?.charsRead, book?.totalChars]);

  const jumpToLocation = useCallback(
    (loc: number) => {
      const total = pace.totalLocations || (totalCharsRef.current ? Math.round(totalCharsRef.current / 250) : 0);
      if (total <= 0) return;
      const ratio = Math.max(0, Math.min(1, (loc - 1) / total));
      seekTo(ratio);
    },
    [pace.totalLocations, seekTo],
  );

  // Pinch-to-zoom font size. Each "notch" = ±1pt. A small pinch (scale
  // ~1.07) yields one notch; a big pinch (scale ~1.5) yields ~3-4. Live
  // updates flow through patchReader → settings → injectJavaScript so
  // the WebView re-applies size mid-gesture.
  const pinchStartFontSize = useRef(settings.fontSize);
  const onPinchStateChange = useCallback(
    (e: PinchGestureHandlerStateChangeEvent) => {
      if (e.nativeEvent.state === GHState.BEGAN) {
        pinchStartFontSize.current = settings.fontSize;
      }
    },
    [settings.fontSize],
  );
  const onPinchEvent = useCallback(
    (e: PinchGestureHandlerGestureEvent) => {
      const scale = e.nativeEvent.scale;
      // Notch curve: scale 1.0 → 0, scale 1.07 → 1, scale 1.5 → 3-4.
      // Use sign+abs+round so pinch-in and pinch-out are symmetric —
      // Math.round(-0.5) is 0 in JS but Math.round(0.5) is 1, which made
      // pinch-out twice as responsive as pinch-in.
      const d = (scale - 1) / 0.12;
      const notches = Math.sign(d) * Math.round(Math.abs(d));
      const clamped = Math.max(8, Math.min(28, pinchStartFontSize.current + notches));
      if (clamped !== settings.fontSize) {
        void patchReader({ fontSize: clamped });
      }
    },
    [patchReader, settings.fontSize],
  );

  const reading = useMemo(() => {
    void paceTick;
    const fmtRel = (iso: string | null) => {
      if (!iso) return "—";
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
      if (days < 1) return "today";
      if (days === 1) return "yesterday";
      if (days < 30) return `${days} days ago`;
      const months = Math.floor(days / 30);
      return months === 1 ? "1 month ago" : `${months} months ago`;
    };
    const fmtMs = (ms: number) => {
      if (!isFinite(ms) || ms <= 0) return "—";
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m`;
      const hr = Math.floor(min / 60);
      return `${hr}h ${min % 60}m`;
    };
    return {
      started: fmtRel(book?.importedAt ?? null),
      today: fmtMs(Date.now() - bookOpenedAt.current),
      eta: pace.bookEta,
    };
  }, [paceTick, pace.bookEta, book?.importedAt]);

  const currentChapterLabel = useMemo(() => {
    if (!currentHref) return null;
    const cur = currentHref.split("#")[0]!.split("/").pop();
    const find = (items: TocItem[]): string | null => {
      for (const item of items) {
        const h = item.href.split("#")[0]!.split("/").pop();
        if (h === cur) return item.label;
        if (item.subitems?.length) {
          const sub = find(item.subitems);
          if (sub) return sub;
        }
      }
      return null;
    };
    return find(toc);
  }, [currentHref, toc]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: WebToNative;
      try {
        msg = JSON.parse(e.nativeEvent.data) as WebToNative;
      } catch {
        return;
      }
      switch (msg.type) {
        case "boot":
          if (!booted.current) {
            booted.current = true;
            void sendOpen();
          }
          break;
        case "ready":
          if (openTimeoutRef.current) {
            clearTimeout(openTimeoutRef.current);
            openTimeoutRef.current = null;
          }
          setBusy(false);
          break;
        case "rendered":
          setBusy(false);
          // First-render highlight push. The useEffect that watches
          // bookHighlights only fires when the array identity changes;
          // if it hadn't changed since mount, the bootstrap would
          // never receive the initial set. Posting again here is
          // idempotent (the bootstrap diffs by id).
          if (book && bookHighlights.length > 0) {
            try {
              webRef.current?.injectJavaScript(
                buildInjectScript({
                  type: "setHighlights",
                  highlights: bookHighlights.map((h) => ({
                    id: h.id,
                    cfiRange: h.cfiRange,
                    color: h.color,
                  })),
                }),
              );
            } catch {
              /* swallow */
            }
          }
          break;
        case "location": {
          const p = msg.percentage ?? 0;
          const now = Date.now();
          // Dwell on the page we're leaving. Skim-exclusion: a dwell <3s
          // means the user was rapidly turning past, so we credit NEITHER
          // active time NOR chars covered — otherwise back-skim inflates
          // charsRead and tanks the WPM rate.
          const dwell = now - pageEnteredAt.current;
          const isSkim = dwell < PARTIAL_PAGE_MS;
          let activeMsDelta = 0;
          let charsDelta = 0;
          if (!isSkim) {
            // Cap rather than drop — slow readers can legitimately spend
            // 60-120s on a dense page; the cap absorbs lock-time without
            // starving the rate of real reading.
            activeMsDelta = Math.min(dwell, AWAY_PAGE_MS);
            if (totalCharsRef.current && totalCharsRef.current > 0) {
              const dPct = Math.max(0, p - lastPercentage.current);
              // Cap dPct at 5% per page — protects against the
              // resume-from-CFI case where the FIRST relocated event
              // arrives with p=0 (epubjs reports 0 until
              // locations.generate finishes) and the SECOND arrives
              // with p=0.43. Clamping (rather than discarding) means
              // legitimately short books still get credit per turn —
              // a 50-page picture book where one turn is 2% works,
              // and a one-shot 43% jump only counts as 5%.
              if (dPct > 0) {
                const capped = Math.min(dPct, 0.05);
                charsDelta = Math.round(capped * totalCharsRef.current);
              }
            }
          }
          lastPercentage.current = p;
          setPercentage(p);
          if (msg.cfi) setCurrentCfi(msg.cfi);
          pageEnteredAt.current = now;
          // Strip URL hash before comparing chapter hrefs — books that put
          // section anchors in their TOC (e.g. chapter1.xhtml#sec2) used to
          // reset chapterEnteredAt every time the user crossed an anchor
          // within the same chapter file.
          const incomingChapter = msg.href ? msg.href.split("#")[0] : null;
          const currentChapter = lastChapterHref.current
            ? lastChapterHref.current.split("#")[0]
            : null;
          if (incomingChapter && incomingChapter !== currentChapter) {
            lastChapterHref.current = msg.href ?? null;
            chapterEnteredAt.current = now;
          }
          if (msg.href) setCurrentHref(msg.href);
          if (book) {
            void setReadingPosition(book.id, msg.cfi, p, activeMsDelta, charsDelta);
          }
          break;
        }
        case "toc":
          setToc(msg.items);
          break;
        case "metrics":
          totalCharsRef.current = msg.totalChars;
          if (book) {
            // Don't write percentage or cfi here — onMessage's deps
            // include book but NOT percentage, so a `metrics` event
            // arriving after the user paged forward would stomp the
            // newer position with the closure's stale value. Pass
            // null cfi so the store keeps its current cfi unchanged;
            // setReadingPosition's signature treats null as "leave
            // the existing cfi alone" only at the call site — here
            // we explicitly only want to update totalChars, so we
            // pass the book's current persisted values back.
            const cur = book;
            void setReadingPosition(
              cur.id,
              cur.lastCfi,
              cur.progress,
              0,
              0,
              msg.totalChars,
            );
          }
          break;
        case "selection":
          // Drag-select. Update or set the floating selection state.
          // Don't dismiss any existing UI here — the SelectionBar
          // (P3) reads activeSelection directly.
          setActiveSelection({
            text: msg.text,
            cfiRange: msg.cfiRange,
            textBefore: msg.textBefore,
            textAfter: msg.textAfter,
            rect: msg.rect,
            source: "drag",
          });
          break;
        case "selectionEnd":
          // User collapsed the selection (tap outside, scroll). Drop
          // the floating bar; the WebView already cleared its own.
          setActiveSelection(null);
          break;
        case "longpress":
          // Legacy path — kept for messages from older bootstraps.
          // The new architecture uses Android-native selection +
          // selectionchange events; longpress messages stop firing.
          setActiveSelection({
            text: msg.word,
            cfiRange: msg.cfi,
            textBefore: "",
            textAfter: "",
            rect: msg.rect,
            source: "longpress",
          });
          break;
        case "tap": {
          // Bootstrap detected a tap inside the iframe. Coords are
          // in outer-document space; convert to RN screen coords by
          // adding insets.top. Then route to the same tap-zone
          // logic the old PanResponder used: left third = prev,
          // right third = next, center = chrome toggle.
          const { width: W } = Dimensions.get("window");
          const screenX = msg.x;
          const screenY = msg.y + insets.top;
          // If a selection is active, a tap elsewhere should DISMISS
          // it rather than page-turn or chrome-toggle. Mirrors how
          // most ereader apps treat the "tap-off" gesture.
          if (selectionActiveRef.current) {
            dismissSelection();
            break;
          }
          if (screenX < W / 3) {
            issuePageTurnRef.current("prev");
          } else if (screenX > (W * 2) / 3) {
            issuePageTurnRef.current("next");
          } else {
            void screenY;
            setChromeVisibleRef.current((v) => !v);
          }
          break;
        }
        case "swipe":
          if (selectionActiveRef.current) break;
          issuePageTurnRef.current(msg.dir);
          break;
        case "highlightTap": {
          // Context menu for an existing highlight. Design spec:
          // Delete / Change color / Copy. Color picker is collapsed
          // here into a sub-prompt rather than a bar so we don't have
          // to position another floating UI; for the alpha, cycling
          // through colors via repeated "Change color" taps would be
          // worse UX, so we open the picker as a chained Alert.
          const hit = bookHighlights.find((h) => h.id === msg.id);
          if (!hit) break;
          Alert.alert(
            // First ~40 chars as a header so the user knows which
            // highlight they're acting on.
            hit.text.length > 40 ? hit.text.slice(0, 40) + "…" : hit.text,
            undefined,
            [
              {
                text: "Delete",
                style: "destructive",
                onPress: () => void removeHighlight(hit.id),
              },
              {
                text: "Change color",
                onPress: () => {
                  Alert.alert("Change color", undefined, [
                    { text: "Yellow", onPress: () => void updateHighlight(hit.id, { color: "yellow" }) },
                    { text: "Pink",   onPress: () => void updateHighlight(hit.id, { color: "pink" }) },
                    { text: "Green",  onPress: () => void updateHighlight(hit.id, { color: "green" }) },
                    { text: "Blue",   onPress: () => void updateHighlight(hit.id, { color: "blue" }) },
                    { text: "Orange", onPress: () => void updateHighlight(hit.id, { color: "orange" }) },
                    { text: "Cancel", style: "cancel" },
                  ]);
                },
              },
              {
                text: "Copy",
                onPress: () => {
                  // The text was captured at create time; copy it
                  // straight from the record. Avoids a round-trip
                  // through the WebView for content that's already
                  // in JS memory.
                  try {
                    webRef.current?.injectJavaScript(
                      // Inject a one-off Clipboard write via
                      // navigator.clipboard.writeText if available;
                      // fall back is a no-op (we don't have RN
                      // Clipboard).
                      `try{navigator.clipboard&&navigator.clipboard.writeText(${JSON.stringify(hit.text)});}catch(e){};true;`,
                    );
                  } catch {
                    /* swallow */
                  }
                },
              },
              { text: "Cancel", style: "cancel" },
            ],
            { cancelable: true },
          );
          break;
        }
        case "debug":
          pushDebug(msg.message);
          break;
        case "error":
          if (openTimeoutRef.current) {
            clearTimeout(openTimeoutRef.current);
            openTimeoutRef.current = null;
          }
          setError(msg.message);
          setBusy(false);
          break;
      }
    },
    [book, bookHighlights, issuePageTurn, pushDebug, removeHighlight, sendOpen, setReadingPosition, updateHighlight],
  );

  if (!book) {
    return (
      <View style={[styles.root, { backgroundColor: theme.readerBg, paddingTop: insets.top }]}>
        <View style={styles.center}>
          <Text style={{ color: theme.readerInk, fontFamily: FONTS.serif, fontSize: 18 }}>
            Book not found.
          </Text>
          <Text
            style={{
              color: theme.readerDim,
              fontFamily: FONTS.mono,
              fontSize: 11,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              marginTop: 8,
              marginBottom: 24,
            }}
          >
            It may have been deleted from another screen.
          </Text>
          <Pressable
            onPress={() => router.replace("/library")}
            style={({ pressed }) => ({
              borderColor: theme.readerInk,
              borderWidth: StyleSheet.hairlineWidth,
              paddingHorizontal: 18,
              paddingVertical: 10,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{
                color: theme.readerInk,
                fontFamily: FONTS.mono,
                fontSize: 12,
                letterSpacing: 0.7,
                textTransform: "uppercase",
                fontWeight: "600",
              }}
            >
              Return to library
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Hide the system status bar while reading, except when chrome is up.
  // Hide the system status bar during pure reading. Any open chrome,
  // sheet, or panel restores it so the user can use system gestures
  // and see notifications.
  const statusBarHidden =
    !chromeVisible &&
    !sheetVisible &&
    !tocOpen &&
    !bookPanelOpen &&
    !sessionPanelOpen &&
    !annotationsOpen &&
    !dictionaryOpen;
  // When the system nav-bar is hidden (immersive mode while reading),
  // also drop the safe-area bottom padding — otherwise the wrapper
  // reserves a strip where the bar used to live and you see a dark band
  // at the bottom of the page even though the pill is hidden.
  const navBarVisible =
    chromeVisible ||
    sheetVisible ||
    tocOpen ||
    bookPanelOpen ||
    sessionPanelOpen ||
    annotationsOpen ||
    dictionaryOpen;
  const wrapperPaddingBottom = navBarVisible ? insets.bottom : 0;

  return (
    <View style={[styles.root, { backgroundColor: theme.readerBg }]}>
      <StatusBar
        hidden={statusBarHidden}
        style={theme.statusDark ? "dark" : "light"}
        backgroundColor={theme.readerBg}
      />
      {/* WebView wrapper carries the safe-area insets. Even with the system
          status bar hidden, the camera punch-hole on edge-to-edge devices
          still occupies the top inset — without it the reader text drew
          under the cutout. Chrome / sheet remain absolute children of the
          root so they handle their own insets without doubling. */}
      <View
        style={{
          flex: 1,
          paddingTop: insets.top,
          paddingBottom: wrapperPaddingBottom,
          backgroundColor: theme.readerBg,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flex: 1,
            transform: [{ translateX: dragX }],
          }}
        >
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          // baseUrl points at the books/ dir so the WebView's document origin
          // is file://… and a relative fetch("./<filename>") resolves to the
          // EPUB on disk. allowFileAccessFromFileURLs is the flag that lets
          // a file:// document XHR sibling files; without it Android WebView
          // blocks the fetch as cross-origin.
          // baseUrl is the books/ dir so the WebView's document origin
          // is file://… and a relative fetch("./<filename>") resolves
          // to the EPUB. allowFileAccessFromFileURLs is the SAME-origin
          // file fetch flag; deliberately NOT enabling
          // allowUniversalAccessFromFileURLs — that's the cross-file
          // sledgehammer that would let a malicious EPUB's scripted
          // content read anywhere in the app sandbox.
          source={{ html: READER_HTML, baseUrl: BOOKS_DIR }}
          allowFileAccess
          allowFileAccessFromFileURLs
          style={{ flex: 1, backgroundColor: theme.readerBg }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          bounces={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          androidLayerType="hardware"
          setSupportMultipleWindows={false}
          onError={(e) => setError(e.nativeEvent.description)}
        />
        </View>
        {/* Gesture overlay wrapped in a PinchGestureHandler. Single-finger
            taps/swipes go through the PanResponder; two-finger pinch
            goes through the Pinch handler and adjusts font size live. */}
        <PinchGestureHandler
          onHandlerStateChange={onPinchStateChange}
          onGestureEvent={onPinchEvent}
        >
          <View
            {...screenGestures.panHandlers}
            // ALWAYS transparent. Touches go straight to the WebView
            // so Android's native long-press / selection / drag-handles
            // engage. Bootstrap (reader-bootstrap.js) detects taps +
            // swipes inside the iframe and posts {type:"tap"} /
            // {type:"swipe"} → RN routes them. PanResponder is kept
            // for future fallback gestures but never claims (see
            // onStartShouldSetPanResponder = false).
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
        </PinchGestureHandler>
      </View>

      {/* Brightness dim overlay — pure black with 1-brightness opacity. We
          can't change the system backlight without a native module, but a
          dim layer on top of the WebView is good enough for late-night
          reading. */}
      {settings.brightness < 0.999 ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: "#000", opacity: 1 - settings.brightness },
          ]}
        />
      ) : null}
      {/* Warmth filter — multiply blend so a black background stays black
          (additive amber on AMOLED bg looked wrong: it brightened the
          pixels we wanted off). Multiply tints the lit pixels and leaves
          the dark pixels alone. The overlay color interpolates from
          white (no change) at warmth=0 to a warm cream at warmth=1.
          Linear, predictable, and doesn't fight brightness. */}
      {settings.warmth > 0.001 ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: `rgb(255,${Math.round(255 - settings.warmth * 42)},${Math.round(255 - settings.warmth * 95)})`,
              mixBlendMode: "multiply",
            },
          ]}
        />
      ) : null}

      {busy ? (
        <View pointerEvents="none" style={[styles.center, StyleSheet.absoluteFill]}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : null}

      {/* Dog-ear pin: shown when the current location is bookmarked
          AND the user has hidden the chrome (i.e. they're reading).
          Sits in an RN absolute-positioned View, NOT inside the
          WebView, so font-size changes don't move it. Tap-through:
          pointerEvents="none" — toggling the bookmark goes through
          the chrome button. */}
      {isBookmarked && !chromeVisible ? (
        <View
          pointerEvents="none"
          style={[
            styles.dogEar,
            {
              top: insets.top + 4,
              borderTopColor: theme.accent,
            },
          ]}
        />
      ) : null}

      {pageMarker ? (
        <View
          pointerEvents="none"
          style={[
            styles.pageMarker,
            {
              top: insets.top + 16,
              backgroundColor: theme.readerInk,
              borderColor: theme.readerRule,
            },
          ]}
        >
          <Text style={[styles.pageMarkerText, { color: theme.readerBg }]}>{pageMarker.label}</Text>
          <Text
            style={[
              styles.pageMarkerText,
              styles.pageMarkerArrow,
              {
                color: theme.readerBg,
                textAlign: pageMarker.dir === "prev" ? "left" : "right",
              },
            ]}
          >
            {pageMarker.dir === "prev" ? "<<" : ">>"}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View
          style={[
            styles.errorBar,
            { backgroundColor: theme.alert, paddingTop: insets.top + 6 },
          ]}
        >
          <Text style={{ color: "#fff", fontFamily: FONTS.sans, fontSize: 12 }}>{error}</Text>
        </View>
      ) : null}

      <ReaderChrome
        visible={chromeVisible}
        theme={theme}
        insets={insets}
        bookTitle={book.title}
        bookmarked={isBookmarked}
        percentage={percentage}
        currentChapterLabel={currentChapterLabel}
        currentLocation={pace.currentLocation}
        totalLocations={pace.totalLocations}
        toc={toc}
        currentHref={currentHref}
        onBack={() => router.replace("/library")}
        onOpenSettings={() => {
          setSheetVisible(true);
          setChromeVisible(false);
        }}
        onOpenToc={() => setTocOpen(true)}
        onOpenSessionPanel={() => setSessionPanelOpen(true)}
        onOpenBookPanel={() => setBookPanelOpen(true)}
        onOpenAnnotations={() => {
          setAnnotationsTab("highlights");
          setAnnotationsOpen(true);
          setChromeVisible(false);
        }}
        onToggleBookmark={() => {
          if (!book || !currentCfi) return;
          void toggleBookmark({
            bookId: book.id,
            cfi: currentCfi,
            chapterHref: (currentHref ?? "").split("#")[0] ?? "",
            chapterLabel: currentChapterLabel ?? "",
            // V1 snippet = chapter label. A real visible-text sample
            // would need another bootstrap message round-trip; the
            // Annotations browser (P6) shows the chapter label
            // anyway, so this is a wash for v1.
            snippet: currentChapterLabel ?? "Bookmark",
          });
        }}
        onSeek={seekTo}
        onOpenHelp={() => {
          setHelpOpen(true);
          setChromeVisible(false);
        }}
        onJumpChapter={jumpChapter}
      />

      <ReaderSettingsSheet
        visible={sheetVisible}
        theme={theme}
        insets={insets}
        settings={settings}
        onChange={(patch) => void patchReader(patch)}
        onClose={() => setSheetVisible(false)}
        onOpenAllSettings={() => {
          setSheetVisible(false);
          router.push("/settings");
        }}
      />

      <TocSheet
        visible={tocOpen}
        theme={theme}
        insets={insets}
        toc={toc}
        currentHref={currentHref}
        onClose={() => setTocOpen(false)}
        onPick={(href) => gotoHref(href)}
      />

      <SessionPanel
        visible={sessionPanelOpen}
        theme={theme}
        insets={insets}
        toc={toc}
        currentHref={currentHref}
        pace={pace}
        onClose={() => setSessionPanelOpen(false)}
        onPickChapter={(href) => {
          gotoHref(href);
          setSessionPanelOpen(false);
        }}
        onOpenToc={() => setTocOpen(true)}
        onJumpToLocation={(loc) => {
          jumpToLocation(loc);
          setSessionPanelOpen(false);
        }}
      />

      <BookPanel
        visible={bookPanelOpen}
        theme={theme}
        insets={insets}
        book={book}
        currentChapterLabel={currentChapterLabel}
        reading={reading}
        highlightCount={bookHighlights.length}
        bookmarkCount={bookBookmarks.length}
        onOpenAnnotations={(tab) => {
          setAnnotationsTab(tab);
          setAnnotationsOpen(true);
        }}
        onExportAnnotations={async () => {
          if (!book) return;
          if (bookHighlights.length === 0 && bookBookmarks.length === 0) return;
          try {
            const path = await exportAnnotationsJson(
              book,
              bookHighlights,
              bookBookmarks,
            );
            if (SpineZip?.shareFile) {
              try {
                await SpineZip.shareFile(
                  path,
                  "application/json",
                  `${book.title} — annotations`,
                  shareFileName(`${book.title} annotations`, book.author).replace(
                    /\.epub$/i,
                    ".json",
                  ),
                );
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : "Couldn't share";
                Alert.alert(
                  "Annotations exported",
                  `Saved, but couldn't open share sheet: ${msg}`,
                );
              }
            } else {
              Alert.alert(
                "Annotations exported",
                "Saved internally; sharing isn't wired in this build.",
              );
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Export failed";
            Alert.alert("Export failed", msg);
          }
        }}
        onClose={() => setBookPanelOpen(false)}
        onMarkFinished={() => {
          if (!book) return;
          // One-tap mark-finished is too easy to mistap (sits one row
          // above destructive Remove). Confirm.
          Alert.alert(
            "Mark as finished?",
            `${book.title} will be set to 100% read.`,
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Mark finished",
                onPress: () => {
                  void setProgress(book.id, 1);
                },
              },
            ],
          );
        }}
        onRemoveFromLibrary={() => {
          if (!book) return;
          void deleteBook(book.id);
          router.replace("/library");
        }}
        onShare={async () => {
          if (!book) return;
          if (!SpineZip?.shareFile) {
            Alert.alert(
              "Sharing not available",
              "This build doesn't have the share native module wired. (Expected in dev/iOS.)",
            );
            return;
          }
          try {
            await SpineZip.shareFile(
              bookFilePath(book.filename),
              "application/epub+zip",
              book.title,
              shareFileName(book.title, book.author),
            );
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Unknown error";
            Alert.alert("Couldn't share", msg);
          }
        }}
      />

      <TapZoneHelpOverlay
        visible={helpOpen}
        theme={theme}
        onClose={() => setHelpOpen(false)}
      />

      <AnnotationsSheet
        visible={annotationsOpen}
        theme={theme}
        insets={insets}
        highlights={bookHighlights}
        bookmarks={bookBookmarks}
        initialTab={annotationsTab}
        onClose={() => setAnnotationsOpen(false)}
        onJumpToCfi={(cfi) => gotoHref(cfi)}
        onDeleteHighlight={(id) => void removeHighlight(id)}
        onDeleteBookmark={(id) => void removeBookmark(id)}
      />

      <DictionarySheet
        visible={dictionaryOpen}
        theme={theme}
        insets={insets}
        word={dictionaryWord}
        onClose={() => setDictionaryOpen(false)}
        onOpenSettings={() => router.push("/settings")}
      />

      {/* DEBUG overlay — gated by the DEBUG_LONGPRESS flag near
          the top of this component. Compile-time off by default;
          flip the flag to chase the next gesture-stack bug. */}
      {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
      {DEBUG_LONGPRESS ? null : null}

      <SelectionBar
        theme={theme}
        insets={insets}
        text={activeSelection?.text ?? null}
        defaultColor={lastHighlightColor}
        fromLongPress={activeSelection?.source === "longpress"}
        onHighlight={(color) => {
          if (!activeSelection || !book) return;
          // No CFI = epubjs couldn't anchor (rare; happens on cover
          // pages or odd flow items). Don't persist a highlight that
          // can never be re-rendered or jumped to. Show nothing
          // visual; the user can copy/share/look-up still — but we
          // suppress the Highlight verb's effect rather than
          // persisting a useless record.
          if (!activeSelection.cfiRange) {
            dismissSelection();
            return;
          }
          void setLastHighlightColor(color);
          void addHighlight({
            bookId: book.id,
            cfiRange: activeSelection.cfiRange,
            text: activeSelection.text,
            textBefore: activeSelection.textBefore,
            textAfter: activeSelection.textAfter,
            chapterHref: (currentHref ?? "").split("#")[0] ?? "",
            chapterLabel: currentChapterLabel ?? "",
            color,
            note: null,
          });
          dismissSelection();
        }}
        onLookup={() => {
          if (!activeSelection) return;
          setDictionaryWord(activeSelection.text);
          setDictionaryOpen(true);
          // Don't dismiss the selection — the user might tap Highlight
          // or Copy after closing the dict sheet. The sheet sits over
          // the SelectionBar regardless. Page turns / chrome toggles
          // still clear it through the existing dismissSelection paths.
        }}
        onCopy={() => {
          try {
            webRef.current?.injectJavaScript(
              buildInjectScript({ type: "copySelection" }),
            );
          } catch {
            /* swallow */
          }
          dismissSelection();
        }}
        onDismiss={dismissSelection}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorBar: { paddingHorizontal: 16, paddingBottom: 8 },
  // Dog-ear pin: a small downward-right triangle in the top-right
  // corner. Uses CSS border-trick (transparent left, colored top)
  // so we don't need an SVG or image asset. 18px wide, accent color.
  dogEar: {
    position: "absolute",
    right: 0,
    width: 0,
    height: 0,
    borderTopWidth: 18,
    borderLeftWidth: 18,
    borderLeftColor: "transparent",
  },
  hintPill: {
    position: "absolute",
    left: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    opacity: 0.92,
    alignItems: "flex-start",
  },
  pageMarker: {
    position: "absolute",
    right: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    opacity: 0.9,
  },
  pageMarkerText: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  pageMarkerArrow: {
    marginTop: 1,
    lineHeight: 11,
  },
});
