import { SPINE } from "../tokens";
import Icon from "../components/Icon";
import { displayPath } from "../utils/formatters";

interface LibraryHeaderCardProps {
  libraryName: string;
  libraryPath: string | null;
  onClick: () => void;
}

// Sidebar header card. Replaces the bare library-name treatment in
// TitleBar as the primary library-switcher affordance. 24×24 brand
// square with serif-italic "S" + library name + mono path subtitle +
// chevron. Locked in v2 sidebar bundle (IdentityStrip, L153).
export default function LibraryHeaderCard({
  libraryName,
  libraryPath,
  onClick,
}: LibraryHeaderCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "12px 14px 11px",
        width: "100%",
        boxSizing: "border-box",
        textAlign: "left",
      }}
    >
      <div
        style={{
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
          flexShrink: 0,
        }}
      >
        S
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: SPINE.sans,
            fontSize: 12.5,
            color: SPINE.text,
            fontWeight: 500,
            lineHeight: 1.1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {libraryName}
        </div>
        {libraryPath && (
          <div
            style={{
              fontFamily: SPINE.mono,
              fontSize: 9.5,
              color: SPINE.textFaint,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayPath(libraryPath)}
          </div>
        )}
      </div>
      <Icon name="chevdown" size={11} color={SPINE.textDim} />
    </button>
  );
}
