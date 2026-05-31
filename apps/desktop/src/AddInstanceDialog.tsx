import { useEffect, useRef, useState } from "react";
import { SPINE } from "./tokens";

// EDTF Level 1 — simplified to the subset Spine actually uses for ebook
// pubDates. Covers: YYYY, YYYY-MM, YYYY-MM-DD, YYYY?, YYYY~, YYYY%,
// YYYY-MM?, YYYY-MM-DD?, open intervals YYYY/YYYY, YYYY/.., ../YYYY, and
// unspecified XXXX, YYYX, YYXX, YXXX. Per an LCCN-format review:
// rejects negative years, Y-prefixed huge years, and Level-2 sets (rare
// in ebook metadata; surface as "advanced advanced" if a real user hits
// the ceiling).
//
// Earlier draft of this regex had `[Y]?-?\d{4}` — code review
// F3 caught the inconsistency vs. the prose. The
// year part is a flat `\d{4}` so Y-prefix and negative years are both
// rejected as the prose claims.
const EDTF_L1 =
  /^(?:\d{4}(?:-\d{2}(?:-\d{2})?)?[?~%]?|\d{4}\/(?:\d{4}|\.\.)|\.\.\/\d{4}|\d{3}X|\d{2}XX|\dXXX|XXXX)$/;

// Minimum year for a soft warning. Calibre's projection sometimes lands
// `0101-01-01` as a sentinel for "unknown date" — technically EDTF-valid
// but semantically wrong. 1450 is the printed-press floor; Project
// Gutenberg classics with legitimate 1700s dates pass cleanly.
const PUBDATE_MIN_YEAR = 1450;

// Verifies a `YYYY-MM-DD` or `YYYY-MM` substring represents a real
// Gregorian date (code review W1: regex alone admits 2024-13-99,
// 2024-02-30, etc.). Round-trip through Date.UTC and check that the
// resulting components match the input — JS Date silently overflows
// otherwise (`new Date(2024, 12, 31)` becomes January next year).
function isRealGregorianDate(s: string): boolean {
  const ymd = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!ymd) return true; // No date components in this token; nothing to verify.
  const y = parseInt(ymd[1], 10);
  const m = parseInt(ymd[2], 10);
  if (m < 1 || m > 12) return false;
  if (ymd[3] === undefined) return true;
  const d = parseInt(ymd[3], 10);
  if (d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function validateEdtf(value: string): { ok: boolean; warning?: string; reason?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (!EDTF_L1.test(trimmed)) {
    return {
      ok: false,
      reason: 'Use EDTF: 2024, 2024-04, 2024-04-15, or 2024? (uncertain)',
    };
  }
  if (!isRealGregorianDate(trimmed)) {
    return {
      ok: false,
      reason: 'That month/day combination is not a valid date',
    };
  }
  // Soft year-floor warning — flagged, not rejected.
  const yearMatch = trimmed.match(/^(\d{4})/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year < PUBDATE_MIN_YEAR) {
      return {
        ok: true,
        warning: `Year ${year} is unusually early — confirm or fix (calibre often imports 0101 as an "unknown" sentinel)`,
      };
    }
  }
  return { ok: true };
}

export interface InstanceDraft {
  format: string;
  publicationDate?: string;
  publisher?: string;
  isbn?: string;
  title?: string;
  reconcileAgainstLoc: boolean;
}

interface AddInstanceDialogProps {
  bookTitle: string;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (draft: InstanceDraft) => void;
}

// Modal for the Inspector's "+ instance" affordance under Work/Instance/Item.
// Wire shape per ADR 014 §1+§2 / spine-api `AddInstanceRequest`:
//   { format, publicationDate?, publisher?, isbn?, title?, reconcileAgainstLoc? }
//
// Required: format. Reconcile defaults true so the canonical body is sent
// even when the LCSH adapter is still stubbed — when reconcile lights up,
// every existing instance is reconcilable retroactively (no migration commit).
//
// Mounting auto-focuses the format input. Cmd/Ctrl+Enter saves (the
// dialog has 5 fields; bare Enter would close mid-typing, so the
// keyboard shortcut is gated on a modifier). Escape cancels. The
// explicit "Add instance" button covers the no-modifier path.
export default function AddInstanceDialog({
  bookTitle,
  isSaving,
  onClose,
  onSave,
}: AddInstanceDialogProps) {
  const [format, setFormat] = useState("EPUB");
  const [publicationDate, setPublicationDate] = useState("");
  const [publisher, setPublisher] = useState("");
  const [isbn, setIsbn] = useState("");
  const [title, setTitle] = useState("");
  const [reconcile, setReconcile] = useState(true);
  const formatRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => formatRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const trimmedFormat = format.trim();
  const dateCheck = validateEdtf(publicationDate);
  const canSubmit = trimmedFormat.length > 0 && dateCheck.ok;

  const submit = () => {
    if (!canSubmit) return;
    onSave({
      format: trimmedFormat,
      publicationDate: publicationDate.trim() || undefined,
      publisher: publisher.trim() || undefined,
      isbn: isbn.trim() || undefined,
      title: title.trim() || undefined,
      reconcileAgainstLoc: reconcile,
    });
  };

  const fieldStyle = {
    width: "100%",
    padding: "7px 10px",
    background: SPINE.canvas,
    border: `1px solid ${SPINE.border}`,
    borderRadius: 3,
    color: SPINE.text,
    fontFamily: SPINE.sans,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
  };

  const labelStyle = {
    fontSize: 10,
    color: SPINE.textDim,
    marginBottom: 4,
  };

  return (
    <>
      <div
        onClick={() => {
          if (!isSaving) onClose();
        }}
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
        role="dialog"
        aria-modal="true"
        aria-label={`Add instance to ${bookTitle}`}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 540,
          maxHeight: "84vh",
          overflowY: "auto",
          background: SPINE.panel,
          border: `1px solid ${SPINE.borderHi}`,
          borderRadius: 4,
          padding: "18px 20px 16px",
          boxShadow: SPINE.shadowModal,
          zIndex: 1001,
          fontFamily: SPINE.sans,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2
          id="add-instance-heading"
          style={{
            fontFamily: SPINE.sans,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: SPINE.textFaint,
            margin: 0,
            marginBottom: 10,
          }}
        >
          Add instance
        </h2>
        <div style={{ fontSize: 11, color: SPINE.textDim, marginBottom: 14 }}>
          New edition of <span style={{ color: SPINE.textMid }}>{bookTitle}</span>
        </div>

        <label style={{ display: "block", marginBottom: 10 }}>
          <div style={labelStyle}>Format <span style={{ color: SPINE.alert }}>*</span></div>
          <input
            ref={formatRef}
            type="text"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            disabled={isSaving}
            placeholder="EPUB, PDF, MOBI, hardcover, paperback…"
            aria-required="true"
            style={fieldStyle}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <label style={{ display: "block" }}>
            <div style={labelStyle}>Publication date</div>
            <input
              type="text"
              value={publicationDate}
              onChange={(e) => setPublicationDate(e.target.value)}
              disabled={isSaving}
              placeholder="2026 or 2026-04-25"
              style={{
                ...fieldStyle,
                border: `1px solid ${dateCheck.ok ? SPINE.border : SPINE.alert}`,
              }}
            />
            {dateCheck.reason && (
              <div style={{ fontSize: 10, color: SPINE.alert, marginTop: 3 }}>
                {dateCheck.reason}
              </div>
            )}
            {dateCheck.warning && (
              <div style={{ fontSize: 10, color: SPINE.warn, marginTop: 3 }}>
                {dateCheck.warning}
              </div>
            )}
          </label>
          <label style={{ display: "block" }}>
            <div style={labelStyle}>ISBN</div>
            <input
              type="text"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              disabled={isSaving}
              placeholder="978…"
              style={fieldStyle}
            />
          </label>
        </div>

        <label style={{ display: "block", marginBottom: 10 }}>
          <div style={labelStyle}>Publisher</div>
          <input
            type="text"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            disabled={isSaving}
            placeholder="optional"
            style={fieldStyle}
          />
        </label>

        <label style={{ display: "block", marginBottom: 14 }}>
          <div style={labelStyle}>Edition title (if different from Work)</div>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isSaving}
            placeholder="optional"
            style={fieldStyle}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 10px",
            border: `1px solid ${SPINE.borderSoft}`,
            borderRadius: 3,
            background: SPINE.canvas,
            cursor: "pointer",
            marginBottom: 14,
          }}
        >
          <input
            type="checkbox"
            checked={reconcile}
            onChange={(e) => setReconcile(e.target.checked)}
            disabled={isSaving}
            style={{ marginTop: 2 }}
          />
          <span style={{ flex: 1, fontFamily: SPINE.sans, fontSize: 12, color: SPINE.text }}>
            Reconcile against id.loc.gov
            <span style={{ display: "block", fontSize: 10, color: SPINE.textDim, marginTop: 2 }}>
              {reconcile
                ? "Backend will look up this edition by ISBN (then title+author) at LoC. Falls back to a local-mint URI if not matched."
                : "Skip the LoC lookup — store as locally-minted urn:spine:instance URI (use for fan editions / private prints)."}
            </span>
          </span>
        </label>

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
            disabled={isSaving || !canSubmit}
            style={{
              padding: "6px 16px",
              background: SPINE.accent,
              color: SPINE.inkInvert,
              border: "none",
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              fontWeight: 500,
              cursor: isSaving || !canSubmit ? "default" : "pointer",
              opacity: !canSubmit ? 0.6 : 1,
            }}
          >
            {isSaving ? "Saving…" : "Add instance"}
          </button>
        </div>
      </div>
    </>
  );
}
