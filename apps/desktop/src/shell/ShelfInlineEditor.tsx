import { useEffect, useRef, useState } from "react";
import { SPINE } from "../tokens";
import ShelfMark, { SHELF_TONE_HEX, type ShelfTone } from "./ShelfMark";

interface ShelfInlineEditorProps {
  initialLabel?: string;
  initialLetter: string;
  initialTone: ShelfTone;
  onCommit: (input: { label: string; letter: string; tone: ShelfTone }) => void;
  onCancel: () => void;
}

const LETTER_PALETTE = [
  "P", "R", "L", "S", "K", "F", "T", "A", "M", "C",
];
const TONE_PALETTE: ShelfTone[] = [
  "brass", "slate", "oxblood", "amber", "sage", "steel",
];

// Inline shelf editor — focused-input + glyph + color picker. Locked
// in v2 (ShelfInlineEdit, L866). Commits on Enter, cancels on Escape.
// Letter + tone pre-loaded by caller; user can override either.
export default function ShelfInlineEditor({
  initialLabel = "",
  initialLetter,
  initialTone,
  onCommit,
  onCancel,
}: ShelfInlineEditorProps) {
  const [label, setLabel] = useState(initialLabel);
  const [letter, setLetter] = useState(initialLetter);
  const [tone, setTone] = useState<ShelfTone>(initialTone);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const tryCommit = () => {
    const trimmed = label.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit({ label: trimmed, letter, tone });
  };

  return (
    <div style={{ margin: "4px 6px" }}>
      <div
        style={{
          padding: "5px 8px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: SPINE.canvasAlt,
          border: `1px solid ${SPINE.accent}`,
          borderRadius: 3,
          boxShadow: "0 0 0 2px rgba(200,161,90,.12)",
        }}
      >
        <span style={{ width: 10, flexShrink: 0 }} />
        <ShelfMark letter={letter} tone={tone} />
        <input
          ref={inputRef}
          type="text"
          value={label}
          placeholder="Shelf name…"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              tryCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            // Blur dismiss only if the input is empty; otherwise commit.
            // Lets the user click the picker swatches without losing
            // their in-flight edit.
            if (!label.trim()) onCancel();
          }}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: SPINE.text,
            fontFamily: SPINE.sans,
            fontSize: 12,
            padding: 0,
          }}
        />
        <span
          style={{
            fontFamily: SPINE.mono,
            fontSize: 9,
            color: SPINE.textFaint,
            padding: "1px 4px",
            border: `1px solid ${SPINE.borderSoft}`,
            borderRadius: 2,
          }}
        >
          ↵
        </span>
      </div>

      <div
        style={{
          marginTop: 6,
          padding: "8px 10px 9px",
          background: SPINE.canvasAlt,
          border: `1px solid ${SPINE.borderSoft}`,
          borderRadius: 3,
        }}
      >
        <PickerLabel>Letter</PickerLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 9 }}>
          {LETTER_PALETTE.map((l) => {
            const selected = l === letter;
            return (
              <button
                key={l}
                type="button"
                onClick={() => setLetter(l)}
                style={{
                  all: "unset",
                  width: 18,
                  height: 18,
                  borderRadius: 2,
                  background: selected ? `${SHELF_TONE_HEX[tone]}22` : "transparent",
                  border: `1px solid ${selected ? SHELF_TONE_HEX[tone] : SPINE.borderSoft}`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: SPINE.serif,
                  fontStyle: "italic",
                  fontSize: 10,
                  fontWeight: 600,
                  color: selected ? SHELF_TONE_HEX[tone] : SPINE.textDim,
                  cursor: "pointer",
                }}
              >
                {l}
              </button>
            );
          })}
        </div>
        <PickerLabel>Color</PickerLabel>
        <div style={{ display: "flex", gap: 5 }}>
          {TONE_PALETTE.map((t) => {
            const selected = t === tone;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTone(t)}
                aria-label={t}
                style={{
                  all: "unset",
                  width: 16,
                  height: 16,
                  borderRadius: 2,
                  background: SHELF_TONE_HEX[t],
                  boxShadow: selected
                    ? `0 0 0 1.5px ${SPINE.text}`
                    : "inset 0 0 0 1px rgba(0,0,0,.2)",
                  cursor: "pointer",
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PickerLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: SPINE.sans,
        fontSize: 9,
        color: SPINE.textFaint,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}
