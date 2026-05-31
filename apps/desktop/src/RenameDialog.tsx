import { useEffect, useRef, useState } from "react";
import { SPINE } from "./tokens";

interface RenameDialogProps {
  bookId: string;
  initialTitle: string;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (newTitle: string) => void;
}

// F2 inline-rename modal. Single text input pre-filled with the
// current title; Enter saves, Escape cancels. Mounts with the input
// pre-selected so the user can immediately type a replacement.
//
// The actual save path goes through App.tsx's existing
// `handleSaveEdit(bookId, draftGraph)` so we get the same validation,
// toast feedback, and library-refresh as the legacy edit mode.
export default function RenameDialog({
  bookId,
  initialTitle,
  isSaving,
  onClose,
  onSave,
}: RenameDialogProps) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialTitle) {
      onClose();
      return;
    }
    onSave(trimmed);
  };

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "brightness(0.5) saturate(0.7)",
          WebkitBackdropFilter: "brightness(0.5) saturate(0.7)",
          zIndex: 1000,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Rename ${initialTitle}`}
        data-book-id={bookId}
        style={{
          position: "fixed",
          top: "30%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          background: SPINE.panel,
          border: `1px solid ${SPINE.borderHi}`,
          borderRadius: 4,
          padding: "18px 20px 16px",
          boxShadow: "0 30px 80px rgba(0,0,0,.6), 0 10px 30px rgba(0,0,0,.4)",
          zIndex: 1001,
          fontFamily: SPINE.sans,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div
          style={{
            fontFamily: SPINE.sans,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: SPINE.textFaint,
            marginBottom: 8,
          }}
        >
          Rename · F2
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isSaving}
          style={{
            width: "100%",
            padding: "8px 10px",
            background: SPINE.canvas,
            border: `1px solid ${SPINE.border}`,
            borderRadius: 3,
            color: SPINE.text,
            fontFamily: SPINE.serif,
            fontStyle: "italic",
            fontSize: 16,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color: SPINE.textMid,
              border: `1px solid ${SPINE.border}`,
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              cursor: isSaving ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isSaving}
            style={{
              padding: "6px 16px",
              background: SPINE.accent,
              color: SPINE.inkInvert,
              border: "none",
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              fontWeight: 500,
              cursor: isSaving ? "default" : "pointer",
            }}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
