// Full-height TOC sheet. Bottom-up modal that lists every chapter from the
// EPUB's navigation. Tapping a row jumps the rendition to that href and
// closes the sheet. Subitems render indented one level deep.

import { useCallback, useMemo } from "react";
import {
  FlatList,
  type ListRenderItem,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import type { TocItem } from "./messages";

interface TocSheetProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  toc: TocItem[];
  currentHref: string | null;
  onClose: () => void;
  onPick: (href: string) => void;
}

interface FlatRow {
  label: string;
  href: string;
  depth: number;
}

function flatten(items: TocItem[], depth: number, out: FlatRow[]): void {
  for (const item of items) {
    if (item.href) {
      out.push({ label: item.label || "Untitled chapter", href: item.href, depth });
    }
    if (item.subitems?.length) {
      flatten(item.subitems, depth + 1, out);
    }
  }
}

function tocKeyExtractor(row: FlatRow): string {
  return `${row.href}-${row.depth}`;
}

function hrefMatches(rowHref: string, currentHref: string | null): boolean {
  if (!currentHref) return false;
  // epubjs reports href without the file path normalization the TOC uses,
  // so compare on a hash-stripped basename suffix to be lenient.
  const a = rowHref.split("#")[0]!.split("/").pop() ?? rowHref;
  const b = currentHref.split("#")[0]!.split("/").pop() ?? currentHref;
  return a === b;
}

export function TocSheet({
  visible,
  theme,
  insets,
  toc,
  currentHref,
  onClose,
  onPick,
}: TocSheetProps) {
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(toc, 0, out);
    return out;
  }, [toc]);

  const renderRow = useCallback<ListRenderItem<FlatRow>>(
    ({ item: row }) => {
      const active = hrefMatches(row.href, currentHref);
      return (
        <Pressable
          onPress={() => {
            onPick(row.href);
            onClose();
          }}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed
                ? `${theme.accent}14`
                : active
                  ? `${theme.accent}10`
                  : "transparent",
              borderBottomColor: theme.readerRule,
              paddingLeft: 20 + row.depth * 18,
            },
          ]}
        >
          {active ? (
            <View
              style={{
                position: "absolute",
                left: 8 + row.depth * 18,
                top: "50%",
                marginTop: -4,
                width: 4,
                height: 8,
                backgroundColor: theme.accent,
              }}
            />
          ) : null}
          <Text
            numberOfLines={2}
            style={{
              color: active ? theme.accent : theme.readerInk,
              fontFamily: FONTS.serif,
              fontSize: 14 - Math.min(row.depth, 2) * 1,
              fontStyle: row.depth > 0 ? "italic" : "normal",
              fontWeight: row.depth === 0 ? "500" : "400",
              lineHeight: 19,
            }}
          >
            {row.label}
          </Text>
        </Pressable>
      );
    },
    [theme, currentHref, onPick, onClose],
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
          <View style={styles.handleRow}>
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
              Contents
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
          {rows.length === 0 ? (
            <View style={styles.empty}>
              <Text
                style={{
                  color: theme.readerDim,
                  fontFamily: FONTS.serif,
                  fontStyle: "italic",
                  fontSize: 15,
                }}
              >
                No table of contents in this book.
              </Text>
            </View>
          ) : (
            // FlatList instead of ScrollView so a 500-chapter NCX
            // (technical reference EPUBs hit 500+) doesn't render
            // every row up front. Window-virtualized: only ~10 rows
            // around the viewport are mounted at any time.
            <FlatList
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingVertical: 6 }}
              data={rows}
              keyExtractor={tocKeyExtractor}
              renderItem={renderRow}
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
  row: {
    paddingRight: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  empty: { padding: 32, alignItems: "center" },
});
