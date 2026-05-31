// Branded home / entry screen. Logo 02 + Spine wordmark + tagline up top, a
// "Resume reading" card for the most-recently-opened book (if any), an
// "Enter library" button, and a brass-rule ribbon at the bottom.
//
// The cover-grid library now lives at /library; this is the route root.

import { useRouter } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLibrary } from "../src/store/library";
import { FONTS } from "../src/themes";
import { Cover } from "../src/ui/Cover";
import { Logo } from "../src/ui/Logo";
import { useAppTheme } from "../src/ui/useTheme";
import type { BookRecord } from "../src/types";
import { APP_VERSION } from "../src/version";

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();
  const books = useLibrary((s) => s.books);
  const hydrated = useLibrary((s) => s.hydrated);
  const touchOpened = useLibrary((s) => s.touchOpened);
  const error = useLibrary((s) => s.error);
  const clearError = useLibrary((s) => s.clearError);

  const resume = useMemo<BookRecord | null>(() => {
    if (books.length === 0) return null;
    const opened = books.filter((b) => b.lastOpenedAt);
    if (opened.length === 0) {
      // No book has been opened yet. Pick the most recently IMPORTED
      // book rather than blindly returning books[0] — the underlying
      // array order isn't guaranteed by the store.
      return (
        [...books].sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0] ?? null
      );
    }
    return (
      opened.sort((a, b) =>
        (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""),
      )[0] ?? null
    );
  }, [books]);

  const onResume = async (book: BookRecord) => {
    await touchOpened(book.id);
    router.push({ pathname: "/reader/[id]", params: { id: book.id } });
  };

  const editions = books.length;
  const ribbonCaption = useMemo(() => {
    if (!hydrated) return "Loading catalog";
    if (editions === 0) return "Bibframe-native · ready for your first import";
    return `Bibframe-native · ${editions} ${editions === 1 ? "work" : "works"}`;
  }, [hydrated, editions]);

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: theme.bg, paddingTop: insets.top },
      ]}
    >
      {/* Errors raised by background ZIP imports (Share intent) used to
       * silently set library.error and never render anywhere — the user
       * lands here after sharing and sees no signal that 0 of 194 EPUBs
       * imported. Surface it the same way library.tsx does so the
       * landing screen never hides a failure. */}
      {error ? (
        <Pressable
          onPress={clearError}
          accessibilityLabel="Dismiss error"
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

      <View style={styles.body}>
        {/* Logo lockup */}
        <View style={styles.logoBlock}>
          <Logo size={96} />
          <Text
            style={{
              color: theme.text,
              fontFamily: FONTS.serif,
              fontSize: 44,
              fontWeight: "600",
              letterSpacing: -0.8,
              marginTop: 28,
            }}
          >
            Spine
          </Text>
          <Text
            style={{
              color: theme.textDim,
              fontFamily: FONTS.sans,
              fontSize: 13,
              lineHeight: 18,
              textAlign: "center",
              maxWidth: 260,
              marginTop: 10,
            }}
          >
            A BIBFRAME-native library for people who love books.
          </Text>
        </View>

        {/* Resume reading card OR placeholder */}
        {!hydrated ? (
          <View style={styles.placeholderCard}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : resume ? (
          <ResumeCard book={resume} onResume={onResume} />
        ) : (
          <View
            style={[
              styles.placeholderCard,
              { borderColor: theme.borderSoft, backgroundColor: theme.panel },
            ]}
          >
            <Text
              style={{
                color: theme.textDim,
                fontFamily: FONTS.serif,
                fontStyle: "italic",
                fontSize: 16,
                textAlign: "center",
              }}
            >
              No book opened yet.
            </Text>
            <Text
              style={{
                color: theme.textFaint,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                textAlign: "center",
                marginTop: 8,
              }}
            >
              Import an EPUB to begin
            </Text>
          </View>
        )}

        {/* Enter library + Settings buttons */}
        <View style={{ width: "100%", flexDirection: "row", gap: 10 }}>
          <Pressable
            onPress={() => router.push("/library")}
            style={({ pressed }) => [
              styles.libraryBtn,
              {
                flex: 1,
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceHi : "transparent",
              },
            ]}
          >
            <Text
              style={{
                color: theme.text,
                fontFamily: FONTS.sans,
                fontSize: 14,
                fontWeight: "600",
                letterSpacing: 0.3,
              }}
            >
              Enter Library
            </Text>
            <Text
              style={{
                color: theme.textDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                marginTop: 3,
              }}
            >
              {editions} {editions === 1 ? "work" : "works"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => router.push("/settings")}
            style={({ pressed }) => [
              styles.settingsBtn,
              {
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceHi : "transparent",
              },
            ]}
          >
            <Text
              style={{
                color: theme.text,
                fontFamily: FONTS.sans,
                fontSize: 14,
                fontWeight: "600",
                letterSpacing: 0.3,
              }}
            >
              Settings
            </Text>
            <Text
              style={{
                color: theme.textDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                marginTop: 3,
              }}
            >
              theme · data
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Bottom ribbon */}
      <View
        style={[
          styles.ribbon,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={[styles.ribbonRule, { backgroundColor: theme.accent }]} />
        <Text
          style={{
            color: theme.textFaint,
            fontFamily: FONTS.mono,
            fontSize: 10,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            marginTop: 10,
          }}
        >
          {ribbonCaption}
        </Text>
        <Text
          style={{
            color: theme.textFaint,
            fontFamily: FONTS.mono,
            fontSize: 9,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            marginTop: 4,
            opacity: 0.6,
          }}
        >
          v{APP_VERSION} · alpha
        </Text>
      </View>
    </View>
  );
}

function ResumeCard({
  book,
  onResume,
}: {
  book: BookRecord;
  onResume: (b: BookRecord) => void;
}) {
  const theme = useAppTheme();
  const pct = Math.round(book.progress * 100);
  return (
    <View style={{ width: "100%" }}>
      <View
        style={[
          styles.resumeCard,
          {
            backgroundColor: theme.panel,
            borderColor: theme.border,
          },
        ]}
      >
        <Cover book={book} width={84} theme={theme} />
        <View style={styles.resumeInfo}>
          <Text
            numberOfLines={1}
            style={{
              color: theme.textFaint,
              fontFamily: FONTS.mono,
              fontSize: 10,
              letterSpacing: 0.8,
              textTransform: "uppercase",
            }}
          >
            {book.lastOpenedAt ? "Continue reading" : "Start reading"}
          </Text>
          <Text
            numberOfLines={2}
            style={{
              color: theme.text,
              fontFamily: FONTS.serif,
              fontStyle: "italic",
              fontSize: 18,
              fontWeight: "600",
              lineHeight: 22,
              marginTop: 6,
            }}
          >
            {book.title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              color: theme.textMid,
              fontFamily: FONTS.sans,
              fontSize: 12,
              marginTop: 4,
            }}
          >
            {book.author}
          </Text>
          {book.progress > 0 ? (
            <View style={{ marginTop: 12 }}>
              <View
                style={[styles.progressTrack, { backgroundColor: theme.border }]}
              >
                <View
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    backgroundColor: pct >= 100 ? theme.ok : theme.accent,
                  }}
                />
              </View>
              <Text
                style={{
                  color: theme.textDim,
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  marginTop: 6,
                }}
              >
                {pct >= 100 ? "Finished" : `${pct}%`}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <Pressable
        onPress={() => onResume(book)}
        style={({ pressed }) => [
          styles.resumeBtn,
          {
            backgroundColor: pressed ? theme.accentHi : theme.accent,
          },
        ]}
      >
        <Text
          style={{
            color: theme.inkInvert,
            fontFamily: FONTS.sans,
            fontSize: 14,
            fontWeight: "700",
            letterSpacing: 0.3,
          }}
        >
          {book.lastOpenedAt ? "› Resume reading" : "› Start reading"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  logoBlock: {
    alignItems: "center",
    marginBottom: 8,
  },
  resumeCard: {
    width: "100%",
    flexDirection: "row",
    gap: 16,
    padding: 16,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resumeInfo: { flex: 1, minWidth: 0 },
  progressTrack: {
    height: 3,
    borderRadius: 1,
    overflow: "hidden",
  },
  resumeBtn: {
    marginTop: 12,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
  },
  libraryBtn: {
    paddingVertical: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 3,
    alignItems: "center",
  },
  settingsBtn: {
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderCard: {
    width: "100%",
    paddingVertical: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  ribbon: {
    paddingHorizontal: 24,
    alignItems: "center",
  },
  ribbonRule: {
    width: 24,
    height: 2,
  },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 3,
  },
});
