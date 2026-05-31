// Bottom-up session panel — reading-session metrics only. Visual /
// display knobs (theme, brightness, warmth) live in the Display sheet
// per user direction. This panel hosts: mini chapter strip, pace KPIs,
// current location with jump-to-location, and the Contents button as
// a shortcut to the full TOC sheet.

import { useMemo, useRef, useState } from "react";
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import type { TocItem } from "./messages";

interface PaceMetrics {
  thisPage: string;
  chapter: string;
  bookEta: string;
  wpm: number;
  /** Kindle-style location index (current). */
  currentLocation: number;
  /** Total locations in the book; 0 if not available yet. */
  totalLocations: number;
}

interface SessionPanelProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  toc: TocItem[];
  currentHref: string | null;
  pace: PaceMetrics;
  onClose: () => void;
  onPickChapter: (href: string) => void;
  onOpenToc: () => void;
  onJumpToLocation: (locationNumber: number) => void;
}

interface FlatChapter {
  label: string;
  href: string;
}
function flatten(items: TocItem[], out: FlatChapter[]): void {
  for (const item of items) {
    if (item.href) out.push({ label: item.label || "Untitled", href: item.href });
    if (item.subitems?.length) flatten(item.subitems, out);
  }
}
function basename(href: string): string {
  return href.split("#")[0]!.split("/").pop() ?? href;
}

function SectionLabel({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return (
    <Text
      style={{
        color: theme.readerDim,
        fontFamily: FONTS.mono,
        fontSize: 9,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        fontWeight: "600",
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 6,
        borderTopColor: theme.readerRule,
        borderTopWidth: StyleSheet.hairlineWidth,
      }}
    >
      {children}
    </Text>
  );
}

export function SessionPanel({
  visible,
  theme,
  insets,
  toc,
  currentHref,
  pace,
  onClose,
  onPickChapter,
  onOpenToc,
  onJumpToLocation,
}: SessionPanelProps) {
  const chapters = useMemo(() => {
    const out: FlatChapter[] = [];
    flatten(toc, out);
    return out;
  }, [toc]);

  const currentIndex = useMemo(() => {
    if (!currentHref) return -1;
    const target = basename(currentHref);
    return chapters.findIndex((c) => basename(c.href) === target);
  }, [chapters, currentHref]);

  const prev = currentIndex > 0 ? chapters[currentIndex - 1]! : null;
  const cur = currentIndex >= 0 ? chapters[currentIndex]! : null;
  const next =
    currentIndex >= 0 && currentIndex < chapters.length - 1
      ? chapters[currentIndex + 1]!
      : null;

  // Down-swipe on the handle area collapses the panel.
  const handlePan = useRef(
    PanResponder.create({
      // onStartShouldSetPanResponder=false so child Pressables (the
      // chapter-strip tiles inside the panel) still receive their taps.
      // Only Move-shouldSet captures vertical drags for the close
      // gesture.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 30 && Math.abs(g.dy) > Math.abs(g.dx)) onClose();
      },
    }),
  ).current;

  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpDraft, setJumpDraft] = useState("");

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable style={styles.scrimTap} onPress={onClose} />
        <View
          style={[
            styles.panel,
            {
              backgroundColor: theme.readerBg,
              borderColor: theme.readerRule,
              paddingBottom: insets.bottom + 10,
            },
          ]}
        >
          <View {...handlePan.panHandlers} style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: theme.readerDim, opacity: 0.4 }]} />
          </View>

          {/* Mini chapter strip + Contents shortcut */}
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingBottom: 10 }}>
            {[prev, cur, next].map((ch, idx) => {
              const isCurrent = idx === 1;
              if (!ch) {
                return (
                  <View
                    key={idx}
                    style={{
                      flex: isCurrent ? 1 : 0.7,
                      padding: 8,
                      borderColor: theme.readerRule,
                      borderWidth: StyleSheet.hairlineWidth,
                      opacity: 0.3,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.readerDim,
                        fontFamily: FONTS.mono,
                        fontSize: 9,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                      }}
                    >
                      {idx === 0 ? "Start" : "End"}
                    </Text>
                  </View>
                );
              }
              return (
                <Pressable
                  key={ch.href}
                  onPress={() => {
                    if (!isCurrent) onPickChapter(ch.href);
                  }}
                  style={{
                    flex: isCurrent ? 1 : 0.7,
                    padding: 8,
                    backgroundColor: isCurrent ? theme.accent : "transparent",
                    borderColor: theme.readerRule,
                    borderWidth: isCurrent ? 0 : StyleSheet.hairlineWidth,
                  }}
                >
                  <Text
                    style={{
                      color: isCurrent ? theme.readerBg : theme.readerDim,
                      fontFamily: FONTS.mono,
                      fontSize: 9,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                    }}
                  >
                    {idx === 0 ? "Prev" : idx === 1 ? "Now" : "Next"}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: isCurrent ? theme.readerBg : theme.readerInk,
                      fontFamily: FONTS.serif,
                      fontStyle: "italic",
                      fontSize: 12,
                      fontWeight: "600",
                      marginTop: 2,
                    }}
                  >
                    {ch.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView style={{ flex: 1 }}>
            {/* Pace */}
            <SectionLabel theme={theme}>Pace</SectionLabel>
            <View
              style={{
                flexDirection: "row",
                gap: 8,
                paddingHorizontal: 16,
                paddingBottom: 10,
              }}
            >
              {[
                { k: "This page", v: pace.thisPage },
                { k: "Chapter", v: pace.chapter },
                { k: "Book ETA", v: pace.bookEta },
              ].map((s) => (
                <View
                  key={s.k}
                  style={{ flex: 1, padding: 8, backgroundColor: `${theme.readerRule}40` }}
                >
                  <Text
                    style={{
                      color: theme.readerDim,
                      fontFamily: FONTS.mono,
                      fontSize: 8,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                    }}
                  >
                    {s.k}
                  </Text>
                  <Text
                    style={{
                      color: theme.readerInk,
                      fontFamily: FONTS.sans,
                      fontSize: 13,
                      fontWeight: "600",
                      marginTop: 2,
                    }}
                  >
                    {s.v}
                  </Text>
                </View>
              ))}
            </View>
            {pace.wpm > 0 ? (
              <Text
                style={{
                  color: theme.readerDim,
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  paddingHorizontal: 16,
                  paddingBottom: 10,
                }}
              >
                ~{pace.wpm} wpm · cumulative
              </Text>
            ) : null}

            {/* Location + jump-to */}
            <SectionLabel theme={theme}>Location</SectionLabel>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 16,
                paddingVertical: 10,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: theme.readerInk,
                    fontFamily: FONTS.sans,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {pace.totalLocations > 0
                    ? `Loc ${pace.currentLocation} of ${pace.totalLocations}`
                    : `Loc ${pace.currentLocation}`}
                </Text>
                <Text
                  style={{
                    color: theme.readerDim,
                    fontFamily: FONTS.mono,
                    fontSize: 9,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    marginTop: 2,
                  }}
                >
                  ~50 words per location
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setJumpDraft(String(pace.currentLocation));
                  setJumpOpen(true);
                }}
                style={({ pressed }) => ({
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.readerRule,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  backgroundColor: pressed ? `${theme.accent}14` : "transparent",
                })}
              >
                <Text
                  style={{
                    color: theme.accent,
                    fontFamily: FONTS.mono,
                    fontSize: 10,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontWeight: "600",
                  }}
                >
                  Jump to…
                </Text>
              </Pressable>
            </View>

            {/* Contents shortcut */}
            <SectionLabel theme={theme}>Contents</SectionLabel>
            <Pressable
              onPress={() => {
                onClose();
                onOpenToc();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 10,
                backgroundColor: pressed ? `${theme.accent}14` : "transparent",
              })}
            >
              <Text
                style={{
                  color: theme.readerInk,
                  fontFamily: FONTS.sans,
                  fontSize: 14,
                  fontWeight: "500",
                }}
              >
                Open table of contents
              </Text>
              <Text
                style={{
                  color: theme.readerDim,
                  fontFamily: FONTS.mono,
                  fontSize: 9,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  marginTop: 2,
                }}
              >
                {chapters.length} chapter{chapters.length === 1 ? "" : "s"}
              </Text>
            </Pressable>
            <View style={{ height: 8 }} />
          </ScrollView>
        </View>
      </View>

      {/* Jump-to-location prompt */}
      <Modal
        visible={jumpOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setJumpOpen(false)}
      >
        <View style={styles.scrim}>
          <View
            style={[
              styles.jumpPanel,
              { backgroundColor: theme.readerBg, borderColor: theme.readerRule },
            ]}
          >
            <Text
              style={{
                color: theme.readerInk,
                fontFamily: FONTS.serif,
                fontStyle: "italic",
                fontSize: 16,
                fontWeight: "600",
                marginBottom: 6,
              }}
            >
              Jump to location
            </Text>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              {pace.totalLocations > 0
                ? `1 – ${pace.totalLocations}`
                : "Enter a location number"}
            </Text>
            <TextInput
              value={jumpDraft}
              onChangeText={setJumpDraft}
              keyboardType="numeric"
              autoFocus
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.readerRule,
                color: theme.readerInk,
                fontFamily: FONTS.mono,
                fontSize: 15,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}
              onSubmitEditing={() => {
                const n = parseInt(jumpDraft, 10);
                const max = pace.totalLocations || 0;
                if (isNaN(n) || n < 1) return;
                if (max > 0 && n > max) return; // out of range — leave the prompt open
                onJumpToLocation(n);
                setJumpOpen(false);
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12, marginTop: 14 }}>
              <Pressable onPress={() => setJumpOpen(false)} hitSlop={8}>
                <Text
                  style={{
                    color: theme.readerDim,
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontWeight: "600",
                    paddingVertical: 6,
                    paddingHorizontal: 8,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const n = parseInt(jumpDraft, 10);
                  const max = pace.totalLocations || 0;
                  if (isNaN(n) || n < 1) return;
                  if (max > 0 && n > max) return;
                  onJumpToLocation(n);
                  setJumpOpen(false);
                }}
                hitSlop={8}
              >
                <Text
                  style={{
                    color: theme.accent,
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontWeight: "700",
                    paddingVertical: 6,
                    paddingHorizontal: 8,
                  }}
                >
                  Jump
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)", justifyContent: "flex-end" },
  scrimTap: { flex: 1 },
  panel: {
    height: "62%",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handleRow: { alignItems: "center", paddingTop: 8, paddingBottom: 6, height: 28 },
  handle: { width: 48, height: 4, borderRadius: 2 },
  jumpPanel: {
    margin: 24,
    padding: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    alignSelf: "center",
    width: "85%",
    maxWidth: 420,
  },
});
