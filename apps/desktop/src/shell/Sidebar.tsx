import type { ReactNode } from "react";
import type React from "react";
import { SPINE } from "../tokens";
import Icon, { type IconName } from "../components/Icon";
import { fmtNum } from "../utils/formatters";

export type CaretState = "none" | "right" | "down";

export interface SidebarItem {
  id: string;
  label: string;
  icon?: IconName;
  indent?: number;
  count?: number;
  /** Status dot color rendered before label (e.g. for needs-reconcile rows). */
  accent?: string;
  /** Disclosure caret on the row (▶/▼). When set, `onToggle` fires
   *  on caret click; selecting the row still fires `onSelect`. */
  caret?: CaretState;
  /** Faint accent dot in caret slot — signals "an active filter lives
   *  in the children of this row" (visual breadcrumb). */
  ancestorActive?: boolean;
  /** Italic-serif label rendering — used for genre/subject leaves. */
  italic?: boolean;
  /** Mono-spaced label — used for DDC prefixed rows. */
  mono?: boolean;
  /** Tree-guide hairline rendering for nested rows. */
  treeGuide?: boolean;
  /** Last sibling in the group — caps the tree-guide vertical at 50%. */
  lastInGroup?: boolean;
  /** Drag-drop target highlight (dashed accent outline). */
  drop?: boolean;
  /** Forced-hover state — used for context-menu-anchored rows. */
  hovered?: boolean;
  /** Custom prefix mark (e.g. ShelfMark). Renders left of icon. */
  mark?: ReactNode;
  /** Right-aligned slot, replaces count when set. */
  rightSlot?: ReactNode;
  /** Right-click handler — typically opens a per-row context menu.
   *  Receives the native event so callers can pin menus at click pos. */
  onContextMenu?: (e: React.MouseEvent) => void;
}

export interface SidebarSection {
  /** Optional. Pass null/undefined to render content without a header. */
  title?: string | null;
  /** Per-section count rendered next to the title. */
  count?: number;
  /** Right-side action affordance in the section header (e.g. "+ new"). */
  action?: { label: string; onClick: () => void };
  items: SidebarItem[];
  /** Arbitrary content rendered AFTER the items list (e.g. provenance
   *  footer, empty-state card, "no shelves yet" italic-serif copy). */
  footer?: ReactNode;
}

interface SidebarProps {
  sections: SidebarSection[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Per-row toggle handler for caret rows. Receives the row id. */
  onToggle?: (id: string) => void;
  width?: number;
  /** Header slot rendered above the first section (LibraryHeaderCard). */
  header?: ReactNode;
  /** Footer slot pinned to the sidebar bottom. */
  footer?: ReactNode;
}

// Sidebar nav. Sections + items fully data-driven so callers drive
// structure without touching the component. Active item gets a 2px
// accent left-border + surfaceHi fill; the icon turns accent. Per
// v2 design bundle: tree-guide hairlines for nested rows, italic
// serif for subject leaves, mono for DDC, ancestor-active dot,
// drag-drop outline.
export default function Sidebar({
  sections,
  activeId,
  onSelect,
  onToggle,
  width = 240,
  header,
  footer,
}: SidebarProps) {
  return (
    <div
      style={{
        width,
        background: SPINE.panel,
        borderRight: `1px solid ${SPINE.border}`,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        fontFamily: SPINE.sans,
        overflow: "hidden",
      }}
    >
      {header}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {sections.map((section, sectionIdx) => (
          <div key={section.title ?? `section-${sectionIdx}`}>
            {section.title != null && (
              <SectionHeader
                label={section.title}
                count={section.count}
                action={section.action}
                first={sectionIdx === 0 && !header}
              />
            )}
            {section.items.map((item) => (
              <SidebarRow
                key={item.id}
                item={item}
                isActive={item.id === activeId}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
            {section.footer}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}

interface SectionHeaderProps {
  label: string;
  count?: number;
  action?: { label: string; onClick: () => void };
  first: boolean;
}

function SectionHeader({ label, count, action, first }: SectionHeaderProps) {
  return (
    <div
      style={{
        marginTop: first ? 6 : 14,
        marginBottom: 4,
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span
        style={{
          fontFamily: SPINE.sans,
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: SPINE.textFaint,
        }}
      >
        {label}
      </span>
      {count != null && (
        <span
          style={{
            fontFamily: SPINE.mono,
            fontSize: 10,
            color: SPINE.textFaint,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtNum(count)}
        </span>
      )}
      <span style={{ flex: 1, height: 1, background: SPINE.borderSoft }} />
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            all: "unset",
            cursor: "pointer",
            fontFamily: SPINE.sans,
            fontSize: 10,
            color: SPINE.accent,
            letterSpacing: 0.4,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

interface SidebarRowProps {
  item: SidebarItem;
  isActive: boolean;
  onSelect: (id: string) => void;
  onToggle?: (id: string) => void;
}

function SidebarRow({ item, isActive, onSelect, onToggle }: SidebarRowProps) {
  const indent = item.indent ?? 0;
  const caret = item.caret ?? "none";
  const isHovered = item.hovered ?? false;

  const labelFontFamily = item.mono
    ? SPINE.mono
    : item.italic
    ? SPINE.serif
    : SPINE.sans;
  const labelFontSize = item.italic ? 12.5 : item.mono ? 11 : 12;
  const labelFontStyle = item.italic ? "italic" : "normal";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item.id)}
      onContextMenu={item.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(item.id);
        }
      }}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 6px",
        padding: "4px 10px 4px 0",
        paddingLeft: 8 + indent * 14,
        borderRadius: 3,
        borderLeft: isActive
          ? `2px solid ${SPINE.accent}`
          : "2px solid transparent",
        background: isActive
          ? SPINE.surfaceHi
          : isHovered
          ? SPINE.surface
          : "transparent",
        outline: item.drop ? `1px dashed ${SPINE.accent}` : "none",
        outlineOffset: item.drop ? -1 : 0,
        color: isActive || isHovered ? SPINE.text : SPINE.textMid,
        fontSize: 12,
        fontWeight: isActive ? 500 : 400,
        lineHeight: 1.2,
        cursor: "pointer",
      }}
    >
      {item.treeGuide && indent > 0 && (
        <>
          <span
            style={{
              position: "absolute",
              left: 8 + (indent - 1) * 14 + 6,
              top: 0,
              bottom: item.lastInGroup ? "50%" : 0,
              width: 1,
              background: SPINE.borderSoft,
              pointerEvents: "none",
            }}
          />
          <span
            style={{
              position: "absolute",
              left: 8 + (indent - 1) * 14 + 6,
              top: "50%",
              width: 7,
              height: 1,
              background: SPINE.borderSoft,
              pointerEvents: "none",
            }}
          />
        </>
      )}
      <span
        style={{
          width: 10,
          display: "inline-flex",
          justifyContent: "center",
          flexShrink: 0,
          position: "relative",
          zIndex: 1,
          background: caret !== "none" ? SPINE.panel : "transparent",
        }}
        onClick={(e) => {
          if (caret !== "none" && onToggle) {
            e.stopPropagation();
            onToggle(item.id);
          }
        }}
      >
        {caret === "down" && (
          <Icon name="chevdown" size={9} color={SPINE.textDim} />
        )}
        {caret === "right" && (
          <Icon name="chev" size={9} color={SPINE.textDim} />
        )}
        {item.ancestorActive && caret === "none" && (
          <span
            style={{
              width: 4,
              height: 4,
              borderRadius: 2,
              background: SPINE.accent,
              opacity: 0.6,
            }}
          />
        )}
      </span>
      {item.mark}
      {item.icon && (
        <Icon
          name={item.icon}
          size={13}
          color={isActive ? SPINE.accent : SPINE.textDim}
        />
      )}
      {item.accent && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: item.accent,
            flexShrink: 0,
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: labelFontFamily,
          fontStyle: labelFontStyle,
          fontSize: labelFontSize,
          fontWeight: isActive ? 500 : 400,
        }}
      >
        {item.label}
      </span>
      {item.rightSlot ??
        (item.count != null && (
          <span
            style={{
              fontFamily: SPINE.mono,
              fontSize: 10,
              color: isActive ? SPINE.textMid : SPINE.textDim,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtNum(item.count)}
          </span>
        ))}
    </div>
  );
}
