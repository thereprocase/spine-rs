// Library home — cover grid, top app bar, FAB to import, long-press to delete.
// Mirrors the structure of mockup screen 03 (MLibraryGrid) but stripped to alpha
// scope: no filters, no sort toggle, no view-toggle row, no scent dots.

import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLibrary } from "../src/store/library";
import { FONTS } from "../src/themes";
import { Cover } from "../src/ui/Cover";
import { useAppTheme } from "../src/ui/useTheme";
import type { BookRecord } from "../src/types";

const COLUMNS = 3;
const HORIZ_PADDING = 16;
const COL_GAP = 14;
type SortMode = "recent" | "title" | "author";

export default function LibraryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();
  const books = useLibrary((s) => s.books);
  const importing = useLibrary((s) => s.importing);
  const importProgress = useLibrary((s) => s.importProgress);
  const error = useLibrary((s) => s.error);
  const importEpub = useLibrary((s) => s.importEpub);
  const deleteBook = useLibrary((s) => s.deleteBook);
  const clearError = useLibrary((s) => s.clearError);
  const touchOpened = useLibrary((s) => s.touchOpened);
  const hydrated = useLibrary((s) => s.hydrated);
  const { width } = useWindowDimensions();
  const [longPressedId, setLongPressedId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Live filter on title + author. Layered ON TOP of tag filtering —
  // user can pick a tag AND search within. Empty string = no filter.
  // Trimmed + lowercased once per render in the filter step below.
  const [searchQuery, setSearchQuery] = useState("");

  const coverWidth = useMemo(() => {
    const usable = width - HORIZ_PADDING * 2 - COL_GAP * (COLUMNS - 1);
    return Math.floor(usable / COLUMNS);
  }, [width]);

  const editions = useMemo(() => books.length, [books]);
  // Tag pill counts are "drill-aware" — each pill shows the number of books
  // that would be VISIBLE IF YOU TAPPED IT. We key everything by the
  // lowercased tag so duplicate-casing across the library (e.g. "Sci-Fi"
  // on one book, "sci-fi" on another) doesn't drift the React key from
  // render to render and break the active-pill check + reorder. Canonical
  // (display) casing is pinned to the lexicographically-first variant for
  // stability.
  // Indexed once per `books` change: tag → {canonical display casing,
  // set of book IDs carrying that tag}. We memoise it separately from
  // tagCounts so flipping selectedTags doesn't repeat the full
  // book-walk; only the per-tag intersect runs each time.
  const tagIndex = useMemo(() => {
    const idx = new Map<string, { canonical: string; bookIds: Set<string> }>();
    for (const book of books) {
      for (const tag of book.tags ?? []) {
        const clean = tag.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        const existing = idx.get(key);
        if (existing) {
          existing.bookIds.add(book.id);
          if (clean < existing.canonical) existing.canonical = clean;
        } else {
          idx.set(key, { canonical: clean, bookIds: new Set([book.id]) });
        }
      }
    }
    return idx;
  }, [books]);

  // Tag pill counts are "drill-aware" — each pill shows the number of
  // books that would be VISIBLE IF YOU TAPPED IT. Previously this was
  // O(B*T*B) — for each tag, walk every book and rebuild a tag set —
  // which got noticeable on a 200-book library with 50+ tags.
  // Now: precompute the active intersection once, then per-tag take a
  // Set intersection from the index. O(T*S) where S is the smaller set.
  const tagCounts = useMemo(() => {
    const selectedSet = new Set(selectedTags); // already stored lowercase

    // Books matching the CURRENT selection (drill state). Empty
    // selection = all books.
    let activeBookIds: Set<string> | null = null;
    for (const sel of selectedSet) {
      const entry = tagIndex.get(sel);
      const ids = entry?.bookIds ?? new Set<string>();
      if (activeBookIds === null) {
        activeBookIds = new Set(ids);
      } else {
        const next = new Set<string>();
        for (const id of activeBookIds) if (ids.has(id)) next.add(id);
        activeBookIds = next;
      }
    }
    const allBookIds = activeBookIds ?? new Set(books.map((b) => b.id));

    const out: Array<{ key: string; canonical: string; count: number }> = [];
    for (const [key, { canonical, bookIds }] of tagIndex) {
      const isActive = selectedSet.has(key);
      let count: number;
      if (isActive) {
        // Removing this tag from selection → re-intersect the OTHER
        // selected tags. With Sets this is straight intersection.
        let postBookIds: Set<string> | null = null;
        for (const sel of selectedSet) {
          if (sel === key) continue;
          const ids = tagIndex.get(sel)?.bookIds ?? new Set<string>();
          if (postBookIds === null) {
            postBookIds = new Set(ids);
          } else {
            const next = new Set<string>();
            for (const id of postBookIds) if (ids.has(id)) next.add(id);
            postBookIds = next;
          }
        }
        count = postBookIds === null ? books.length : postBookIds.size;
      } else {
        // Adding this tag → intersect with current active set.
        let hits = 0;
        // Iterate the smaller set for cheaper membership checks.
        const [small, large] =
          bookIds.size <= allBookIds.size ? [bookIds, allBookIds] : [allBookIds, bookIds];
        for (const id of small) if (large.has(id)) hits += 1;
        count = hits;
      }
      // Drop dead-end pills (would yield empty grid). Keep active pills
      // always — the user needs a way to un-select them.
      if (!isActive && count === 0) continue;
      out.push({ key, canonical, count });
    }
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    return out.sort(
      (a, b) => b.count - a.count || collator.compare(a.canonical, b.canonical),
    );
  }, [books, selectedTags, tagIndex]);
  const sortedBooks = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    const tagFiltered =
      selectedTags.length === 0
        ? books
        : books.filter((book) => {
            const tags = new Set((book.tags ?? []).map((tag) => tag.toLowerCase()));
            // selectedTags is stored lowercase
            return selectedTags.every((tag) => tags.has(tag));
          });
    // Search filter: case-insensitive substring match against title and
    // first-author name. Layered on top of tag filtering so the two
    // compose. Empty / whitespace-only query passes everything through.
    const q = searchQuery.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? tagFiltered
        : tagFiltered.filter(
            (b) =>
              b.title.toLowerCase().includes(q) ||
              b.author.toLowerCase().includes(q),
          );
    return [...filtered].sort((a, b) => {
      if (sortMode === "title") {
        return collator.compare(a.title, b.title) || collator.compare(a.author, b.author);
      }
      if (sortMode === "author") {
        return collator.compare(a.author, b.author) || collator.compare(a.title, b.title);
      }
      // "Recent" = most recently READ. Books that have never been opened
      // sort last (by import time as a tiebreak), so a 194-book ZIP
      // import doesn't shove yesterday's read off the top of the grid.
      const aOpened = a.lastOpenedAt;
      const bOpened = b.lastOpenedAt;
      if (aOpened && bOpened) {
        return bOpened.localeCompare(aOpened) || collator.compare(a.title, b.title);
      }
      if (aOpened && !bOpened) return -1;
      if (!aOpened && bOpened) return 1;
      // Both never opened — fall back to import time.
      return b.importedAt.localeCompare(a.importedAt) || collator.compare(a.title, b.title);
    });
  }, [books, selectedTags, searchQuery, sortMode]);

  const toggleTag = (key: string) => {
    // Caller passes the lowercased key from tagCounts. Storing lowercase
    // means active-pill checks, sortedBooks filter, and toggleTag all
    // share one canonical form — no case drift between renders.
    setSelectedTags((current) =>
      current.includes(key) ? current.filter((t) => t !== key) : [...current, key],
    );
  };

  const onPressCover = async (book: BookRecord) => {
    await touchOpened(book.id);
    router.push({ pathname: "/reader/[id]", params: { id: book.id } });
  };

  const onLongPress = (book: BookRecord) => {
    setLongPressedId(book.id);
    // For "Untitled" books (parser failure or genuinely missing metadata)
    // the title alone gives the user nothing to identify the book by —
    // every untitled book has the same alert header. Append the filename
    // so the user can distinguish them before tapping Delete.
    const isUntitled =
      !book.title || book.title.trim().toLowerCase() === "untitled";
    const heading = isUntitled ? `Untitled — ${book.filename}` : book.title;
    Alert.alert(
      heading,
      "Permanently delete this book? The EPUB file will be removed from this device.",
      [
        { text: "Cancel", style: "cancel", onPress: () => setLongPressedId(null) },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteBook(book.id);
            setLongPressedId(null);
          },
        },
      ],
      { cancelable: true, onDismiss: () => setLongPressedId(null) },
    );
  };

  const renderItem = ({ item }: { item: BookRecord }) => {
    const isPressed = longPressedId === item.id;
    const firstAuthor = item.author.split(",")[0]?.trim() ?? item.author;
    return (
      <Pressable
        onPress={() => onPressCover(item)}
        onLongPress={() => onLongPress(item)}
        delayLongPress={350}
        style={{ width: coverWidth, opacity: isPressed ? 0.5 : 1 }}
      >
        <View style={{ position: "relative" }}>
          <Cover book={item} width={coverWidth} theme={theme} />
          {item.progress > 0 && item.progress < 1 ? (
            <View
              style={[
                styles.progressTrack,
                { backgroundColor: "rgba(0,0,0,0.3)" },
              ]}
            >
              <View
                style={{
                  width: `${item.progress * 100}%`,
                  height: "100%",
                  backgroundColor: theme.accent,
                }}
              />
            </View>
          ) : null}
        </View>
        <Text
          numberOfLines={2}
          style={{
            marginTop: 10,
            color: theme.text,
            fontFamily: FONTS.sans,
            fontSize: 11,
            fontWeight: "500",
            lineHeight: 14,
          }}
        >
          {item.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            marginTop: 2,
            color: theme.textDim,
            fontFamily: FONTS.sans,
            fontSize: 10,
          }}
        >
          {firstAuthor}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
      {/* Large app bar — mirrors AppBar(large) from mockup tokens. */}
      <View style={[styles.appBar, { borderBottomColor: theme.borderSoft }]}>
        <View style={styles.appBarRow}>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={importEpub}
            disabled={importing}
            style={({ pressed }) => [
              styles.addBtn,
              {
                backgroundColor: pressed ? theme.surfaceHi : "transparent",
                borderColor: theme.border,
                marginRight: 8,
              },
            ]}
          >
            <Text style={{ color: theme.accent, fontFamily: FONTS.sans, fontSize: 13, fontWeight: "600" }}>
              {importing ? "Importing…" : "+ Import"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => router.push("/settings")}
            accessibilityLabel="Open settings"
            hitSlop={6}
            style={({ pressed }) => [
              styles.settingsIconBtn,
              {
                backgroundColor: pressed ? theme.surfaceHi : "transparent",
                borderColor: theme.border,
              },
            ]}
          >
            <Text
              style={{
                color: theme.text,
                fontFamily: FONTS.serif,
                fontSize: 18,
                lineHeight: 18,
              }}
            >
              ⚙
            </Text>
          </Pressable>
        </View>
        <Text
          style={{
            color: theme.text,
            fontFamily: FONTS.serif,
            fontSize: 26,
            fontWeight: "600",
            letterSpacing: -0.3,
            lineHeight: 30,
            marginTop: 10,
          }}
        >
          Library
        </Text>
        <Text
          style={{
            color: theme.textDim,
            fontFamily: FONTS.mono,
            fontSize: 11,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginTop: 4,
          }}
        >
          {sortedBooks.length === editions
            ? `${editions} ${editions === 1 ? "work" : "works"}`
            : `${sortedBooks.length} of ${editions} works`}
        </Text>
      </View>

      {error ? (
        <Pressable
          onPress={clearError}
          accessibilityLabel="Dismiss error"
          accessibilityHint="Tap to dismiss this error message"
          style={[styles.errorBar, { backgroundColor: theme.alert }]}
        >
          <Text
            style={{ color: "#fff", fontFamily: FONTS.sans, fontSize: 12, flex: 1 }}
          >
            {error}
          </Text>
          <Text
            style={{
              color: "#fff",
              fontFamily: FONTS.mono,
              fontSize: 14,
              fontWeight: "700",
              marginLeft: 12,
              paddingHorizontal: 4,
            }}
          >
            ×
          </Text>
        </Pressable>
      ) : null}

      {!hydrated ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : books.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.textDim, fontFamily: FONTS.serif, fontSize: 18, fontStyle: "italic" }}>
            No books yet.
          </Text>
          <Text
            style={{
              color: theme.textFaint,
              fontFamily: FONTS.mono,
              fontSize: 11,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              marginTop: 8,
            }}
          >
            Tap + Import to add an EPUB
          </Text>
        </View>
      ) : (
        <FlatList
          ListHeaderComponent={
            <View>
              {/* Search bar — title + author live filter. Single-line,
                  with an inline ✕ to clear when there's a query. Sits
                  above the sort row so the user reaches for it before
                  the secondary controls. */}
              <View
                style={[
                  styles.searchWrap,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                  },
                ]}
              >
                <Text
                  style={{
                    color: theme.textDim,
                    fontFamily: FONTS.sans,
                    fontSize: 15,
                    marginRight: 6,
                  }}
                >
                  ⌕
                </Text>
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search title or author"
                  placeholderTextColor={theme.textFaint}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="search"
                  style={{
                    flex: 1,
                    color: theme.text,
                    fontFamily: FONTS.sans,
                    fontSize: 14,
                    paddingVertical: 0,
                  }}
                />
                {searchQuery.length > 0 ? (
                  <Pressable
                    onPress={() => setSearchQuery("")}
                    hitSlop={10}
                    accessibilityLabel="Clear search"
                    style={{ paddingHorizontal: 6 }}
                  >
                    <Text
                      style={{
                        color: theme.textDim,
                        fontFamily: FONTS.mono,
                        fontSize: 16,
                        fontWeight: "700",
                      }}
                    >
                      ×
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.sortRow}>
                <SortButton
                  label="Recent"
                  active={sortMode === "recent"}
                  theme={theme}
                  onPress={() => setSortMode("recent")}
                />
                <SortButton
                  label="Title A-Z"
                  active={sortMode === "title"}
                  theme={theme}
                  onPress={() => setSortMode("title")}
                />
                <SortButton
                  label="Author A-Z"
                  active={sortMode === "author"}
                  theme={theme}
                  onPress={() => setSortMode("author")}
                />
              </View>
              {tagCounts.length > 0 ? (
                <View style={styles.tagBrowser}>
                  <View style={styles.tagHeader}>
                    <Text
                      style={{
                        color: theme.textFaint,
                        fontFamily: FONTS.mono,
                        fontSize: 10,
                        letterSpacing: 0.7,
                        textTransform: "uppercase",
                      }}
                    >
                      Tags
                    </Text>
                    {selectedTags.length > 0 ? (
                      <Pressable onPress={() => setSelectedTags([])} hitSlop={8}>
                        <Text
                          style={{
                            color: theme.accent,
                            fontFamily: FONTS.mono,
                            fontSize: 10,
                            letterSpacing: 0.6,
                            textTransform: "uppercase",
                          }}
                        >
                          Clear
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.tagScroll}
                  >
                    {tagCounts.map(({ key, canonical, count }) => {
                      const active = selectedTags.includes(key);
                      return (
                        <Pressable
                          key={key}
                          onPress={() => toggleTag(key)}
                          style={({ pressed }) => [
                            styles.tagPill,
                            {
                              borderColor: active ? theme.accent : theme.border,
                              backgroundColor: active
                                ? theme.accent
                                : pressed
                                  ? theme.surfaceHi
                                  : "transparent",
                            },
                          ]}
                        >
                          <Text
                            numberOfLines={1}
                            style={{
                              color: active ? theme.bg : theme.textMid,
                              fontFamily: FONTS.sans,
                              fontSize: 11,
                              fontWeight: "600",
                            }}
                          >
                            {canonical}
                          </Text>
                          <Text
                            style={{
                              color: active ? theme.bg : theme.textDim,
                              fontFamily: FONTS.mono,
                              fontSize: 9,
                              marginLeft: 6,
                            }}
                          >
                            {count}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          }
          data={sortedBooks}
          numColumns={COLUMNS}
          keyExtractor={(b) => b.id}
          renderItem={renderItem}
          columnWrapperStyle={{ gap: COL_GAP }}
          contentContainerStyle={{
            paddingHorizontal: HORIZ_PADDING,
            paddingTop: 16,
            paddingBottom: insets.bottom + 24,
            rowGap: 22,
          }}
          ListEmptyComponent={
            searchQuery.trim().length > 0 || selectedTags.length > 0 ? (
              <View style={[styles.center, { paddingTop: 48 }]}>
                <Text
                  style={{
                    color: theme.textDim,
                    fontFamily: FONTS.serif,
                    fontSize: 16,
                    fontStyle: "italic",
                    textAlign: "center",
                  }}
                >
                  {searchQuery.trim().length > 0 && selectedTags.length > 0
                    ? "No books match this search and tag filter."
                    : searchQuery.trim().length > 0
                      ? `No books match "${searchQuery.trim()}".`
                      : "No books match these tags."}
                </Text>
                <Pressable
                  onPress={() => {
                    setSelectedTags([]);
                    setSearchQuery("");
                  }}
                  hitSlop={12}
                  style={{ marginTop: 12 }}
                >
                  <Text
                    style={{
                      color: theme.accent,
                      fontFamily: FONTS.mono,
                      fontSize: 11,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                    }}
                  >
                    Clear filters
                  </Text>
                </Pressable>
              </View>
            ) : null
          }
        />
      )}

      {importing ? (
        <View pointerEvents="none" style={[styles.toast, { backgroundColor: theme.panel, borderColor: theme.border }]}>
          <ActivityIndicator color={theme.accent} />
          <View style={{ marginLeft: 10, maxWidth: 240 }}>
            <Text
              style={{
                color: theme.textMid,
                fontFamily: FONTS.sans,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {importProgress
                ? `Importing ${importProgress.current} / ${importProgress.total}`
                : "Importing…"}
            </Text>
            {importProgress ? (
              <Text
                numberOfLines={1}
                style={{
                  color: theme.textDim,
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  marginTop: 2,
                }}
              >
                {importProgress.label}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SortButton({
  label,
  active,
  theme,
  onPress,
}: {
  label: string;
  active: boolean;
  theme: ReturnType<typeof useAppTheme>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.sortBtn,
        {
          backgroundColor: active ? theme.accent : pressed ? theme.surfaceHi : "transparent",
          borderColor: active ? theme.accent : theme.border,
        },
      ]}
    >
      <Text
        style={{
          color: active ? theme.bg : theme.textMid,
          fontFamily: FONTS.mono,
          fontSize: 10,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appBar: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  appBarRow: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  settingsIconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
  },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    minHeight: 40,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  sortRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  sortBtn: {
    minHeight: 36,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toast: {
    position: "absolute",
    bottom: 28,
    left: 24,
    right: 24,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagBrowser: {
    marginBottom: 16,
  },
  tagHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  tagScroll: {
    gap: 8,
    paddingRight: 16,
  },
  tagPill: {
    minHeight: 34,
    maxWidth: 180,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
});
