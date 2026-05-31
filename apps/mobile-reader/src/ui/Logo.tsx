// Three-spines-on-a-shelf logo (logo 02 from the logo lab). Lifted verbatim
// from internal design notes (spine-logos.jsx) —
// rendered with RN Views instead of SVG so the glyph stays crisp at any size.

import { StyleSheet, View } from "react-native";

interface LogoProps {
  size: number;
}

const GRID = 18;

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

const TILES: Tile[] = [
  // baseline rule
  { x: 2, y: 14, w: 14, h: 1, color: "#3a2a20" },
  { x: 2, y: 15, w: 14, h: 1, color: "#1A0F12" },
  // book 1 — oxblood
  { x: 3, y: 6, w: 3, h: 8, color: "#6B1E2B" },
  { x: 3, y: 7, w: 3, h: 1, color: "#8B2A3A" },
  { x: 3, y: 11, w: 3, h: 1, color: "#A8802D" },
  // book 2 — slate, tallest
  { x: 7, y: 4, w: 3, h: 10, color: "#34343b" },
  { x: 7, y: 5, w: 3, h: 1, color: "#E4B84F" },
  { x: 7, y: 9, w: 3, h: 1, color: "#E4B84F" },
  { x: 7, y: 12, w: 3, h: 1, color: "#c8a15a" },
  // book 3 — slate-green
  { x: 11, y: 7, w: 3, h: 7, color: "#6b857b" },
  { x: 11, y: 8, w: 3, h: 1, color: "#a8c4bc" },
  { x: 11, y: 11, w: 3, h: 1, color: "#A8802D" },
];

export function Logo({ size }: LogoProps) {
  const px = size / GRID;
  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      {TILES.map((t, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: t.x * px,
            top: t.y * px,
            width: t.w * px,
            height: t.h * px,
            backgroundColor: t.color,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative" },
});
