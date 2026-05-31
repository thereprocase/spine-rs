import "react-native-gesture-handler";

import { Stack, useRouter, useSegments } from "expo-router";
import * as Linking from "expo-linking";
import { useFonts } from "expo-font";
import { useShareIntent } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Alert, AppState, NativeModules } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useLibrary } from "../src/store/library";
import { usePrefs } from "../src/store/prefs";
import { useDictionaries } from "../src/store/dictionaries";
import { READER_NATIVE_FONT_SOURCES } from "../src/reader/fonts";
import { useAppTheme } from "../src/ui/useTheme";
import { ImportProgressBanner } from "../src/ui/ImportProgressBanner";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

interface NativeFileIntent {
  action: string;
  files: Array<{ uri: string; name?: string | null; mimeType?: string | null; size?: number | null }>;
}

interface SpineNativeModule {
  getPendingFileIntent?: () => Promise<NativeFileIntent | null>;
}

const SpineZip = NativeModules.SpineZip as SpineNativeModule | undefined;

// Shared between the Open-with (VIEW) flow and the share-to (SEND) flow
// so the two dialogs can't drift apart again.
function confirmZipImport(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Import EPUBs from ZIP?",
      `${label} looks like a ZIP. Import every EPUB inside it?`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Import", onPress: () => resolve(true) },
      ],
    );
  });
}

/** Single-EPUB share/open-with: ask the user what to do.
 *
 *   - Read once: stage the book, open the reader, and discard the
 *     library record on reader exit. Useful for one-shot reads where
 *     the user doesn't want a temp file polluting their library.
 *   - Add to library: persist + land on /library (don't auto-open).
 *   - Cancel: do nothing.
 *
 * Returns the chosen disposition. Resolved on dismiss too (Cancel).
 *
 * Why a dialog at all: prior versions silently imported + opened. The
 * book vanished into the library without confirmation, and users who
 * shared "just to read" were stuck with permanent records they didn't
 * want. ZIP imports already had a confirm; this matches the pattern. */
type SingleEpubChoice = "read-once" | "add-to-library" | "cancel";
function chooseSingleEpubAction(label: string): Promise<SingleEpubChoice> {
  return new Promise((resolve) => {
    Alert.alert(
      "Open EPUB",
      `${label}`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
        { text: "Add to library", onPress: () => resolve("add-to-library") },
        { text: "Read once", onPress: () => resolve("read-once") },
      ],
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });
}

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const isInReader = (segments as string[])[0] === "reader";
  const hydrateLibrary = useLibrary((s) => s.hydrate);
  const hydratePrefs = usePrefs((s) => s.hydrate);
  const hydrateDictionaries = useDictionaries((s) => s.hydrate);
  const importFromUri = useLibrary((s) => s.importFromUri);
  const theme = useAppTheme();
  const lastHandledUri = useRef<string | null>(null);
  useFonts(READER_NATIVE_FONT_SOURCES);

  useEffect(() => {
    void hydratePrefs();
    void hydrateLibrary();
    void hydrateDictionaries();
  }, [hydrateLibrary, hydratePrefs, hydrateDictionaries]);

  // "Open with" handler. Android dispatches a VIEW intent with a content://
  // or file:// URI when the user taps an EPUB/ZIP in any file manager that
  // honours our intent filter. expo-linking surfaces it here.
  useEffect(() => {
    const waitHydrated = async () => {
      while (!useLibrary.getState().hydrated) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    // ZIP imports (often dozens of books) → /library so the user
    // picks. Single EPUBs went straight into the reader; now they
    // route based on the user's pre-import choice (chooseSingleEpubAction):
    //   "read-once"      → /reader/[id]?temp=1 (record auto-deleted on
    //                       reader exit)
    //   "add-to-library" → /library
    //   "cancel"         → handled before this routing step (no records).
    const routeAfterImport = (
      records: Awaited<ReturnType<typeof importFromUri>>,
      sourceWasZip: boolean,
      singleChoice: SingleEpubChoice | null,
    ) => {
      if (records.length === 0) return;
      if (sourceWasZip || records.length > 1) {
        router.replace("/library");
        return;
      }
      const first = records[0];
      if (!first) return;
      if (singleChoice === "add-to-library") {
        router.replace("/library");
        return;
      }
      // Default + "read-once": open the reader. The temp flag
      // tells the reader to clean up on unmount.
      router.replace({
        pathname: "/reader/[id]",
        params: { id: first.id, ...(singleChoice === "read-once" ? { temp: "1" } : {}) },
      });
    };

    const isZipLike = (name: string, mime?: string | null) => {
      const lowerName = name.toLowerCase();
      const lowerMime = mime?.toLowerCase() ?? "";
      return (
        lowerName.endsWith(".zip") ||
        lowerMime === "application/zip" ||
        lowerMime === "application/x-zip-compressed"
      );
    };

    // For ZIPs we ask "import everything?" once. For single EPUBs we
    // ask the three-way Read-once / Add-to-library / Cancel question
    // before doing anything destructive. Returns both the imported
    // records and the user's single-EPUB choice so routeAfterImport
    // can pick the destination.
    const importOne = async (
      uri: string,
      name: string,
      mime?: string | null,
    ): Promise<{
      records: Awaited<ReturnType<typeof importFromUri>>;
      singleChoice: SingleEpubChoice | null;
    }> => {
      const zipLike = isZipLike(name, mime);
      if (zipLike) {
        if (!(await confirmZipImport(name))) {
          return { records: [], singleChoice: null };
        }
      } else {
        const choice = await chooseSingleEpubAction(name);
        if (choice === "cancel") {
          return { records: [], singleChoice: "cancel" };
        }
        try {
          const records = await importFromUri(uri, name, mime);
          return { records, singleChoice: choice };
        } finally {
          if (lastHandledUri.current === uri) {
            lastHandledUri.current = null;
          }
        }
      }
      try {
        return { records: await importFromUri(uri, name, mime), singleChoice: null };
      } finally {
        // Drop the dedupe ref after the import resolves so a deliberate
        // re-share of the SAME file later isn't silently swallowed.
        // The dedupe still defends against the same intent firing
        // twice (which Android does on rotate / cold-boot).
        if (lastHandledUri.current === uri) {
          lastHandledUri.current = null;
        }
      }
    };

    const handle = async (incoming: string | null) => {
      if (!incoming) return;
      // Ignore our own internal scheme launches (spine://...) — those are
      // navigation deep links handled by expo-router, not file imports.
      if (incoming.startsWith("spine://")) return;
      const lower = incoming.toLowerCase();
      const name = fileNameFromUri(incoming);
      const lowerName = name.toLowerCase();
      const isProviderFile = lower.startsWith("content://") || lower.startsWith("file://");
      const looksLikeSupported =
        isProviderFile ||
        lower.endsWith(".epub") ||
        lower.endsWith(".zip") ||
        lowerName.endsWith(".epub") ||
        lowerName.endsWith(".zip") ||
        lower.includes("application%2fepub") ||
        lower.includes("application/epub") ||
        lower.includes("application%2fzip") ||
        lower.includes("application/zip");
      if (!looksLikeSupported) return;
      if (lastHandledUri.current === incoming) return;
      lastHandledUri.current = incoming;

      // Wait for hydration so the import lands on top of the persisted
      // library, not an empty one.
      await waitHydrated();
      const sourceWasZip = isZipLike(name, null);
      const { records, singleChoice } = await importOne(incoming, name, null);
      routeAfterImport(records, sourceWasZip, singleChoice);
    };

    const handleNativeIntent = async () => {
      const pending = await SpineZip?.getPendingFileIntent?.();
      if (!pending?.files?.length) return;
      await waitHydrated();
      const imported: Awaited<ReturnType<typeof importFromUri>> = [];
      let anyZip = false;
      // Track the LAST single-EPUB choice. With native multi-intent,
      // multiple files can arrive at once; if any are ZIPs we land on
      // /library regardless. If exactly ONE single EPUB arrives, the
      // user's choice routes them; if multiple arrive, /library is
      // always the right destination so the per-file choice is moot.
      let lastSingleChoice: SingleEpubChoice | null = null;
      for (const file of pending.files) {
        if (!file.uri || lastHandledUri.current === file.uri) continue;
        lastHandledUri.current = file.uri;
        const name = file.name ?? fileNameFromUri(file.uri);
        if (isZipLike(name, file.mimeType ?? null)) anyZip = true;
        const { records, singleChoice } = await importOne(
          file.uri,
          name,
          file.mimeType ?? null,
        );
        imported.push(...records);
        if (singleChoice && singleChoice !== "cancel") {
          lastSingleChoice = singleChoice;
        }
      }
      routeAfterImport(imported, anyZip, lastSingleChoice);
    };

    void Linking.getInitialURL().then(handle);
    void handleNativeIntent();
    const sub = Linking.addEventListener("url", (event) => {
      void handle(event.url);
      void handleNativeIntent();
    });
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") void handleNativeIntent();
    });
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [importFromUri, router]);

  // ACTION_SEND ("share to") intents — Android wraps the file URI in
  // EXTRA_STREAM, which is invisible to expo-linking. expo-share-intent's
  // native bridge surfaces it here.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  useEffect(() => {
    if (!hasShareIntent || !shareIntent.files?.length) return;
    const file = shareIntent.files[0];
    if (!file) return;
    const uri = file.path ?? null;
    if (!uri) return;
    if (lastHandledUri.current === uri) return;
    lastHandledUri.current = uri;
    void (async () => {
      while (!useLibrary.getState().hydrated) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const name = file.fileName ?? fileNameFromUri(uri);
      const mime = file.mimeType?.toLowerCase() ?? "";
      const isZip =
        name.toLowerCase().endsWith(".zip") ||
        mime === "application/zip" ||
        mime === "application/x-zip-compressed";
      let singleChoice: SingleEpubChoice | null = null;
      if (isZip) {
        // Reuse the SAME confirm helper as the deep-link path so we
        // ship one set of dialog copy, not two.
        const ok = await confirmZipImport(name);
        if (!ok) {
          resetShareIntent();
          return;
        }
      } else {
        // Single EPUB share: ask Read-once / Add to library / Cancel.
        // Same dialog as the deep-link path for consistency.
        singleChoice = await chooseSingleEpubAction(name);
        if (singleChoice === "cancel") {
          resetShareIntent();
          return;
        }
      }
      try {
        const records = await importFromUri(uri, name, mime);
        resetShareIntent();
        if (records.length > 0) {
          // ZIP / multi-record always lands on /library; single EPUB
          // routes by the user's chosen disposition.
          if (isZip || records.length > 1) {
            router.replace("/library");
          } else if (singleChoice === "add-to-library") {
            router.replace("/library");
          } else {
            const first = records[0];
            if (first) {
              router.replace({
                pathname: "/reader/[id]",
                params: {
                  id: first.id,
                  ...(singleChoice === "read-once" ? { temp: "1" } : {}),
                },
              });
            }
          }
        }
      } finally {
        // Same dedupe-clear as the importOne path so users can re-share
        // the same file later if they want to.
        if (lastHandledUri.current === uri) {
          lastHandledUri.current = null;
        }
      }
    })();
  }, [hasShareIntent, shareIntent, importFromUri, resetShareIntent, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaProvider>
        <StatusBar style={theme.statusDark ? "dark" : "light"} backgroundColor={theme.bg} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
            animation: "fade",
          }}
        />
        {/* Root-level import-progress banner. Visible from any route
            so users sharing a 194-EPUB ZIP from WhatsApp see something
            move while the unpack runs, instead of staring at the home
            screen and concluding nothing happened. */}
        <SafeAreaInsetsContext.Consumer>
          {(insets) =>
            insets ? (
              <ImportProgressBanner
                theme={theme}
                insets={insets}
                // When the user is in the reader, show only a thin
                // 2px progress strip at the top edge — don't yank
                // them out of immersive reading with a full-banner
                // takeover for an import they already kicked off.
                compact={isInReader}
              />
            ) : null
          }
        </SafeAreaInsetsContext.Consumer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function fileNameFromUri(uri: string): string {
  const stripped = uri.split("?")[0]!;
  const last = stripped.split("/").pop() ?? stripped;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
