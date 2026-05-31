// Bottom-up dictionary lookup sheet. Opens when the user taps "Look up"
// in the SelectionBar. Looks the selected word up across every
// installed dictionary; if more than one returned a hit, the body
// is a horizontal pager — swipe (or tap the ‹ › arrows) to flip
// between Webster's, WordNet, etc. Order follows the priority list
// the user sets in Settings → Dictionaries (top entry first).
//
// Empty-state guides the user to Settings → Dictionaries when nothing
// is installed — keeping dictionaries out of the APK is the explicit
// product call.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import type { DictionaryHit } from "../dictionaries";
import { useDictionaries } from "../store/dictionaries";
import { FONTS, type Theme } from "../themes";

interface DictionarySheetProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  /** The selected text — single word for long-press, possibly a phrase
   * for drag-select. We try the full string first, then fall back to
   * the first word so a sloppy drag still resolves. */
  word: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function DictionarySheet({
  visible,
  theme,
  insets,
  word,
  onClose,
  onOpenSettings,
}: DictionarySheetProps) {
  const dicts = useDictionaries((s) => s.dicts);
  const lookupFn = useDictionaries((s) => s.lookup);

  const [hits, setHits] = useState<DictionaryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvedWord, setResolvedWord] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageWidth, setPageWidth] = useState(
    Dimensions.get("window").width,
  );
  const pagerRef = useRef<FlatList<DictionaryHit>>(null);

  useEffect(() => {
    if (!visible || !word) {
      setHits([]);
      setResolvedWord(null);
      setPageIndex(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHits([]);
    setResolvedWord(null);
    setPageIndex(0);
    (async () => {
      const trimmed = word.trim();
      const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
      let result = await lookupFn(trimmed);
      let used = trimmed;
      if (result.length === 0 && firstWord && firstWord !== trimmed) {
        const fallback = await lookupFn(firstWord);
        if (fallback.length > 0) {
          result = fallback;
          used = firstWord;
        }
      }
      if (cancelled) return;
      setHits(result);
      setResolvedWord(used);
      setLoading(false);
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, word, lookupFn, dicts]);

  // Down-swipe on the handle area closes (matches the rest of the
  // bottom-sheet family).
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

  const display = (resolvedWord ?? word ?? "").trim();

  const onPagerScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      // Round-to-nearest with a half-page tolerance so a settle
      // animation doesn't briefly show the wrong page index.
      if (pageWidth <= 0) return;
      const idx = Math.round(x / pageWidth);
      if (idx !== pageIndex) setPageIndex(idx);
    },
    [pageWidth, pageIndex],
  );

  const goToPage = useCallback(
    (idx: number) => {
      if (!pagerRef.current) return;
      const clamped = Math.max(0, Math.min(hits.length - 1, idx));
      pagerRef.current.scrollToIndex({ index: clamped, animated: true });
      setPageIndex(clamped);
    },
    [hits.length],
  );

  const renderHit: ListRenderItem<DictionaryHit> = ({ item: hit }) => (
    <View style={{ width: pageWidth }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
      >
        <View style={[styles.card, { borderColor: theme.readerRule }]}>
          <Text
            style={{
              color: theme.readerDim,
              fontFamily: FONTS.mono,
              fontSize: 9,
              letterSpacing: 1,
              textTransform: "uppercase",
              fontWeight: "600",
            }}
          >
            {hit.meta.name} · {hit.meta.lang}
          </Text>
          <Text
            style={{
              color: theme.readerInk,
              fontFamily: FONTS.serif,
              fontSize: 16,
              fontWeight: "600",
              marginTop: 6,
            }}
          >
            {hit.headword}
          </Text>
          {hit.definitions.map((def, idx) => (
            <Text
              key={`${hit.meta.id}-${idx}`}
              style={{
                color: theme.readerInk,
                fontFamily: FONTS.serif,
                fontSize: 14,
                lineHeight: 20,
                marginTop: 8,
              }}
            >
              {hit.definitions.length > 1 ? `${idx + 1}. ` : ""}
              {def}
            </Text>
          ))}
        </View>
      </ScrollView>
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
          onLayout={(e) => setPageWidth(e.nativeEvent.layout.width)}
        >
          <View {...handlePan.panHandlers} style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: theme.readerDim, opacity: 0.4 }]} />
          </View>
          <View style={[styles.headerRow, { borderBottomColor: theme.readerRule }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  color: theme.readerDim,
                  fontFamily: FONTS.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  fontWeight: "600",
                }}
              >
                Look up
                {hits.length > 1
                  ? ` · ${pageIndex + 1} of ${hits.length}`
                  : ""}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: theme.readerInk,
                  fontFamily: FONTS.serif,
                  fontStyle: "italic",
                  fontSize: 22,
                  fontWeight: "600",
                  marginTop: 2,
                }}
              >
                {display || "—"}
              </Text>
            </View>
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

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : dicts.length === 0 ? (
            <EmptyState
              theme={theme}
              title="No dictionaries installed"
              body="Spine looks words up against JSON dictionaries you install. Tap below to install one in Settings."
              actionLabel="Open Settings → Dictionaries"
              onAction={() => {
                onClose();
                onOpenSettings();
              }}
            />
          ) : hits.length === 0 ? (
            <EmptyState
              theme={theme}
              title="Not found"
              body={
                display
                  ? `“${display}” isn’t in any installed dictionary. Try the base form, or install another dictionary.`
                  : "Select a word and tap Look up to see definitions here."
              }
              actionLabel="Manage dictionaries"
              onAction={() => {
                onClose();
                onOpenSettings();
              }}
            />
          ) : (
            <View style={{ flex: 1 }}>
              <FlatList
                ref={pagerRef}
                data={hits}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                keyExtractor={(h) => h.meta.id}
                renderItem={renderHit}
                onScroll={onPagerScroll}
                scrollEventThrottle={16}
                getItemLayout={(_, index) => ({
                  length: pageWidth,
                  offset: pageWidth * index,
                  index,
                })}
              />
              {hits.length > 1 ? (
                <View
                  style={[
                    styles.pagerControls,
                    {
                      borderTopColor: theme.readerRule,
                    },
                  ]}
                >
                  <Pressable
                    onPress={() => goToPage(pageIndex - 1)}
                    disabled={pageIndex === 0}
                    accessibilityLabel="Previous dictionary"
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.pagerArrow,
                      {
                        opacity: pageIndex === 0 ? 0.25 : pressed ? 0.5 : 1,
                      },
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
                      ‹
                    </Text>
                  </Pressable>

                  <View style={styles.dotsRow}>
                    {hits.map((h, idx) => (
                      <Pressable
                        key={h.meta.id}
                        onPress={() => goToPage(idx)}
                        hitSlop={6}
                        accessibilityLabel={`Show ${h.meta.name}`}
                      >
                        <View
                          style={[
                            styles.dot,
                            {
                              backgroundColor:
                                idx === pageIndex
                                  ? theme.accent
                                  : theme.readerDim,
                              opacity: idx === pageIndex ? 1 : 0.4,
                            },
                          ]}
                        />
                      </Pressable>
                    ))}
                  </View>

                  <Pressable
                    onPress={() => goToPage(pageIndex + 1)}
                    disabled={pageIndex >= hits.length - 1}
                    accessibilityLabel="Next dictionary"
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.pagerArrow,
                      {
                        opacity:
                          pageIndex >= hits.length - 1 ? 0.25 : pressed ? 0.5 : 1,
                      },
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
                      ›
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function EmptyState({
  theme,
  title,
  body,
  actionLabel,
  onAction,
}: {
  theme: Theme;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text
        style={{
          color: theme.readerInk,
          fontFamily: FONTS.serif,
          fontStyle: "italic",
          fontSize: 16,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          color: theme.readerDim,
          fontFamily: FONTS.sans,
          fontSize: 13,
          lineHeight: 19,
          marginTop: 10,
          textAlign: "center",
          maxWidth: 320,
        }}
      >
        {body}
      </Text>
      <Pressable
        onPress={onAction}
        style={({ pressed }) => [
          styles.actionBtn,
          {
            borderColor: theme.accent,
            backgroundColor: pressed ? `${theme.accent}22` : "transparent",
          },
        ]}
      >
        <Text
          style={{
            color: theme.accent,
            fontFamily: FONTS.sans,
            fontSize: 13,
            fontWeight: "600",
          }}
        >
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)", justifyContent: "flex-end" },
  scrimTap: { flex: 1 },
  panel: {
    height: "70%",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handleRow: { alignItems: "center", paddingTop: 8, paddingBottom: 4 },
  handle: { width: 48, height: 4, borderRadius: 2 },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loading: { padding: 32, alignItems: "center" },
  empty: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtn: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pagerControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pagerArrow: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  dotsRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
