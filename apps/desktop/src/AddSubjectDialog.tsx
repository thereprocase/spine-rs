import { useEffect, useRef, useState } from "react";
import { SPINE } from "./tokens";
import { callApiJson, isApiError } from "./api/client";

export type SubjectSource = "lcsh" | "local-tag";

interface AddSubjectDialogProps {
  bookTitle: string;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (term: string, source: SubjectSource) => void;
}

// Wire shape per the Sprint-8 Step 4 design:
//   GET /api/v1/loc/lcsh/suggest?q=<term> → { matches: [{uri, label}] }
// Backend projects suggest2's `aLabel` into `label`. First hit is best
// per §A.4 (sortmethod=alpha, left-anchored — no scoring).
interface LcshMatch {
  uri: string;
  label: string;
}

interface LcshSuggestResponse {
  matches: LcshMatch[];
}

// Modal for the Inspector's "+ add" affordance under Subjects · LCSH.
// Wire shape per ADR 014 §5: `{ term: String, source: "lcsh" | "local-tag" }`.
//
// LCSH autocomplete: as the user types (≥2 chars), debounced 200ms, GETs the
// suggest endpoint and renders the first 10 hits as a dropdown. Clicking a
// hit fills the term + flips source to "lcsh". Endpoint may 404 pre-merge —
// dropdown silently no-ops in that case so free-text submit still works.
//
// Mounting auto-focuses the term input. Enter saves (or accepts highlighted
// hit if dropdown open), ↑/↓ navigates dropdown, Escape cancels.
export default function AddSubjectDialog({
  bookTitle,
  isSaving,
  onClose,
  onSave,
}: AddSubjectDialogProps) {
  const [term, setTerm] = useState("");
  const [reconcile, setReconcile] = useState(true);
  const [matches, setMatches] = useState<LcshMatch[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [autocompleteAvailable, setAutocompleteAvailable] = useState(true);
  const termRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => termRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  // Debounced autocomplete fetch. <2 chars → empty; ≥2 chars → fire after
  // 200ms of quiet. Hit 404 once → mark unavailable for the rest of the
  // dialog lifetime (avoids hammering an endpoint we know isn't there yet).
  useEffect(() => {
    if (!reconcile || !autocompleteAvailable) {
      setMatches([]);
      return;
    }
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setMatches([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        const resp = await callApiJson<LcshSuggestResponse>(
          "GET",
          `/api/v1/loc/lcsh/suggest?q=${encodeURIComponent(trimmed)}`
        );
        setMatches(resp.matches ?? []);
        setHighlightIdx(0);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          // Endpoint not deployed yet — degrade to free-text, stop polling.
          setAutocompleteAvailable(false);
          setMatches([]);
        } else {
          // Network blip / 5xx — keep last results, don't surface noise.
        }
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [term, reconcile, autocompleteAvailable]);

  const acceptMatch = (m: LcshMatch) => {
    setTerm(m.label);
    setReconcile(true);
    setMatches([]);
  };

  const submit = () => {
    const trimmed = term.trim();
    if (!trimmed) return;
    onSave(trimmed, reconcile ? "lcsh" : "local-tag");
  };

  const dropdownOpen = matches.length > 0 && reconcile && term.trim().length >= 2;

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
        aria-label={`Add subject to ${bookTitle}`}
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
          boxShadow: SPINE.shadowModal,
          zIndex: 1001,
          fontFamily: SPINE.sans,
        }}
        onKeyDown={(e) => {
          if (dropdownOpen) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightIdx((i) => Math.min(matches.length - 1, i + 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(0, i - 1));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const m = matches[highlightIdx];
              if (m) acceptMatch(m);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (matches.length > 0) {
              setMatches([]);
            } else {
              onClose();
            }
          }
        }}
      >
        <h2
          id="add-subject-heading"
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
          Add subject
        </h2>

        <label style={{ display: "block", marginBottom: 12, position: "relative" }}>
          <div style={{ fontSize: 10, color: SPINE.textDim, marginBottom: 4 }}>Subject term</div>
          <input
            ref={termRef}
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            disabled={isSaving}
            placeholder="e.g. Science fiction"
            autoComplete="off"
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-autocomplete="list"
            aria-required="true"
            style={{
              width: "100%",
              padding: "7px 10px",
              background: SPINE.canvas,
              border: `1px solid ${SPINE.border}`,
              borderRadius: 3,
              color: SPINE.text,
              fontFamily: SPINE.sans,
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          {dropdownOpen && (
            <ul
              role="listbox"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 2,
                background: SPINE.panel,
                border: `1px solid ${SPINE.borderHi}`,
                borderRadius: 3,
                boxShadow: SPINE.shadowPopover,
                listStyle: "none",
                margin: 0,
                padding: 4,
                maxHeight: 280,
                overflowY: "auto",
                zIndex: 1002,
              }}
            >
              {matches.map((m, idx) => (
                <li
                  key={m.uri}
                  role="option"
                  aria-selected={idx === highlightIdx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptMatch(m);
                  }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  style={{
                    padding: "5px 8px",
                    background: idx === highlightIdx ? SPINE.surface : "transparent",
                    color: idx === highlightIdx ? SPINE.text : SPINE.textMid,
                    borderRadius: 2,
                    cursor: "pointer",
                    fontSize: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span>{m.label}</span>
                  <span style={{ fontFamily: SPINE.mono, fontSize: 10, color: SPINE.textFaint }}>
                    {m.uri}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
            Reconcile against id.loc.gov LCSH
            <span style={{ display: "block", fontSize: 10, color: SPINE.textDim, marginTop: 2 }}>
              {reconcile
                ? "Backend will look up this term in LCSH; falls back to a local-mint URI if not matched."
                : "Skip the LoC lookup — store as a local-only tag with a minted urn:spine:subject URI."}
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
            disabled={isSaving || !term.trim()}
            style={{
              padding: "6px 16px",
              background: SPINE.accent,
              color: SPINE.inkInvert,
              border: "none",
              borderRadius: 3,
              fontFamily: SPINE.sans,
              fontSize: 12,
              fontWeight: 500,
              cursor: isSaving || !term.trim() ? "default" : "pointer",
              opacity: !term.trim() ? 0.6 : 1,
            }}
          >
            {isSaving ? "Saving…" : "Add subject"}
          </button>
        </div>
      </div>
    </>
  );
}
