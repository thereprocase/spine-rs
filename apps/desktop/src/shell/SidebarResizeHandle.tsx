import { useEffect, useRef, useState } from "react";
import { SPINE } from "../tokens";

interface SidebarResizeHandleProps {
  width: number;
  onWidthChange: (width: number) => void;
  /** Triggered when the user drags below the rail threshold (~80px).
   *  Snaps width to 240 + flips the parent into rail mode. */
  onCollapseToRail: () => void;
  minWidth?: number;
  maxWidth?: number;
}

const SNAP_POINTS: { px: number; label: string }[] = [
  { px: 200, label: "200 · min" },
  { px: 240, label: "240 · default" },
  { px: 320, label: "320 · wide" },
  { px: 56, label: "rail · 56" },
];

const SNAP_THRESHOLD = 8; // px tolerance for snapping
const RAIL_COLLAPSE_THRESHOLD = 130; // dragging below this triggers rail

// Drag-resize handle for the sidebar right edge. 4px accent strip,
// glow when grabbed, floating width readout, snap-points marked.
// Locked from v2 SidebarDragResize (L558).
export default function SidebarResizeHandle({
  width,
  onWidthChange,
  onCollapseToRail,
  minWidth = 200,
  maxWidth = 480,
}: SidebarResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX.current;
      let next = startWidth.current + delta;
      if (next < RAIL_COLLAPSE_THRESHOLD) {
        // Hold the visual at minWidth while dragged through the rail
        // threshold; commit to rail on mouse-up.
        onWidthChange(minWidth);
        return;
      }
      // Snap to nearby snap-points (excluding rail).
      for (const p of SNAP_POINTS) {
        if (p.px < minWidth) continue;
        if (Math.abs(next - p.px) < SNAP_THRESHOLD) {
          next = p.px;
          break;
        }
      }
      next = Math.max(minWidth, Math.min(maxWidth, next));
      onWidthChange(next);
    };
    const onUp = (e: MouseEvent) => {
      setDragging(false);
      const delta = e.clientX - startX.current;
      const finalCandidate = startWidth.current + delta;
      if (finalCandidate < RAIL_COLLAPSE_THRESHOLD) {
        onCollapseToRail();
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onWidthChange, onCollapseToRail, minWidth, maxWidth]);

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={(e) => {
          e.preventDefault();
          startX.current = e.clientX;
          startWidth.current = width;
          setDragging(true);
          document.body.style.cursor = "ew-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={onCollapseToRail}
        title="Drag to resize · double-click to collapse"
        style={{
          position: "absolute",
          top: 0,
          left: width - 2,
          bottom: 0,
          width: 4,
          cursor: "ew-resize",
          background: dragging ? SPINE.accent : "transparent",
          opacity: dragging ? 0.9 : 1,
          boxShadow: dragging
            ? "0 0 0 1px rgba(200,161,90,.4), 0 0 18px rgba(200,161,90,.4)"
            : "none",
          zIndex: 800,
          transition: dragging ? "none" : "background 120ms ease",
        }}
        onMouseEnter={(e) => {
          if (!dragging) e.currentTarget.style.background = `${SPINE.accent}66`;
        }}
        onMouseLeave={(e) => {
          if (!dragging) e.currentTarget.style.background = "transparent";
        }}
      />
      {dragging && (
        <>
          <div
            style={{
              position: "fixed",
              left: width + 8,
              top: 60,
              background: SPINE.panel,
              border: `1px solid ${SPINE.borderHi}`,
              borderRadius: 2,
              padding: "3px 7px",
              fontFamily: SPINE.mono,
              fontSize: 10,
              color: SPINE.text,
              boxShadow: "0 4px 12px rgba(0,0,0,.4)",
              whiteSpace: "nowrap",
              zIndex: 900,
              pointerEvents: "none",
            }}
          >
            {Math.round(width)}px
          </div>
          <div
            style={{
              position: "fixed",
              left: width + 8,
              top: 92,
              width: 130,
              display: "flex",
              flexDirection: "column",
              gap: 5,
              fontFamily: SPINE.mono,
              fontSize: 8.5,
              color: SPINE.textFaint,
              zIndex: 900,
              pointerEvents: "none",
            }}
          >
            {SNAP_POINTS.map((p) => {
              const near = Math.abs(width - p.px) < SNAP_THRESHOLD;
              return (
                <div
                  key={p.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    opacity: near ? 1 : 0.55,
                  }}
                >
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      background: near ? SPINE.accent : SPINE.textFaint,
                      borderRadius: 2,
                    }}
                  />
                  <span>{p.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
