// Bottom-up Highlights | Bookmarks browser. Tap a row to jump the
// reader to that location; long-press for a delete confirm. Rows are
// grouped by chapter using the persisted chapterLabel — the TOC may
// not be loaded yet (sheet can open from BookPanel before the rendition
// has fired its first location event).

import { useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  type ListRenderItem,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import type { Bookmark, Highlight } from "../types";
import { HIGHLIGHT_COLORS } from "./SelectionBar";

type Tab = "highlights" | "bookmarks";

interface AnnotationsSheetProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  highlights: Highlight[];
  bookmarks: Bookmark[];
  /** Tab to open in. Defaults to "highlights" if undefined. */
  initialTab?: Tab;
  onClose: () => void;
  /** Jump to a CFI (highlight cfiRange or bookmark cfi). The reader's
   * `goto` message accepts both hrefs and CFIs — epubjs's
   * rendition.display() handles both transparently. */
  onJumpToCfi: (cfi: string) => void;
  onDeleteHighlight: (id: string) => void;
  onDeleteBookmark: (id: string) => void;
}

interface FlatRow<T> {
  kind: "header" | "row";
  key: string;
  chapterLabel: string;
  item?: T;
}

// Build a [chapter-header, row, row, …, chapter-header, row, …] flat list
// preserving input order within a chapter (the store keeps newest-first
// on append; we don't re-sort since the user just made these and the
// "most recent on top" feel matches the rest of the app).
function group<T extends { chapterLabel: string; id: string }>(rows: T[]): FlatRow<T>[] {
  const out: FlatRow<T>[] = [];
  let lastLabel: string | null = null;
  for (const row of rows) {
    const label = row.chapterLabel || "Untitled";
    if (label !== lastLabel) {
      out.push({ kind: "header", key: `h-${label}-${out.length}`, chapterLabel: label });
      lastLabel = label;
    }
    out.push({ kind: "row", key: `r-${row.id}`, chapterLabel: label, item: row });
  }
  return out;
}

function colorTintFor(color: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.key === color)?.tint ?? HIGHLIGHT_COLORS[0]!.tint;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  } catch {
    return "";
  }
}

export function AnnotationsSheet({
  visible,
  theme,
  insets,
  highlights,
  bookmarks,
  initialTab,
  onClose,
  onJumpToCfi,
  onDeleteHighlight,
  onDeleteBookmark,
}: AnnotationsSheetProps) {
  // Re-sync the active tab whenever the sheet opens — the parent owns
  // initialTab as a hint, not a controlled prop.
  const [tab, setTab] = useState<Tab>(initialTab ?? "highlights");
  const lastVisibleRef = useRef(visible);
  if (visible && !lastVisibleRef.current) {
    if (initialTab && initialTab !== tab) setTab(initialTab);
  }
  lastVisibleRef.current = visible;

  // Down-swipe on the handle area closes. Same pattern as SessionPanel /
  // TocSheet so users learn one gesture.
  const handlePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 30 && Math.abs(g.dy) > Math.abs(g.dx)) onClose();
      },
    }),
  ).current;

  const highlightRows = useMemo(() => group(highlights), [highlights]);
  const bookmarkRows = useMemo(() => group(bookmarks), [bookmarks]);

  const onPressHighlight = (h: Highlight) => {
    onJumpToCfi(h.cfiRange);
    onClose();
  };
  const onLongPressHighlight = (h: Highlight) => {
    const preview = h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text;
    Alert.alert(
      "Delete highlight?",
      preview,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => onDeleteHighlight(h.id),
        },
      ],
      { cancelable: true },
    );
  };
  const onPressBookmark = (b: Bookmark) => {
    onJumpToCfi(b.cfi);
    onClose();
  };
  const onLongPressBookmark = (b: Bookmark) => {
    Alert.alert(
      "Delete bookmark?",
      b.snippet || b.chapterLabel || "Bookmark",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => onDeleteBookmark(b.id),
        },
      ],
      { cancelable: true },
    );
  };

  const renderHighlight: ListRenderItem<FlatRow<Highlight>> = ({ item }) => {
    if (item.kind === "header") {
      return <ChapterHeader theme={theme} label={item.chapterLabel} />;
    }
    const h = item.item!;
    return (
      <Pressable
        onPress={() => onPressHighlight(h)}
        onLongPress={() => onLongPressHighlight(h)}
        style={({ pressed }) => [
          styles.row,
          {
            borderBottomColor: theme.readerRule,
            backgroundColor: pressed ? `${theme.accent}14` : "transparent",
          },
        ]}
      >
        <View
          style={[
            styles.colorChip,
            { backgroundColor: colorTintFor(h.color) },
          ]}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={3}
            style={{
              color: theme.readerInk,
              fontFamily: FONTS.serif,
              fontSize: 14,
              lineHeight: 19,
            }}
          >
            {h.text || "(empty selection)"}
          </Text>
          <Text
            style={{
              color: theme.readerDim,
              fontFamily: FONTS.mono,
              fontSize: 9,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginTop: 4,
            }}
          >
            {formatTimestamp(h.createdAt)}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderBookmark: ListRenderItem<FlatRow<Bookmark>> = ({ item }) => {
    if (item.kind === "header") {
      return <ChapterHeader theme={theme} label={item.chapterLabel} />;
    }
    const b = item.item!;
    return (
      <Pressable
        onPress={() => onPressBookmark(b)}
        onLongPress={() => onLongPressBookmark(b)}
        style={({ pressed }) => [
          styles.row,
          {
            borderBottomColor: theme.readerRule,
            backgroundColor: pressed ? `${theme.accent}14` : "transparent",
          },
        ]}
      >
        <Text
          style={{
            color: theme.accent,
            fontFamily: FONTS.serif,
            fontSize: 18,
            lineHeight: 18,
            marginRight: 12,
            marginTop: 1,
          }}
        >
          ★
        </Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={2}
            style={{
              color: theme.readerInk,
              fontFamily: FONTS.serif,
              fontSize: 14,
              lineHeight: 19,
            }}
          >
            {b.snippet || b.chapterLabel || "Bookmark"}
          </Text>
          <Text
            style={{
              color: theme.readerDim,
              fontFamily: FONTS.mono,
              fontSize: 9,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginTop: 4,
            }}
          >
            {formatTimestamp(b.createdAt)}
          </Text>
        </View>
      </Pressable>
    );
  };

  const empty = (label: string) => (
    <View style={styles.empty}>
      <Text
        style={{
          color: theme.readerDim,
          fontFamily: FONTS.serif,
          fontStyle: "italic",
          fontSize: 15,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </View>
  );

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
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View {...handlePan.panHandlers} style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: theme.readerDim, opacity: 0.4 }]} />
          </View>
          <View style={[styles.headerRow, { borderBottomColor: theme.readerRule }]}>
            <Text
              style={{
                color: theme.readerDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 1.4,
                textTransform: "uppercase",
                fontWeight: "600",
              }}
            >
              Annotations
            </Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text
                style={{
                  color: theme.accent,
                  fontFamily: FONTS.mono,
                  fontSize: 11,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                Done
              </Text>
            </Pressable>
          </View>
          <View style={[styles.tabRow, { borderBottomColor: theme.readerRule }]}>
            <TabBtn
              theme={theme}
              label="Highlights"
              count={highlights.length}
              active={tab === "highlights"}
              onPress={() => setTab("highlights")}
            />
            <TabBtn
              theme={theme}
              label="Bookmarks"
              count={bookmarks.length}
              active={tab === "bookmarks"}
              onPress={() => setTab("bookmarks")}
            />
          </View>
          {tab === "highlights" ? (
            highlights.length === 0 ? (
              empty(
                "No highlights yet.\nLong-press a word, then tap Highlight.",
              )
            ) : (
              <FlatList
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingVertical: 6 }}
                data={highlightRows}
                keyExtractor={(r) => r.key}
                renderItem={renderHighlight}
                initialNumToRender={20}
                windowSize={9}
                removeClippedSubviews
              />
            )
          ) : bookmarks.length === 0 ? (
            empty("No bookmarks yet.\nTap ☆ in the top chrome to mark a page.")
          ) : (
            <FlatList
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingVertical: 6 }}
              data={bookmarkRows}
              keyExtractor={(r) => r.key}
              renderItem={renderBookmark}
              initialNumToRender={20}
              windowSize={9}
              removeClippedSubviews
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function ChapterHeader({ theme, label }: { theme: Theme; label: string }) {
  return (
    <Text
      style={{
        color: theme.readerDim,
        fontFamily: FONTS.mono,
        fontSize: 9,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        fontWeight: "600",
        paddingHorizontal: 20,
        paddingTop: 14,
        paddingBottom: 6,
      }}
    >
      {label}
    </Text>
  );
}

function TabBtn({
  theme,
  label,
  count,
  active,
  onPress,
}: {
  theme: Theme;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tabBtn,
        {
          borderBottomColor: active ? theme.accent : "transparent",
          backgroundColor: pressed ? `${theme.accent}10` : "transparent",
        },
      ]}
    >
      <Text
        style={{
          color: active ? theme.readerInk : theme.readerDim,
          fontFamily: FONTS.sans,
          fontSize: 13,
          fontWeight: active ? "700" : "500",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: active ? theme.accent : theme.readerDim,
          fontFamily: FONTS.mono,
          fontSize: 10,
          marginLeft: 6,
        }}
      >
        {count}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)", justifyContent: "flex-end" },
  scrimTap: { flex: 1 },
  panel: {
    height: "82%",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handleRow: { alignItems: "center", paddingTop: 8, paddingBottom: 4 },
  handle: { width: 48, height: 4, borderRadius: 2 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderBottomWidth: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colorChip: {
    width: 4,
    minHeight: 36,
    alignSelf: "stretch",
    marginRight: 12,
    borderRadius: 2,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
});
