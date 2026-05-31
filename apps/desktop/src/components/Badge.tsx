import type { CSSProperties, ReactNode } from "react";
import { SPINE } from "../tokens";

export type BadgeKind = "reconciled" | "local" | "missing" | "new" | "neutral" | "filled";

interface BadgePalette {
  bg: string;
  fg: string;
  border: string;
}

const BADGE_PALETTES: Record<BadgeKind, BadgePalette> = {
  reconciled: { bg: "transparent", fg: SPINE.ok,      border: SPINE.badgeBorderOk },
  local:      { bg: "transparent", fg: SPINE.warn,    border: SPINE.badgeBorderWarn },
  missing:    { bg: "transparent", fg: SPINE.alert,   border: SPINE.badgeBorderAlert },
  new:        { bg: "transparent", fg: SPINE.accent,  border: SPINE.badgeBorderAccent },
  neutral:    { bg: "transparent", fg: SPINE.textMid, border: SPINE.border },
  filled:     { bg: SPINE.accent,  fg: SPINE.inkInvert, border: SPINE.accent },
};

interface BadgeProps {
  kind?: BadgeKind;
  label: ReactNode;
  mono?: boolean;
  style?: CSSProperties;
}

// Outlined metadata chip for grid rows and inspector blocks.
// - kind selects the palette (reconciled/local/missing/new/neutral/filled)
// - mono renders identifier-like text (LCCN, ISBN) in Geist Mono without
//   UPPERCASE transform; default uppercase-sans suits status labels.
export default function Badge({ kind = "neutral", label, mono = false, style = {} }: BadgeProps) {
  const palette = BADGE_PALETTES[kind];
  return (
    <span
      style={{
        fontFamily: mono ? SPINE.mono : SPINE.sans,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: mono ? 0 : 0.3,
        textTransform: mono ? "none" : "uppercase",
        background: palette.bg,
        color: palette.fg,
        padding: "2px 6px",
        borderRadius: 2,
        border: `1px solid ${palette.border}`,
        lineHeight: 1.2,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </span>
  );
}
