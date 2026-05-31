import type { ReactNode } from "react";
import { SPINE } from "../tokens";

export interface StatusCounts {
  works: number;
  instances: number;
  items: number;
}

interface StatusBarProps {
  serverLabel?: string;
  serverOk?: boolean;
  counts?: StatusCounts | null;
  /** Relative-date string for `MAX(books.timestamp)` — Footer-level "last import" cell. */
  lastImport?: string | null;
  /** Relative-date string for the LoC SRU response cache. Renders "not enabled" when `null`. */
  locCacheAge?: string | null;
  /** When `locCacheAge` is null but the cache subsystem is known-absent (Phase A option 2 stub), pass `cacheAbsent` so the cell renders the not-enabled hint instead of hiding. */
  cacheAbsent?: boolean;
  jobs?: ReactNode;
  hints?: string;
  /** Number of books in the multi-select set. Renders an `N selected · Clear`
   *  chip in the right-hand cluster when > 1 (single-select skips the chip;
   *  the Inspector already conveys single-book context). */
  selectionCount?: number;
  onClearSelection?: () => void;
  /** Reconcile-queue depth from `GET /api/v1/reconcile/queue`. Renders a
   *  low-ink "N reconciles pending" cell when > 0; hidden at zero. */
  reconcilePendingCount?: number;
}

const DEFAULT_HINTS = "⌘K palette · F2 rename · ⏎ open";

// 22px window-bottom status bar. Mono font, low ink. Server liveness on
// left (green dot when ok); centre carries corpus counts + LoC cache age;
// the `jobs` slot accepts any ReactNode (e.g. <JobsIndicator/>) so this
// component stays decoupled from any particular jobs API.
export default function StatusBar({
  serverLabel = "spine-srv · in-process",
  serverOk = true,
  counts,
  lastImport,
  locCacheAge,
  cacheAbsent,
  jobs,
  hints = DEFAULT_HINTS,
  selectionCount = 0,
  onClearSelection,
  reconcilePendingCount = 0,
}: StatusBarProps) {
  return (
    <div
      style={{
        height: 22,
        background: SPINE.panel,
        borderTop: `1px solid ${SPINE.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 14,
        fontFamily: SPINE.mono,
        fontSize: 10,
        color: SPINE.textFaint,
        flexShrink: 0,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 5, color: serverOk ? SPINE.ok : SPINE.alert }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: serverOk ? SPINE.ok : SPINE.alert,
          }}
        />
        {serverLabel}
      </span>
      {counts && (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {counts.works} works · {counts.instances} instances · {counts.items} items
        </span>
      )}
      {lastImport && <span>last import · {lastImport}</span>}
      {locCacheAge ? (
        <span>loc cache · {locCacheAge}</span>
      ) : cacheAbsent ? (
        <span style={{ color: SPINE.textDim }}>loc cache · not enabled</span>
      ) : null}
      <div style={{ flex: 1 }} />
      {selectionCount > 1 && (
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: SPINE.accent }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{selectionCount} selected</span>
          {onClearSelection && (
            <button
              type="button"
              onClick={onClearSelection}
              style={{
                background: "transparent",
                border: "none",
                color: SPINE.textDim,
                cursor: "pointer",
                font: "inherit",
                padding: "0 4px",
                textDecoration: "underline",
              }}
            >
              Clear
            </button>
          )}
        </span>
      )}
      {reconcilePendingCount > 0 && (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {reconcilePendingCount} reconcile{reconcilePendingCount === 1 ? "" : "s"} pending
        </span>
      )}
      {jobs && <span style={{ display: "flex", alignItems: "center" }}>{jobs}</span>}
      <span style={{ color: SPINE.textDim }}>{hints}</span>
    </div>
  );
}
