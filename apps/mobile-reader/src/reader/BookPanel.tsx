// Top-down "book panel" — reached by tapping the title in the collapsed
// top chrome. Shows cover/work info, reading-session stats (wired), wired
// Share, and library actions. Edition switcher and send-to-Kindle stay
// X-overlaid since those features aren't shipping yet.

import { useRef } from "react";
import { Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import type { BookRecord } from "../types";

import { Cover } from "../ui/Cover";
import { XOverlay } from "./chromeShared";

interface ReadingMetrics {
  started: string;
  today: string;
  eta: string;
}

interface BookPanelProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  book: BookRecord;
  currentChapterLabel: string | null;
  reading: ReadingMetrics;
  highlightCount: number;
  bookmarkCount: number;
  onClose: () => void;
  onMarkFinished: () => void;
  onRemoveFromLibrary: () => void;
  onShare: () => void;
  onOpenAnnotations: (tab: "highlights" | "bookmarks") => void;
  /** Export the book's highlights + bookmarks as JSON via the share
   * sheet. Disabled (greyed) when both counts are zero — there's
   * nothing to export. */
  onExportAnnotations: () => void;
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
      }}
    >
      {children}
    </Text>
  );
}

interface RowProps {
  theme: Theme;
  label: string;
  value?: string;
  hint?: string;
  destructive?: boolean;
  onPress?: () => void;
  last?: boolean;
}
function Row({ theme, label, value, hint, destructive, onPress, last }: RowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: `${theme.readerRule}66`,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        backgroundColor: pressed ? `${theme.accent}14` : "transparent",
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: destructive ? theme.alert : theme.readerInk,
            fontFamily: FONTS.sans,
            fontSize: 13,
            fontWeight: destructive ? "600" : "500",
          }}
        >
          {label}
        </Text>
        {hint ? (
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
            {hint}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text
          style={{
            color: theme.readerDim,
            fontFamily: FONTS.sans,
            fontSize: 12,
            marginLeft: 8,
          }}
          numberOfLines={1}
        >
          {value}
        </Text>
      ) : null}
    </Pressable>
  );
}

function StatCell({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View
      style={{
        flex: 1,
        padding: 10,
        backgroundColor: `${theme.readerRule}40`,
      }}
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
        {label}
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
        {value}
      </Text>
    </View>
  );
}

export function BookPanel({
  visible,
  theme,
  insets,
  book,
  currentChapterLabel,
  reading,
  highlightCount,
  bookmarkCount,
  onClose,
  onMarkFinished,
  onRemoveFromLibrary,
  onShare,
  onOpenAnnotations,
  onExportAnnotations,
}: BookPanelProps) {
  const annotationCount = highlightCount + bookmarkCount;
  // Down-swipe on the bottom handle closes the panel — mirrors the
  // SessionPanel/TocSheet gesture so users learn one pattern. Threshold
  // 30px dy and dy-dominant.
  // onStartShouldSetPanResponder: false — the inner Pressable needs to
  // win pure taps for tap-to-close. We only claim the responder when
  // the user actually starts dragging vertically. Without this guard
  // the Pressable's onPress was getting eaten by Grant→Release with
  // no movement, so tap-to-close was broken.
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
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View
          style={[
            styles.panel,
            {
              backgroundColor: theme.readerBg,
              borderColor: theme.readerRule,
              paddingTop: insets.top + 4,
            },
          ]}
        >
          {/* Compact header strip. The left-side `‹` was unreadable as
              "close" in user testing — all three testers
              missed it. Use an explicit "Done" button on the right
              (iOS modal convention) so the close affordance is verbal,
              not glyphic. The down-swipe handle at the bottom and the
              hardware back button still work. */}
          <View style={[styles.headerRow, { borderBottomColor: theme.readerRule }]}>
            <View style={styles.headerBtn} />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                textAlign: "center",
                color: theme.readerInk,
                fontFamily: FONTS.serif,
                fontStyle: "italic",
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {book.title}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close book panel"
              style={({ pressed }) => [
                styles.doneBtn,
                {
                  backgroundColor: pressed ? `${theme.accent}22` : "transparent",
                },
              ]}
            >
              <Text
                style={{
                  color: theme.accent,
                  fontFamily: FONTS.sans,
                  fontSize: 14,
                  fontWeight: "700",
                  letterSpacing: 0.3,
                }}
              >
                Done
              </Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }}>
            {/* Cover + Work strip */}
            <View
              style={{
                flexDirection: "row",
                gap: 14,
                padding: 16,
                borderBottomColor: theme.readerRule,
                borderBottomWidth: StyleSheet.hairlineWidth,
              }}
            >
              <Cover book={book} width={78} theme={theme} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    color: theme.readerInk,
                    fontFamily: FONTS.serif,
                    fontStyle: "italic",
                    fontSize: 18,
                    fontWeight: "600",
                    lineHeight: 22,
                  }}
                  numberOfLines={2}
                >
                  {book.title}
                </Text>
                <Text
                  style={{
                    color: theme.readerInk,
                    fontFamily: FONTS.sans,
                    fontSize: 12,
                    marginTop: 4,
                  }}
                  numberOfLines={1}
                >
                  {book.author}
                </Text>
                {currentChapterLabel ? (
                  <Text
                    style={{
                      color: theme.readerDim,
                      fontFamily: FONTS.mono,
                      fontSize: 9,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      marginTop: 8,
                    }}
                    numberOfLines={1}
                  >
                    Now: {currentChapterLabel}
                  </Text>
                ) : null}
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
                  {Math.round(book.progress * 100)}% · imported{" "}
                  {new Date(book.importedAt).toLocaleDateString()}
                </Text>
              </View>
            </View>

            {/* Reading session — wired from real cumulative metrics */}
            <SectionLabel theme={theme}>Reading</SectionLabel>
            <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingBottom: 12 }}>
              <StatCell theme={theme} label="Started" value={reading.started} />
              <StatCell theme={theme} label="Today" value={reading.today} />
              <StatCell theme={theme} label="ETA" value={reading.eta} />
            </View>

            {/* Edition switcher — "This edition" is FUNCTIONALLY TRUE
                (the user is reading exactly this instance). Only the
                multi-edition switcher is wishful — that's the row that
                gets the X overlay, so a user doesn't read the whole
                section as broken. */}
            <SectionLabel theme={theme}>Edition · 1 instance</SectionLabel>
            <Row theme={theme} label="This edition" value="Current" hint="Imported EPUB" last />
            <XOverlay theme={theme}>
              <Row theme={theme} label="Other editions" value="0" hint="Switch translations / printings — coming soon" last />
            </XOverlay>

            {/* Annotations — wired to AnnotationsSheet + JSON export */}
            <SectionLabel theme={theme}>
              Annotations · {highlightCount} highlight{highlightCount === 1 ? "" : "s"} · {bookmarkCount} bookmark{bookmarkCount === 1 ? "" : "s"}
            </SectionLabel>
            <Row
              theme={theme}
              label="Highlights"
              value={`${highlightCount}`}
              hint={highlightCount === 0 ? "Long-press a word, then tap Highlight" : "Tap to browse · jump to source"}
              onPress={() => {
                onOpenAnnotations("highlights");
                onClose();
              }}
            />
            <Row
              theme={theme}
              label="Bookmarks"
              value={`${bookmarkCount}`}
              hint={bookmarkCount === 0 ? "Tap ☆ in the top chrome to mark a page" : "Tap to browse · jump to source"}
              onPress={() => {
                onOpenAnnotations("bookmarks");
                onClose();
              }}
            />

            {/* Share / export — Share wired via FileProvider; export
                writes a JSON snapshot of this book's annotations to
                the share sheet. Send-to-Kindle stays X (cross-device
                sync isn't shipping yet). */}
            <SectionLabel theme={theme}>Share &amp; export</SectionLabel>
            <Row
              theme={theme}
              label="Share book"
              hint="Send the EPUB file via the system share sheet"
              onPress={() => {
                onShare();
                onClose();
              }}
            />
            {annotationCount > 0 ? (
              <Row
                theme={theme}
                label="Export annotations"
                hint="JSON · highlights + bookmarks for this book"
                onPress={() => {
                  onExportAnnotations();
                  onClose();
                }}
              />
            ) : (
              <XOverlay theme={theme}>
                <Row theme={theme} label="Export annotations" hint="No highlights or bookmarks yet" />
              </XOverlay>
            )}
            <XOverlay theme={theme}>
              <Row theme={theme} label="Send to Kindle / device" hint="Cross-device sync" last />
            </XOverlay>

            {/* Library actions */}
            <SectionLabel theme={theme}>Library</SectionLabel>
            <XOverlay theme={theme}>
              <Row theme={theme} label="Move to shelf" value="Currently reading" hint="Shelves coming soon" />
            </XOverlay>
            <Row
              theme={theme}
              label="Mark as finished"
              hint="Sets progress to 100%"
              onPress={() => {
                onMarkFinished();
                onClose();
              }}
            />
            <Row
              theme={theme}
              label="Remove from library"
              destructive
              onPress={() => {
                onRemoveFromLibrary();
                onClose();
              }}
              last
            />
            <View style={{ height: insets.bottom + 24 }} />
          </ScrollView>

          <View
            {...handlePan.panHandlers}
            style={[styles.handleRow, { paddingBottom: insets.bottom + 8 }]}
          >
            <Pressable onPress={onClose} hitSlop={12}>
              <View style={[styles.handle, { backgroundColor: theme.readerDim, opacity: 0.4 }]} />
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.42)" },
  panel: {
    flex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 56, height: 40, alignItems: "center", justifyContent: "center" },
  doneBtn: {
    minWidth: 56,
    height: 40,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
  },
  handleRow: { alignItems: "center", paddingTop: 12 },
  handle: { width: 48, height: 4, borderRadius: 2 },
});
