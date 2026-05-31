// Top + bottom chrome overlays for the reader. The collapsed-bottom row
// now carries chapter prev/next, a draggable progress scrubber, a Contents
// button, a Display button (opens the existing settings sheet), and a "More"
// chevron that opens the SessionPanel. The collapsed-top row's title is a
// tap-target that opens the BookPanel.

import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import { useChromeSlider } from "./chromeShared";
import type { TocItem } from "./messages";
import { APP_VERSION } from "../version";

interface ChromeProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  bookTitle: string;
  percentage: number;
  currentChapterLabel: string | null;
  currentLocation: number;
  totalLocations: number;
  toc: TocItem[];
  currentHref: string | null;
  /** True iff a bookmark exists at the current location. Drives the
   * filled vs outlined glyph on the bookmark button. The reader
   * computes this with chapter+paragraph-level tolerance, not strict
   * CFI equality, so a font-size change doesn't unmark a page. */
  bookmarked: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenToc: () => void;
  onOpenSessionPanel: () => void;
  onOpenBookPanel: () => void;
  onOpenAnnotations: () => void;
  onOpenHelp: () => void;
  onToggleBookmark: () => void;
  onSeek: (ratio: number) => void;
  onJumpChapter: (dir: "prev" | "next") => void;
}

interface FlatChapter {
  label: string;
  href: string;
}
function flatten(items: TocItem[], out: FlatChapter[]): void {
  for (const item of items) {
    if (item.href) out.push({ label: item.label, href: item.href });
    if (item.subitems?.length) flatten(item.subitems, out);
  }
}
function basename(href: string): string {
  return href.split("#")[0]!.split("/").pop() ?? href;
}

function Scrubber({
  theme,
  value,
  onSeek,
}: {
  theme: Theme;
  value: number;
  onSeek: (r: number) => void;
}) {
  // Show the scrubbed value while dragging, but only commit (call onSeek)
  // on release. Using a single onChange handler that updates display state
  // keeps the slider responsive even while the WebView seek is in flight.
  const { trackRef, panHandlers, onLayout } = useChromeSlider(
    () => undefined,
    onSeek,
  );
  const pct = Math.round(value * 100);
  return (
    <View style={{ marginVertical: 6 }}>
      <View
        ref={trackRef}
        onLayout={onLayout}
        {...panHandlers}
        style={{ height: 28, justifyContent: "center" }}
      >
        <View
          style={{
            height: 4,
            backgroundColor: theme.readerRule,
            borderRadius: 2,
          }}
        >
          <View
            style={{
              height: "100%",
              width: `${pct}%`,
              backgroundColor: theme.accent,
              borderRadius: 2,
            }}
          />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: `${pct}%`,
            marginLeft: -8,
            top: 5,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: theme.accent,
            borderWidth: 2,
            borderColor: theme.readerBg,
          }}
        />
      </View>
    </View>
  );
}

function IconBtn({
  theme,
  label,
  glyph,
  caption,
  onPress,
  disabled,
}: {
  theme: Theme;
  label: string;
  glyph: string;
  caption?: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: "center",
        paddingVertical: 6,
        opacity: disabled ? 0.32 : pressed ? 0.6 : 1,
      })}
      accessibilityLabel={label}
    >
      <Text
        style={{
          color: theme.readerInk,
          fontFamily: FONTS.serif,
          fontSize: 18,
          lineHeight: 22,
        }}
      >
        {glyph}
      </Text>
      <Text
        style={{
          color: theme.readerDim,
          fontFamily: FONTS.mono,
          fontSize: 9,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginTop: 2,
        }}
      >
        {caption ?? label}
      </Text>
    </Pressable>
  );
}

export function ReaderChrome({
  visible,
  theme,
  insets,
  bookTitle,
  bookmarked,
  onToggleBookmark,
  percentage,
  currentChapterLabel,
  currentLocation,
  totalLocations,
  toc,
  currentHref,
  onBack,
  onOpenSettings,
  onOpenToc,
  onOpenSessionPanel,
  onOpenBookPanel,
  onOpenAnnotations,
  onOpenHelp,
  onSeek,
  onJumpChapter,
}: ChromeProps) {
  const chapterEdges = useMemo(() => {
    const out: FlatChapter[] = [];
    flatten(toc, out);
    if (out.length === 0) return { hasPrev: false, hasNext: false };
    if (!currentHref) return { hasPrev: false, hasNext: out.length > 0 };
    const target = basename(currentHref);
    const idx = out.findIndex((c) => basename(c.href) === target);
    if (idx < 0) return { hasPrev: false, hasNext: out.length > 0 };
    return { hasPrev: idx > 0, hasNext: idx < out.length - 1 };
  }, [toc, currentHref]);

  // Up-swipe on the handle expands the SessionPanel; tap also opens it
  // (handled by the Pressable below). Threshold is -30px dy (negative =
  // upward).
  const handlePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy < -30 && Math.abs(g.dy) > Math.abs(g.dx)) onOpenSessionPanel();
      },
    }),
  ).current;

  // Keep the chrome mounted at all times and fade with a native-driven
  // Animated.Value. The previous `if (!visible) return null` mounted
  // and unmounted the entire top+bottom tree (~2 dozen Views, the
  // scrubber, the chapter buttons, the meta row) on every toggle. On
  // Android, with a heavy WebView underneath, that's the source of
  // the "twitch" — layout pass + paint of the chrome subtree fights
  // for the same frame as the WebView's compositor. Native opacity
  // animation keeps the chrome on a separate transaction and the
  // WebView never re-lays-out.
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const slide = useRef(new Animated.Value(visible ? 0 : 1)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: visible ? 180 : 140,
        easing: visible ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: visible ? 0 : 1,
        duration: visible ? 180 : 140,
        easing: visible ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, opacity, slide]);

  // Slide top down 8px and bottom up 8px when hidden — tiny offset
  // makes the fade feel intentional instead of stuttery.
  const topTranslate = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -8],
  });
  const bottomTranslate = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 8],
  });

  const pct = Math.round(percentage * 100);
  return (
    <>
      {/* Top bar — tappable title opens BookPanel.
          pointerEvents toggles between "box-none" (children receive
          taps but the wrapper itself doesn't block) and "none" (no
          taps reach this subtree at all). When the chrome is hiding,
          we MUST gate touches before opacity finishes; otherwise a
          ghost icon catches the tap mid-fade. */}
      <Animated.View
        pointerEvents={visible ? "box-none" : "none"}
        style={[
          styles.top,
          {
            paddingTop: insets.top + 6,
            opacity,
            transform: [{ translateY: topTranslate }],
          },
        ]}
      >
        <View
          style={{
            backgroundColor: theme.readerBg,
            paddingHorizontal: 12,
            paddingBottom: 10,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottomColor: theme.readerRule,
            borderBottomWidth: StyleSheet.hairlineWidth,
          }}
        >
          <Pressable onPress={onBack} hitSlop={10} style={styles.iconBtn48}>
            <Text style={{ color: theme.readerInk, fontSize: 22, lineHeight: 22 }}>
              ▦
            </Text>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 8,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              Library
            </Text>
          </Pressable>
          <Pressable
            onPress={onOpenBookPanel}
            hitSlop={6}
            style={({ pressed }) => ({
              flex: 1,
              marginHorizontal: 12,
              alignItems: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.readerInk,
                fontFamily: FONTS.serif,
                fontStyle: "italic",
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {bookTitle}
            </Text>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 8,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              Tap for book ▾
            </Text>
          </Pressable>
          {/* Bookmark toggle. Filled when the current location matches
              an existing bookmark, outlined otherwise. Sits between
              the title-tap area and Help, per the design spec. */}
          <Pressable
            onPress={onToggleBookmark}
            hitSlop={10}
            accessibilityLabel={bookmarked ? "Remove bookmark from this page" : "Bookmark this page"}
            style={({ pressed }) => [
              styles.iconBtn48,
              { opacity: pressed ? 0.5 : 1 },
            ]}
          >
            <Text
              style={{
                color: bookmarked ? theme.accent : theme.readerInk,
                fontFamily: FONTS.serif,
                fontSize: 20,
                lineHeight: 20,
                fontWeight: "600",
              }}
            >
              {bookmarked ? "★" : "☆"}
            </Text>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 8,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              Mark
            </Text>
          </Pressable>
          <Pressable
            onPress={onOpenHelp}
            hitSlop={10}
            accessibilityLabel="Show tap-zone help"
            style={({ pressed }) => [
              styles.iconBtn48,
              { opacity: pressed ? 0.5 : 1 },
            ]}
          >
            <Text
              style={{
                color: theme.readerInk,
                fontFamily: FONTS.serif,
                fontSize: 22,
                lineHeight: 22,
                fontWeight: "600",
              }}
            >
              ?
            </Text>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 8,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              Help
            </Text>
          </Pressable>
        </View>
      </Animated.View>

      {/* Bottom bar — three rows:
            1. Handle (drag-up or tap to open Session)
            2. Scrubber + percentage
            3. Caption row (chapter on left, % on right)
            4. Action row: ⟨ prev-chapter · Contents · Display · Session · next-chapter ⟩
      */}
      <Animated.View
        pointerEvents={visible ? "box-none" : "none"}
        style={[
          styles.bottom,
          {
            paddingBottom: insets.bottom + 4,
            opacity,
            transform: [{ translateY: bottomTranslate }],
          },
        ]}
      >
        <View
          style={{
            backgroundColor: theme.readerBg,
            borderTopColor: theme.readerRule,
            borderTopWidth: StyleSheet.hairlineWidth,
          }}
        >
          {/* Handle */}
          <Pressable
            onPress={onOpenSessionPanel}
            hitSlop={12}
            style={({ pressed }) => ({
              alignSelf: "stretch",
              alignItems: "center",
              paddingVertical: 8,
              opacity: pressed ? 0.6 : 1,
            })}
            {...handlePan.panHandlers}
          >
            <View style={[styles.dragHandle, { backgroundColor: theme.readerDim, opacity: 0.5 }]} />
          </Pressable>

          {/* Scrubber */}
          <View style={{ paddingHorizontal: 16 }}>
            <Scrubber theme={theme} value={percentage} onSeek={onSeek} />
          </View>

          {/* Caption row — chapter on left, location + percentage on
              right with version stamped small under it. */}
          <View style={styles.captionRow}>
            <Text
              numberOfLines={1}
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                flex: 1,
                marginRight: 8,
              }}
            >
              {currentChapterLabel ?? "Reading"}
            </Text>
            <View style={{ alignItems: "flex-end" }}>
              <Text
                style={{
                  color: theme.readerInk,
                  fontFamily: FONTS.mono,
                  fontSize: 11,
                  fontWeight: "600",
                }}
              >
                {totalLocations > 0 ? `Loc ${currentLocation} · ${pct}%` : `${pct}%`}
              </Text>
              <Text
                style={{
                  color: theme.readerDim,
                  fontFamily: FONTS.mono,
                  fontSize: 8,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  marginTop: 2,
                  opacity: 0.55,
                }}
              >
                v{APP_VERSION}
              </Text>
            </View>
          </View>

          {/* Action row */}
          <View
            style={[
              styles.actionsRow,
              { borderTopColor: theme.readerRule },
            ]}
          >
            <IconBtn
              theme={theme}
              label="Previous chapter"
              glyph="⟨"
              caption="Prev"
              disabled={!chapterEdges.hasPrev}
              onPress={() => onJumpChapter("prev")}
            />
            <IconBtn
              theme={theme}
              label="Contents"
              glyph="☰"
              caption="TOC"
              onPress={onOpenToc}
            />
            <IconBtn
              theme={theme}
              label="Display"
              glyph="Aa"
              caption="Display"
              onPress={onOpenSettings}
            />
            <IconBtn
              theme={theme}
              label="Annotations"
              glyph="✎"
              caption="Notes"
              onPress={onOpenAnnotations}
            />
            <IconBtn
              theme={theme}
              label="Session"
              glyph="•••"
              caption="Session"
              onPress={onOpenSessionPanel}
            />
            <IconBtn
              theme={theme}
              label="Next chapter"
              glyph="⟩"
              caption="Next"
              disabled={!chapterEdges.hasNext}
              onPress={() => onJumpChapter("next")}
            />
          </View>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", left: 0, right: 0, top: 0 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  iconBtn48: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 6,
  },
  dragHandle: { width: 48, height: 4, borderRadius: 2 },
  captionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  actionsRow: {
    flexDirection: "row",
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
  },
});
