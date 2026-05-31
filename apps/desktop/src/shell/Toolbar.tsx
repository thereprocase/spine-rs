import { SPINE } from "../tokens";
import Icon, { type IconName } from "../components/Icon";

export type Density = "dense" | "balanced" | "relaxed";
export type ViewMode = "grid" | "hybrid" | "list";

const DENSITY_OPTIONS: readonly Density[] = ["dense", "balanced", "relaxed"] as const;

const VIEW_OPTIONS: readonly { mode: ViewMode; icon: IconName }[] = [
  { mode: "grid", icon: "grid" },
  { mode: "hybrid", icon: "rows" },
  { mode: "list", icon: "list" },
] as const;

interface ToolbarProps {
  title: string;
  subtitle?: string;
  density: Density;
  onDensityChange: (density: Density) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  sort: string;
  onSortClick?: () => void;
  /** Pending reconcile count. When > 0, render a pill button left of
   *  Sort that opens the Reconcile drawer. 0 hides the pill. */
  reconcilePendingCount?: number;
  onReconcileClick?: () => void;
}

// 40px bar above the grid. Title + count on the left; density (3-way)
// / view-mode (3-way) segmented controls + sort dropdown trigger on
// the right. Sort is a trigger, not the menu — parent owns the popover.
export default function Toolbar({
  title,
  subtitle,
  density,
  onDensityChange,
  view,
  onViewChange,
  sort,
  onSortClick,
  reconcilePendingCount = 0,
  onReconcileClick,
}: ToolbarProps) {
  return (
    <div
      style={{
        height: 40,
        background: SPINE.bg,
        borderBottom: `1px solid ${SPINE.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: SPINE.sans, fontSize: 13, fontWeight: 500, color: SPINE.text }}>
        {title}
      </span>
      {subtitle && (
        <span
          style={{
            fontFamily: SPINE.mono,
            fontSize: 11,
            color: SPINE.textFaint,
            marginLeft: 4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {subtitle}
        </span>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 1, background: SPINE.canvas, padding: 2, borderRadius: 3 }}>
        {DENSITY_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDensityChange(d)}
            style={{
              padding: "3px 8px",
              border: "none",
              background: density === d ? SPINE.surfaceHi : "transparent",
              color: density === d ? SPINE.text : SPINE.textDim,
              fontFamily: SPINE.sans,
              fontSize: 11,
              textTransform: "capitalize",
              cursor: "pointer",
              borderRadius: 2,
            }}
          >
            {d}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 1, background: SPINE.canvas, padding: 2, borderRadius: 3 }}>
        {VIEW_OPTIONS.map(({ mode, icon }) => (
          <button
            key={mode}
            type="button"
            onClick={() => onViewChange(mode)}
            aria-label={`View as ${mode}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 7px",
              border: `1px solid ${view === mode ? SPINE.borderHi : "transparent"}`,
              background: view === mode ? SPINE.surface : "transparent",
              color: view === mode ? SPINE.text : SPINE.textMid,
              fontFamily: SPINE.sans,
              fontSize: 11,
              fontWeight: view === mode ? 500 : 400,
              cursor: "pointer",
              borderRadius: 3,
            }}
          >
            <Icon name={icon} size={12} color={view === mode ? SPINE.accent : SPINE.textDim} />
          </button>
        ))}
      </div>

      {reconcilePendingCount > 0 && (
        <button
          type="button"
          onClick={onReconcileClick}
          aria-label={`Open reconcile drawer (${reconcilePendingCount} pending)`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px 3px 8px",
            border: `1px solid ${SPINE.accent}`,
            background: "transparent",
            color: SPINE.accent,
            fontFamily: SPINE.sans,
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
            borderRadius: 12,
          }}
        >
          <span
            style={{
              minWidth: 16,
              height: 16,
              padding: "0 5px",
              borderRadius: 8,
              background: SPINE.accent,
              color: SPINE.inkInvert,
              fontFamily: SPINE.mono,
              fontSize: 10,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {reconcilePendingCount}
          </span>
          Reconcile
        </button>
      )}

      <button
        type="button"
        onClick={onSortClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          border: `1px solid ${SPINE.border}`,
          background: "transparent",
          color: SPINE.textMid,
          fontFamily: SPINE.sans,
          fontSize: 11,
          cursor: "pointer",
          borderRadius: 3,
        }}
      >
        <Icon name="sort" size={12} color={SPINE.textDim} />
        {sort}
        <Icon name="chevdown" size={11} color={SPINE.textDim} />
      </button>
    </div>
  );
}
