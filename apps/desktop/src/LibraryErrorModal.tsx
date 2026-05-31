import { SPINE } from "./tokens";
import { displayPath } from "./utils/formatters";
import type { LibraryErrorKind } from "./utils/formatters";

interface LibraryErrorModalProps {
  kind: LibraryErrorKind;
  /** The path the user attempted to open. Shown to the user so they
   *  can tell which library produced the error and decide. */
  attemptedPath: string;
  /** Re-open the OS file picker so the user can pick another path.
   *  Available on both `uninitialized` and `wrong-database-file`. */
  onPickAnother: () => void;
  /** Re-seed an empty/uninitialized location with the bundled calibre
   *  template. Available ONLY on `uninitialized` — not offered for
   *  `wrong-database-file` because that path is non-empty and may hold
   *  the user's irreplaceable other-app data. */
  onCreateHere?: () => void;
  onCancel: () => void;
}

// Three-button modal on `LibraryError::Uninitialized` (Pick another /
// Create library here / Cancel) and two-button on
// `LibraryError::WrongDatabaseFile` (Pick another / Cancel) per the
// Sprint 8.5 hot-fix dispatch. Surfaces both at first-run (Bootstrap)
// and on Switch-Library mid-session.
//
// The `Create library here` action is deliberately scoped to the
// uninitialized case: a 0-byte `metadata.db` is safe to overwrite,
// but a non-empty file with non-calibre tables could be the user's
// irreplaceable data — so we refuse to seed and force them to pick
// another path.
export default function LibraryErrorModal({
  kind,
  attemptedPath,
  onPickAnother,
  onCreateHere,
  onCancel,
}: LibraryErrorModalProps) {
  const heading =
    kind === "uninitialized" ? "Library is empty" : "Not a calibre library";
  const body =
    kind === "uninitialized"
      ? "The selected file exists but has no calibre tables yet. You can re-seed it from the bundled template, or pick a different library."
      : "The selected file is a database, but it doesn't look like a calibre metadata.db. Spine will not overwrite it. Pick a different file.";

  return (
    <>
      <div
        onClick={onCancel}
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
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={heading}
        style={{
          position: "fixed",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          background: SPINE.panel,
          border: `1px solid ${SPINE.borderHi}`,
          borderRadius: 4,
          padding: "18px 20px 16px",
          boxShadow: SPINE.shadowModal,
          zIndex: 1001,
          fontFamily: SPINE.sans,
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2
          style={{
            fontFamily: SPINE.sans,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: kind === "wrong-database-file" ? SPINE.alert : SPINE.textFaint,
            margin: 0,
            marginBottom: 10,
          }}
        >
          {heading}
        </h2>

        <div style={{ fontSize: 13, color: SPINE.text, marginBottom: 10, lineHeight: 1.5 }}>
          {body}
        </div>

        <div
          style={{
            fontFamily: SPINE.mono,
            fontSize: 11,
            color: SPINE.textDim,
            background: SPINE.canvas,
            border: `1px solid ${SPINE.borderSoft}`,
            borderRadius: 3,
            padding: "6px 8px",
            marginBottom: 16,
            wordBreak: "break-all",
          }}
        >
          {displayPath(attemptedPath)}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color: SPINE.textMid,
              border: `1px solid ${SPINE.border}`,
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onPickAnother}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color: SPINE.text,
              border: `1px solid ${SPINE.borderHi}`,
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Pick another
          </button>
          {kind === "uninitialized" && onCreateHere && (
            <button
              type="button"
              onClick={onCreateHere}
              style={{
                padding: "6px 16px",
                background: SPINE.accent,
                color: SPINE.inkInvert,
                border: "none",
                borderRadius: 3,
                fontFamily: SPINE.sans,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Create library here
            </button>
          )}
        </div>
      </div>
    </>
  );
}
