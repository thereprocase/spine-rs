import { useEffect, useRef } from "react";
import { SPINE } from "../tokens";
import Icon, { type IconName } from "../components/Icon";

export interface ShelfContextMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  kbd?: string;
  danger?: boolean;
  divider?: boolean;
}

interface ShelfContextMenuProps {
  /** Anchor coordinates in viewport space (clientX/clientY). */
  x: number;
  y: number;
  items: ShelfContextMenuItem[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}

// Right-click context menu for shelf rows. Locked layout in v2
// ShelvesContextMenu (L1018). Items default order: Rename · Nest
// under… · Pin to top · Move ↑↓ · — · Hide · Delete (danger).
// Anchored at click position; click-outside or Escape dismisses.
export default function ShelfContextMenu({
  x,
  y,
  items,
  onSelect,
  onDismiss,
}: ShelfContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        width: 200,
        background: SPINE.panel,
        border: `1px solid ${SPINE.borderHi}`,
        borderRadius: 3,
        boxShadow: "0 12px 32px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4)",
        padding: "5px 0",
        zIndex: 1500,
        fontFamily: SPINE.sans,
      }}
    >
      {items.map((it, idx) =>
        it.divider ? (
          <div
            key={`d-${idx}`}
            style={{ height: 1, background: SPINE.borderSoft, margin: "4px 0" }}
          />
        ) : (
          <button
            key={it.id}
            role="menuitem"
            type="button"
            onClick={() => {
              onSelect(it.id);
              onDismiss();
            }}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "6px 10px",
              color: it.danger ? SPINE.alert : SPINE.textMid,
              fontFamily: SPINE.sans,
              fontSize: 12,
              width: "calc(100% - 0px)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = SPINE.surface;
              e.currentTarget.style.color = it.danger ? SPINE.alert : SPINE.text;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = it.danger ? SPINE.alert : SPINE.textMid;
            }}
          >
            {it.icon && (
              <Icon
                name={it.icon}
                size={12}
                color={it.danger ? SPINE.alert : SPINE.textDim}
              />
            )}
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.kbd && (
              <span
                style={{
                  fontFamily: SPINE.mono,
                  fontSize: 9,
                  color: SPINE.textFaint,
                }}
              >
                {it.kbd}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
