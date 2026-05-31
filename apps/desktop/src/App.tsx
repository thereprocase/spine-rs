import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from "react";
import "./App.css";
import {
  Book as BookIcon,
  GraduationCap,
  Search,
  Database,
  CheckCircle2,
  ArrowRightCircle,
  Trash2,
  Download,
  ExternalLink,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Reader from "./Reader";
import GraphView from "./GraphView";
import TimelineView from "./TimelineView";
import { FacetBrowser, type FacetKind } from "./FacetBrowser";
import { JobsIndicator } from "./JobsIndicator";
import { RemoveBookDialog } from "./RemoveBookDialog";
import { callApi, callApiJson as bridgeCallApiJson, isApiError } from "./api/client";
import type { DeletedBook } from "./types";
import { extractYear, humanizeBackendError, formatRejected, emptyProjectionMessage, formatBytes, relDate, classifyLibraryError, type LibraryErrorKind } from "./utils/formatters";
import LibraryErrorModal from "./LibraryErrorModal";
import { identifierUrl, diffProjection } from "./utils/identifiers";
import { normalizeName } from "./utils/names";
import CoverImage from "./components/CoverImage";
import Bootstrap from "./Bootstrap";
import HybridList from "./grids/HybridList";
import CoverGrid from "./grids/CoverGrid";
import DenseTable from "./grids/DenseTable";
import CommandPalette from "./CommandPalette";
import { registerCommands } from "./palette/registerCommands";
import { projectBook, type BookProjection } from "./projections";
import { usePersistentState } from "./hooks/usePersistentState";
import TitleBar from "./shell/TitleBar";
import Sidebar, { type SidebarSection } from "./shell/Sidebar";
import LibraryHeaderCard from "./shell/LibraryHeaderCard";
import SidebarRail, { type RailGroup } from "./shell/SidebarRail";
import SidebarResizeHandle from "./shell/SidebarResizeHandle";
import { useShelvesSection } from "./shell/ShelvesSection";
import { useFacetBrowserSection } from "./features/Browse/TagAuthorBrowser";
import { loadShelves } from "./shell/ShelvesData";
import ShelfMark from "./shell/ShelfMark";
import EmptyStateCard from "./shell/EmptyStateCard";
import Toolbar, { type Density, type ViewMode as ShellViewMode } from "./shell/Toolbar";
import FilterBar, { type FilterChip } from "./shell/FilterBar";
import Footer from "./shell/Footer";
import StatusBar from "./shell/StatusBar";
import Inspector from "./Inspector";
import RenameDialog from "./RenameDialog";
import AddSubjectDialog from "./AddSubjectDialog";
import AddInstanceDialog, { type InstanceDraft } from "./AddInstanceDialog";
import Settings, { type RecentLibrary } from "./Settings";
import ReconcileDrawer from "./ReconcileDrawer";
import InspectorInferredTab from "./inspector/InspectorInferredTab";
import EditMetadataDrawer, { type EditMetadataPayload } from "./features/Inspector/EditMetadataDrawer";
import BatchInspector from "./BatchInspector";
import { SPINE } from "./tokens";

interface Book {
  id: string;
  title: string;
  authors: string[];
  legacyMetadata: {
    publisher?: string;
    pubDate?: string;
    series?: string;
    seriesIndex?: number;
    tags: string[];
    description?: string;
    hasCover?: boolean;
  };
  bibliographicGraph?: {
    workUri: string;
    instanceUri: string;
    work: {
      uri: string;
      title?: string;
      originDate?: string;
      subjects: { uri: string; label: string; source: string }[];
      creators: { uri: string; name: string; role: string }[];
      language?: string;
      lccn?: string;
      ddc?: string;
    };
    instances: {
      uri: string;
      format: string;
      publicationDate?: string;
      publisher?: string;
      isbn?: string;
      oclc?: string;
    }[];
  };
}

interface ReadingProgress {
  bookId: string;
  locator: string;
  progressFraction?: number;
  chapterLabel?: string;
  updatedAt: string;
}

interface DesktopStateSnapshot {
  currentLibrary: string | null;
  recentLibraries: string[];
}

// GET /api/v1/storage — typeshared from spine-api/src/v1.rs StorageInfo
// (Phase A endpoint). Numeric fields are u64 / Option<i64>
// in Rust; JSON marshals to TypeScript number / number|null.
interface StorageInfo {
  spineDbBytes: number;
  metadataDbBytes: number;
  coversBytes: number;
  bookCount: number;
  lastImportAtMs: number | null;
}

// GET /api/v1/jobs/summary — typeshared from spine-api/src/v1.rs JobsSummary.
// Aggregated counts over the in-memory job-status map.
interface JobsSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

// GET /api/v1/loc/cache_status — Phase A option-2 stub. Always
// `present: false` until the LoC cache layer ships.
interface LocCacheStatus {
  present: boolean;
  entries: number;
  lastRefreshedAtMs: number | null;
}

// GET /api/v1/library/list — Phase A endpoint #4. Server-first
// snapshot of recent + current libraries. Hydrated from Tauri's
// DesktopConfig at boot via `push_recent_library`.
interface LibraryList {
  recent: string[];
  current: string | null;
}

type SortKey = "lastOpened" | "added" | "title" | "author" | "pubDate" | "workDate";
type SortDir = "asc" | "desc";

interface SortOption {
  key: SortKey;
  label: string;
}

const SORT_OPTIONS: readonly SortOption[] = [
  { key: "lastOpened", label: "Last opened" },
  { key: "added", label: "Date added" },
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "pubDate", label: "Publication date" },
  { key: "workDate", label: "Work date (origin)" },
] as const;

// Re-exported shim so existing call sites that use the local identifier keep
// working. New code should import from `./api` directly.
const callApiJson = bridgeCallApiJson;

// Above this many books in the library, the search bar falls back to server-
// side `GET /book?q=...` on a debounce instead of filtering the full list in
// memory. Named so it's easy to tune when we have real corpus numbers.
const SERVER_SEARCH_THRESHOLD = 1000;
const SEARCH_DEBOUNCE_MS = 250;

function App() {
  const [library, setLibrary] = useState<Book[]>([]);
  const [desktopState, setDesktopState] = useState<DesktopStateSnapshot | null>(null);
  const [readingProgressByBookId, setReadingProgressByBookId] = useState<Record<string, ReadingProgress>>({});
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryErrorModal, setLibraryErrorModal] = useState<
    { kind: LibraryErrorKind; attemptedPath: string } | null
  >(null);
  const [isOpeningLibrary, setIsOpeningLibrary] = useState(false);
  // Multi-select model. `selectedIds` is the canonical set; `primarySelectedId`
  // tracks the "anchor for single-book affordances" (Inspector, Reader,
  // keyboard nav). `selectionAnchor` is the source for shift-click range —
  // last single-click target. Plain click resets all three; ⌘/Ctrl-click
  // toggles set membership; Shift-click extends from anchor through `sortedBooks`.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"design" | "legacy" | "spine" | "inferred">("design");
  const [isReaderOpen, setIsReaderOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [navSection, setNavSection] = useState<"core" | "sidecar" | "reading">("core");
  const [sidebarActiveId, setSidebarActiveId] = useState<string>("library:all");
  // Shelves section state lives inside useShelvesSection (localStorage-
  // backed until Sprint M3 backend ships). Returns a fully-formed
  // SidebarSection ready to splice into sidebarSections.
  const shelvesSection = useShelvesSection({
    activeId: sidebarActiveId,
    onShelfSelect: () => {
      /* row clicks routed via handleSidebarSelect's shelf: branch */
    },
  });

  // BROWSE section — five faceted top-levels (author/tag/series/publisher/
  // language) lazily fetched from `GET /api/v1/library/facets?facet=`.
  // Click handler resolved via `browseSection.handleClick` inside
  // `handleSidebarSelect`. Per the project roadmap §S13 step 1.
  const browseSection = useFacetBrowserSection({
    activeId: sidebarActiveId,
    onFacetSelect: (facet, value) => {
      setSearchQuery(`${facet}:${value}`);
      setNavSection("core");
    },
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showLibrarySwitcher, setShowLibrarySwitcher] = useState(false);

  const [candidates, setCandidates] = useState<any[]>([]);
  const [isFetchingCandidates, setIsFetchingCandidates] = useState(false);

  // Server-side search fallback (for libraries above SERVER_SEARCH_THRESHOLD).
  // When populated, the rendered list uses these results instead of the
  // client-side filter over the full `library`. `null` means "no backend
  // result yet — fall through to client filter."
  const [serverSearchResults, setServerSearchResults] = useState<Book[] | null>(null);
  const [serverSearchError, setServerSearchError] = useState(false);
  const searchDebounceRef = useRef<number | null>(null);

  // Remove dialog + single-book-edit plumbing.
  const [removeTarget, setRemoveTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [addSubjectTarget, setAddSubjectTarget] = useState<{ id: string; title: string } | null>(null);
  const [isSavingSubject, setIsSavingSubject] = useState(false);
  const [addInstanceTarget, setAddInstanceTarget] = useState<{ id: string; title: string } | null>(null);
  const [isSavingInstance, setIsSavingInstance] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [batchReconcileProgress, setBatchReconcileProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchRemoveConfirm, setBatchRemoveConfirm] = useState<string[] | null>(null);
  const [batchRemoveDeleteFiles, setBatchRemoveDeleteFiles] = useState(false);
  const [editMetadataTarget, setEditMetadataTarget] = useState<Book | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Jobs activity token — bumped whenever a new job is dispatched so the
  // JobsIndicator re-fetches the list. Idle libraries don't poll.
  const [jobsActivityToken, setJobsActivityToken] = useState(0);

  // Footer storage stats — refreshed on init + on library size change.
  // Endpoint may not exist on builds prior to T4 Phase A; null on error
  // so Footer renders em-dash placeholders gracefully.
  const [storageStats, setStorageStats] = useState<StorageInfo | null>(null);
  const [jobsSummary, setJobsSummary] = useState<JobsSummary | null>(null);
  const [locCacheStatus, setLocCacheStatus] = useState<LocCacheStatus | null>(null);
  const [libraryList, setLibraryList] = useState<LibraryList | null>(null);

  // Facet browser refresh token — bumped whenever the library changes so the
  // browser re-fetches any currently-expanded facet list.
  const [facetRefreshToken, setFacetRefreshToken] = useState(0);

  // Reconcile drawer — open/close, latest pending count, and an
  // explicit-minimize flag. The minimize flag suppresses auto-open
  // after the user has dismissed the drawer at least once this
  // session, so a steady stream of new pending rows doesn't keep
  // popping the drawer back into their face.
  const [showReconcileDrawer, setShowReconcileDrawer] = useState(false);
  const [reconcileMinimized, setReconcileMinimized] = useState(false);
  const [reconcilePendingCount, setReconcilePendingCount] = useState(0);
  const [showFacets, setShowFacets] = useState(false);

  const showToast = (msg: string, durationMs = 3000) => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, durationMs);
  };
  const [initialized, setInitialized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [ingestStatus, setIngestStatus] = useState<string | null>(null);
  const [viewMode, setViewMode] = usePersistentState<"grid" | "hybrid" | "list" | "graph" | "timeline">("spine.viewMode", "hybrid");
  const [density, setDensity] = usePersistentState<Density>("spine.density", "balanced");
  const [sortKey, setSortKey] = usePersistentState<SortKey>("spine.sortKey", "lastOpened");
  const [sortDir, setSortDir] = usePersistentState<SortDir>("spine.sortDir", "desc");
  const [theme, setTheme] = usePersistentState<"auto" | "dark" | "light">("spine.theme", "auto");
  // Sidebar collapse state — `false` renders full Sidebar, `true`
  // renders the 56px SidebarRail. Persisted across sessions.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState<boolean>("spine.sidebarCollapsed", false);
  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>("spine.sidebarWidth", 240);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  // Brief visual acknowledgement when a book is selected so first-time users
  // who click a card notice the inspector populated on the right.
  const [inspectorPulse, setInspectorPulse] = useState(false);

  // Tracks the live setInterval handle for job-status polling so we can
  // clear it on completion AND on component unmount. A single interval
  // iterates through every pending job each tick so dropping N EPUBs at
  // once doesn't orphan N-1 pollers.
  const pollIntervalRef = useRef<number | null>(null);
  const pendingJobIdsRef = useRef<string[]>([]);
  const ingestTotalsRef = useRef<{ completed: number; failed: number; queued: number }>({
    completed: 0,
    failed: 0,
    queued: 0
  });

  useEffect(() => {
    let cancelled = false;
    let unlistenFns: Array<() => void> = [];

    const initializeDesktop = async () => {
      try {
        const state = await invoke<DesktopStateSnapshot>("get_desktop_state");
        if (cancelled) return;
        setDesktopState(state);
        if (state.currentLibrary) {
          await refreshLibrary(state);
        } else {
          setInitialized(true);
        }
      } catch (err) {
        console.error("Failed to load desktop state:", err);
        if (!cancelled) {
          setInitialized(true);
          setLibraryError(humanizeBackendError(String(err)));
        }
      }

      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlistenFns.push(await listen("tauri://drag-enter", () => {
          setIsDragging(true);
        }));
        unlistenFns.push(await listen("tauri://drag-leave", () => {
          setIsDragging(false);
        }));
        unlistenFns.push(await listen("tauri://drag-drop", async (event: any) => {
          setIsDragging(false);
          const payload = event.payload;
          const paths: string[] | null = Array.isArray(payload?.paths)
            ? payload.paths
            : Array.isArray(payload)
              ? payload
              : null;
          if (!paths) {
            console.warn("Unexpected drag-drop payload shape:", payload);
            return;
          }
          if (paths.length === 0) return;

          await ingestPaths(paths);
        }));
      }).catch(e => console.error("Event listener error:", e));
    };

    void initializeDesktop();

    return () => {
      cancelled = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      pendingJobIdsRef.current = [];
      ingestTotalsRef.current = { completed: 0, failed: 0, queued: 0 };
    };
  }, []);

  // Ctrl/Cmd+O mirrors the footer Add EPUBs button for keyboard-only users.
  // The handler reads addEpubs off a ref so we don't recreate the listener
  // every render (addEpubs closes over multiple state setters).
  const addEpubsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Same ref pattern for ingestPaths so the bootstrap "Add folder of EPUBs"
  // handler reaches the latest ingestPaths without recreating callbacks.
  const ingestPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  // Same pattern for refreshLibrary — callbacks wrapped in useCallback with
  // stable deps must reach the latest refreshLibrary (which closes over
  // desktopState) via this ref, not via closure.
  const refreshLibraryRef = useRef<(state?: DesktopStateSnapshot | null) => Promise<void>>(async () => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isOpenShortcut = (e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "O");
      if (!isOpenShortcut) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      void addEpubsRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Theme — flip `data-theme` on documentElement so the SPINE token
  // CSS-variables resolve through the right palette (dark / light).
  // "auto" follows the OS via `prefers-color-scheme`; explicit
  // dark/light overrides the OS hint. Persists to localStorage; the
  // SPINE.* string values stay theme-invariant (each is a
  // `var(--spine-*)` reference).
  useEffect(() => {
    if (theme !== "auto") {
      document.documentElement.dataset.theme = theme;
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme = mql.matches ? "light" : "dark";
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [theme]);

  // Footer storage-stats fetch. Re-runs when the library size changes
  // so a 50-book ingest updates the Footer in real time. Endpoint may
  // not exist on older spine-srv builds — failure leaves storageStats
  // null and the Footer falls back to em-dash placeholders.
  useEffect(() => {
    let cancelled = false;
    bridgeCallApiJson<StorageInfo>("GET", "/api/v1/storage")
      .then((info) => {
        if (!cancelled) setStorageStats(info);
      })
      .catch(() => {
        if (!cancelled) setStorageStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [library.length, desktopState?.currentLibrary]);

  // StatusBar jobs ticker — polls `/api/v1/jobs/summary`. Bumps on
  // `jobsActivityToken` (every dispatch) AND on a 2s interval while
  // any job is pending/running, otherwise idles (no poll until next
  // activity bump). Endpoint may 404 on older builds — null on error.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const fetchOnce = async () => {
      try {
        const summary = await bridgeCallApiJson<JobsSummary>("GET", "/api/v1/jobs/summary");
        if (cancelled) return;
        setJobsSummary(summary);
        if (summary.pending + summary.running > 0) {
          timer = window.setTimeout(fetchOnce, 2000);
        }
      } catch {
        if (!cancelled) setJobsSummary(null);
      }
    };

    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [jobsActivityToken]);

  // StatusBar LoC cache cell — single fetch on mount. The Phase A
  // stub returns `{ present: false, entries: 0, lastRefreshedAtMs: null }`
  // until the cache layer lands; we render "loc cache · not enabled".
  useEffect(() => {
    let cancelled = false;
    bridgeCallApiJson<LocCacheStatus>("GET", "/api/v1/loc/cache_status")
      .then((info) => {
        if (!cancelled) setLocCacheStatus(info);
      })
      .catch(() => {
        if (!cancelled) setLocCacheStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopState?.currentLibrary]);

  // TitleBar library-switcher dropdown — reads `GET /api/v1/library/list`
  // (Phase A endpoint #4), the server-first source of truth.
  // Falls back to `desktopState.recentLibraries` (Tauri-side cache) when
  // the endpoint isn't on the build, so older MSI installs still see
  // their recents in the dropdown.
  useEffect(() => {
    let cancelled = false;
    bridgeCallApiJson<LibraryList>("GET", "/api/v1/library/list")
      .then((info) => {
        if (!cancelled) setLibraryList(info);
      })
      .catch(() => {
        if (!cancelled) setLibraryList(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopState?.currentLibrary]);

  // ⌘A / Ctrl-A — select every book in the visible (sorted) list.
  // Escape clears the selection. Both skipped when an input is focused
  // so they don't shadow form-input copy/paste/cancel semantics.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const list = sortedBooksRef.current;
        if (list.length === 0) return;
        setSelectedIds(new Set(list.map((b) => b.id)));
        // Anchor + primary stay at the previously-selected one; if none, last item
        if (!primarySelectedId) {
          setPrimarySelectedId(list[list.length - 1].id);
          setSelectionAnchor(list[0].id);
        }
        return;
      }
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (selectedIds.size === 0) return;
        // Don't preventDefault — let other Escape handlers (palette, dialogs)
        // also run. Clear selection silently.
        setSelectedIds(new Set());
        setSelectionAnchor(null);
        setPrimarySelectedId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [primarySelectedId, selectedIds.size]);

  // Keyboard nav across the visible book list — ↑↓ / J K / Home End /
  // PageUp PageDown move selection by 1 / 10 / first-last; Enter opens
  // the reader. Skipped when an input/textarea/contentEditable is
  // focused, when no books are visible, or when viewMode is graph/
  // timeline (those views own their own keymap). Reads `sortedBooks`
  // off a ref because the memo is declared further down in the file
  // and the listener needs the latest value on each keystroke without
  // re-binding per-sort change.
  const sortedBooksRef = useRef<BookProjection[]>([]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (viewMode === "graph" || viewMode === "timeline") return;
      const list = sortedBooksRef.current;
      if (list.length === 0) return;

      const currentIdx = primarySelectedId ? list.findIndex((b) => b.id === primarySelectedId) : -1;
      let newIdx = currentIdx;

      switch (e.key) {
        case "ArrowDown":
        case "j":
        case "J":
          newIdx = currentIdx < 0 ? 0 : Math.min(list.length - 1, currentIdx + 1);
          break;
        case "ArrowUp":
        case "k":
        case "K":
          newIdx = currentIdx <= 0 ? Math.max(0, currentIdx) : currentIdx - 1;
          break;
        case "Home":
          newIdx = 0;
          break;
        case "End":
          newIdx = list.length - 1;
          break;
        case "PageDown":
          newIdx = Math.min(list.length - 1, (currentIdx < 0 ? 0 : currentIdx) + 10);
          break;
        case "PageUp":
          newIdx = Math.max(0, (currentIdx < 0 ? 0 : currentIdx) - 10);
          break;
        case "Enter":
          if (primarySelectedId) {
            e.preventDefault();
            setIsReaderOpen(true);
          }
          return;
        default:
          return;
      }

      e.preventDefault();
      if (newIdx >= 0 && newIdx < list.length) {
        const newId = list[newIdx].id;
        if (newId !== primarySelectedId) {
          selectBook(newId);
          // Scroll the newly-selected row into view if it's offscreen.
          // Grids tag rows with `data-book-id`; querying after a frame
          // gives React time to re-render the selected styling.
          window.requestAnimationFrame(() => {
            const el = document.querySelector(`[data-book-id="${newId}"]`);
            if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
              (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" });
            }
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [primarySelectedId, viewMode]);

  // F2 inline rename — only when a book is selected and the user
  // isn't typing in an input. Mirrors design's "F2 rename" hint in
  // the StatusBar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const id = primarySelectedId;
      if (!id) return;
      const book = library.find((b) => b.id === id);
      if (!book) return;
      e.preventDefault();
      setRenameTarget({ id: book.id, title: book.title });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [primarySelectedId, library]);

  // / — focus the TitleBar search input. Vim-style; does nothing when
  // focus is already in an input. Matches the palette command at
  // `Focus search · /`.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const input =
        document.querySelector<HTMLInputElement>('input[placeholder="search…"]') ??
        document.querySelector<HTMLInputElement>('input[aria-label="Search library"]');
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌘F / Ctrl-F also focuses search — match the universal "find" idiom.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
          return;
        }
        const input =
          document.querySelector<HTMLInputElement>('input[placeholder="search…"]') ??
          document.querySelector<HTMLInputElement>('input[aria-label="Search library"]');
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌘K / Ctrl-K toggles the command palette. Accepts key even inside
  // inputs so the user's muscle-memory works from the search field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setIsPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌘\ / Ctrl-\ toggles the sidebar between full + rail. Mirrors
  // VSCode's primary-sidebar shortcut so the muscle-memory is free.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const paletteCommands = useMemo(
    () =>
      registerCommands({
        onAddFolder: () => void addEpubsRef.current(),
        onFocusSearch: () => {
          // Match the TitleBar search input (placeholder "search…").
          const input =
            document.querySelector<HTMLInputElement>('input[placeholder="search…"]') ??
            document.querySelector<HTMLInputElement>('input[aria-label="Search library"]');
          input?.focus();
        },
        onSwitchView: (v) => setViewMode(v),
        onToggleFacets: () => setShowFacets((s) => !s),
        onRefresh: () => void refreshLibraryRef.current(),
        onSyncCalibre: () => {
          setIngestStatus("Syncing with calibre…");
          callApiJson<{ jobs_dispatched: number }>("POST", "/api/v1/sync/calibre")
            .then((data) => {
              setIngestStatus(`Dispatched ${data.jobs_dispatched} sync jobs.`);
              setTimeout(() => setIngestStatus(null), 3000);
              void refreshLibraryRef.current();
            })
            .catch((err) => {
              setIngestStatus(`Sync failed: ${humanizeBackendError(err)}`);
              setTimeout(() => setIngestStatus(null), 5000);
            });
        },
      }),
    [setViewMode]
  );

  // Render the aggregate ingest status line. Users dropping 50 books want a
  // progress counter, not 50 toasts scrolling past.
  const renderIngestProgress = (rejectedNote: string = "") => {
    const { completed, failed, queued } = ingestTotalsRef.current;
    const total = completed + failed + queued;
    if (total === 0) return;
    if (queued === 0) {
      if (failed === 0) {
        setIngestStatus(`Ingestion complete: ${completed}/${total}${rejectedNote}`);
      } else {
        setIngestStatus(`Ingestion done: ${completed}/${total} complete · ${failed} failed${rejectedNote}`);
      }
      setTimeout(() => setIngestStatus(null), 5000);
    } else {
      const failedPart = failed > 0 ? ` · ${failed} failed` : "";
      setIngestStatus(`Ingesting: ${completed}/${total} complete${failedPart}${rejectedNote}`);
    }
  };

  // Polls every pending backend job on a single 1s interval. Each tick calls
  // the status endpoint for every id in `pendingJobIdsRef`, bucketing results
  // into completed/failed and dropping finished ids from the queue. The old
  // implementation spawned one interval per call and the setInterval ref was
  // overwritten on every call — for N books dropped at once only the last
  // interval survived and the other N-1 toasts never fired.
  const pollJobStatus = (jobId: string, rejectedNote: string = "") => {
    pendingJobIdsRef.current = [...pendingJobIdsRef.current, jobId];
    ingestTotalsRef.current = {
      ...ingestTotalsRef.current,
      queued: ingestTotalsRef.current.queued + 1
    };
    renderIngestProgress(rejectedNote);

    if (pollIntervalRef.current !== null) {
      return; // Interval already running; new job joins the queue.
    }

    const startedAt = Date.now();
    const maxWallMs = 120_000; // 2 minutes per batch, same budget as before.

    const handle = window.setInterval(async () => {
      if (pendingJobIdsRef.current.length === 0) {
        clearInterval(handle);
        if (pollIntervalRef.current === handle) {
          pollIntervalRef.current = null;
        }
        return;
      }
      if (Date.now() - startedAt > maxWallMs) {
        const stranded = pendingJobIdsRef.current.length;
        pendingJobIdsRef.current = [];
        clearInterval(handle);
        if (pollIntervalRef.current === handle) {
          pollIntervalRef.current = null;
        }
        setIngestStatus(`Ingestion timed out — ${stranded} job${stranded === 1 ? "" : "s"} still running in background. Refresh to check.`);
        setTimeout(() => setIngestStatus(null), 5000);
        ingestTotalsRef.current = { completed: 0, failed: 0, queued: 0 };
        return;
      }

      const stillPending: string[] = [];
      let finishedThisTick = 0;
      for (const id of pendingJobIdsRef.current) {
        try {
          const res = await invoke<string>("call_api", { method: "GET", path: `/api/v1/jobs/${id}` });
          const status = JSON.parse(res);
          if (status.status === "completed") {
            ingestTotalsRef.current = {
              ...ingestTotalsRef.current,
              queued: Math.max(0, ingestTotalsRef.current.queued - 1),
              completed: ingestTotalsRef.current.completed + 1
            };
            finishedThisTick += 1;
          } else if (status.status === "failed") {
            console.error(`Ingest job ${id} failed:`, status.result);
            ingestTotalsRef.current = {
              ...ingestTotalsRef.current,
              queued: Math.max(0, ingestTotalsRef.current.queued - 1),
              failed: ingestTotalsRef.current.failed + 1
            };
            finishedThisTick += 1;
          } else {
            stillPending.push(id);
          }
        } catch {
          // Transient fetch error — keep the job in the pending list.
          stillPending.push(id);
        }
      }
      pendingJobIdsRef.current = stillPending;

      if (finishedThisTick > 0 && ingestTotalsRef.current.queued === 0) {
        renderIngestProgress(rejectedNote);
        // Library only needs refreshing once, at the end of the batch.
        // Go through the ref so a library-switch during ingest doesn't
        // make us refresh the old library via a stale closure.
        void refreshLibraryRef.current();
        ingestTotalsRef.current = { completed: 0, failed: 0, queued: 0 };
      } else {
        renderIngestProgress(rejectedNote);
      }

      if (pendingJobIdsRef.current.length === 0) {
        clearInterval(handle);
        if (pollIntervalRef.current === handle) {
          pollIntervalRef.current = null;
        }
      }
    }, 1000);
    pollIntervalRef.current = handle;
  };

  // Shared ingest path for drag-drop and the Add EPUBs dialog. Filters out
  // non-EPUBs, dispatches each accepted path, and lets pollJobStatus handle
  // the aggregate progress UI.
  const ingestPaths = async (paths: string[]) => {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const path of paths) {
      if (path.toLowerCase().endsWith(".epub")) {
        accepted.push(path);
      } else {
        rejected.push(path);
      }
    }

    const rejectedNote = formatRejected(rejected);

    if (accepted.length === 0) {
      setIngestStatus(`No EPUBs to ingest.${rejectedNote}`);
      setTimeout(() => setIngestStatus(null), 5000);
      return;
    }

    setIngestStatus(`Dispatching ${accepted.length} EPUB${accepted.length === 1 ? "" : "s"}...${rejectedNote}`);
    for (const path of accepted) {
      try {
        const jobId = await invoke<string>("dispatch_ingest_local", { path });
        pollJobStatus(jobId, rejectedNote);
        setJobsActivityToken(t => t + 1);
      } catch (e) {
        ingestTotalsRef.current = {
          ...ingestTotalsRef.current,
          failed: ingestTotalsRef.current.failed + 1
        };
        console.error("dispatch_ingest_local failed:", e);
        setIngestStatus(`Failed: ${humanizeBackendError(e)}`);
        setTimeout(() => setIngestStatus(null), 5000);
      }
    }
  };
  ingestPathsRef.current = ingestPaths;

  const addEpubs = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB", extensions: ["epub"] }]
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      await ingestPaths(paths);
    } catch (err) {
      console.error("Add EPUBs dialog failed:", err);
      setIngestStatus(`Add EPUBs failed: ${humanizeBackendError(String(err))}`);
      setTimeout(() => setIngestStatus(null), 5000);
    }
  };
  addEpubsRef.current = addEpubs;

  // Set primary + selectedIds to a single book. Used by code paths that
  // logically replace the selection (post-ingest auto-select, candidate
  // accept, deletion fallback, etc.). Functional-updater form supported.
  const selectSingle = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      setPrimarySelectedId((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        setSelectedIds(resolved == null ? new Set<string>() : new Set([resolved]));
        setSelectionAnchor(resolved);
        return resolved;
      });
    },
    []
  );

  // Mode-aware select for grid click handlers. `replace` = plain click
  // (this becomes the only selection); `toggle` = ⌘/Ctrl-click (add or
  // remove from set); `range` = Shift-click (extend from anchor through
  // current target via `sortedBooks` indices). Always updates the
  // `primarySelectedId` to the freshly-clicked id so single-book
  // affordances anchor on the latest interaction.
  const selectWithMode = useCallback(
    (bookId: string, mode: "replace" | "toggle" | "range") => {
      if (mode === "replace") {
        setSelectedIds(new Set([bookId]));
        setSelectionAnchor(bookId);
        setPrimarySelectedId(bookId);
        setInspectorPulse(true);
        window.setTimeout(() => setInspectorPulse(false), 500);
        return;
      }
      if (mode === "toggle") {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(bookId)) next.delete(bookId);
          else next.add(bookId);
          return next;
        });
        setSelectionAnchor(bookId);
        setPrimarySelectedId(bookId);
        return;
      }
      // range
      setSelectedIds((prev) => {
        const list = sortedBooksRef.current;
        const anchor = selectionAnchor ?? bookId;
        const a = list.findIndex((b) => b.id === anchor);
        const t = list.findIndex((b) => b.id === bookId);
        if (a < 0 || t < 0) {
          // Anchor or target not in current view; degrade to replace.
          return new Set([bookId]);
        }
        const lo = Math.min(a, t);
        const hi = Math.max(a, t);
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(list[i].id);
        return next;
      });
      setPrimarySelectedId(bookId);
    },
    [selectionAnchor]
  );

  // Flash the inspector briefly when a book is selected — a no-op if the
  // user is rapid-clicking; the timeout resets cleanly. Existing callers
  // expect single-select semantics.
  const selectBook = (bookId: string) => selectWithMode(bookId, "replace");

  const refreshLibrary = async (stateOverride?: DesktopStateSnapshot | null) => {
    const activeDesktopState = stateOverride ?? desktopState;
    if (!activeDesktopState?.currentLibrary) {
      setLibrary([]);
      setReadingProgressByBookId({});
      selectSingle(null);
      setInitialized(true);
      return;
    }

    try {
      const [books, progressEntries] = await Promise.all([
        callApiJson<Book[]>("GET", "/api/v1/book"),
        callApiJson<ReadingProgress[]>("GET", "/api/v1/reading-progress")
      ]);
      const progressByBookId = Object.fromEntries(progressEntries.map(entry => [entry.bookId, entry]));
      setLibrary(books);
      setReadingProgressByBookId(progressByBookId);
      selectSingle(prev => books.some(book => book.id === prev) ? prev : books[0]?.id ?? null);
      setFacetRefreshToken(t => t + 1);
    } catch (err) {
      console.error("Failed to fetch library:", err);
    } finally {
      setInitialized(true);
    }
  };
  refreshLibraryRef.current = refreshLibrary;

  // Handlers for Remove / Save-edit / Export. Hoisted so they're visible in
  // the JSX section below without re-declaring on every render.
  const handleRemoveConfirmed = useCallback((result: DeletedBook) => {
    // Remove the book from local state immediately — waiting on refreshLibrary
    // means a beat of stale UI.
    setLibrary(prev => prev.filter(b => b.id !== result.uuid));
    selectSingle(prev => (prev === result.uuid ? null : prev));
    const fileNote = result.deletedFiles.length > 0
      ? ` (${result.deletedFiles.length} file${result.deletedFiles.length === 1 ? "" : "s"} deleted)`
      : "";
    const failedDeletes = result.failedFileDeletes ?? [];
    if (failedDeletes.length > 0) {
      // The DB commit already happened — the book is gone from the library.
      // Warn the user that some on-disk files could not be removed so they
      // can clean them up manually.
      showToast(
        `Book removed from library${fileNote}, but ${failedDeletes.length} file${failedDeletes.length === 1 ? "" : "s"} could not be deleted from disk`,
        6000
      );
    } else {
      showToast(`Book removed${fileNote}`);
    }
    void refreshLibraryRef.current();
  }, []);

  const handleSaveEdit = useCallback(async (bookId: string, draftGraph: any) => {
    if (!draftGraph) return;
    setIsSavingEdit(true);
    try {
      const selected = library.find(b => b.id === bookId);
      if (!selected) throw new Error("Selected book no longer in library");
      const draftTitle = draftGraph.work.title ?? selected.title;
      const draftAuthors = (draftGraph.work.creators as any[] | undefined)?.map(c => c.name) ?? selected.authors;
      const draftTags = (draftGraph.work.subjects as any[] | undefined)?.map(s => s.label) ?? selected.legacyMetadata.tags;
      const draftPublisher = draftGraph.instances?.[0]?.publisher;
      const draftPubDate = draftGraph.instances?.[0]?.publicationDate
        ?? draftGraph.work.originDate;
      const projection = diffProjection(
        {
          title: selected.title,
          authors: selected.authors,
          tags: selected.legacyMetadata.tags ?? [],
          series: selected.legacyMetadata.series,
          seriesIndex: selected.legacyMetadata.seriesIndex,
          publisher: selected.legacyMetadata.publisher,
          pubDate: selected.legacyMetadata.pubDate,
          language: selected.bibliographicGraph?.work.language
        },
        {
          title: draftTitle,
          authors: draftAuthors,
          tags: draftTags,
          publisher: draftPublisher ?? null,
          pubDate: draftPubDate ?? null,
          language: draftGraph.work.language
        }
      );
      // Ensure the graph carries a work_uri and instance_uri. For
      // local-minted URIs (urn:spine:work:<uuid>) these are already set.
      // For LoC-sourced URIs the work_uri is an id.loc.gov IRI — send it
      // unmodified; the backend's validate_work_uri accepts HTTP/HTTPS URIs
      // from LoC without requiring the UUID to appear in the URI.
      // Do NOT append fragments (#) to work_uri — the backend rejects them.
      const graph = { ...draftGraph };
      if (!graph.workUri) {
        graph.workUri = graph.work?.uri ?? `urn:spine:work:${bookId}`;
      }
      if (!graph.instanceUri) {
        graph.instanceUri = graph.instances?.[0]?.uri ?? `urn:spine:instance:${bookId}`;
      }

      await callApi("PUT", `/api/v1/book/${bookId}/metadata/fields`, {
        graph,
        projection,
        bookUuid: bookId
      });
      showToast("Saved", 2000);
      // Refresh just the edited book so the inspector reflects the new state.
      try {
        const updated = await bridgeCallApiJson<Book>("GET", `/api/v1/book/${bookId}`);
        if (updated) {
          setLibrary(prev => prev.map(b => (b.id === bookId ? updated : b)));
          setFacetRefreshToken(t => t + 1);
        }
      } catch (err) {
        console.error("Failed to refresh edited book:", err);
      }
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 413) {
          showToast("Edit too large — try fewer changes at once.", 5000);
        } else if (err.status === 400 && /work_uri/i.test(err.message)) {
          console.error("UUID mismatch on edit save:", err);
          showToast("Internal error — please report.", 5000);
        } else if (err.status === 503) {
          showToast("Library not loaded.", 4000);
        } else {
          showToast(`Save failed (${err.status || "network"}): ${err.message}`, 5000);
        }
      } else {
        showToast(`Save failed: ${String(err)}`, 5000);
      }
    } finally {
      setIsSavingEdit(false);
    }
  }, [library]);

  // S13 step 3+5: folder-export per the project roadmap §S13. Calls
  // `POST /api/v1/book/:id/export?dest=<dir>` so the server lays out
  // `<dir>/<Author>/<Title>/<Title>.epub|.opf` per the fixed template.
  // Returns the per-book result so callers can aggregate partial
  // failures across batches.
  const handleExportBookToFolder = useCallback(
    async (bookId: string, destDir: string) => {
      const path = `/api/v1/book/${bookId}/export?dest=${encodeURIComponent(destDir)}`;
      await callApi("POST", path);
    },
    [],
  );

  // S13 step 3: single-book "Save to disk" — opens a folder picker
  // and exports a single book at `<dir>/<Author>/<Title>/<Title>.epub|.opf`.
  // Replaces the legacy zip-file flow on Inspector "Save to disk" buttons.
  const handleExportBookWithPicker = useCallback(
    async (bookId: string, bookTitle: string) => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const dir = await open({ directory: true, multiple: false });
        if (!dir || Array.isArray(dir)) return;
        try {
          await handleExportBookToFolder(bookId, dir);
          showToast(`Saved "${bookTitle}" to ${dir}`, 4000);
        } catch (err) {
          const apiErr = err as { status?: number; message?: string };
          if (apiErr?.status === 404) {
            showToast("Book has no format files to export.", 5000);
          } else if (apiErr?.status === 400) {
            showToast(`Export rejected: ${apiErr.message ?? "invalid destination"}`, 5000);
          } else if (apiErr?.status === 503) {
            showToast("Library not loaded.", 4000);
          } else {
            showToast(`Export failed: ${humanizeBackendError(err)}`, 5000);
          }
        }
      } catch (err) {
        console.error("Folder picker failed:", err);
        showToast(`Export failed: ${humanizeBackendError(String(err))}`, 5000);
      }
    },
    [handleExportBookToFolder],
  );

  const handleExportBook = useCallback(async (bookId: string, defaultName: string) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({
        defaultPath: defaultName,
        filters: [{ name: "Zip archive", extensions: ["zip"] }]
      });
      if (!chosen) {
        setIsExporting(false);
        return;
      }
      try {
        await invoke<null>("export_book_to_disk", { bookId, destPath: chosen });
        showToast(`Saved to ${chosen}`, 4000);
      } catch (err) {
        const parsed = String(err);
        if (parsed.includes("404") || /no on-disk format files/i.test(parsed)) {
          showToast("Book has no format files to export.", 5000);
        } else if (parsed.includes("503")) {
          showToast("Library not loaded.", 4000);
        } else {
          showToast(`Export failed: ${parsed}`, 5000);
        }
      }
    } catch (err) {
      console.error("Save dialog failed:", err);
      showToast(`Export failed: ${humanizeBackendError(String(err))}`, 5000);
    } finally {
      setIsExporting(false);
    }
  }, [isExporting]);

  const handleFacetSelect = useCallback((_: FacetKind, name: string) => {
    setSearchQuery(name);
    setNavSection("core");
  }, []);

  const openLibrary = async (metadataDbPath: string) => {
    setIsOpeningLibrary(true);
    setLibraryError(null);
    setLibraryErrorModal(null);
    try {
      const state = await invoke<DesktopStateSnapshot>("open_library", { metadataDbPath });
      setDesktopState(state);
      selectSingle(null);
      await refreshLibrary(state);
    } catch (err) {
      // Sprint 8.5 hot-fix: route Uninitialized / WrongDatabaseFile to the
      // recovery modal instead of the bare error string. Other errors fall
      // through to the existing libraryError display.
      const kind = classifyLibraryError(err);
      if (kind) {
        setLibraryErrorModal({ kind, attemptedPath: metadataDbPath });
      } else {
        setLibraryError(humanizeBackendError(String(err)));
      }
    } finally {
      setIsOpeningLibrary(false);
    }
  };

  const promptSwitchLibrary = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Calibre metadata.db', extensions: ['db'] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await openLibrary(selected);
    } catch (err) {
      console.error("Switch library dialog failed:", err);
      setLibraryError(humanizeBackendError(String(err)));
    }
  };

  // Bootstrap "Start a new library" — user picks a directory, we seed it
  // from the bundled calibre template, ingest the bundled welcome.epub so
  // the library isn't empty on first open, then switch to it.
  const startNewLibrary = async () => {
    setIsOpeningLibrary(true);
    setLibraryError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) {
        setIsOpeningLibrary(false);
        return;
      }
      const state = await invoke<DesktopStateSnapshot>("create_library", { dirPath: selected });
      setDesktopState(state);
      selectSingle(null);
      await refreshLibrary(state);

      // Seed welcome.epub so the fresh library is readable end-to-end on
      // first open, not an empty grid. Route the returned job_id through
      // pollJobStatus so the library grid refreshes automatically when the
      // ingest completes — otherwise the user would see an empty grid for
      // the brief window between refreshLibrary() and ingest-done.
      // Failure here is non-fatal; the library is still usable without the
      // welcome book.
      try {
        const jobId = await invoke<string>("seed_welcome_book");
        setIngestStatus("Ingesting welcome book…");
        pollJobStatus(jobId);
        setJobsActivityToken(t => t + 1);
      } catch (seedErr) {
        console.warn("seed_welcome_book failed (non-fatal):", seedErr);
      }
    } catch (err) {
      setLibraryError(humanizeBackendError(String(err)));
    } finally {
      setIsOpeningLibrary(false);
    }
  };

  // Bootstrap "Add a folder of EPUBs" — user picks a directory that already
  // contains EPUBs. Seed a fresh library in that directory, then ingest
  // every .epub found at the top level.
  const addFolderOfEpubs = async () => {
    setIsOpeningLibrary(true);
    setLibraryError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) {
        setIsOpeningLibrary(false);
        return;
      }
      const state = await invoke<DesktopStateSnapshot>("create_library", { dirPath: selected });
      setDesktopState(state);
      selectSingle(null);

      const epubs = await invoke<string[]>("list_epubs_in_dir", { dir: selected });
      if (epubs.length > 0) {
        setIngestStatus(`Library created. Ingesting ${epubs.length} EPUB${epubs.length === 1 ? "" : "s"}…`);
        await ingestPathsRef.current(epubs);
      } else {
        setIngestStatus("Library created. No EPUBs found in that folder.");
        setTimeout(() => setIngestStatus(null), 5000);
      }
      await refreshLibrary(state);
    } catch (err) {
      setLibraryError(humanizeBackendError(String(err)));
    } finally {
      setIsOpeningLibrary(false);
    }
  };

  const handleProgressSaved = (progress: ReadingProgress) => {
    setReadingProgressByBookId(prev => ({
      ...prev,
      [progress.bookId]: progress
    }));
  };

  const [synthesizedCandidate, setSynthesizedCandidate] = useState<{graph: any, reasoning: string} | null>(null);
  const [editableGraph, setEditableGraph] = useState<any>(null);
  const [rolePicker, setRolePicker] = useState<{x: number, y: number, uri: string} | null>(null);
  const [candIndex, setCandIndex] = useState(0);
  
  const updateRole = (role: string) => {
    if (!rolePicker || !editableGraph) return;
    const newGraph = {...editableGraph};
    const c = newGraph.work.creators.find((c: any) => c.uri === rolePicker.uri);
    if (c) {
      c.role = role;
      setEditableGraph(newGraph);
    }
    setRolePicker(null);
  };

  const handleLookupMetadata = (id: string) => {
    setIsFetchingCandidates(true);
    setCandidates([]);
    setCandIndex(0);
    setSynthesizedCandidate(null);
    setEditableGraph(null);
    invoke<string>("call_api", { 
      method: "GET", 
      path: `/api/v1/book/${id}/candidates`
    })
      .then((res) => {
        const parsed = JSON.parse(res);
        
        let candList = [];
        let synth = null;
        
        if (Array.isArray(parsed)) {
          candList = parsed; // Fallback for old API
        } else if (parsed && parsed.candidates) {
          candList = parsed.candidates;
          synth = parsed.synthesized;
        }

        if (candList.length === 0) {
          setIngestStatus("No authoritative records found at the Library of Congress for this book.");
          setTimeout(() => setIngestStatus(null), 5000);
        } else {
          setCandidates(candList);
          setSynthesizedCandidate(synth);
          if (synth) setEditableGraph(synth.graph);
        }
        setIsFetchingCandidates(false);
      })
      .catch((err) => {
        console.error("Failed to fetch candidates:", err);
        setIngestStatus(`Library of Congress lookup failed: ${humanizeBackendError(err)}`);
        setTimeout(() => setIngestStatus(null), 6000);
        setIsFetchingCandidates(false);
      });
  };

  const handleAcceptCandidate = (id: string, candidate: any) => {
    invoke<string>("call_api", {
      method: "POST",
      path: `/api/v1/book/${id}/metadata`,
      body: JSON.stringify(candidate)
    })
      .then(() => {
        setCandidates([]);
    setCandIndex(0);
        return invoke<string>("call_api", { method: "GET", path: `/api/v1/book/${id}` });
      })
      .then((resString) => {
        const updatedBook = JSON.parse(resString);
        if (updatedBook) {
          setLibrary(prev => prev.map(b => b.id === id ? updatedBook : b));
          setInspectorMode("spine");
        }
      })
      .catch(console.error);
  };

  const sidecarBooks = useMemo(
    () => library.filter(b => !b.bibliographicGraph),
    [library]
  );
  const readingBooks = useMemo(
    () => [...library.filter(b => readingProgressByBookId[b.id])]
      .sort((left, right) => {
        const leftUpdated = new Date(readingProgressByBookId[left.id].updatedAt).getTime();
        const rightUpdated = new Date(readingProgressByBookId[right.id].updatedAt).getTime();
        return rightUpdated - leftUpdated;
      }),
    [library, readingProgressByBookId]
  );

  // Kick off a debounced backend search when the library is large enough to
  // make a client-side scan noticeable. Small libraries (below the threshold)
  // always use the local path — no IPC round-trip, no typing latency.
  useEffect(() => {
    if (navSection !== "core") {
      setServerSearchResults(null);
      setServerSearchError(false);
      return;
    }
    if (library.length < SERVER_SEARCH_THRESHOLD) {
      setServerSearchResults(null);
      setServerSearchError(false);
      return;
    }
    const q = searchQuery.trim();
    if (!q) {
      setServerSearchResults(null);
      setServerSearchError(false);
      return;
    }

    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: "500" });
        const results = await bridgeCallApiJson<Book[]>(
          "GET",
          `/api/v1/book?${params.toString()}`
        );
        setServerSearchResults(results);
        setServerSearchError(false);
      } catch {
        setServerSearchError(true);
        setServerSearchResults(null);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (searchDebounceRef.current !== null) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, [searchQuery, library.length, navSection]);

  const currentBooks = useMemo(() => {
    let source: Book[] = library;
    if (navSection === "sidecar") source = sidecarBooks;
    if (navSection === "reading") source = readingBooks;

    // Prefer server-side results when they came back (large libraries + core
    // section). Fall through to client-side filtering when absent or when
    // the library is small / not the core section.
    if (serverSearchResults !== null && navSection === "core") {
      return serverSearchResults;
    }

    const searchLower = searchQuery.toLowerCase();
    if (!searchLower) return source;

    return source.filter(b => {
      if (b.title.toLowerCase().includes(searchLower)) return true;
      if (b.authors.some(a => a.toLowerCase().includes(searchLower))) return true;
      if (b.legacyMetadata?.publisher?.toLowerCase().includes(searchLower)) return true;
      if (b.legacyMetadata?.tags?.some(t => t.toLowerCase().includes(searchLower))) return true;
      if (b.bibliographicGraph?.work.subjects?.some(s => s.label.toLowerCase().includes(searchLower))) return true;
      return false;
    });
  }, [library, sidecarBooks, readingBooks, navSection, searchQuery, serverSearchResults]);

  const projectedBooks = useMemo(
    () => currentBooks.map(book => projectBook(book, readingProgressByBookId[book.id])),
    [currentBooks, readingProgressByBookId]
  );

  // Apply user-chosen sort across the projected set. Comparators closure
  // over `library` + `readingProgressByBookId` for fields not in the
  // projection (added timestamp, last-opened timestamp). Stable by id
  // when the primary key is equal so the visible order is deterministic
  // across renders.
  const sortedBooks = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpStr = (a: string, b: string) => a.localeCompare(b);
    const byId: Record<string, Book> = {};
    for (const b of library) byId[b.id] = b;

    const keyFn = (p: typeof projectedBooks[number]): string | number => {
      switch (sortKey) {
        case "title":
          return p.title.toLocaleLowerCase();
        case "author":
          return (p.author ?? "").toLocaleLowerCase();
        case "pubDate":
          return p.pubDate ?? "";
        case "workDate":
          return p.workDate ?? "";
        case "added": {
          const ts = (byId[p.id]?.legacyMetadata as { timestamp?: string } | undefined)?.timestamp;
          if (!ts) return 0;
          const t = Date.parse(ts);
          return Number.isNaN(t) ? 0 : t;
        }
        case "lastOpened": {
          const ts = readingProgressByBookId[p.id]?.updatedAt;
          if (!ts) return 0;
          const t = Date.parse(ts);
          return Number.isNaN(t) ? 0 : t;
        }
      }
    };

    return [...projectedBooks].sort((a, b) => {
      const ka = keyFn(a);
      const kb = keyFn(b);
      let primary = 0;
      if (typeof ka === "string" && typeof kb === "string") primary = cmpStr(ka, kb);
      else primary = (ka as number) - (kb as number);
      if (primary !== 0) return primary * dir;
      return cmpStr(a.id, b.id);
    });
  }, [projectedBooks, sortKey, sortDir, library, readingProgressByBookId]);

  // Sync ref so the keyboard-nav handler reads the current visible list.
  sortedBooksRef.current = sortedBooks;

  // Sidebar sections data-driven from current library + reading state.
  // Counts use real numbers where we have them; placeholder zero where the
  // facet/metric isn't wired yet. Items map to navSection via handleSidebarSelect.
  const sidebarSections: SidebarSection[] = useMemo(() => {
    const finishedCount = library.reduce((acc, b) => {
      const frac = readingProgressByBookId[b.id]?.progressFraction ?? 0;
      return frac >= 1 ? acc + 1 : acc;
    }, 0);
    const inProgressCount = readingBooks.length;
    const startedSet = new Set<string>(
      Object.entries(readingProgressByBookId)
        .filter(([, p]) => (p?.progressFraction ?? 0) > 0)
        .map(([id]) => id)
    );
    const unreadCount = library.reduce(
      (acc, b) => (startedSet.has(b.id) ? acc : acc + 1),
      0
    );
    const newArrivalsCount = library.reduce((acc, b) => {
      const ts = (b.legacyMetadata as { timestamp?: string }).timestamp;
      if (!ts) return acc;
      const t = Date.parse(ts);
      if (Number.isNaN(t)) return acc;
      return Date.now() - t < 30 * 86400_000 ? acc + 1 : acc;
    }, 0);

    const authorCounts = new Map<string, { display: string; count: number }>();
    const seriesSet = new Set<string>();
    const subjectCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const b of library) {
      for (const a of b.authors) {
        const key = normalizeName(a);
        const entry = authorCounts.get(key);
        if (entry) entry.count += 1;
        else authorCounts.set(key, { display: a, count: 1 });
      }
      const s = b.legacyMetadata.series;
      if (s) seriesSet.add(s);
      const subj = b.bibliographicGraph?.work?.subjects;
      if (subj) for (const x of subj) if (x.label) subjectCounts.set(x.label, (subjectCounts.get(x.label) ?? 0) + 1);
      const tags = b.legacyMetadata.tags;
      if (tags) for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const topAuthors = Array.from(authorCounts.values())
      .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
      .slice(0, 6);
    const topSubjects = Array.from(subjectCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);

    const isEmpty = library.length === 0;
    const allUnreconciled =
      library.length > 0 &&
      sidecarBooks.length === library.length &&
      library.length >= 5;
    return [
      {
        title: "Library",
        items: [
          { id: "library:all", label: "All books", icon: "books", count: library.length },
          { id: "library:now", label: "Now reading", icon: "now", count: inProgressCount },
          { id: "library:new", label: "New arrivals", icon: "clock", count: newArrivalsCount },
          { id: "library:fin", label: "Finished", icon: "check", count: finishedCount },
          { id: "library:unread", label: "Unread", icon: "circle", count: unreadCount },
        ],
        // Cold-start affordance — shows the "+ Add books" / "Import
        // from Calibre" card when the library is empty so first-run
        // users have an obvious next step. Designer locked the copy
        // verbatim in v2 SidebarColdStart (books === 0 branch).
        footer: isEmpty ? (
          <EmptyStateCard
            heading="An empty shelf."
            body="Drop in EPUBs, point at a Calibre database, or import an OPDS catalog. Spine reconciles against the Library of Congress as it reads."
            primaryCta={{ label: "+ Add books…", onClick: () => void addEpubs() }}
            secondaryCta={{
              label: "Import from Calibre",
              onClick: () => void promptSwitchLibrary(),
            }}
          />
        ) : undefined,
      },
      {
        title: "Agents",
        items: [
          { id: "agents:authors", label: "Authors", icon: "author", count: authorCounts.size },
          ...topAuthors.map((a) => ({
            id: `agents:author:${a.display}`,
            label: normalizeName(a.display),
            indent: 1,
            count: a.count,
          })),
          { id: "agents:translators", label: "Translators", icon: "author", count: 0 },
        ],
      },
      {
        title: "Curation",
        items: [
          { id: "curation:series", label: "Series", icon: "series", count: seriesSet.size },
          { id: "curation:subjects", label: "Subjects (LCSH)", icon: "tag", count: subjectCounts.size },
          ...topSubjects.map(([label, count]) => ({
            id: `curation:subject:${label}`,
            label,
            indent: 1,
            count,
          })),
          { id: "curation:tags", label: "Tags", icon: "tag", count: tagCounts.size },
          ...topTags.map(([label, count]) => ({
            id: `curation:tag:${label}`,
            label,
            indent: 1,
            count,
          })),
        ],
        // Mid-progression nudge — when the library has books but none
        // are reconciled yet, prompt the batch reconcile flow inline.
        // Designer locked this in v2 SidebarColdStart (books === 10
        // branch). Threshold ≥5 chosen so we don't nag at 1-2 books.
        footer: allUnreconciled ? (
          <EmptyStateCard
            variant="callout"
            status={{
              dotTone: SPINE.warn,
              label: `${library.length} books · 0 reconciled`,
            }}
            body="Reconcile against the Library of Congress to populate subjects, classification, and language facets."
            primaryCta={{
              label: "Reconcile all →",
              onClick: () => {
                setSidebarActiveId("maint:reconcile");
                setNavSection("sidecar");
              },
            }}
          />
        ) : undefined,
      },
      shelvesSection,
      browseSection.section,
      {
        title: "Maintenance",
        items: [
          {
            id: "maint:reconcile",
            label: "Needs reconcile",
            icon: "alert",
            count: sidecarBooks.length,
            accent: SPINE.warn,
          },
          {
            id: "maint:missing",
            label: "Missing file",
            icon: "filemiss",
            count: 0,
            accent: SPINE.alert,
          },
        ],
      },
    ];
  }, [library, readingBooks, sidecarBooks, readingProgressByBookId, shelvesSection, browseSection.section]);

  // Rail groups — flattened, top-level destinations only. Each id
  // matches the SidebarItem id so the activeId / onSelect contract
  // stays consistent between rail + full sidebar.
  const railGroups: RailGroup[] = useMemo(() => {
    const inProgressCount = readingBooks.length;
    const shelves = loadShelves()
      .filter((s) => !s.hidden)
      .sort((a, b) => a.order - b.order);
    return [
      {
        items: [
          { id: "library:all", icon: "books", count: library.length || undefined, tooltip: "All books" },
          { id: "library:now", icon: "now", count: inProgressCount || undefined, tooltip: "Now reading" },
          { id: "library:new", icon: "clock", tooltip: "New arrivals" },
        ],
      },
      {
        items: [
          { id: "agents:authors", icon: "author", tooltip: "Authors" },
          { id: "curation:subjects", icon: "tag", tooltip: "Subjects" },
          { id: "curation:series", icon: "series", tooltip: "Series" },
        ],
      },
      {
        items: shelves.map((s) => ({
          id: `shelf:${s.id}`,
          mark: <ShelfMark letter={s.letter} tone={s.tone} size={16} />,
          tooltip: s.label,
        })),
      },
      {
        items: [
          { id: "maint:reconcile", icon: "alert", count: sidecarBooks.length || undefined, tooltip: "Needs reconcile", badge: sidecarBooks.length > 0 },
        ],
      },
    ];
  }, [library.length, readingBooks.length, sidecarBooks.length, shelvesSection]);

  const handleSidebarSelect = useCallback(
    (id: string) => {
      setSidebarActiveId(id);
      // BROWSE section owns its own click semantics (toggle branch /
      // apply facet filter). Short-circuit before the legacy id-prefix
      // branches so a leaf row like `browse:author:Pratchett` doesn't
      // fall through to the sub-item search-filter handlers below.
      if (browseSection.handleClick(id)) return;
      if (id === "library:now") {
        setNavSection("reading");
        return;
      }
      if (id === "maint:reconcile") {
        setNavSection("sidecar");
        return;
      }
      // Indented sub-items in Agents / Curation set a search filter.
      if (id.startsWith("agents:author:")) {
        setSearchQuery(id.slice("agents:author:".length));
        setNavSection("core");
        return;
      }
      if (id.startsWith("curation:subject:")) {
        setSearchQuery(id.slice("curation:subject:".length));
        setNavSection("core");
        return;
      }
      if (id.startsWith("curation:tag:")) {
        setSearchQuery(id.slice("curation:tag:".length));
        setNavSection("core");
        return;
      }
      if (id.startsWith("shelf:")) {
        // Shelf membership filter — until Sprint M3 backend ships
        // shelf-member triples, the filter is a search-string fallback
        // using the shelf label so the row click does *something*. The
        // real wire (memberIds → grid filter) lands with the backend.
        const shelves = loadShelves();
        const sid = id.slice("shelf:".length);
        const match = shelves.find((s) => s.id === sid);
        if (match) setSearchQuery(match.label);
        setNavSection("core");
        return;
      }
      if (id.startsWith("library:") || id.startsWith("agents:") || id.startsWith("curation:") || id === "maint:missing") {
        setNavSection("core");
      }
    },
    [browseSection]
  );

  // Title + subtitle shown at the top of the grid via Toolbar.
  const navTitle = useMemo(() => {
    const titles: Record<string, string> = {
      "library:all": "All books",
      "library:now": "Now reading",
      "library:new": "New arrivals",
      "library:fin": "Finished",
      "library:unread": "Unread",
      "agents:authors": "Authors",
      "agents:translators": "Translators",
      "curation:series": "Series",
      "curation:subjects": "Subjects (LCSH)",
      "curation:tags": "Tags",
      "maint:reconcile": "Needs reconcile",
      "maint:missing": "Missing file",
    };
    if (sidebarActiveId.startsWith("shelf:")) {
      const sid = sidebarActiveId.slice("shelf:".length);
      const match = loadShelves().find((s) => s.id === sid);
      if (match) return match.label;
    }
    return titles[sidebarActiveId] ?? "Library";
  }, [sidebarActiveId]);

  const navBreadcrumb = useMemo(() => {
    const section = sidebarActiveId.split(":")[0];
    const sectionLabel: Record<string, string> = {
      library: "Library",
      agents: "Agents",
      curation: "Curation",
      shelf: "Shelves",
      maint: "Maintenance",
    };
    const sLabel = sectionLabel[section] ?? "Library";
    return `${sLabel} · ${navTitle}`;
  }, [sidebarActiveId, navTitle]);

  // Active filter chips drawn from search query + facet (when wired).
  // Search-as-chip only when the corpus is large enough to benefit from
  // the visual reminder; otherwise the search input itself is the cue.
  const activeFilterChips: FilterChip[] = useMemo(() => {
    const chips: FilterChip[] = [];
    if (searchQuery.trim()) {
      chips.push({ id: "search", facet: "search", value: searchQuery.trim() });
    }
    return chips;
  }, [searchQuery]);

  // For the Toolbar's segmented control: graph + timeline are accessed
  // via the Command Palette to keep design discipline (3-mode segmented).
  // When viewMode is graph or timeline, the segmented control reads as
  // "hybrid" (closest equivalent) and a footer hint reminds the user.
  const segmentedView: ShellViewMode =
    viewMode === "grid" || viewMode === "hybrid" || viewMode === "list" ? viewMode : "hybrid";

  const selectedBook = library.find(b => b.id === primarySelectedId);
  const selectedBookProgress = selectedBook ? readingProgressByBookId[selectedBook.id] : undefined;

  const toggleSubject = (subj: any, add: boolean) => {
    if (!editableGraph) return;
    const newGraph = { ...editableGraph };
    if (add) {
      if (!newGraph.work.subjects.find((s: any) => s.label.toLowerCase() === subj.label.toLowerCase())) {
        newGraph.work.subjects.push(subj);
      }
    } else {
      newGraph.work.subjects = newGraph.work.subjects.filter((s: any) => s.label.toLowerCase() !== subj.label.toLowerCase());
    }
    setEditableGraph(newGraph);
  };

  const toggleCreator = (creator: any, add: boolean) => {
    if (!editableGraph) return;
    const newGraph = { ...editableGraph };
    if (add) {
      if (!newGraph.work.creators.find((c: any) => c.name.toLowerCase() === creator.name.toLowerCase())) {
        newGraph.work.creators.push(creator);
      }
    } else {
      newGraph.work.creators = newGraph.work.creators.filter((c: any) => c.name.toLowerCase() !== creator.name.toLowerCase());
    }
    setEditableGraph(newGraph);
  };

  const setGoldenTitle = (title: string) => setEditableGraph({...editableGraph, work: {...editableGraph.work, title}});
  const setGoldenDate = (originDate: string) => setEditableGraph({...editableGraph, work: {...editableGraph.work, originDate}});
  const setGoldenEditionDate = (pubDate: string) => {
    const newGraph = {...editableGraph};
    if (newGraph.instances && newGraph.instances.length > 0) newGraph.instances[0].publicationDate = pubDate;
    setEditableGraph(newGraph);
  };
  const setGoldenLanguage = (language: string) => setEditableGraph({...editableGraph, work: {...editableGraph.work, language}});
  const setGoldenLCCN = (lccn: string) => setEditableGraph({...editableGraph, work: {...editableGraph.work, lccn}});
  const setGoldenDDC = (ddc: string) => setEditableGraph({...editableGraph, work: {...editableGraph.work, ddc}});
  const setGoldenPublisher = (publisher: string) => {
    const newGraph = {...editableGraph};
    if (newGraph.instances && newGraph.instances.length > 0) newGraph.instances[0].publisher = publisher;
    setEditableGraph(newGraph);
  };
  const setGoldenISBN = (isbn: string) => {
    const newGraph = {...editableGraph};
    if (newGraph.instances && newGraph.instances.length > 0) newGraph.instances[0].isbn = isbn;
    setEditableGraph(newGraph);
  };
  const setGoldenOCLC = (oclc: string) => {
    const newGraph = {...editableGraph};
    if (newGraph.instances && newGraph.instances.length > 0) newGraph.instances[0].oclc = oclc;
    setEditableGraph(newGraph);
  };

  const copyAllFromLocal = () => {
    if (!editableGraph || !selectedBook) return;
    setEditableGraph({
      ...editableGraph,
      work: {
        ...editableGraph.work,
        title: selectedBook.title,
        originDate: extractYear(selectedBook.legacyMetadata?.pubDate)?.toString() ?? null,
        creators: selectedBook.authors.map((a: string, i: number) => ({ uri: `urn:spine:local:agent:${i}`, name: normalizeName(a), role: "author" })),
        subjects: selectedBook.legacyMetadata?.tags?.map((t: string, i: number) => ({ uri: `urn:spine:local:tag:${i}`, label: t })) || []
      }
    });
  };

  const copyAllFromLOC = () => {
    if (!editableGraph || candidates.length === 0) return;
    setEditableGraph({
      ...editableGraph,
      work: {
        ...editableGraph.work,
        title: candidates[candIndex].work.title,
        originDate: candidates[candIndex].work.originDate,
        creators: [...candidates[candIndex].work.creators],
        subjects: [...candidates[candIndex].work.subjects],
        language: candidates[candIndex].work.language,
        lccn: candidates[candIndex].work.lccn,
        ddc: candidates[candIndex].work.ddc
      },
      instances: candidates[candIndex].instances ? [{
        ...candidates[candIndex].instances[0]
      }] : []
    });
  };


  const allUniqueCreators = useMemo(
    () => Array.from(new Map(
      [
        ...(selectedBook?.authors.map((a: string, i: number) => ({ uri: `urn:spine:local:agent:${i}`, name: normalizeName(a), role: "author" })) || []),
        ...candidates.flatMap(c => c.work.creators.map((creator: any) => ({ ...creator, name: normalizeName(creator.name) })))
      ].map(c => [c.name.toLowerCase().trim().replace(/[\.,\[\]]/g, ''), c])
    ).values()),
    [selectedBook, candidates]
  );

  const allUniqueSubjects = useMemo(
    () => Array.from(new Map(
      [
        ...(selectedBook?.legacyMetadata?.tags?.map((t: string, i: number) => ({ uri: `urn:spine:local:tag:${i}`, label: t })) || []),
        ...candidates.flatMap(c => c.work.subjects)
      ].map(s => [s.label.toLowerCase().trim().replace(/[\.,\[\]]/g, ''), s])
    ).values()),
    [selectedBook, candidates]
  );



  const allUniqueTitles = Array.from(new Set([
    selectedBook?.title,
    ...candidates.map(c => c.work.title)
  ].filter(Boolean)));

  if (!initialized) {
    return (
      <div className="loading-screen">
        <Database className="spin" size={48} />
        <p>Starting Spine…</p>
      </div>
    );
  }

  if (!desktopState?.currentLibrary) {
    return (
      <Bootstrap
        recentLibraries={desktopState?.recentLibraries ?? []}
        isOpeningLibrary={isOpeningLibrary}
        libraryError={libraryError}
        onStartNew={() => void startNewLibrary()}
        onAddFolder={() => void addFolderOfEpubs()}
        onOpenExisting={() => void promptSwitchLibrary()}
        onOpenRecent={(path) => void openLibrary(path)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: SPINE.bg, color: SPINE.text }}>
      <TitleBar
        libraryName={(desktopState?.currentLibrary ?? "Library").split(/[\\/]/).filter(Boolean).slice(-1)[0] || "Library"}
        breadcrumb={navBreadcrumb}
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchFocus={() => { /* focus reaches input directly; palette opens via ⌘K */ }}
        onLibrarySwitch={() => setShowLibrarySwitcher(v => !v)}
        onAddClick={() => void addEpubs()}
        onSettingsClick={() => setShowSettings(v => !v)}
      />

      {showLibrarySwitcher && (
        <div
          role="menu"
          onMouseLeave={() => setShowLibrarySwitcher(false)}
          style={{
            position: 'absolute', top: 38, left: 80, zIndex: 200,
            background: SPINE.panel, border: `1px solid ${SPINE.borderHi}`,
            borderRadius: 3, padding: 4, minWidth: 280,
            boxShadow: SPINE.shadowPopover,
            fontFamily: SPINE.sans, fontSize: 12,
          }}
        >
          {(libraryList?.recent ?? desktopState?.recentLibraries ?? []).map((p) => (
            <button
              key={p}
              role="menuitem"
              onClick={() => { setShowLibrarySwitcher(false); void openLibrary(p); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', background: 'transparent', border: 'none',
                color: SPINE.text, cursor: 'pointer', fontFamily: SPINE.mono, fontSize: 11,
              }}
            >
              {p}
            </button>
          ))}
          <div style={{ borderTop: `1px solid ${SPINE.border}`, marginTop: 4, paddingTop: 4 }}>
            <button
              role="menuitem"
              onClick={() => { setShowLibrarySwitcher(false); void promptSwitchLibrary(); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', background: 'transparent', border: 'none',
                color: SPINE.accent, cursor: 'pointer', fontFamily: SPINE.sans, fontSize: 12,
              }}
            >
              + Open another library…
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          theme={theme}
          onThemeChange={setTheme}
          currentLibraryPath={desktopState?.currentLibrary ?? null}
          recentLibraries={(desktopState?.recentLibraries ?? []).map<RecentLibrary>((p) => ({
            path: p,
          }))}
          onSwitchLibrary={() => {
            setShowSettings(false);
            void promptSwitchLibrary();
          }}
          onOpenLibrary={(p) => {
            setShowSettings(false);
            void openLibrary(p);
          }}
          onPinLibrary={() => {
            // Pin/forget persistence is a Sprint 10 backend follow-on
            // (DesktopConfig.pinned_libraries). Surface a friendly toast
            // for now so the affordance reads without misleading.
            showToast("Pin/forget persistence ships next sprint", 3000);
          }}
          onForgetLibrary={() => {
            showToast("Pin/forget persistence ships next sprint", 3000);
          }}
          onRefreshLibrary={() => {
            setShowSettings(false);
            void refreshLibrary();
          }}
          onSyncWithCalibre={() => {
            setShowSettings(false);
            setIngestStatus("Syncing with calibre…");
            callApiJson<{ jobs_dispatched: number }>("POST", "/api/v1/sync/calibre")
              .then((data) => {
                setIngestStatus(`Dispatched ${data.jobs_dispatched} sync jobs.`);
                setTimeout(() => setIngestStatus(null), 3000);
                void refreshLibrary();
              })
              .catch((err) => {
                setIngestStatus(`Sync failed: ${humanizeBackendError(err)}`);
                setTimeout(() => setIngestStatus(null), 5000);
              });
          }}
          // Backup props are intentionally undefined until the
          // Sprint 9 backup endpoints land. Settings drawer renders the
          // empty-state ("configure when backend ships") in the meantime.
        />
      )}

      {/* Mount ReconcileDrawer unconditionally so its polling tick keeps
          the Toolbar pending-count pill live even when the drawer itself
          is closed. The component returns null when `open` is false. */}
      <ReconcileDrawer
        open={showReconcileDrawer}
        onClose={() => {
          setShowReconcileDrawer(false);
          setReconcileMinimized(true);
        }}
        onAutoOpen={() => {
          if (!reconcileMinimized) setShowReconcileDrawer(true);
        }}
        onCountChange={setReconcilePendingCount}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {sidebarCollapsed ? (
          <SidebarRail
            groups={railGroups}
            activeId={sidebarActiveId}
            onSelect={handleSidebarSelect}
            onExpand={() => setSidebarCollapsed(false)}
            onSettings={() => setShowSettings(true)}
          />
        ) : (
          <div style={{ position: "relative", flexShrink: 0 }}>
          <Sidebar
            width={sidebarWidth}
            sections={sidebarSections}
            activeId={sidebarActiveId}
            onSelect={handleSidebarSelect}
            header={
              <LibraryHeaderCard
                libraryName={
                  (desktopState?.currentLibrary ?? "Library")
                    .split(/[\\/]/)
                    .filter(Boolean)
                    .slice(-1)[0] || "Library"
                }
                libraryPath={desktopState?.currentLibrary ?? null}
                onClick={() => setShowLibrarySwitcher((v) => !v)}
              />
            }
            footer={
              <>
                <div style={{ padding: '8px 12px', borderTop: `1px solid ${SPINE.border}` }}>
                  <JobsIndicator activityToken={jobsActivityToken} />
                </div>
                <Footer
                  storage={
                    storageStats
                      ? {
                          spineDb: formatBytes(storageStats.spineDbBytes),
                          metadataDb: formatBytes(storageStats.metadataDbBytes),
                          covers: formatBytes(storageStats.coversBytes),
                        }
                      : null
                  }
                />
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  aria-label="Collapse sidebar"
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    padding: "6px 12px",
                    fontFamily: SPINE.sans,
                    fontSize: 10,
                    color: SPINE.textFaint,
                    borderTop: `1px solid ${SPINE.borderSoft}`,
                    letterSpacing: 0.4,
                  }}
                  title="Collapse to rail (⌘\\)"
                >
                  ‹‹ collapse
                </button>
              </>
            }
          />
          <SidebarResizeHandle
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            onCollapseToRail={() => {
              setSidebarWidth(240);
              setSidebarCollapsed(true);
            }}
          />
          </div>
        )}

        {/* --- Center Main: The Bookshelf --- */}
        <main
          className={`library-main ${isDragging ? "dragging" : ""}`}
          style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: SPINE.canvas }}
        >
        {isDragging && (
          <div
            className="drop-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: SPINE.overlay,
              backdropFilter: 'brightness(0.85) saturate(0.7)',
              WebkitBackdropFilter: 'brightness(0.85) saturate(0.7)',
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              border: `4px dashed ${SPINE.accent}`,
              margin: '16px',
              borderRadius: '4px',
            }}
          >
            <Database size={64} color={SPINE.accent} />
            <h2
              style={{
                color: SPINE.accent,
                marginTop: '16px',
                fontFamily: SPINE.serif,
                fontStyle: 'italic',
                fontWeight: 600,
              }}
            >
              Drop EPUBs to Ingest
            </h2>
          </div>
        )}
        {ingestStatus && (
          <div
            className="ingest-status"
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              background: SPINE.accent,
              color: SPINE.inkInvert,
              padding: '8px 16px',
              borderRadius: 3,
              zIndex: 101,
              boxShadow: SPINE.shadowPopover,
              fontFamily: SPINE.sans,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {ingestStatus}
          </div>
        )}
        <Toolbar
          title={navTitle}
          subtitle={(() => {
            const totalForSection =
              navSection === "sidecar" ? sidecarBooks.length :
              navSection === "reading" ? readingBooks.length :
              library.length;
            const isFiltered = currentBooks.length !== totalForSection;
            const head = isFiltered
              ? `showing ${currentBooks.length} of ${totalForSection} book${totalForSection === 1 ? "" : "s"}`
              : `${currentBooks.length} book${currentBooks.length === 1 ? "" : "s"}`;
            const viewSuffix =
              viewMode === "graph" ? " · graph view (⌘K to switch)" :
              viewMode === "timeline" ? " · timeline view (⌘K to switch)" : "";
            return `${head}${viewSuffix}`;
          })()}
          density={density}
          onDensityChange={setDensity}
          view={segmentedView}
          onViewChange={setViewMode}
          sort={`${SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Sort"} ${sortDir === "asc" ? "↑" : "↓"}`}
          onSortClick={() => setShowSortMenu((v) => !v)}
          reconcilePendingCount={reconcilePendingCount}
          onReconcileClick={() => {
            setShowReconcileDrawer((v) => !v);
            // Re-opening manually clears the minimize flag so future
            // arrivals can auto-open again if the user closes it later.
            setReconcileMinimized(false);
          }}
        />
        {showSortMenu && (
          <div
            role="menu"
            onMouseLeave={() => setShowSortMenu(false)}
            style={{
              position: "absolute",
              top: 116,
              right: 16,
              zIndex: 200,
              background: SPINE.panel,
              border: `1px solid ${SPINE.borderHi}`,
              borderRadius: 3,
              padding: 4,
              minWidth: 220,
              boxShadow: SPINE.shadowPopover,
              fontFamily: SPINE.sans,
              fontSize: 12,
            }}
          >
            <div
              style={{
                padding: "6px 10px 4px",
                fontFamily: SPINE.sans,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                color: SPINE.textFaint,
              }}
            >
              Sort by
            </div>
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                role="menuitemradio"
                aria-checked={opt.key === sortKey}
                onClick={() => setSortKey(opt.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  background: opt.key === sortKey ? SPINE.surface : "transparent",
                  border: "none",
                  borderLeft: opt.key === sortKey ? `2px solid ${SPINE.accent}` : "2px solid transparent",
                  color: SPINE.text,
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                <span style={{ flex: 1 }}>{opt.label}</span>
                {opt.key === sortKey && (
                  <span style={{ color: SPINE.accent, fontFamily: SPINE.mono, fontSize: 11 }}>✓</span>
                )}
              </button>
            ))}
            <div
              style={{
                borderTop: `1px solid ${SPINE.border}`,
                marginTop: 4,
                padding: "6px 10px 4px",
                display: "flex",
                gap: 6,
              }}
            >
              {(["asc", "desc"] as const).map((dir) => (
                <button
                  key={dir}
                  role="menuitemradio"
                  aria-checked={dir === sortDir}
                  onClick={() => setSortDir(dir)}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    background: dir === sortDir ? SPINE.surfaceHi : "transparent",
                    color: dir === sortDir ? SPINE.text : SPINE.textMid,
                    border: `1px solid ${dir === sortDir ? SPINE.borderHi : SPINE.border}`,
                    borderRadius: 2,
                    cursor: "pointer",
                    fontFamily: SPINE.sans,
                    fontSize: 11,
                  }}
                >
                  {dir === "asc" ? "Ascending ↑" : "Descending ↓"}
                </button>
              ))}
            </div>
          </div>
        )}
        <FilterBar
          chips={activeFilterChips}
          onRemoveChip={(id) => {
            if (id === "search") setSearchQuery("");
          }}
          onClearAll={() => setSearchQuery("")}
        />
        {serverSearchError && (
          <div
            role="status"
            style={{
              padding: '6px 14px', background: SPINE.canvasAlt,
              borderBottom: `1px solid ${SPINE.borderSoft}`,
              fontFamily: SPINE.sans, fontSize: 11, color: SPINE.warn,
            }}
          >
            Search failed — showing local results
          </div>
        )}
        {showFacets && (
          <div
            id="facet-browser-panel"
            style={{
              padding: '8px 14px',
              background: SPINE.panel,
              borderBottom: `1px solid ${SPINE.borderSoft}`,
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            <FacetBrowser
              onSelectFacet={handleFacetSelect}
              refreshToken={facetRefreshToken}
            />
          </div>
        )}

        {viewMode === "hybrid" && (
          <HybridList
            books={sortedBooks}
            selectedIds={selectedIds}
            primarySelectedId={primarySelectedId}
            onSelect={selectWithMode}
            onOpen={(id) => {
              selectSingle(id);
              setIsReaderOpen(true);
            }}
            onContextMenu={(id, x, y) => {
              // Finder-style: if right-clicked row is in selection, keep set;
              // otherwise replace selection with this row before showing menu.
              if (!selectedIds.has(id)) selectBook(id);
              setContextMenu({ id, x, y });
            }}
            emptyMessage={emptyProjectionMessage(navSection, searchQuery)}
            density={density}
          />
        )}
        {viewMode === "grid" && (
          <CoverGrid
            books={sortedBooks}
            selectedIds={selectedIds}
            primarySelectedId={primarySelectedId}
            onSelect={selectWithMode}
            onOpen={(id) => {
              selectSingle(id);
              setIsReaderOpen(true);
            }}
            onContextMenu={(id, x, y) => {
              // Finder-style: if right-clicked row is in selection, keep set;
              // otherwise replace selection with this row before showing menu.
              if (!selectedIds.has(id)) selectBook(id);
              setContextMenu({ id, x, y });
            }}
            emptyMessage={emptyProjectionMessage(navSection, searchQuery)}
            density={density}
          />
        )}
        {viewMode === "list" && (
          <DenseTable
            books={sortedBooks}
            selectedIds={selectedIds}
            primarySelectedId={primarySelectedId}
            onSelect={selectWithMode}
            onOpen={(id) => {
              selectSingle(id);
              setIsReaderOpen(true);
            }}
            onContextMenu={(id, x, y) => {
              // Finder-style: if right-clicked row is in selection, keep set;
              // otherwise replace selection with this row before showing menu.
              if (!selectedIds.has(id)) selectBook(id);
              setContextMenu({ id, x, y });
            }}
            emptyMessage={emptyProjectionMessage(navSection, searchQuery)}
            density={density}
          />
        )}

        {viewMode === "graph" && <GraphView books={currentBooks} onSelectBook={selectSingle} />}
        {viewMode === "timeline" && <TimelineView books={currentBooks} onSelectBook={selectSingle} selectedBookId={primarySelectedId} />}
      </main>

      {/* --- Right Inspector: The Metadata Hub --- */}
      <aside
        className={`inspector-panel ${inspectorPulse ? "inspector-pulse" : ""}`}
        style={inspectorMode === "design" ? { width: 340, padding: 0, background: SPINE.panel } : undefined}
      >
        {selectedIds.size > 1 && inspectorMode === "design" ? (
          <BatchInspector
            count={selectedIds.size}
            isReconciling={batchReconcileProgress !== null}
            reconcileProgress={batchReconcileProgress}
            onReconcileAll={async () => {
              // Serialize SRU calls per ADR 005 LoC cache budget — max 1 in
              // flight + 500ms gap. Walks the current snapshot of selectedIds.
              const ids = Array.from(selectedIds);
              setBatchReconcileProgress({ done: 0, total: ids.length });
              for (let i = 0; i < ids.length; i++) {
                try {
                  await new Promise<void>((resolve) => {
                    handleLookupMetadata(ids[i]);
                    resolve();
                  });
                  // Small gap before the next SRU call. ADR 005 doesn't pin
                  // an exact value; 500ms keeps us well under any reasonable
                  // rate-limit ceiling.
                  await new Promise((r) => window.setTimeout(r, 500));
                } catch (err) {
                  console.error("Batch reconcile step failed:", err);
                }
                setBatchReconcileProgress({ done: i + 1, total: ids.length });
              }
              setBatchReconcileProgress(null);
              showToast(`Reconciled ${ids.length} books against id.loc.gov`, 3000);
            }}
            onRemoveAll={() => setBatchRemoveConfirm(Array.from(selectedIds))}
            onExportAll={async () => {
              try {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const dir = await open({ directory: true, multiple: false });
                if (!dir || Array.isArray(dir)) return;
                const ids = Array.from(selectedIds);
                let succeeded = 0;
                const failures: string[] = [];
                for (const id of ids) {
                  try {
                    await handleExportBookToFolder(id, dir);
                    succeeded += 1;
                  } catch (err) {
                    failures.push(id);
                    console.error(`Export failed for ${id}:`, err);
                  }
                }
                if (failures.length === 0) {
                  showToast(`Exported ${succeeded} book${succeeded === 1 ? "" : "s"} to ${dir}`, 4000);
                } else {
                  showToast(
                    `Exported ${succeeded} of ${ids.length} · ${failures.length} failed`,
                    5000,
                  );
                }
              } catch (err) {
                showToast(`Batch export failed: ${humanizeBackendError(String(err))}`, 5000);
              }
            }}
            onClearSelection={() => {
              setSelectedIds(new Set());
              setSelectionAnchor(null);
              setPrimarySelectedId(null);
            }}
          />
        ) : selectedBook && inspectorMode === "design" ? (
          <Inspector
            book={selectedBook}
            progress={selectedBookProgress}
            onContinueRead={() => setIsReaderOpen(true)}
            onEdit={() => setEditMetadataTarget(selectedBook)}
            onReconcile={() => handleLookupMetadata(selectedBook.id)}
            onAdvancedView={() => setInspectorMode("spine")}
            onRemove={() => setRemoveTarget({ id: selectedBook.id, title: selectedBook.title })}
            onExport={() => {
              void handleExportBookWithPicker(selectedBook.id, selectedBook.title);
            }}
            onSearchAuthor={(a) => { setSearchQuery(a); setNavSection("core"); }}
            onSearchSubject={(s) => { setSearchQuery(s); setNavSection("core"); }}
            onSearchPublisher={(p) => { setSearchQuery(p); setNavSection("core"); }}
            onAddSubject={() => setAddSubjectTarget({ id: selectedBook.id, title: selectedBook.title })}
            onAddInstance={() => setAddInstanceTarget({ id: selectedBook.id, title: selectedBook.title })}
            onSetPrimaryInstance={async (instanceUri) => {
              const bookId = selectedBook.id;
              const tail = instanceUri.startsWith("urn:spine:instance:")
                ? instanceUri.slice("urn:spine:instance:".length)
                : null;
              if (!tail) {
                showToast("Make-primary not available for LoC URIs yet (deferred per ADR 014)", 4000);
                return;
              }
              try {
                await callApi(
                  "PATCH",
                  `/api/v1/book/${bookId}/instance/${encodeURIComponent(tail)}/primary`
                );
                showToast("Primary edition updated", 2000);
                try {
                  const updated = await bridgeCallApiJson<Book>("GET", `/api/v1/book/${bookId}`);
                  if (updated) setLibrary((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
                } catch {
                  /* ignore refresh failure */
                }
              } catch (err) {
                if (isApiError(err) && err.status === 404) {
                  showToast("Set-primary requires backend update — pending next session", 4000);
                } else {
                  showToast(`Set primary failed: ${humanizeBackendError(err)}`, 5000);
                }
              }
            }}
            onDeleteSubject={async (label, uri) => {
              const bookId = selectedBook.id;
              if (!uri) {
                // Legacy calibre tag without a minted URI (predates spine-bf
                // add_subject). Surface as soft warning rather than calling
                // DELETE without an `?uri=` (per ADR 014 §5 the endpoint
                // requires URI). Migration of legacy tags lands as a separate
                // backfill commit.
                showToast(`Legacy tag “${label}” — convert via Edit metadata to remove`, 4000);
                return;
              }
              try {
                await callApi("DELETE", `/api/v1/book/${bookId}/subject?uri=${encodeURIComponent(uri)}`);
                showToast(`Removed subject “${label}”`, 2000);
                try {
                  const updated = await bridgeCallApiJson<Book>("GET", `/api/v1/book/${bookId}`);
                  if (updated) setLibrary((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
                } catch {
                  /* ignore refresh failure */
                }
              } catch (err) {
                if (isApiError(err) && err.status === 404) {
                  showToast("Subject editing requires backend update — pending next session", 4000);
                } else {
                  showToast(`Remove subject failed: ${humanizeBackendError(err)}`, 5000);
                }
              }
            }}
          />
        ) : selectedBook ? (
          <div className="inspector-container">
            <div className="inspector-tabs">
              <button
                className={(inspectorMode as string) === "design" ? "active" : ""}
                onClick={() => setInspectorMode("design")}
              >
                SUMMARY
              </button>
              <button
                className={inspectorMode === "legacy" ? "active" : ""}
                onClick={() => setInspectorMode("legacy")}
              >
                CALIBRE
              </button>
              <button
                className={inspectorMode === "spine" ? "active" : ""}
                onClick={() => setInspectorMode("spine")}
                disabled={!selectedBook.bibliographicGraph}
              >
                GRAPH
              </button>
              <button
                className={inspectorMode === "inferred" ? "active" : ""}
                onClick={() => setInspectorMode("inferred")}
              >
                INFERRED
              </button>
            </div>

            <div className="inspector-content">
              <div className="inspector-hero">
                <CoverImage bookId={selectedBook.id} hasCover={selectedBook.legacyMetadata.hasCover} className="hero-cover" />
                <h2>{selectedBook.title}</h2>
                <div className="hero-author">
                  by{" "}
                  {selectedBook.authors.map((a, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        className="hero-author-link"
                        onClick={() => { setSearchQuery(a); setNavSection("core"); }}
                        title={`Filter library by ${a}`}
                      >
                        {a}
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              {inspectorMode === "legacy" && (
                <div className="inspector-body">
                  <div className="data-section">
                    <label>Legacy fields</label>
                    <div className="meta-row">
                      <span className="key">Publisher</span>
                      {selectedBook.legacyMetadata.publisher ? (
                        <button
                          type="button"
                          className="val val-link"
                          onClick={() => { setSearchQuery(selectedBook.legacyMetadata.publisher!); setNavSection("core"); }}
                          title={`Filter library by publisher ${selectedBook.legacyMetadata.publisher}`}
                        >
                          {selectedBook.legacyMetadata.publisher}
                        </button>
                      ) : (
                        <span className="val">Unknown</span>
                      )}
                    </div>
                    <div className="meta-row">
                      <span className="key">Pub Date</span>
                      <span className="val">{selectedBook.legacyMetadata.pubDate || "Unknown"}</span>
                    </div>
                    {selectedBook.legacyMetadata.series && (
                      <div className="meta-row">
                        <span className="key">Series</span>
                        <button
                          type="button"
                          className="val val-link"
                          onClick={() => { setSearchQuery(selectedBook.legacyMetadata.series!); setNavSection("core"); }}
                          title={`Filter library by series ${selectedBook.legacyMetadata.series}`}
                        >
                          {selectedBook.legacyMetadata.series}
                          {selectedBook.legacyMetadata.seriesIndex !== undefined && ` #${selectedBook.legacyMetadata.seriesIndex}`}
                        </button>
                      </div>
                    )}
                    {selectedBook.legacyMetadata.tags && selectedBook.legacyMetadata.tags.length > 0 && (
                      <div className="meta-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                        <span className="key">Tags</span>
                        <div className="subject-list">
                          {selectedBook.legacyMetadata.tags.map(t => (
                            <button
                              key={t}
                              type="button"
                              className="subject-link"
                              onClick={() => { setSearchQuery(t); setNavSection("core"); }}
                              title={`Filter library by tag ${t}`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="data-section">
                    <label>Summary</label>
                    <p className="summary-text">{selectedBook.legacyMetadata.description || "No description."}</p>
                  </div>

                  {!selectedBook.bibliographicGraph && (
                    <div className="ingest-cta">
                      <div className="cta-icon"><ArrowRightCircle size={24} /></div>
                      <div className="cta-text">
                        <h4>Lookup Metadata</h4>
                        <p>Search Library of Congress for this book.</p>
                      </div>
                      <button 
                        className="cta-button"
                        onClick={() => handleLookupMetadata(selectedBook.id)}
                      >
                        {isFetchingCandidates ? "Searching..." : "Lookup LoC"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              
              {inspectorMode === "spine" && (
                <div className="inspector-body spine-mode">
                  {selectedBook.bibliographicGraph && (
                    <div className="graph-viz">
                       <div className="graph-segment">
                          <div className="segment-header">
                            <GraduationCap size={16} /> <span>bf:Work</span>
                          </div>
                          <code className="uri-display">{selectedBook.bibliographicGraph.work.uri}</code>
                          <div className="segment-rows">
                             <div className="seg-row">
                               <span className="k">Created</span>
                               <span className="v">{selectedBook.bibliographicGraph.work.originDate || "Undated"}</span>
                             </div>
                             <div className="seg-row">
                               <span className="k">Agents</span>
                               <div className="agent-list">
                                  {selectedBook.bibliographicGraph.work.creators.map(c => (
                                    <button
                                      key={c.uri}
                                      type="button"
                                      className="agent-tag agent-tag-link"
                                      onClick={() => { setSearchQuery(c.name); setNavSection("core"); }}
                                      title={`Filter library by ${c.name}`}
                                      aria-label={`Filter library by creator ${c.name}`}
                                    >
                                      <span className="r">{c.role}</span>
                                      <span className="n">{c.name}</span>
                                    </button>
                                  ))}
                               </div>
                             </div>
                             {selectedBook.bibliographicGraph.work.subjects && selectedBook.bibliographicGraph.work.subjects.length > 0 && (
                               <div className="seg-row">
                                 <span className="k">Subjects</span>
                                 <div className="subject-list">
                                   {selectedBook.bibliographicGraph.work.subjects.map(s => (
                                     <button
                                       key={s.uri}
                                       type="button"
                                       className="subject-link"
                                       onClick={() => { setSearchQuery(s.label); setNavSection("core"); }}
                                       title={`Filter library by ${s.label}`}
                                     >
                                       {s.label}
                                     </button>
                                   ))}
                                 </div>
                               </div>
                             )}
                             {(selectedBook.bibliographicGraph.work.lccn || selectedBook.bibliographicGraph.work.ddc) && (
                               <div className="seg-row">
                                 <span className="k">Identifiers</span>
                                 <div className="identifier-list">
                                   {selectedBook.bibliographicGraph.work.lccn && (
                                     <a
                                       href={identifierUrl("lccn", selectedBook.bibliographicGraph.work.lccn)!}
                                       target="_blank"
                                       rel="noopener noreferrer"
                                       className="identifier-link"
                                     >
                                       LCCN: {selectedBook.bibliographicGraph.work.lccn}
                                       <ExternalLink size={10} style={{ marginLeft: 4 }} />
                                     </a>
                                   )}
                                   {selectedBook.bibliographicGraph.work.ddc && (
                                     <a
                                       href={identifierUrl("ddc", selectedBook.bibliographicGraph.work.ddc)!}
                                       target="_blank"
                                       rel="noopener noreferrer"
                                       className="identifier-link"
                                     >
                                       DDC: {selectedBook.bibliographicGraph.work.ddc}
                                       <ExternalLink size={10} style={{ marginLeft: 4 }} />
                                     </a>
                                   )}
                                 </div>
                               </div>
                             )}
                          </div>
                       </div>

                       <div className="segment-connector"></div>

                       <div className="graph-segment">
                          <div className="segment-header">
                            <BookIcon size={16} /> <span>bf:Instance</span>
                          </div>
                          <div className="instance-badges">
                            {selectedBook.bibliographicGraph.instances.map(i => (
                              <div key={i.uri} className="instance-badge">
                                <div className="instance-badge-head">
                                  <span className="fmt">{i.format}</span>
                                  {i.publisher && (
                                    <button
                                      type="button"
                                      className="instance-publisher-link"
                                      onClick={() => { setSearchQuery(i.publisher!); setNavSection("core"); }}
                                      title={`Filter library by publisher ${i.publisher}`}
                                    >
                                      {i.publisher}
                                    </button>
                                  )}
                                </div>
                                <code className="uri">{i.uri}</code>
                                <div className="instance-ids">
                                  {i.isbn && (
                                    <a
                                      href={identifierUrl("isbn", i.isbn)!}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="identifier-link"
                                    >
                                      ISBN: {i.isbn}
                                      <ExternalLink size={10} style={{ marginLeft: 4 }} />
                                    </a>
                                  )}
                                  {i.oclc && (
                                    <a
                                      href={identifierUrl("oclc", i.oclc)!}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="identifier-link"
                                    >
                                      OCLC: {i.oclc}
                                      <ExternalLink size={10} style={{ marginLeft: 4 }} />
                                    </a>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                       </div>
                       
                       <div className="reconcile-cta" style={{ marginTop: '20px' }}>
                          <button 
                            className="cta-button"
                            onClick={() => handleLookupMetadata(selectedBook.id)}
                            style={{ width: '100%' }}
                            disabled={isFetchingCandidates}
                          >
                            <Search size={16} style={{ marginRight: '8px' }} />
                            {isFetchingCandidates ? "Searching..." : "Fetch New LoC Candidates"}
                          </button>
                          <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px', textAlign: 'center' }}>
                            Search for better metadata and overwrite this graph.
                          </p>
                       </div>
                    </div>
                  )}
                </div>
              )}

              {inspectorMode === "inferred" && (
                <InspectorInferredTab bookId={selectedBook.id} />
              )}
            </div>

            <footer className="inspector-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
              {selectedBookProgress && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'grid', gap: '4px' }}>
                  <span>
                    Last location: {selectedBookProgress.chapterLabel || "Saved position"}
                    {typeof selectedBookProgress.progressFraction === "number" && ` (${Math.round(selectedBookProgress.progressFraction * 100)}%)`}
                  </span>
                  <span>Updated {new Date(selectedBookProgress.updatedAt).toLocaleString()}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-read" onClick={() => setIsReaderOpen(true)} style={{ flex: 1 }}>Launch Reader</button>
                <button
                  type="button"
                  className="btn-secondary-inspector"
                  onClick={() => {
                    void handleExportBookWithPicker(selectedBook.id, selectedBook.title);
                  }}
                  disabled={isExporting}
                  aria-label={`Save ${selectedBook.title} to disk as a zip archive`}
                  title="Save formats + OPF to disk as a zip"
                >
                  <Download size={14} style={{ marginRight: 6 }} />
                  {isExporting ? "Saving..." : "Save to disk"}
                </button>
                <button
                  type="button"
                  className="btn-remove-inspector"
                  onClick={() => setRemoveTarget({ id: selectedBook.id, title: selectedBook.title })}
                  aria-label={`Remove ${selectedBook.title} from library`}
                  title="Remove from library"
                >
                  <Trash2 size={14} style={{ marginRight: 6 }} />
                  Remove
                </button>
              </div>
            </footer>
          </div>
        ) : (
          <div className="no-selection-state">
             <div className="pulse-circle"></div>
             <p>Select a book to see its metadata</p>
             <p className="no-selection-hint">Click any book in the list to view its BIBFRAME graph, edit its fields, export it, or remove it from the library.</p>
          </div>
        )}
      </aside>
      </div>

      <StatusBar
        counts={{
          works: library.length,
          instances: library.reduce((acc, b) => acc + (b.bibliographicGraph?.instances?.length ?? 1), 0),
          items: library.length,
        }}
        selectionCount={selectedIds.size}
        reconcilePendingCount={reconcilePendingCount}
        onClearSelection={() => {
          setSelectedIds(new Set());
          setSelectionAnchor(null);
          setPrimarySelectedId(null);
        }}
        lastImport={
          storageStats?.lastImportAtMs != null
            ? relDate(new Date(storageStats.lastImportAtMs).toISOString())
            : null
        }
        locCacheAge={
          locCacheStatus?.present && locCacheStatus.lastRefreshedAtMs != null
            ? relDate(new Date(locCacheStatus.lastRefreshedAtMs).toISOString())
            : null
        }
        cacheAbsent={locCacheStatus != null && !locCacheStatus.present}
        jobs={
          jobsSummary && (jobsSummary.pending + jobsSummary.running > 0)
            ? `ingest · ${jobsSummary.running} running${jobsSummary.pending > 0 ? ` · ${jobsSummary.pending} queued` : ""}${jobsSummary.failed > 0 ? ` · ${jobsSummary.failed} failed` : ""}`
            : ingestStatus ?? (jobsSummary ? "idle" : undefined)
        }
      />

      {/* --- Liquid Glass Candidate Drawer --- */}
      {candidates.length > 0 && selectedBook && (
        <div className="candidate-drawer" style={{ width: '90%', left: '5%', maxWidth: '1200px', height: '85vh', overflowY: 'auto' }}>
          <div className="drawer-header">
            <h3><Search size={20} /> Reconciling: {selectedBook.title}</h3>
            <button className="drawer-close" onClick={() => setCandidates([])}>Close</button>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: '20px', background: 'rgba(0,0,0,0.3)', padding: '20px', borderRadius: '8px', marginBottom: '24px' }}>
            {/* Column Headers */}
            <div>
              <h4 style={{ borderBottom: '1px solid #475569', paddingBottom: '8px', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                <span>Original</span>
                <button onClick={copyAllFromLocal} style={{ fontSize: '10px', padding: '2px 6px', background: '#334155', border: 'none', color: '#cbd5e1', cursor: 'pointer', borderRadius: '4px' }}>Copy All &rarr;</button>
              </h4>
            </div>
            <div>
              <h4 style={{ borderBottom: '1px solid var(--accent)', paddingBottom: '8px', color: 'var(--accent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>References</span>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                    <button onClick={() => setCandIndex(p => Math.max(0, p - 1))} disabled={candIndex === 0} style={{ background: 'none', border: 'none', color: candIndex === 0 ? '#475569' : '#0ea5e9', cursor: 'pointer' }}>&larr;</button>
                    <span style={{ color: '#94a3b8' }}>{candIndex + 1} of {candidates.length}</span>
                    <button onClick={() => setCandIndex(p => Math.min(candidates.length - 1, p + 1))} disabled={candIndex === candidates.length - 1} style={{ background: 'none', border: 'none', color: candIndex === candidates.length - 1 ? '#475569' : '#0ea5e9', cursor: 'pointer' }}>&rarr;</button>
                  </div>
                </div>
                <button onClick={copyAllFromLOC} style={{ fontSize: '10px', padding: '2px 6px', background: '#0369a1', border: 'none', color: '#e0f2fe', cursor: 'pointer', borderRadius: '4px' }}>Copy All &rarr;</button>
              </h4>
            </div>
            <div>
              <h4 style={{ borderBottom: '1px solid #10b981', paddingBottom: '8px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle2 size={16} /> Final
              </h4>
            </div>

            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid #1e293b', marginTop: '8px', paddingBottom: '4px' }}>
              <h5 style={{ color: '#6366f1', textTransform: 'uppercase', margin: 0, letterSpacing: '1px' }}>Work (Intellectual Entity)</h5>
            </div>
            {/* Title */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Title</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{selectedBook.title}</span>
                <button onClick={() => setGoldenTitle(selectedBook.title)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Title</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{candidates[candIndex].work.title || 'Unknown'}</span>
                {candidates[candIndex].work.title && <button onClick={() => setGoldenTitle(candidates[candIndex].work.title)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981' }}>Title</strong>
              <input 
                type="text" 
                value={editableGraph?.work.title || ''} 
                onChange={e => setGoldenTitle(e.target.value)}
                style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px', width: '100%', fontFamily: 'inherit' }}
                placeholder="Golden Title..."
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                {allUniqueTitles.map((t: string, i: number) => (
                  <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: editableGraph?.work.title === t ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255, 255, 255, 0.05)', color: editableGraph?.work.title === t ? '#10b981' : '#64748b', borderColor: editableGraph?.work.title === t ? '#10b981' : '#334155' }} onClick={() => setGoldenTitle(t)}>
                    {t}
                  </span>
                ))}
              </div>
            </div>

            {/* Creators */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Creators</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {selectedBook.authors.map((author: string, i: number) => {
                  const norm = normalizeName(author);
                  return (
                    <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.05)' }} onClick={() => toggleCreator({ uri: `urn:spine:local:agent:${i}`, name: norm, role: "author" }, true)} title="Click to add to Golden Record">
                      {norm} +
                    </span>
                  );
                })}
                {selectedBook.authors.length === 0 && 'None'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Creators</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {candidates[candIndex].work.creators.map((c: any, i: number) => (
                  <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.05)' }} onClick={() => toggleCreator({ ...c, name: normalizeName(c.name) }, true)} title="Click to add to Golden Record">
                    {normalizeName(c.name)} +
                  </span>
                ))}
                {candidates[candIndex].work.creators.length === 0 && 'None'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ color: '#10b981' }}>Creators</strong>
                <button onClick={() => setEditableGraph({...editableGraph, work: {...editableGraph.work, creators: []}})} style={{ fontSize: '10px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '4px', cursor: 'pointer' }}>Clear All</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {allUniqueCreators.map((c: any, i: number) => {
                  const isSelected = editableGraph?.work.creators.find((ec: any) => ec.name.toLowerCase() === c.name.toLowerCase());
                  if (isSelected) {
                    return (
                      <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', borderColor: '#10b981' }} onClick={() => toggleCreator(c, false)} onContextMenu={(e) => { e.preventDefault(); setRolePicker({x: e.clientX, y: e.clientY, uri: isSelected.uri}); }} title={`Role: ${isSelected.role || 'creator'} (Right-click to change)`}>
                        {c.name} ({isSelected.role || 'creator'}) &times;
                      </span>
                    );
                  } else {
                    return (
                      <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255, 255, 255, 0.05)', color: '#64748b', borderColor: '#334155' }} onClick={() => toggleCreator(c, true)} title="Click to add">
                        {c.name} +
                      </span>
                    );
                  }
                })}
              </div>
            </div>

            {/* Date */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ fontSize: '14px' }}>Written</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{extractYear(selectedBook.legacyMetadata?.pubDate) ?? 'Unknown'}</span>
                {extractYear(selectedBook.legacyMetadata?.pubDate) !== null && <button onClick={() => setGoldenDate(String(extractYear(selectedBook.legacyMetadata?.pubDate)))} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
              <div style={{ marginTop: '8px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>Edition</div>
              <div>{extractYear(selectedBook.legacyMetadata?.pubDate) ?? 'Unknown'}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ fontSize: '14px' }}>Written</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{candidates[candIndex].work.originDate || 'Unknown'}</span>
                {candidates[candIndex].work.originDate && <button onClick={() => setGoldenDate(candidates[candIndex].work.originDate)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
              <div style={{ marginTop: '8px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>Edition</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{candidates[candIndex].instances?.[0]?.publicationDate || 'Unknown'}</span>
                {candidates[candIndex].instances?.[0]?.publicationDate && <button onClick={() => setGoldenEditionDate(candidates[candIndex].instances[0].publicationDate)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981', fontSize: '14px' }}>Written</strong>
              <input 
                type="text" 
                value={editableGraph?.work.originDate || ''} 
                onChange={e => setGoldenDate(e.target.value)}
                style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '6px 8px', borderRadius: '4px', width: '100%', fontFamily: 'inherit', fontWeight: 'bold' }}
                placeholder="YYYY (Authorship Date)"
              />
              <strong style={{ color: '#10b981', marginTop: '8px', fontSize: '11px', textTransform: 'uppercase' }}>Edition</strong>
              <input 
                type="text" 
                value={editableGraph?.instances?.[0]?.publicationDate || ''}
                onChange={e => setGoldenEditionDate(e.target.value)}
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid #334155', color: '#94a3b8', padding: '4px 8px', borderRadius: '4px', width: '100%', fontFamily: 'inherit', fontSize: '12px' }}
                placeholder="YYYY (Manifestation Date)"
              />
            </div>


            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid #1e293b', marginTop: '16px', paddingBottom: '4px' }}>
              <h5 style={{ color: '#ec4899', textTransform: 'uppercase', margin: 0, letterSpacing: '1px' }}>Instance (Manifestation)</h5>
            </div>
            {/* Publisher */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Publisher</strong>
              <span>{selectedBook.legacyMetadata?.publisher || 'None'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Publisher</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{candidates[candIndex].instances?.[0]?.publisher || 'Unknown'}</span>
                {candidates[candIndex].instances?.[0]?.publisher && <button onClick={() => setGoldenPublisher(candidates[candIndex].instances[0].publisher)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981' }}>Publisher</strong>
              <input type="text" value={editableGraph?.instances?.[0]?.publisher || ''} onChange={e => setGoldenPublisher(e.target.value)} style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px', width: '100%' }} placeholder="Publisher..." />
            </div>

            {/* Language */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Language</strong>
              <span>{'Unknown'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Language</strong>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{candidates[candIndex].work.language || 'Unknown'}</span>
                {candidates[candIndex].work.language && <button onClick={() => setGoldenLanguage(candidates[candIndex].work.language)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button>}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981' }}>Language</strong>
              <input type="text" value={editableGraph?.work.language || ''} onChange={e => setGoldenLanguage(e.target.value)} style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px', width: '100%' }} placeholder="Language..." />
            </div>

            {/* Identifiers */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Identifiers & Class</strong>
              <span>None</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Identifiers & Class</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {candidates[candIndex].work.lccn && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>LCCN: {candidates[candIndex].work.lccn}</span><button onClick={() => setGoldenLCCN(candidates[candIndex].work.lccn)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button></div>}
                {candidates[candIndex].work.ddc && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>DDC: {candidates[candIndex].work.ddc}</span><button onClick={() => setGoldenDDC(candidates[candIndex].work.ddc)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button></div>}
                {candidates[candIndex].instances?.[0]?.isbn && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>ISBN: {candidates[candIndex].instances[0].isbn}</span><button onClick={() => setGoldenISBN(candidates[candIndex].instances[0].isbn)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button></div>}
                {candidates[candIndex].instances?.[0]?.oclc && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>OCLC: {candidates[candIndex].instances[0].oclc}</span><button onClick={() => setGoldenOCLC(candidates[candIndex].instances[0].oclc)} style={{ fontSize: '10px', cursor: 'pointer' }}>&rarr;</button></div>}
                {!candidates[candIndex].work.lccn && !candidates[candIndex].work.ddc && !candidates[candIndex].instances?.[0]?.isbn && !candidates[candIndex].instances?.[0]?.oclc && 'None'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981' }}>Identifiers & Class</strong>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}><span style={{ width: '40px' }}>LCCN</span><input type="text" value={editableGraph?.work.lccn || ''} onChange={e => setGoldenLCCN(e.target.value)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px' }} placeholder="..." /></div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}><span style={{ width: '40px' }}>DDC</span><input type="text" value={editableGraph?.work.ddc || ''} onChange={e => setGoldenDDC(e.target.value)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px' }} placeholder="..." /></div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}><span style={{ width: '40px' }}>ISBN</span><input type="text" value={editableGraph?.instances?.[0]?.isbn || ''} onChange={e => setGoldenISBN(e.target.value)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px' }} placeholder="..." /></div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}><span style={{ width: '40px' }}>OCLC</span><input type="text" value={editableGraph?.instances?.[0]?.oclc || ''} onChange={e => setGoldenOCLC(e.target.value)} style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #10b981', color: 'white', padding: '4px 8px', borderRadius: '4px' }} placeholder="..." /></div>
            </div>

            {/* Subjects */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Subjects</strong>
              <div className="candidate-subjects" style={{ flexWrap: 'wrap' }}>
                {selectedBook.legacyMetadata?.tags?.map((tag: string, i: number) => (
                  <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.05)' }} onClick={() => toggleSubject({ uri: `urn:spine:local:tag:${i}`, label: tag }, true)} title="Click to add to Golden Record">
                    {tag} +
                  </span>
                ))}
                {(!selectedBook.legacyMetadata?.tags || selectedBook.legacyMetadata.tags.length === 0) && 'None'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Subjects</strong>
              <div className="candidate-subjects" style={{ flexWrap: 'wrap' }}>
                {candidates[candIndex].work.subjects.map((s: any, i: number) => (
                  <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.05)' }} onClick={() => toggleSubject(s, true)} title="Click to add to Golden Record">
                    {s.label} +
                  </span>
                ))}
                {candidates[candIndex].work.subjects.length === 0 && 'None'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ color: '#10b981' }}>Subjects</strong>
                <button onClick={() => setEditableGraph({...editableGraph, work: {...editableGraph.work, subjects: []}})} style={{ fontSize: '10px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '4px', cursor: 'pointer' }}>Clear All</button>
              </div>
              <div className="candidate-subjects" style={{ flexWrap: 'wrap' }}>
                {allUniqueSubjects.map((s: any, i: number) => {
                  const isSelected = editableGraph?.work.subjects.find((es: any) => es.label.toLowerCase() === s.label.toLowerCase());
                  if (isSelected) {
                    return (
                      <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', borderColor: '#10b981' }} onClick={() => toggleSubject(s, false)} title="Click to remove">
                        {s.label} &times;
                      </span>
                    );
                  } else {
                    return (
                      <span key={i} className="subject-pill" style={{ cursor: 'pointer', background: 'rgba(255, 255, 255, 0.05)', color: '#64748b', borderColor: '#334155' }} onClick={() => toggleSubject(s, true)} title="Click to add">
                        {s.label} +
                      </span>
                    );
                  }
                })}
              </div>
              <div style={{ marginTop: '8px', display: 'flex', gap: '4px' }}>
                <input 
                  type="text" 
                  id="new-subject-input"
                  placeholder="Add custom tag..." 
                  style={{ flex: 1, background: 'rgba(0,0,0,0.5)', border: '1px solid #475569', color: 'white', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = e.currentTarget.value.trim();
                      if (val) {
                        toggleSubject({ uri: `urn:spine:local:tag:${Date.now()}`, label: val }, true);
                        e.currentTarget.value = '';
                      }
                    }
                  }}
                />
                <button 
                  onClick={() => {
                    const input = document.getElementById('new-subject-input') as HTMLInputElement;
                    if (input && input.value.trim()) {
                      toggleSubject({ uri: `urn:spine:local:tag:${Date.now()}`, label: input.value.trim() }, true);
                      input.value = '';
                    }
                  }}
                  style={{ background: '#10b981', border: 'none', color: '#0f172a', borderRadius: '4px', padding: '0 8px', cursor: 'pointer', fontWeight: 'bold' }}>+</button>
              </div>
            </div>
            
            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid #1e293b', marginTop: '16px', paddingBottom: '4px' }}>
              <h5 style={{ color: '#10b981', textTransform: 'uppercase', margin: 0, letterSpacing: '1px' }}>Item (Digital File)</h5>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Formats</strong>
              <span>{'EPUB (Legacy)'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong>Formats</strong>
              <span>None</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <strong style={{ color: '#10b981' }}>Formats</strong>
              <span>{'EPUB (Legacy)'}</span>
            </div>
          </div>
          
          {synthesizedCandidate && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginBottom: '24px' }}>
              <button
                onClick={() => setCandidates([])}
                style={{ padding: '12px 24px', background: 'transparent', border: '1px solid #475569', color: '#cbd5e1', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Wrong Book
              </button>
              <button
                className="btn-destructive" 
                style={{ background: '#10b981', padding: '12px 24px', fontSize: '14px' }}
                onClick={() => handleAcceptCandidate(selectedBook!.id, editableGraph)}
              >
                Save Final
              </button>
            </div>
          )}

          {rolePicker && (
            <div style={{ position: 'fixed', top: rolePicker.y, left: rolePicker.x, background: '#1e293b', border: '1px solid #475569', borderRadius: '6px', padding: '8px', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
              <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '4px' }}>Assign Role</div>
              {['aut (Author)', 'trl (Translator)', 'ill (Illustrator)', 'edt (Editor)', 'ctb (Contributor)'].map(r => (
                <button key={r} onClick={() => updateRole(r.split(' ')[0])} style={{ background: 'transparent', border: 'none', color: 'white', textAlign: 'left', padding: '4px 8px', cursor: 'pointer', fontSize: '12px', borderRadius: '4px' }} onMouseOver={e => e.currentTarget.style.background = '#334155'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                  {r}
                </button>
              ))}
              <hr style={{ borderColor: '#334155', margin: '4px 0' }}/>
              <button onClick={() => setRolePicker(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', textAlign: 'left', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
            </div>
          )}
        </div>
      )}
      
      {isReaderOpen && primarySelectedId && (
        <Reader
          bookId={primarySelectedId}
          bookTitle={selectedBook?.title}
          initialProgress={primarySelectedId ? readingProgressByBookId[primarySelectedId] ?? null : null}
          onProgressSaved={handleProgressSaved}
          onClose={() => setIsReaderOpen(false)}
        />
      )}

      {batchRemoveConfirm && (() => {
        const ids = batchRemoveConfirm;
        const count = ids.length;
        const deleteFiles = batchRemoveDeleteFiles;
        return (
          <>
            <div
              onClick={() => setBatchRemoveConfirm(null)}
              aria-hidden
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.4)",
                backdropFilter: "brightness(0.5) saturate(0.7)",
                WebkitBackdropFilter: "brightness(0.5) saturate(0.7)",
                zIndex: 1000,
              }}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`Remove ${count} books`}
              style={{
                position: "fixed",
                top: "30%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 480,
                background: SPINE.panel,
                border: `1px solid ${SPINE.borderHi}`,
                borderRadius: 4,
                padding: "18px 20px 16px",
                boxShadow: "0 30px 80px rgba(0,0,0,.6), 0 10px 30px rgba(0,0,0,.4)",
                zIndex: 1001,
                fontFamily: SPINE.sans,
              }}
            >
              <div
                style={{
                  fontFamily: SPINE.sans,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: SPINE.alert,
                  marginBottom: 8,
                }}
              >
                Remove {count} books?
              </div>
              <div style={{ fontSize: 12, color: SPINE.textMid, lineHeight: 1.5, marginBottom: 12 }}>
                Removes the selected books from this library.
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: SPINE.textMid,
                  marginBottom: 6,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={deleteFiles}
                  onChange={(e) => setBatchRemoveDeleteFiles(e.target.checked)}
                />
                <span>Also delete files from disk</span>
              </label>
              <div style={{ fontSize: 11, color: SPINE.textDim, marginBottom: 14, paddingLeft: 22 }}>
                {deleteFiles
                  ? "Format files for all selected books will be permanently deleted."
                  : "Files on disk are kept; only the library entries are removed."}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => { setBatchRemoveConfirm(null); setBatchRemoveDeleteFiles(false); }}
                  style={{
                    padding: "6px 14px",
                    background: "transparent",
                    color: SPINE.textMid,
                    border: `1px solid ${SPINE.border}`,
                    borderRadius: 3,
                    fontFamily: SPINE.sans,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const wantDelete = deleteFiles;
                    setBatchRemoveConfirm(null);
                    setBatchRemoveDeleteFiles(false);
                    let removed = 0;
                    const failed: string[] = [];
                    for (const id of ids) {
                      try {
                        await callApi("DELETE", `/api/v1/book/${id}?delete_files=${wantDelete}`);
                        removed += 1;
                      } catch (err) {
                        failed.push(id);
                        console.error(`Batch remove failed for ${id}:`, err);
                      }
                    }
                    setSelectedIds(new Set());
                    setSelectionAnchor(null);
                    setPrimarySelectedId(null);
                    void refreshLibrary();
                    if (failed.length === 0) {
                      showToast(`Removed ${removed} book${removed === 1 ? "" : "s"}`, 3000);
                    } else {
                      showToast(`Removed ${removed} of ${count} books · ${failed.length} failed`, 5000);
                    }
                  }}
                  style={{
                    padding: "6px 16px",
                    background: SPINE.alert,
                    color: SPINE.inkInvert,
                    border: "none",
                    borderRadius: 3,
                    fontFamily: SPINE.sans,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Remove {count}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {removeTarget && (
        <RemoveBookDialog
          bookId={removeTarget.id}
          bookTitle={removeTarget.title}
          onClose={() => setRemoveTarget(null)}
          onRemoved={handleRemoveConfirmed}
          onError={(msg) => showToast(msg, 5000)}
        />
      )}

      {editMetadataTarget && (
        <EditMetadataDrawer
          bookId={editMetadataTarget.id}
          bookTitle={editMetadataTarget.title}
          initial={{
            title: editMetadataTarget.title,
            authors: editMetadataTarget.authors,
            tags: editMetadataTarget.legacyMetadata.tags ?? [],
            series: editMetadataTarget.legacyMetadata.series ?? null,
            series_index: editMetadataTarget.legacyMetadata.seriesIndex ?? null,
            pubdate: editMetadataTarget.legacyMetadata.pubDate ?? null,
            publisher: editMetadataTarget.legacyMetadata.publisher ?? null,
            language: editMetadataTarget.bibliographicGraph?.work.language ?? "eng",
          }}
          onClose={() => setEditMetadataTarget(null)}
          onSaved={(payload: EditMetadataPayload) => {
            void refreshLibrary();
            showToast(`Saved metadata for "${payload.title}"`, 3000);
          }}
        />
      )}

      {contextMenu && (() => {
        const target = library.find((b) => b.id === contextMenu.id);
        if (!target) return null;
        const safeAuthor = (target.authors[0] ?? "Unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
        const safeTitle = target.title.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const liveShelves = loadShelves()
          .filter((s) => !s.hidden)
          .sort((a, b) => a.order - b.order);
        type MenuItem = {
          label: string;
          onClick: () => void;
          danger?: boolean;
          headerOnly?: boolean;
          mark?: ReactNode;
          checkmark?: boolean;
        };
        const baseItems: ReadonlyArray<MenuItem> = [
          { label: "Open in reader", onClick: () => { setIsReaderOpen(true); } },
          { label: "Reconcile against id.loc.gov", onClick: () => handleLookupMetadata(target.id) },
          { label: "Edit metadata…", onClick: () => setEditMetadataTarget(target) },
          { label: "Rename… (F2)", onClick: () => setRenameTarget({ id: target.id, title: target.title }) },
          { label: "Export EPUB…", onClick: () => void handleExportBook(target.id, `${safeAuthor}-${safeTitle}.zip`) },
          { label: "Remove from library…", danger: true, onClick: () => setRemoveTarget({ id: target.id, title: target.title }) },
        ];
        // Shelf membership toggle — clicking a shelf row in the menu
        // adds or removes the book from the shelf. Persists via
        // ShelvesData.saveShelves; no backend yet (Sprint M3).
        const shelfItems: MenuItem[] = liveShelves.length === 0 ? [] : [
          { label: "Add to shelf", onClick: () => {}, headerOnly: true },
          ...liveShelves.map<MenuItem>((s) => {
            const isMember = s.memberIds.includes(target.id);
            return {
              label: s.label,
              checkmark: isMember,
              mark: <ShelfMark letter={s.letter} tone={s.tone} />,
              onClick: () => {
                const all = loadShelves();
                const next = all.map((sh) =>
                  sh.id === s.id
                    ? {
                        ...sh,
                        memberIds: isMember
                          ? sh.memberIds.filter((id) => id !== target.id)
                          : [...sh.memberIds, target.id],
                      }
                    : sh,
                );
                // Persist via the same key ShelvesSection reads on
                // mount. ShelvesSection won't rerender until next
                // open/close — acceptable for now; real fix is to
                // lift shelves state into App.tsx with the M3 backend.
                try {
                  window.localStorage.setItem(
                    "spine.shelves.v1",
                    JSON.stringify(next),
                  );
                } catch {
                  /* private mode etc. — silently no-op */
                }
                showToast(
                  isMember
                    ? `Removed from “${s.label}”`
                    : `Added to “${s.label}”`,
                  2000,
                );
              },
            };
          }),
        ];
        const items: ReadonlyArray<MenuItem> = [...baseItems, ...shelfItems];
        return (
          <>
            <div
              onClick={() => setContextMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
              aria-hidden
              style={{ position: "fixed", inset: 0, zIndex: 900 }}
            />
            <div
              role="menu"
              style={{
                position: "fixed",
                top: Math.min(contextMenu.y, window.innerHeight - 240),
                left: Math.min(contextMenu.x, window.innerWidth - 240),
                minWidth: 220,
                background: SPINE.panel,
                border: `1px solid ${SPINE.borderHi}`,
                borderRadius: 3,
                padding: 4,
                zIndex: 901,
                boxShadow: SPINE.shadowPopover,
                fontFamily: SPINE.sans,
                fontSize: 12,
              }}
            >
              {items.map((it, idx) => {
                if (it.headerOnly) {
                  return (
                    <div
                      key={`h-${idx}`}
                      style={{
                        padding: "8px 12px 4px",
                        marginTop: 2,
                        borderTop: `1px solid ${SPINE.borderSoft}`,
                        fontFamily: SPINE.sans,
                        fontSize: 9.5,
                        fontWeight: 600,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                        color: SPINE.textFaint,
                      }}
                    >
                      {it.label}
                    </div>
                  );
                }
                return (
                  <button
                    key={idx}
                    role="menuitem"
                    onClick={() => {
                      setContextMenu(null);
                      it.onClick();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 12px",
                      background: "transparent",
                      border: "none",
                      color: it.danger ? SPINE.alert : SPINE.text,
                      cursor: "pointer",
                      fontFamily: SPINE.sans,
                      fontSize: 12,
                      borderRadius: 2,
                    }}
                  >
                    {it.mark}
                    <span style={{ flex: 1 }}>{it.label}</span>
                    {it.checkmark && (
                      <span style={{ color: SPINE.accent, fontFamily: SPINE.mono, fontSize: 11 }}>✓</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        );
      })()}

      {addSubjectTarget && (
        <AddSubjectDialog
          bookTitle={addSubjectTarget.title}
          isSaving={isSavingSubject}
          onClose={() => setAddSubjectTarget(null)}
          onSave={async (term, source) => {
            const bookId = addSubjectTarget.id;
            setIsSavingSubject(true);
            try {
              await callApi("POST", `/api/v1/book/${bookId}/subject`, { term, source });
              showToast(`Added subject “${term}”`, 2000);
              try {
                const updated = await bridgeCallApiJson<Book>("GET", `/api/v1/book/${bookId}`);
                if (updated) setLibrary((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
              } catch {
                /* ignore refresh failure */
              }
              setAddSubjectTarget(null);
            } catch (err) {
              if (isApiError(err) && err.status === 404) {
                showToast("Subject editing requires backend update — pending next session", 4000);
                setAddSubjectTarget(null);
              } else {
                showToast(`Add subject failed: ${humanizeBackendError(err)}`, 5000);
              }
            } finally {
              setIsSavingSubject(false);
            }
          }}
        />
      )}

      {libraryErrorModal && (
        <LibraryErrorModal
          kind={libraryErrorModal.kind}
          attemptedPath={libraryErrorModal.attemptedPath}
          onCancel={() => setLibraryErrorModal(null)}
          onPickAnother={() => {
            setLibraryErrorModal(null);
            void promptSwitchLibrary();
          }}
          onCreateHere={
            libraryErrorModal.kind === "uninitialized"
              ? () => {
                  // Strip the trailing metadata.db filename + any leading
                  // \\?\ verbatim prefix so create_library lands at the
                  // user-meaningful directory, not the literal failed
                  // file. Mirrors `displayPath` for display, but on the
                  // actual path the canonical form sticks.
                  const failed = libraryErrorModal.attemptedPath;
                  const dir = failed.replace(/[\\/]metadata\.db$/i, "");
                  setLibraryErrorModal(null);
                  void (async () => {
                    setIsOpeningLibrary(true);
                    setLibraryError(null);
                    try {
                      const state = await invoke<DesktopStateSnapshot>("create_library", {
                        dirPath: dir,
                      });
                      setDesktopState(state);
                      selectSingle(null);
                      await refreshLibrary(state);
                      try {
                        const jobId = await invoke<string>("seed_welcome_book");
                        setIngestStatus("Ingesting welcome book…");
                        pollJobStatus(jobId);
                        setJobsActivityToken((t) => t + 1);
                      } catch (seedErr) {
                        console.warn("seed_welcome_book failed (non-fatal):", seedErr);
                      }
                    } catch (err) {
                      setLibraryError(humanizeBackendError(String(err)));
                    } finally {
                      setIsOpeningLibrary(false);
                    }
                  })();
                }
              : undefined
          }
        />
      )}

      {addInstanceTarget && (
        <AddInstanceDialog
          bookTitle={addInstanceTarget.title}
          isSaving={isSavingInstance}
          onClose={() => setAddInstanceTarget(null)}
          onSave={async (draft: InstanceDraft) => {
            const bookId = addInstanceTarget.id;
            setIsSavingInstance(true);
            // Wire shape per ADR 014 §1+§2 / spine-api AddInstanceRequest:
            // camelCase JSON keys (typeshare emits camelCase), no `oclc`
            // field on the request — `oclc` is stored on the Instance DTO
            // post-reconcile but isn't in the write request.
            const body = {
              format: draft.format,
              publicationDate: draft.publicationDate,
              publisher: draft.publisher,
              isbn: draft.isbn,
              title: draft.title,
              reconcileAgainstLoc: draft.reconcileAgainstLoc,
            };
            try {
              const result = await bridgeCallApiJson<{ instanceUri: string; partial: boolean }>(
                "POST",
                `/api/v1/book/${bookId}/instance`,
                body
              );
              if (result.partial) {
                showToast("Instance added · reconciliation pending (LoC unavailable)", 3500);
              } else {
                showToast(`Added ${draft.format} instance`, 2000);
              }
              try {
                const updated = await bridgeCallApiJson<Book>("GET", `/api/v1/book/${bookId}`);
                if (updated) setLibrary((prev) => prev.map((b) => (b.id === bookId ? updated : b)));
              } catch {
                /* ignore refresh failure */
              }
              setAddInstanceTarget(null);
            } catch (err) {
              if (isApiError(err) && err.status === 404) {
                showToast("Instance editing requires backend update — pending next session", 4000);
                setAddInstanceTarget(null);
              } else {
                showToast(`Add instance failed: ${humanizeBackendError(err)}`, 5000);
              }
            } finally {
              setIsSavingInstance(false);
            }
          }}
        />
      )}

      {renameTarget && (
        <RenameDialog
          bookId={renameTarget.id}
          initialTitle={renameTarget.title}
          isSaving={isSavingEdit}
          onClose={() => setRenameTarget(null)}
          onSave={async (newTitle) => {
            const book = library.find((b) => b.id === renameTarget.id);
            if (!book) {
              setRenameTarget(null);
              return;
            }
            const baseGraph = book.bibliographicGraph;
            const draftGraph = baseGraph
              ? {
                  ...baseGraph,
                  work: { ...baseGraph.work, title: newTitle },
                }
              : {
                  workUri: `urn:spine:work:${book.id}`,
                  instanceUri: `urn:spine:instance:${book.id}`,
                  work: {
                    uri: `urn:spine:work:${book.id}`,
                    title: newTitle,
                    originDate: extractYear(book.legacyMetadata.pubDate)?.toString() ?? "",
                    creators: book.authors.map((a, i) => ({
                      uri: `urn:spine:agent:${book.id}:${i}`,
                      name: a,
                      role: "author",
                    })),
                    subjects: (book.legacyMetadata.tags ?? []).map((t, i) => ({
                      uri: `urn:spine:subject:${book.id}:${i}`,
                      label: t,
                      source: "calibre",
                    })),
                    language: "eng",
                  },
                  instances: [
                    {
                      uri: `urn:spine:instance:${book.id}`,
                      format: "EPUB",
                      publisher: book.legacyMetadata.publisher ?? "",
                      publicationDate: book.legacyMetadata.pubDate ?? "",
                    },
                  ],
                };
            await handleSaveEdit(book.id, draftGraph);
            setRenameTarget(null);
          }}
        />
      )}

      {toast && (
        <div
          className="spine-toast"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}

      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        commands={paletteCommands}
        books={projectedBooks}
        onSelectBook={(id, openInReader) => {
          selectSingle(id);
          if (openInReader) setIsReaderOpen(true);
        }}
      />
    </div>
  );
}

export default App;

