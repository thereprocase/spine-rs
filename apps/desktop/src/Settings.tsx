import { useEffect, type ReactNode } from "react";
import { SPINE } from "./tokens";
import { displayPath } from "./utils/formatters";

export type Theme = "auto" | "dark" | "light";
export type BackupRetention = "last-3" | "last-7" | "last-30" | "keep-all";

export interface RecentLibrary {
  path: string;
  pinned?: boolean;
  /** Optional human-friendly label; falls back to `displayPath(path)`. */
  label?: string;
}

export interface SettingsProps {
  onClose: () => void;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  currentLibraryPath: string | null;
  recentLibraries: RecentLibrary[];
  onSwitchLibrary: () => void;
  /** Optional — when omitted, recent rows display read-only without an
   *  open-on-click affordance. Wires to App.tsx's `openLibrary`. */
  onOpenLibrary?: (path: string) => void;
  onPinLibrary: (path: string) => void;
  onForgetLibrary: (path: string) => void;
  /** Existing chrome actions, surfaced as Library-section buttons.
   *  Optional so the section degrades to Switch-only when the parent
   *  doesn't expose them (test fixtures, headless contexts). */
  onRefreshLibrary?: () => void;
  onSyncWithCalibre?: () => void;

  // Backup section — props are optional so the section degrades to a
  // "configure when backend ships" empty-state pre-merge of the
  // POST /api/v1/library/backup + GET /api/v1/library/backup/last endpoints.
  /** Epoch ms of the last successful backup; null = never; undefined = endpoint not wired. */
  lastBackupAtMs?: number | null;
  backupDestination?: string | null;
  backupRetention?: BackupRetention;
  onPickBackupDest?: () => void;
  onBackupNow?: () => void;
  onRetentionChange?: (r: BackupRetention) => void;
  isBackupRunning?: boolean;
  /** Last error from a backup attempt, surfaced inline. */
  backupError?: string | null;
}

const RETENTION_LABELS: Record<BackupRetention, string> = {
  "last-3": "Keep last 3",
  "last-7": "Keep last 7",
  "last-30": "Keep last 30",
  "keep-all": "Keep all",
};

// Right-side Settings drawer per Sprint 9 dispatch. Fixed-width 380px,
// full-height, slides over the canvas. Sections: Theme · Library ·
// Backup · Reconcile · About. Replaces the small drop-menu off the gear
// icon — Theme is relocated here, the existing menu actions (Refresh /
// Sync with calibre) move into the Library section as secondary actions.
//
// Controlled component: parent owns all state (theme, recents, backup
// summary, isBackupRunning). Backup section gracefully degrades when
// backup props are undefined — pre-merge of the S9 endpoints the
// section reads "configure when backend ships". Cross-lane handshake
// pattern matches AddSubjectDialog's LCSH dropdown: pre-build against
// the locked contract, fall back gracefully.
export default function Settings({
  onClose,
  theme,
  onThemeChange,
  currentLibraryPath,
  recentLibraries,
  onSwitchLibrary,
  onOpenLibrary,
  onPinLibrary,
  onForgetLibrary,
  onRefreshLibrary,
  onSyncWithCalibre,
  lastBackupAtMs,
  backupDestination,
  backupRetention,
  onPickBackupDest,
  onBackupNow,
  onRetentionChange,
  isBackupRunning,
  backupError,
}: SettingsProps) {
  const backupAvailable = onBackupNow !== undefined;

  // Document-level Escape close. The drawer's `onKeyDown` only fires
  // when the focused element is inside the aside; if the user has
  // focus on something outside (or nothing focused) Escape would be
  // missed. Document listener catches both.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        aria-label="Settings"
        data-testid="settings-drawer"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          background: SPINE.panel,
          borderLeft: `1px solid ${SPINE.borderHi}`,
          boxShadow: SPINE.shadowModal,
          zIndex: 1001,
          fontFamily: SPINE.sans,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
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
          <h2
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: 0.4,
              color: SPINE.text,
            }}
          >
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
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

        <Section title="Theme" testId="settings-theme">
          <div role="radiogroup" aria-label="Theme" style={{ display: "flex", gap: 6 }}>
            {(["auto", "dark", "light"] as const).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                onClick={() => onThemeChange(t)}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  background: theme === t ? SPINE.surfaceHi : "transparent",
                  color: theme === t ? SPINE.text : SPINE.textMid,
                  border: `1px solid ${theme === t ? SPINE.borderHi : SPINE.border}`,
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: SPINE.sans,
                  fontSize: 12,
                  textTransform: "capitalize",
                }}
                title={t === "auto" ? "Follow OS prefers-color-scheme" : `Force ${t} theme`}
              >
                {t}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Library" testId="settings-library">
          <Field label="Current">
            <code
              style={{
                fontFamily: SPINE.mono,
                fontSize: 11,
                color: SPINE.text,
                wordBreak: "break-all",
                display: "block",
              }}
            >
              {currentLibraryPath ? displayPath(currentLibraryPath) : "(none open)"}
            </code>
          </Field>
          <Field label="Recent">
            {recentLibraries.length === 0 ? (
              <div style={{ fontSize: 11, color: SPINE.textDim }}>No recent libraries.</div>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {recentLibraries.map((lib) => (
                  <li
                    key={lib.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11,
                      color: SPINE.textMid,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenLibrary?.(lib.path)}
                      disabled={!onOpenLibrary}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        padding: "3px 6px",
                        color:
                          lib.path === currentLibraryPath ? SPINE.accent : SPINE.text,
                        cursor: onOpenLibrary ? "pointer" : "default",
                        fontFamily: SPINE.sans,
                        fontSize: 11,
                        wordBreak: "break-all",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 1,
                      }}
                      title={lib.path}
                    >
                      {lib.label && (
                        <span style={{ fontWeight: 500 }}>{lib.label}</span>
                      )}
                      <span
                        style={{
                          fontFamily: SPINE.mono,
                          fontSize: 10,
                          color: lib.label ? SPINE.textDim : "inherit",
                        }}
                      >
                        {displayPath(lib.path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onPinLibrary(lib.path)}
                      title={lib.pinned ? "Unpin from top" : "Pin to top"}
                      aria-pressed={lib.pinned}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: lib.pinned ? SPINE.accent : SPINE.textFaint,
                        cursor: "pointer",
                        fontSize: 11,
                        padding: "2px 4px",
                      }}
                    >
                      {lib.pinned ? "★" : "☆"}
                    </button>
                    {lib.path !== currentLibraryPath && (
                      <button
                        type="button"
                        onClick={() => onForgetLibrary(lib.path)}
                        title="Forget this library"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: SPINE.textFaint,
                          cursor: "pointer",
                          fontSize: 11,
                          padding: "2px 4px",
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <ButtonRow>
            <DrawerButton onClick={onSwitchLibrary}>Switch library…</DrawerButton>
            {onRefreshLibrary && (
              <DrawerButton onClick={onRefreshLibrary}>Refresh</DrawerButton>
            )}
            {onSyncWithCalibre && (
              <DrawerButton onClick={onSyncWithCalibre} kind="quiet">
                Sync with calibre
              </DrawerButton>
            )}
          </ButtonRow>
        </Section>

        <Section title="Backup" testId="settings-backup">
          {!backupAvailable ? (
            <div style={{ fontSize: 11, color: SPINE.textDim }}>
              Backup endpoint pending — feature lights up automatically when the
              backend ships in this Sprint.
            </div>
          ) : (
            <>
              <Field label="Destination">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <code
                    style={{
                      fontFamily: SPINE.mono,
                      fontSize: 11,
                      color: SPINE.text,
                      wordBreak: "break-all",
                      flex: 1,
                    }}
                  >
                    {backupDestination ? displayPath(backupDestination) : "(not configured)"}
                  </code>
                  {onPickBackupDest && (
                    <DrawerButton onClick={onPickBackupDest} kind="quiet">
                      Choose…
                    </DrawerButton>
                  )}
                </div>
              </Field>
              <Field label="Last backup">
                <span
                  data-testid="settings-last-backup"
                  style={{ fontFamily: SPINE.sans, fontSize: 11, color: SPINE.textMid }}
                >
                  {lastBackupAtMs == null
                    ? "never"
                    : new Date(lastBackupAtMs).toLocaleString()}
                </span>
              </Field>
              {onRetentionChange && (
                <Field label="Retention">
                  <select
                    value={backupRetention ?? "last-7"}
                    onChange={(e) => onRetentionChange(e.target.value as BackupRetention)}
                    aria-label="Retention"
                    style={{
                      width: "100%",
                      padding: "5px 8px",
                      background: SPINE.canvas,
                      border: `1px solid ${SPINE.border}`,
                      borderRadius: 3,
                      color: SPINE.text,
                      fontFamily: SPINE.sans,
                      fontSize: 12,
                    }}
                  >
                    {(Object.keys(RETENTION_LABELS) as BackupRetention[]).map((r) => (
                      <option key={r} value={r}>
                        {RETENTION_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {backupError && (
                <div style={{ fontSize: 11, color: SPINE.alert, marginTop: 4 }}>
                  {backupError}
                </div>
              )}
              <ButtonRow>
                <DrawerButton
                  onClick={onBackupNow!}
                  disabled={isBackupRunning}
                  kind="primary"
                >
                  {isBackupRunning ? "Backing up…" : "Back up now"}
                </DrawerButton>
              </ButtonRow>
            </>
          )}
        </Section>

        <Section title="Reconcile" testId="settings-reconcile">
          <div style={{ fontSize: 11, color: SPINE.textDim }}>
            Sprint 10: full reconcile drawer (per ADR 015). For now, individual
            reconcile flows live on each book's Inspector.
          </div>
        </Section>

        <Section title="About" testId="settings-about">
          <Field label="Spine">
            <span style={{ fontFamily: SPINE.sans, fontSize: 11, color: SPINE.textMid }}>
              Alpha · ground-up calibre rewrite
            </span>
          </Field>
          <Field label="License">
            <span style={{ fontFamily: SPINE.sans, fontSize: 11, color: SPINE.textMid }}>
              GPL-3.0
            </span>
          </Field>
        </Section>
      </aside>
    </>
  );
}

interface SectionProps {
  title: string;
  testId?: string;
  children: ReactNode;
}

function Section({ title, testId, children }: SectionProps) {
  return (
    <section
      data-testid={testId}
      style={{
        padding: "14px 18px",
        borderBottom: `1px solid ${SPINE.borderSoft}`,
      }}
    >
      <h3
        style={{
          margin: 0,
          marginBottom: 10,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: SPINE.textFaint,
        }}
      >
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontFamily: SPINE.sans,
          fontSize: 9,
          fontWeight: 500,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: SPINE.textFaint,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
      {children}
    </div>
  );
}

interface DrawerButtonProps {
  onClick: () => void;
  disabled?: boolean;
  kind?: "primary" | "quiet";
  children: ReactNode;
}

function DrawerButton({ onClick, disabled, kind, children }: DrawerButtonProps) {
  const palette =
    kind === "primary"
      ? { bg: SPINE.accent, fg: SPINE.inkInvert, border: SPINE.accent }
      : kind === "quiet"
      ? { bg: "transparent", fg: SPINE.textDim, border: SPINE.borderSoft }
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
        fontSize: 12,
        fontWeight: kind === "primary" ? 500 : 400,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
