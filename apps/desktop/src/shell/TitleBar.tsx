import { SPINE } from "../tokens";
import Icon from "../components/Icon";

interface TitleBarProps {
  libraryName: string;
  breadcrumb?: string;
  searchValue: string;
  onSearchChange?: (value: string) => void;
  onSearchFocus?: () => void;
  onLibrarySwitch?: () => void;
  onAddClick?: () => void;
  onSettingsClick?: () => void;
}

const TRAFFIC_LIGHT_COLORS = ["#d07060", "#d4a85a", "#8ab07a"] as const;

function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform);
}

// 36px top chrome. Traffic lights are macOS-only decoration; Windows and
// Linux builds use the native window controls supplied by the host shell.
export default function TitleBar({
  libraryName,
  breadcrumb,
  searchValue,
  onSearchChange,
  onSearchFocus,
  onLibrarySwitch,
  onAddClick,
  onSettingsClick,
}: TitleBarProps) {
  const showTrafficLights = isMacLikePlatform();

  return (
    <div
      style={{
        height: 36,
        background: SPINE.bg,
        borderBottom: `1px solid ${SPINE.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 10px 0 12px",
        fontFamily: SPINE.sans,
        fontSize: 12,
        color: SPINE.textMid,
        gap: 12,
        flexShrink: 0,
      }}
    >
      {showTrafficLights && (
        <div style={{ display: "flex", gap: 7 }}>
          {TRAFFIC_LIGHT_COLORS.map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onLibrarySwitch}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: SPINE.text,
          fontWeight: 500,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: onLibrarySwitch ? "pointer" : "default",
          font: "inherit",
        }}
      >
        <Icon name="books" size={13} color={SPINE.accent} />
        <span>{libraryName}</span>
        <Icon name="chevdown" size={12} color={SPINE.textDim} />
      </button>

      <div style={{ width: 1, height: 14, background: SPINE.border }} />

      {breadcrumb && (
        <div style={{ color: SPINE.textDim, fontSize: 12 }}>{breadcrumb}</div>
      )}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: SPINE.canvas,
          border: `1px solid ${SPINE.border}`,
          padding: "4px 10px",
          borderRadius: 3,
          width: 280,
          fontFamily: SPINE.mono,
          fontSize: 11,
          color: SPINE.text,
        }}
      >
        <Icon name="search" size={12} color={SPINE.textDim} />
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange?.(e.target.value)}
          onFocus={onSearchFocus}
          placeholder="search…"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "inherit",
            font: "inherit",
            padding: 0,
          }}
        />
        <span style={{ color: SPINE.textFaint, fontSize: 10 }}>⌘K</span>
      </div>

      <button
        type="button"
        onClick={onAddClick}
        aria-label="Add"
        style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
      >
        <Icon name="add" size={14} color={SPINE.textDim} />
      </button>
      <button
        type="button"
        onClick={onSettingsClick}
        aria-label="Settings"
        style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
      >
        <Icon name="settings" size={14} color={SPINE.textDim} />
      </button>
    </div>
  );
}
