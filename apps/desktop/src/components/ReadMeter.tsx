import { SPINE } from "../tokens";

interface ReadMeterProps {
  value: number;
  width?: number;
  showNum?: boolean;
}

// Librarian-sober reading progress: 3px-tall bar + mono percent.
// `value` is 0..1 (progress fraction). Done state (>= 1) switches
// the fill to SPINE.ok and replaces the number with a check glyph.
export default function ReadMeter({ value, width = 60, showNum = true }: ReadMeterProps) {
  const clamped = Math.max(0, Math.min(value, 1));
  const pct = Math.round(clamped * 100);
  const done = clamped >= 1;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: SPINE.mono,
        fontSize: 11,
        color: SPINE.textMid,
      }}
    >
      <div style={{ width, height: 3, background: SPINE.border, position: "relative", borderRadius: 0 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            background: done ? SPINE.ok : SPINE.accent,
          }}
        />
      </div>
      {showNum && (
        <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 26, textAlign: "right" }}>
          {done ? "✓" : `${pct}%`}
        </span>
      )}
    </div>
  );
}
