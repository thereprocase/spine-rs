import { SPINE } from "../tokens";

export type ProvSource = "lcsh" | "user" | "imported" | "inferred";

interface ProvDotProps {
  source: ProvSource;
  size?: number;
}

// Provenance indicator for the Subject tree footer. Hollow-vs-filled
// is meaningful — `inferred` is hollow because it signals
// "uncommitted/provisional", not just a different color. Locked in v2
// sidebar bundle (spine-sidebar-states.jsx L1132, ProvDot).
export default function ProvDot({ source, size = 5 }: ProvDotProps) {
  const tones: Record<ProvSource, { fill: string; ring: string }> = {
    lcsh:     { fill: SPINE.accent, ring: SPINE.accent },
    user:     { fill: SPINE.ok,     ring: SPINE.ok },
    imported: { fill: SPINE.link,   ring: SPINE.link },
    inferred: { fill: "transparent", ring: SPINE.textFaint },
  };
  const t = tones[source];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: t.fill,
        border: `1px solid ${t.ring}`,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}
