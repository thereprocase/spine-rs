import type { CSSProperties, ReactNode } from "react";
import { Book as BookIcon, FolderPlus, FileUp, FolderOpen } from "lucide-react";
import { SPINE } from "./tokens";
import Badge from "./components/Badge";
import { displayPath } from "./utils/formatters";

interface BootstrapProps {
  recentLibraries: string[];
  isOpeningLibrary: boolean;
  libraryError: string | null;
  onStartNew: () => void;
  onAddFolder: () => void;
  onOpenExisting: () => void;
  onOpenRecent: (path: string) => void;
}

export default function Bootstrap({
  recentLibraries,
  isOpeningLibrary,
  libraryError,
  onStartNew,
  onAddFolder,
  onOpenExisting,
  onOpenRecent,
}: BootstrapProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "grid",
        placeItems: "center",
        padding: 32,
        background: SPINE.bg,
        color: SPINE.text,
        fontFamily: SPINE.sans,
      }}
    >
      <div
        style={{
          width: "min(1040px, 100%)",
          display: "grid",
          gap: 22,
          padding: 36,
          background: SPINE.panel,
          border: `1px solid ${SPINE.border}`,
          borderRadius: 4,
          boxShadow: SPINE.shadowModal,
        }}
      >
        <header style={{ display: "grid", gap: 12, justifyItems: "center", textAlign: "center", paddingBottom: 6 }}>
          <div
            style={{
              width: 44,
              height: 44,
              display: "grid",
              placeItems: "center",
              background: SPINE.canvasAlt,
              border: `1px solid ${SPINE.border}`,
              borderRadius: 3,
            }}
          >
            <BookIcon size={22} color={SPINE.accent} />
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: SPINE.serif,
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 30,
              letterSpacing: -0.2,
              color: SPINE.text,
            }}
          >
            Welcome to Spine
          </h1>
          <p
            style={{
              margin: 0,
              maxWidth: 560,
              color: SPINE.textMid,
              lineHeight: 1.55,
              fontSize: 13,
            }}
          >
            A library manager for people who own their books. Pick how you want to start.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          }}
        >
          <ActionCard
            kind="primary"
            icon={<FolderPlus size={26} color={SPINE.accent} />}
            title="Start a new library"
            description="Pick an empty folder. Spine sets up a fresh library you can start adding books to."
            cta="Choose folder…"
            onClick={onStartNew}
            disabled={isOpeningLibrary}
          />
          <ActionCard
            kind="primary"
            icon={<FileUp size={26} color={SPINE.accent} />}
            title="Add a folder of EPUBs"
            description="Point Spine at a folder of books. We'll create a library there and ingest every EPUB."
            cta="Choose folder…"
            onClick={onAddFolder}
            disabled={isOpeningLibrary}
          />
          <ActionCard
            kind="secondary"
            icon={<FolderOpen size={26} color={SPINE.textDim} />}
            title="Open an existing calibre library"
            description="You already have a calibre library? Point us at its metadata.db and we'll use it."
            cta="Choose metadata.db…"
            badge={<Badge kind="neutral" label="Legacy" />}
            onClick={onOpenExisting}
            disabled={isOpeningLibrary}
          />
        </div>

        {isOpeningLibrary && (
          <p
            style={{
              margin: 0,
              color: SPINE.textDim,
              fontSize: 12,
              fontFamily: SPINE.mono,
              textAlign: "center",
            }}
          >
            Working on it…
          </p>
        )}
        {libraryError && (
          <p
            style={{
              margin: 0,
              color: SPINE.alert,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            {libraryError}
          </p>
        )}

        {recentLibraries.length > 0 && (
          <section style={{ display: "grid", gap: 10, paddingTop: 6, borderTop: `1px solid ${SPINE.borderSoft}` }}>
            <h2
              style={{
                margin: 0,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                color: SPINE.textFaint,
              }}
            >
              Recent libraries
            </h2>
            {recentLibraries.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => onOpenRecent(path)}
                title={path}
                style={{
                  textAlign: "left",
                  background: SPINE.canvasAlt,
                  color: SPINE.textMid,
                  border: `1px solid ${SPINE.borderSoft}`,
                  borderRadius: 3,
                  padding: "10px 14px",
                  fontFamily: SPINE.mono,
                  fontSize: 11,
                  cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {displayPath(path)}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

interface ActionCardProps {
  kind: "primary" | "secondary";
  icon: ReactNode;
  title: string;
  description: string;
  cta: string;
  badge?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

function ActionCard({ kind, icon, title, description, cta, badge, onClick, disabled }: ActionCardProps) {
  const baseStyle: CSSProperties = {
    display: "grid",
    gridTemplateRows: "auto auto 1fr auto",
    gap: 8,
    padding: "22px 18px 18px",
    background: kind === "primary" ? SPINE.canvas : SPINE.canvasAlt,
    border: `1px solid ${kind === "primary" ? SPINE.border : SPINE.borderSoft}`,
    borderRadius: 3,
    textAlign: "left",
    color: kind === "primary" ? SPINE.text : SPINE.textMid,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    font: "inherit",
    transition: "border-color 120ms ease, background 120ms ease",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={baseStyle}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = SPINE.accent;
        e.currentTarget.style.background = SPINE.surface;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = kind === "primary" ? SPINE.border : SPINE.borderSoft;
        e.currentTarget.style.background = kind === "primary" ? SPINE.canvas : SPINE.canvasAlt;
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {icon}
        {badge}
      </div>
      <h2
        style={{
          margin: 0,
          fontFamily: SPINE.serif,
          fontStyle: "italic",
          fontWeight: 600,
          fontSize: 17,
          color: SPINE.text,
          letterSpacing: -0.1,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          color: SPINE.textMid,
          lineHeight: 1.5,
        }}
      >
        {description}
      </p>
      <span
        style={{
          fontFamily: SPINE.mono,
          fontSize: 11,
          color: kind === "primary" ? SPINE.accent : SPINE.textDim,
          marginTop: 4,
        }}
      >
        {cta}
      </span>
    </button>
  );
}
