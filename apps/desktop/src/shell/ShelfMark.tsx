import { SPINE } from "../tokens";

export type ShelfTone =
  | "brass"   // default / system shelves
  | "slate"   // co-reading / plural
  | "oxblood" // caution / loans / holds
  | "amber"   // favourites / highlight
  | "sage"    // research / ongoing
  | "steel";  // genre / neutral

export const SHELF_TONE_HEX: Record<ShelfTone, string> = {
  brass:   "#c8a15a",
  slate:   "#94b0c4",
  oxblood: "#a83040",
  amber:   "#e4b84f",
  sage:    "#8ab07a",
  steel:   "#6b8aa0",
};

interface ShelfMarkProps {
  letter: string;
  tone: ShelfTone;
  size?: number;
}

// Letter-monogram glyph for user shelves. NOT emoji — emoji rendering
// varies cross-platform and breaks the typographic feel. Single
// italic-serif letter inside a tinted gradient square. Designer locked
// the 6-color palette in v2 sidebar bundle (spine-sidebar-states.jsx
// L1077, ShelfGlyphPalette).
export default function ShelfMark({ letter, tone, size = 14 }: ShelfMarkProps) {
  const hex = SHELF_TONE_HEX[tone];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        background: `linear-gradient(180deg, ${hex}22 0%, ${hex}11 100%)`,
        border: `1px solid ${hex}55`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontFamily: SPINE.serif,
        fontStyle: "italic",
        fontSize: size <= 14 ? 9 : Math.round(size * 0.6),
        fontWeight: 600,
        color: hex,
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
}
