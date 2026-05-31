import type { ReactNode } from "react";
import { SPINE } from "../tokens";
import Icon, { type IconName } from "../components/Icon";
import type { ShelfTone } from "./ShelfMark";

export interface RailItem {
  id: string;
  /** Lucide icon (mutually exclusive with `mark`). */
  icon?: IconName;
  /** Custom mark — typically a ShelfMark. */
  mark?: ReactNode;
  /** Compact count rendered below the icon (mono 8px). Pass strings
   *  like "1.2k" for already-formatted counts. */
  count?: string | number;
  /** Show an unread/changes badge dot at top-right. */
  badge?: boolean;
  /** Full label for the hover tooltip. */
  tooltip?: string;
}

export interface RailGroup {
  /** Items are grouped by category; dividers render between groups. */
  items: RailItem[];
}

interface SidebarRailProps {
  width?: number;
  groups: RailGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Click on the brand square / chev tab to expand back to full sidebar. */
  onExpand: () => void;
  /** Settings affordance pinned at the bottom. */
  onSettings?: () => void;
}

// 56px collapsed sidebar rail. Brand square at top, vertical icon
// stack with count below (mono 8px), badge dot for unread, settings
// pinned at bottom. Locked from v2 (SidebarRail, L671).
export default function SidebarRail({
  width = 56,
  groups,
  activeId,
  onSelect,
  onExpand,
  onSettings,
}: SidebarRailProps) {
  return (
    <div
      style={{
        width,
        background: SPINE.panel,
        color: SPINE.text,
        borderRight: `1px solid ${SPINE.border}`,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        position: "relative",
      }}
    >
      <div
        style={{
          padding: "12px 0 11px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
        }}
      >
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          style={{
            all: "unset",
            cursor: "pointer",
            width: 24,
            height: 24,
            borderRadius: 3,
            background: `linear-gradient(180deg, ${SPINE.accent} 0%, #a8854a 100%)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: SPINE.serif,
            fontStyle: "italic",
            fontSize: 14,
            fontWeight: 600,
            color: SPINE.inkInvert,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.15)",
          }}
        >
          S
        </button>
      </div>

      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand sidebar"
        style={{
          all: "unset",
          cursor: "pointer",
          position: "absolute",
          top: 22,
          right: -7,
          width: 14,
          height: 22,
          background: SPINE.panel,
          border: `1px solid ${SPINE.border}`,
          borderLeft: "none",
          borderRadius: "0 3px 3px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 5,
        }}
      >
        <Icon name="chev" size={9} color={SPINE.textDim} />
      </button>

      <div
        style={{
          padding: "6px 0",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          overflowY: "auto",
          flex: 1,
        }}
      >
        {groups.map((group, gIdx) => (
          <div key={gIdx}>
            {gIdx > 0 && (
              <div
                style={{
                  width: 18,
                  height: 1,
                  background: SPINE.borderSoft,
                  margin: "6px auto",
                }}
              />
            )}
            {group.items.map((item) => (
              <RailButton
                key={item.id}
                item={item}
                active={item.id === activeId}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          borderTop: `1px solid ${SPINE.borderSoft}`,
          padding: "10px 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            aria-label="Settings"
            style={{
              all: "unset",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <Icon name="settings" size={13} color={SPINE.textDim} />
          </button>
        )}
      </div>
    </div>
  );
}

interface RailButtonProps {
  item: RailItem;
  active: boolean;
  onClick: () => void;
}

function RailButton({ item, active, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.tooltip ?? ""}
      aria-label={item.tooltip ?? item.id}
      style={{
        all: "unset",
        position: "relative",
        width: 40,
        height: 40,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        background: active ? SPINE.surfaceHi : "transparent",
        cursor: "pointer",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            left: -6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 2,
            height: 18,
            background: SPINE.accent,
            borderRadius: 1,
          }}
        />
      )}
      {item.mark ??
        (item.icon && (
          <Icon
            name={item.icon}
            size={16}
            color={active ? SPINE.accent : SPINE.textDim}
          />
        ))}
      {item.count != null && (
        <span
          style={{
            fontFamily: SPINE.mono,
            fontSize: 8,
            color: active ? SPINE.textMid : SPINE.textFaint,
            marginTop: 2,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {item.count}
        </span>
      )}
      {item.badge && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 5,
            height: 5,
            borderRadius: 3,
            background: SPINE.accent,
            boxShadow: `0 0 0 2px ${SPINE.panel}`,
          }}
        />
      )}
    </button>
  );
}

// Re-export the tone type so callers building rail items can construct
// a ShelfMark with a typed `tone` prop.
export type { ShelfTone };
