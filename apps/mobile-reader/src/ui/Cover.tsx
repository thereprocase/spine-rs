// Cover tile. If the EPUB shipped an embedded cover image, render it via
// expo-image. Otherwise build a generated cover from the title/author —
// styled to match the mockup MobileCover (paperboard panel + serif italic title
// + brass-gold rule + author label).

import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { coverFilePath } from "../storage";
import { FONTS, type Theme } from "../themes";
import type { BookRecord } from "../types";

interface CoverProps {
  book: BookRecord;
  width: number;
  theme: Theme;
}

const ASPECT = 1.5;

// Deterministic palette per book — hash title+author to pick a paper color.
const PALETTES: Array<{ bg: string; ink: string; rule: string }> = [
  { bg: "#3d3530", ink: "#d9c9a8", rule: "#8a7a62" }, // calf brown
  { bg: "#2c3540", ink: "#c4d4e2", rule: "#6a7a8a" }, // navy cloth
  { bg: "#3a2628", ink: "#e0c8a8", rule: "#8a6862" }, // burgundy
  { bg: "#2e3a2c", ink: "#cad6b8", rule: "#6a7a62" }, // forest cloth
  { bg: "#3a3220", ink: "#dcc890", rule: "#8a7848" }, // mustard linen
  { bg: "#2a2a32", ink: "#c8c2d8", rule: "#6a6878" }, // slate
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function paletteFor(book: BookRecord) {
  return PALETTES[hash(book.title + book.author) % PALETTES.length]!;
}

export function Cover({ book, width, theme }: CoverProps) {
  const height = Math.round(width * ASPECT);
  const radius = 2;

  if (book.coverFilename) {
    return (
      <Image
        source={{ uri: coverFilePath(book.coverFilename) }}
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: theme.surface,
        }}
        contentFit="cover"
        transition={120}
        // memory-disk so a 200-cover library grid doesn't re-decode
        // every PNG on every scroll-back. Default policy ("disk") still
        // hits the JPEG/PNG decoder on each remount; "memory-disk"
        // keeps the decoded bitmap warm for the session.
        cachePolicy="memory-disk"
        recyclingKey={book.coverFilename}
      />
    );
  }

  // Generated cover.
  const p = paletteFor(book);
  const padX = Math.max(7, Math.round(width * 0.08));
  const padY = Math.max(8, Math.round(width * 0.07));
  const titleSize = Math.max(9, Math.round(width * 0.11));
  const authorSize = Math.max(7, Math.round(width * 0.075));
  const ruleColor = p.rule;
  const firstAuthor = book.author.split(",")[0]?.trim() ?? book.author;

  return (
    <View
      style={[
        styles.cover,
        {
          width,
          height,
          backgroundColor: p.bg,
          borderRadius: radius,
          paddingHorizontal: padX,
          paddingVertical: padY,
        },
      ]}
    >
      <View style={[styles.rule, { backgroundColor: ruleColor }]} />
      <Text
        numberOfLines={5}
        style={{
          color: p.ink,
          fontFamily: FONTS.serif,
          fontStyle: "italic",
          fontWeight: "600",
          fontSize: titleSize,
          lineHeight: titleSize * 1.18,
          letterSpacing: 0.1,
          marginTop: padY * 0.4,
        }}
      >
        {book.title}
      </Text>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <View
          style={{
            width: "40%",
            height: 1,
            backgroundColor: ruleColor,
            opacity: 0.5,
          }}
        />
      </View>
      <View style={[styles.rule, { backgroundColor: ruleColor }]} />
      <Text
        numberOfLines={1}
        style={{
          color: p.ink,
          fontFamily: FONTS.sans,
          fontWeight: "500",
          fontSize: authorSize,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          opacity: 0.85,
          marginTop: padY * 0.3,
        }}
      >
        {firstAuthor}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    overflow: "hidden",
  },
  rule: {
    height: 1,
    opacity: 0.6,
  },
});
