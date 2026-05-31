import { useEffect, useRef, useState, type ReactNode } from "react";
import { SPINE } from "./tokens";
import { callApiJson, isApiError } from "./api/client";
import { displayPath, humanizeBackendError, relDate } from "./utils/formatters";
import Cover from "./components/Cover";

// Wire-shape locked per the Sprint 10 design. Endpoints:
//   GET  /api/v1/reconcile/queue                    → ReconcileQueueResponse
//   POST /api/v1/reconcile/{book_id}/promote        { locUri }   (Accept LoC)
//   POST /api/v1/reconcile/{book_id}/skip           (no body)
// Mint-local is frontend-only — short-circuits to the spinemint URI
// already minted at ingest, dismisses the row + fires onResolved
// without a network round-trip. No POST to a /mint-local path exists
// in the Sprint 10 contract (a "must NOT POST" assertion in
// ReconcileDrawerWired.test.tsx pins this).
//
// Pending-list entry shape is best-effort speculative until the backend
// locks the wire type — graceful field reads handle the most likely
// shapes (snake_case Rust serde + camelCase typeshare). Soft missing
// fields render as "—" so a rough partial response renders without
// throwing.
export interface ReconcileCandidate {
  uri: string;
  label?: string;
  title?: string;
  agent?: string;
  pubDate?: string;
  /** 0.0 - 1.0 confidence; ADR 015 §4 surfaces 0.50-0.79 in the drawer. */
  confidence?: number;
}

export interface ReconcilePendingRow {
  bookId: string;
  title: string;
  author?: string;
  hasCover?: boolean;
  /** Top three LoC candidates, ranked by suggest2 alpha order (no
   *  client re-scoring). Empty for `TimedOut` rows. */
  candidates: ReconcileCandidate[];
  /** ISO 8601 — set when this row was flagged as needing review.
   *  ADR 015 §4 calls this `spine:reconcileTimeoutAt` for TimedOut, or
   *  the candidate-cache write time for Unmatched-with-candidates. */
  flaggedAt?: string;
  /** Reason for the flag — "timeout" / "low-confidence" / etc. Optional;
   *  helps the user understand why the row is here. */
  reason?: string;
}

export interface ReconcileQueueResponse {
  /** The backend may model the response body as `{ rows: [...] }`,
   *  `{ queue: [...] }`, or a bare array — the parser tolerates all
   *  three shapes (see `extractRows` below). */
  rows?: ReconcilePendingRow[];
  queue?: ReconcilePendingRow[];
  /** Convenience count — same as rows.length but cheap to read for
   *  the Toolbar pill before a full fetch lands. */
  count?: number;
}

/** Backwards-compatible alias for callers that imported the older
 *  pre-S10 type name. New code should use `ReconcileQueueResponse`. */
export type ReconcilesPendingResponse = ReconcileQueueResponse;

function extractRows(
  resp: ReconcileQueueResponse | ReconcilePendingRow[] | null | undefined,
): ReconcilePendingRow[] {
  if (Array.isArray(resp)) return resp;
  if (!resp) return [];
  return resp.rows ?? resp.queue ?? [];
}

interface ReconcileDrawerProps {
  /** Drawer open. Parent owns this so the Toolbar pill click can flip
   *  it; mount the drawer regardless and gate render on this flag. */
  open: boolean;
  onClose: () => void;
  /** Hook for the auto-open-on-first-arrival behaviour per ADR 015 §4.
   *  Parent keeps a "user explicitly minimized" flag so subsequent
   *  arrivals don't re-trigger an open. */
  onAutoOpen?: () => void;
  /** Resolved-row callback — parent removes the row from its local
   *  list and (optionally) re-fetches the count to refresh the pill. */
  onResolved?: (bookId: string) => void;
  /** Pending-row count change. Fires on every successful poll tick
   *  with the latest length so the parent can render a Toolbar pill
   *  even while the drawer is closed. */
  onCountChange?: (count: number) => void;
}

const POLL_INTERVAL_MS = 30_000;
const SKIP_UNDO_MS = 5_000;

// Right-rail Reconcile drawer per ADR 015 §4 (Sprint 10). Rows
// surface books that landed with provisional `spinemint` URIs because
// LoC reconcile was Unmatched-with-low-confidence-candidates or
// TimedOut. Each row offers three actions:
//   - Accept LoC suggestion  → POST /api/v1/reconcile/{id}/promote { locUri }
//                              (writes `owl:sameAs` + `bf:AdminMetadata`)
//   - Mint local              → frontend-only no-op (book already has
//                              spinemint URI from ingest; just dismiss)
//   - Skip ingest             → POST /api/v1/reconcile/{id}/skip
//                              (sets `spine:reconcileTimeoutAt = 0`,
//                              fired AFTER 5s undo window elapses)
//
// Auto-open semantics: when the first row arrives and the user hasn't
// explicitly minimized, fire onAutoOpen so the parent flips `open`
// to true. Subsequent arrivals while open is true are no-ops.
//
// Graceful 404: pre-merge of the Sprint 10 backend, the GET
// returns 404. The drawer renders an empty-state ("Reconcile drawer
// activates when the Sprint 10 backend ships") and stops polling so
// it doesn't hammer a known-missing endpoint.
export default function ReconcileDrawer({
  open,
  onClose,
  onAutoOpen,
  onResolved,
  onCountChange,
}: ReconcileDrawerProps) {
  const [rows, setRows] = useState<ReconcilePendingRow[]>([]);
  const [endpointAvailable, setEndpointAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingByBook, setPendingByBook] = useState<Map<string, "accepting" | "skipping">>(
    () => new Map(),
  );
  const undoTimers = useRef<Map<string, number>>(new Map());
  const seenAnyRow = useRef(false);

  // Initial fetch + polling. Stop polling on 404 (endpoint not deployed).
  useEffect(() => {
    if (!endpointAvailable) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const resp = await callApiJson<ReconcileQueueResponse | ReconcilePendingRow[]>(
          "GET",
          "/api/v1/reconcile/queue",
        );
        if (cancelled) return;
        const next = extractRows(resp);
        setRows(next);
        onCountChange?.(next.length);
        if (next.length > 0 && !seenAnyRow.current) {
          seenAnyRow.current = true;
          onAutoOpen?.();
        }
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err) && err.status === 404) {
          setEndpointAvailable(false);
        }
        // 5xx / network blip — keep last rows; don't surface noise on
        // each poll. The next successful tick replaces.
      }
    };

    void tick();
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [endpointAvailable, onAutoOpen, onCountChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Cancel any in-flight skip-undo timers when the component unmounts so
  // we don't fire a delayed callback after the parent has discarded us.
  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      for (const id of timers.values()) {
        window.clearTimeout(id);
      }
      timers.clear();
    };
  }, []);

  const setPending = (bookId: string, kind: "accepting" | "skipping" | null) => {
    setPendingByBook((prev) => {
      const next = new Map(prev);
      if (kind == null) next.delete(bookId);
      else next.set(bookId, kind);
      return next;
    });
  };

  const handleAccept = async (row: ReconcilePendingRow, candidate: ReconcileCandidate) => {
    setPending(row.bookId, "accepting");
    setError(null);
    try {
      await callApiJson("POST", `/api/v1/reconcile/${row.bookId}/promote`, {
        locUri: candidate.uri,
      });
      setRows((prev) => prev.filter((r) => r.bookId !== row.bookId));
      onResolved?.(row.bookId);
    } catch (err) {
      setError(`Accept failed: ${humanizeBackendError(err)}`);
    } finally {
      setPending(row.bookId, null);
    }
  };

  // Mint-local is a frontend-only short-circuit per the Sprint 10 design:
  // the book already has a `spinemint` URI from ingest, so all we do
  // is drop the row from the queue + fire onResolved. No POST to any
  // backend endpoint — the wired-test scaffold pins this with
  // a "must NOT POST" assertion against /mint-local paths.
  const handleMintLocal = (row: ReconcilePendingRow) => {
    setRows((prev) => prev.filter((r) => r.bookId !== row.bookId));
    onResolved?.(row.bookId);
  };

  // Skip ingest: ADR 015 §4 specifies "5s undo". The row stays in the
  // list during the window and renders as <SkipUndoRow> via the
  // `pendingByBook` "skipping" flag — that's where the inline Undo
  // affordance lives. The destructive POST + row removal only fire
  // when the 5s timer elapses without an undo.
  const handleSkip = (row: ReconcilePendingRow) => {
    setPending(row.bookId, "skipping");

    const timer = window.setTimeout(async () => {
      undoTimers.current.delete(row.bookId);
      try {
        await callApiJson("POST", `/api/v1/reconcile/${row.bookId}/skip`);
        setRows((prev) => prev.filter((r) => r.bookId !== row.bookId));
        onResolved?.(row.bookId);
      } catch (err) {
        setError(`Skip ingest failed: ${humanizeBackendError(err)}`);
      } finally {
        setPending(row.bookId, null);
      }
    }, SKIP_UNDO_MS);
    undoTimers.current.set(row.bookId, timer);
  };

  // Cancel the pending skip — the row was never removed from `rows`
  // (it just rendered as <SkipUndoRow> while the flag was set), so we
  // only need to clear the timer + flag and the normal row body
  // re-renders next paint.
  const undoSkip = (row: ReconcilePendingRow) => {
    const timer = undoTimers.current.get(row.bookId);
    if (timer != null) {
      window.clearTimeout(timer);
      undoTimers.current.delete(row.bookId);
    }
    setPending(row.bookId, null);
  };

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: SPINE.overlay,
          backdropFilter: "brightness(0.85) saturate(0.7)",
          WebkitBackdropFilter: "brightness(0.85) saturate(0.7)",
          zIndex: 1000,
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Reconcile pending books"
        data-testid="reconcile-drawer"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          background: SPINE.panel,
          borderLeft: `1px solid ${SPINE.borderHi}`,
          boxShadow: SPINE.shadowModal,
          zIndex: 1001,
          fontFamily: SPINE.sans,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${SPINE.borderSoft}`,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: 0.4,
                color: SPINE.text,
              }}
            >
              Reconcile
            </h2>
            <span style={{ fontSize: 11, color: SPINE.textDim }}>
              {rows.length === 0
                ? "No pending reconciles."
                : `${rows.length} pending — review or accept LoC suggestions`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close reconcile drawer"
            style={{
              background: "transparent",
              border: "none",
              color: SPINE.textDim,
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
              padding: 4,
            }}
          >
            ✕
          </button>
        </header>

        {error && (
          <div
            role="alert"
            style={{
              padding: "8px 18px",
              fontSize: 11,
              color: SPINE.alert,
              borderBottom: `1px solid ${SPINE.borderSoft}`,
              background: SPINE.canvasAlt,
            }}
          >
            {error}
          </div>
        )}

        {!endpointAvailable ? (
          <EmptyState>
            Reconcile drawer activates when the Sprint 10 backend ships. Books
            that need review will appear here automatically; auto-resolved
            matches stay quiet in the library grid.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>
            No pending reconciles. Books with high-confidence LoC matches or
            no candidates land in the library directly — only ambiguous or
            timed-out reconciles surface here.
          </EmptyState>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {rows.map((row) => {
              const pending = pendingByBook.get(row.bookId);
              const isSkipping = pending === "skipping";
              return (
                <li
                  key={row.bookId}
                  data-testid="reconcile-row"
                  data-book-id={row.bookId}
                  style={{
                    padding: "12px 18px",
                    borderBottom: `1px solid ${SPINE.borderSoft}`,
                    opacity: pending && !isSkipping ? 0.7 : 1,
                    background: isSkipping ? SPINE.canvasAlt : "transparent",
                  }}
                >
                  {isSkipping ? (
                    <SkipUndoRow row={row} onUndo={() => undoSkip(row)} />
                  ) : (
                    <ReconcileRowBody
                      row={row}
                      pending={pending}
                      onAccept={(c) => void handleAccept(row, c)}
                      onMintLocal={() => void handleMintLocal(row)}
                      onSkip={() => handleSkip(row)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </>
  );
}

interface ReconcileRowBodyProps {
  row: ReconcilePendingRow;
  pending: "accepting" | "skipping" | undefined;
  onAccept: (candidate: ReconcileCandidate) => void;
  onMintLocal: () => void;
  onSkip: () => void;
}

function ReconcileRowBody({
  row,
  pending,
  onAccept,
  onMintLocal,
  onSkip,
}: ReconcileRowBodyProps) {
  const [selectedCandidateUri, setSelectedCandidateUri] = useState<string | null>(
    row.candidates[0]?.uri ?? null,
  );
  const selected = row.candidates.find((c) => c.uri === selectedCandidateUri);
  const canAccept = pending == null && selected !== undefined;

  return (
    <div style={{ display: "flex", gap: 10 }}>
      <Cover
        title={row.title}
        author={row.author ?? "Unknown"}
        bookId={row.bookId}
        hasCover={row.hasCover}
        w={56}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div>
          <div
            style={{
              fontFamily: SPINE.serif,
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 13,
              color: SPINE.text,
              lineHeight: 1.25,
            }}
            title={row.title}
          >
            {row.title}
          </div>
          {row.author && (
            <div style={{ fontFamily: SPINE.sans, fontSize: 11, color: SPINE.textDim }}>
              {row.author}
            </div>
          )}
          {(row.flaggedAt || row.reason) && (
            <div
              style={{
                fontFamily: SPINE.mono,
                fontSize: 10,
                color: SPINE.textFaint,
                marginTop: 2,
              }}
            >
              {row.reason && <span>{row.reason}</span>}
              {row.reason && row.flaggedAt && <span> · </span>}
              {row.flaggedAt && <span>{relDate(row.flaggedAt)}</span>}
            </div>
          )}
        </div>

        {row.candidates.length > 0 ? (
          <ul
            role="radiogroup"
            aria-label="LoC candidates"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 3,
              border: `1px solid ${SPINE.borderSoft}`,
              borderRadius: 3,
            }}
          >
            {row.candidates.slice(0, 3).map((c) => {
              const checked = c.uri === selectedCandidateUri;
              return (
                <li
                  key={c.uri}
                  style={{
                    padding: "6px 8px",
                    background: checked ? SPINE.surface : "transparent",
                    cursor: "pointer",
                    borderBottom: `1px solid ${SPINE.borderSoft}`,
                  }}
                  onClick={() => setSelectedCandidateUri(c.uri)}
                >
                  <label
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "flex-start",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name={`candidate-${row.bookId}`}
                      checked={checked}
                      onChange={() => setSelectedCandidateUri(c.uri)}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: SPINE.sans,
                          fontSize: 11,
                          color: SPINE.text,
                        }}
                      >
                        {c.label ?? c.title ?? c.uri}
                      </div>
                      <div
                        style={{
                          fontFamily: SPINE.mono,
                          fontSize: 9,
                          color: SPINE.textDim,
                          wordBreak: "break-all",
                        }}
                      >
                        {displayPath(c.uri)}
                      </div>
                      {(c.agent || c.pubDate || c.confidence != null) && (
                        <div
                          style={{
                            fontFamily: SPINE.sans,
                            fontSize: 10,
                            color: SPINE.textFaint,
                            marginTop: 1,
                          }}
                        >
                          {c.agent && <span>{c.agent}</span>}
                          {c.agent && c.pubDate && <span> · </span>}
                          {c.pubDate && <span>{c.pubDate}</span>}
                          {c.confidence != null && (
                            <span> · {(c.confidence * 100).toFixed(0)}%</span>
                          )}
                        </div>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <div style={{ fontSize: 11, color: SPINE.textDim, fontStyle: "italic" }}>
            No LoC candidates returned. Mint local or skip ingest.
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
          <DrawerButton
            kind="primary"
            onClick={() => selected && onAccept(selected)}
            disabled={!canAccept}
          >
            {pending === "accepting" ? "Accepting…" : "Accept LoC"}
          </DrawerButton>
          <DrawerButton onClick={onMintLocal} disabled={pending != null}>
            Mint local
          </DrawerButton>
          <DrawerButton onClick={onSkip} kind="danger" disabled={pending != null}>
            Skip ingest
          </DrawerButton>
        </div>
      </div>
    </div>
  );
}

interface SkipUndoRowProps {
  row: ReconcilePendingRow;
  onUndo: () => void;
}

function SkipUndoRow({ row, onUndo }: SkipUndoRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: SPINE.sans,
        fontSize: 12,
        color: SPINE.textMid,
      }}
    >
      <span>
        Skipping ingest for{" "}
        <em style={{ fontFamily: SPINE.serif, color: SPINE.text }}>{row.title}</em>…
      </span>
      <button
        type="button"
        onClick={onUndo}
        style={{
          background: "transparent",
          border: `1px solid ${SPINE.accent}`,
          color: SPINE.accent,
          padding: "3px 10px",
          borderRadius: 3,
          fontFamily: SPINE.sans,
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        Undo
      </button>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "32px 24px",
        fontSize: 12,
        color: SPINE.textDim,
        lineHeight: 1.6,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

interface DrawerButtonProps {
  onClick: () => void;
  disabled?: boolean;
  kind?: "primary" | "danger";
  children: ReactNode;
}

function DrawerButton({ onClick, disabled, kind, children }: DrawerButtonProps) {
  const palette =
    kind === "primary"
      ? { bg: SPINE.accent, fg: SPINE.inkInvert, border: SPINE.accent }
      : kind === "danger"
      ? { bg: "transparent", fg: SPINE.alert, border: SPINE.alert }
      : { bg: "transparent", fg: SPINE.text, border: SPINE.border };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 12px",
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 3,
        fontFamily: SPINE.sans,
        fontSize: 11,
        fontWeight: kind === "primary" ? 500 : 400,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
