// Settings — visual ports mockup screen 11. LoC reconciliation, sync reading
// position, highlights export, and reset reconciliation are intentionally
// absent: the alpha doesn't have networked / cross-device features, and there
// are no highlights to export yet. Everything else is wired.

import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { exportLibraryJson } from "../src/storage/export";
import {
  READER_FONT_CATEGORIES,
  READER_FONT_OPTIONS,
  getReaderFontLabel,
  type ReaderFontCategory,
  type ReaderFontId,
} from "../src/reader/fonts";
import {
  asyncStorageBytes,
  booksUsage,
  coversUsage,
  formatBytes,
} from "../src/storage/stats";
import { CURATED_DICTIONARIES, dictionariesUsage } from "../src/dictionaries";
import { useDictionaries } from "../src/store/dictionaries";
import { useLibrary } from "../src/store/library";
import { usePrefs } from "../src/store/prefs";
import { FONTS, SPINE_THEMES, THEME_ORDER, type ThemeName } from "../src/themes";
import { useAppTheme } from "../src/ui/useTheme";

const GITHUB_URL = "https://github.com/thereprocase/spine";

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();
  const books = useLibrary((s) => s.books);
  const importEpub = useLibrary((s) => s.importEpub);
  const deleteLibrary = useLibrary((s) => s.deleteLibrary);
  const importing = useLibrary((s) => s.importing);
  const reader = usePrefs((s) => s.reader);
  const appTheme = usePrefs((s) => s.appTheme);
  const setAppTheme = usePrefs((s) => s.setAppTheme);
  const patchReader = usePrefs((s) => s.patchReader);

  const [booksBytes, setBooksBytes] = useState<number | null>(null);
  const [coverBytes, setCoverBytes] = useState<number | null>(null);
  const [metaBytes, setMetaBytes] = useState<number | null>(null);
  const [dictBytes, setDictBytes] = useState<number | null>(null);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [fontPickerCategory, setFontPickerCategory] = useState<ReaderFontCategory | null>(null);
  const [dictUrlModalOpen, setDictUrlModalOpen] = useState(false);
  const [dictUrl, setDictUrl] = useState("");

  const dicts = useDictionaries((s) => s.dicts);
  const dictsHydrated = useDictionaries((s) => s.hydrated);
  const installDict = useDictionaries((s) => s.installFromUrl);
  const uninstallDict = useDictionaries((s) => s.uninstall);
  const moveDictPriority = useDictionaries((s) => s.movePriority);
  const installingDict = useDictionaries((s) => s.installing);
  const installingUrl = useDictionaries((s) => s.installingUrl);
  // Display order = ascending priority. memo so the array reference is
  // stable across re-renders (used as a dep below).
  const orderedDicts = useMemo(
    () => [...dicts].sort((a, b) => a.priority - b.priority),
    [dicts],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      booksUsage(),
      coversUsage(),
      asyncStorageBytes(),
      dictionariesUsage(),
    ]).then(([b, c, m, d]) => {
      if (cancelled) return;
      setBooksBytes(b);
      setCoverBytes(c);
      setMetaBytes(m);
      setDictBytes(d);
    });
    return () => {
      cancelled = true;
    };
  }, [books.length, dicts.length]);

  const onExport = async () => {
    if (books.length === 0) {
      Alert.alert("Nothing to export", "Import a book first.");
      return;
    }
    try {
      const path = await exportLibraryJson(books);
      // Hand off to the system share sheet so the user can drop the
      // JSON wherever they want — Drive, email, Files, whatever.
      // Showing the raw filesystem path was useless: a regular user
      // can't navigate to /data/user/0/com.thereprocase.spinereader/
      // from any file manager.
      const SpineZip = (NativeModules.SpineZip as
        | { shareFile?: (path: string, mime: string, title: string, displayName?: string | null) => Promise<boolean> }
        | undefined);
      if (SpineZip?.shareFile) {
        try {
          await SpineZip.shareFile(
            path,
            "application/json",
            "Spine library export",
            "spine-library.json",
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Couldn't share";
          Alert.alert("Library exported", `Saved, but couldn't open share sheet: ${msg}`);
        }
      } else {
        Alert.alert("Library exported", "Saved internally; sharing isn't wired in this build.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Export failed";
      Alert.alert("Export failed", msg);
    }
  };

  const onPickTheme = () => {
    // Cycle through ALL themes (THEME_ORDER), not the legacy 3-theme
    // hard-coded subset. noir/stark were silently invisible from this
    // picker even though they were already present in the reader.
    const idx = THEME_ORDER.findIndex((t) => t.key === appTheme);
    const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length]?.key ?? "dark";
    void setAppTheme(next);
  };

  const onPickReaderFont = (category: ReaderFontCategory, fontId: ReaderFontId) => {
    // Keep the modal open after a pick so the user can compare fonts —
    // the body copy promised "Tap a row to compare; tap Done when you're
    // happy" and was lying to itself before. Now Done is the only way
    // out (or the back button / scrim tap).
    const fontMap = { ...reader.fontMap, [category]: fontId };
    void patchReader({ fontMap });
  };

  const deletePhraseAccepted = isDeletePhraseAccepted(deletePhrase);

  const onDeleteLibrary = () => {
    if (!deletePhraseAccepted) return;
    Alert.alert(
      "Are you sure?",
      "This deletes every imported EPUB, cover, and library record stored by Spine on this device. Reader settings stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Yes, delete",
          style: "destructive",
          onPress: async () => {
            await deleteLibrary();
            setDeletePhrase("");
            setDeleteModalVisible(false);
            setBooksBytes(0);
            setCoverBytes(0);
            setMetaBytes(0);
          },
        },
      ],
    );
  };

  const version =
    (Constants.expoConfig?.version as string | undefined) ?? "0.1.0";

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
      <View
        style={[
          styles.appBar,
          { borderBottomColor: theme.borderSoft },
        ]}
      >
        <View style={styles.appBarRow}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
            <Text style={[styles.backChev, { color: theme.text }]}>‹</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
        </View>
        <Text
          style={{
            color: theme.text,
            fontFamily: FONTS.serif,
            fontSize: 26,
            fontWeight: "600",
            letterSpacing: -0.3,
            lineHeight: 30,
            marginTop: 8,
          }}
        >
          Settings
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
          v{version} · {books.length} {books.length === 1 ? "work" : "works"}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <Section theme={theme} title="Library">
          <Row
            theme={theme}
            label="Library location"
            value={booksBytes === null ? "…" : `Internal · ${formatBytes(booksBytes)}`}
            first
          />
          <Row theme={theme} label="Catalog source" value="local" />
          <Row
            theme={theme}
            label="Import books"
            onPress={importEpub}
            trailing={
              importing ? <ActivityIndicator color={theme.accent} /> : <Chev theme={theme} />
            }
          />
        </Section>

        <Section theme={theme} title="Reader">
          <Row
            theme={theme}
            label="Display defaults"
            value={`${capitalize(reader.theme)} · ${reader.fontSize}pt`}
            first
            showChev={false}
          />
          <Row
            theme={theme}
            label="App theme"
            value={capitalize(appTheme)}
            onPress={onPickTheme}
            valueColor={theme.accent}
          />
        </Section>

        <Section theme={theme} title="Reader fonts">
          {READER_FONT_CATEGORIES.map((category, index) => (
            <Row
              key={category.key}
              theme={theme}
              label={`${category.label} category`}
              subtitle={category.caption}
              value={getReaderFontLabel(reader.fontMap[category.key])}
              valueColor={theme.accent}
              onPress={() => setFontPickerCategory(category.key)}
              first={index === 0}
            />
          ))}
        </Section>

        <Section theme={theme} title="Reader formatting">
          <Row
            theme={theme}
            label="Justify text"
            toggle={reader.justify}
            onToggle={(v) => void patchReader({ justify: v })}
            first
            showChev={false}
          />
          <Row
            theme={theme}
            label="Hyphenate"
            toggle={reader.hyphenate}
            onToggle={(v) => void patchReader({ hyphenate: v })}
            showChev={false}
          />
          <Row
            theme={theme}
            label="Drop cap at chapter start"
            toggle={reader.dropCap}
            onToggle={(v) => void patchReader({ dropCap: v })}
            showChev={false}
          />
          <Row
            theme={theme}
            label="Scroll mode"
            toggle={reader.mode === "scroll"}
            onToggle={(v) => void patchReader({ mode: v ? "scroll" : "paginated" })}
            showChev={false}
          />
        </Section>

        <Section
          theme={theme}
          title={`Dictionaries · ${dictsHydrated ? `${dicts.length} installed` : "loading…"}`}
        >
          {orderedDicts.length === 0 ? (
            <Row
              theme={theme}
              label="No dictionaries installed"
              subtitle="Spine looks words up against JSON dictionaries you install"
              first
              showChev={false}
            />
          ) : (
            <>
              {orderedDicts.length > 1 ? (
                <View
                  style={{
                    paddingHorizontal: 20,
                    paddingTop: 12,
                    paddingBottom: 4,
                  }}
                >
                  <Text
                    style={{
                      color: theme.textFaint,
                      fontFamily: FONTS.mono,
                      fontSize: 9,
                      letterSpacing: 0.7,
                      textTransform: "uppercase",
                    }}
                  >
                    Lookup order — top entry returns first
                  </Text>
                </View>
              ) : null}
              {orderedDicts.map((d, idx) => (
                <View
                  key={d.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderTopColor: theme.borderSoft,
                    borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: theme.text,
                        fontFamily: FONTS.sans,
                        fontSize: 14,
                      }}
                    >
                      {idx + 1}. {d.name}
                    </Text>
                    <Text
                      style={{
                        color: theme.textDim,
                        fontFamily: FONTS.mono,
                        fontSize: 10,
                        marginTop: 2,
                      }}
                    >
                      {d.lang} · {d.entryCount.toLocaleString()} entries · {formatBytes(d.sizeBytes)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void moveDictPriority(d.id, "up")}
                    disabled={idx === 0}
                    hitSlop={8}
                    accessibilityLabel={`Move ${d.name} up`}
                    style={({ pressed }) => [
                      styles.reorderBtn,
                      {
                        opacity: idx === 0 ? 0.25 : pressed ? 0.5 : 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text style={[styles.reorderGlyph, { color: theme.text }]}>↑</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void moveDictPriority(d.id, "down")}
                    disabled={idx === orderedDicts.length - 1}
                    hitSlop={8}
                    accessibilityLabel={`Move ${d.name} down`}
                    style={({ pressed }) => [
                      styles.reorderBtn,
                      {
                        opacity:
                          idx === orderedDicts.length - 1 ? 0.25 : pressed ? 0.5 : 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text style={[styles.reorderGlyph, { color: theme.text }]}>↓</Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      Alert.alert(
                        "Remove dictionary?",
                        `Uninstall ${d.name}? The downloaded file will be deleted from this device.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Remove",
                            style: "destructive",
                            onPress: () => void uninstallDict(d.id),
                          },
                        ],
                      )
                    }
                    hitSlop={8}
                    accessibilityLabel={`Remove ${d.name}`}
                    style={({ pressed }) => [
                      styles.reorderBtn,
                      {
                        opacity: pressed ? 0.5 : 1,
                        borderColor: theme.alert,
                      },
                    ]}
                  >
                    <Text style={[styles.reorderGlyph, { color: theme.alert }]}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {CURATED_DICTIONARIES.filter(
            (c) => !dicts.some((d) => d.sourceUrl === c.url),
          ).map((c) => (
            <Row
              key={c.id}
              theme={theme}
              label={`${c.name} · ${c.era === "modern" ? "modern" : "classic"}`}
              subtitle={`${c.description}\n${c.license} · ~${c.approxSizeMb} MB`}
              onPress={() => {
                Alert.alert(
                  "Install dictionary?",
                  `${c.name}\n\nLicense: ${c.license}\nApprox ${c.approxSizeMb} MB\n\nFrom:\n${c.url}`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Install",
                      onPress: async () => {
                        try {
                          await installDict(c.url, { name: c.name, lang: c.lang });
                        } catch (e: unknown) {
                          const msg = e instanceof Error ? e.message : "Install failed";
                          Alert.alert("Install failed", msg);
                        }
                      },
                    },
                  ],
                );
              }}
              trailing={installingUrl === c.url ? <ActivityIndicator color={theme.accent} /> : undefined}
            />
          ))}
          <Row
            theme={theme}
            label="Add dictionary from URL"
            subtitle="Paste any compatible JSON URL (Spine native, Webster's-flat, or array format)"
            onPress={() => {
              setDictUrl("");
              setDictUrlModalOpen(true);
            }}
            trailing={
              installingDict &&
              installingUrl !== null &&
              !CURATED_DICTIONARIES.some((c) => c.url === installingUrl)
                ? <ActivityIndicator color={theme.accent} />
                : undefined
            }
          />
          <Row
            theme={theme}
            label="Dictionary formats"
            subtitle="Native Spine · Webster's flat ({word: def}) · array of {word, definition}"
            onPress={() => void Linking.openURL(`${GITHUB_URL}#dictionaries`)}
          />
        </Section>

        <Section theme={theme} title="Data">
          <Row
            theme={theme}
            label="Metadata database"
            value={metaBytes === null ? "…" : formatBytes(metaBytes)}
            first
            showChev={false}
          />
          <Row
            theme={theme}
            label="Cover cache"
            value={coverBytes === null ? "…" : formatBytes(coverBytes)}
            showChev={false}
          />
          <Row
            theme={theme}
            label="Dictionary cache"
            value={dictBytes === null ? "…" : formatBytes(dictBytes)}
            showChev={false}
          />
          <Row
            theme={theme}
            label="Export library"
            subtitle="JSON · flat metadata"
            onPress={onExport}
          />
          <Row
            theme={theme}
            label="Delete library on device"
            subtitle="Alpha reset · removes imported EPUBs and covers (keeps dictionaries)"
            danger
            onPress={() => setDeleteModalVisible(true)}
          />
        </Section>

        <Section theme={theme} title="Theme preview">
          <ThemeSwatchRow current={appTheme} onSelect={(t) => void setAppTheme(t)} />
        </Section>

        <Section theme={theme} title="About">
          <Row
            theme={theme}
            label="GitHub"
            value="thereprocase/spine"
            onPress={() => void Linking.openURL(GITHUB_URL)}
            first
          />
          <Row
            theme={theme}
            label="Version"
            value={`${version} · alpha`}
            showChev={false}
          />
          <Row
            theme={theme}
            label="Build"
            value="local · debug-signed"
            showChev={false}
          />
        </Section>

        <View style={{ paddingVertical: 28, alignItems: "center" }}>
          <Text
            style={{
              color: theme.textFaint,
              fontFamily: FONTS.mono,
              fontSize: 10,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            Spine · Built for BIBFRAME 2.0
          </Text>
        </View>
      </ScrollView>
      <Modal
        visible={deleteModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteModalVisible(false)}
      >
        <View style={styles.modalScrim}>
          <View
            style={[
              styles.confirmPanel,
              {
                backgroundColor: theme.panel,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.confirmTitle, { color: theme.alert }]}>
              Delete library
            </Text>
            <Text style={[styles.confirmBody, { color: theme.textMid }]}>
              Type “delete my library” below to unlock deletion. This wipes every imported book and cannot be undone.
            </Text>
            <TextInput
              value={deletePhrase}
              onChangeText={setDeletePhrase}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="delete my library"
              placeholderTextColor={theme.textFaint}
              style={[
                styles.confirmInput,
                {
                  color: theme.text,
                  borderColor: deletePhraseAccepted ? theme.accent : theme.border,
                  backgroundColor: theme.bg,
                },
              ]}
            />
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => {
                  setDeletePhrase("");
                  setDeleteModalVisible(false);
                }}
                style={[styles.confirmButton, { borderColor: theme.border }]}
              >
                <Text style={[styles.confirmButtonText, { color: theme.textMid }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={onDeleteLibrary}
                disabled={!deletePhraseAccepted || importing}
                style={[
                  styles.confirmButton,
                  {
                    borderColor: theme.alert,
                    backgroundColor: deletePhraseAccepted ? theme.alert : "transparent",
                    opacity: deletePhraseAccepted ? 1 : 0.45,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.confirmButtonText,
                    { color: deletePhraseAccepted ? "#fff" : theme.alert },
                  ]}
                >
                  Delete
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={dictUrlModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDictUrlModalOpen(false)}
      >
        <View style={styles.modalScrim}>
          <View
            style={[
              styles.confirmPanel,
              {
                backgroundColor: theme.panel,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.confirmTitle, { color: theme.text }]}>
              Add dictionary
            </Text>
            <Text style={[styles.confirmBody, { color: theme.textMid }]}>
              Paste a URL to a Spine dictionary JSON file. The download is verified before being installed; nothing is saved if the file isn’t a valid dictionary.
            </Text>
            <TextInput
              value={dictUrl}
              onChangeText={setDictUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://example.com/my-dictionary.json"
              placeholderTextColor={theme.textFaint}
              style={[
                styles.confirmInput,
                {
                  color: theme.text,
                  borderColor: theme.border,
                  backgroundColor: theme.bg,
                },
              ]}
            />
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => setDictUrlModalOpen(false)}
                disabled={installingDict}
                style={[
                  styles.confirmButton,
                  { borderColor: theme.border, opacity: installingDict ? 0.5 : 1 },
                ]}
              >
                <Text style={[styles.confirmButtonText, { color: theme.textMid }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const trimmed = dictUrl.trim();
                  if (!trimmed) return;
                  try {
                    await installDict(trimmed);
                    setDictUrlModalOpen(false);
                    setDictUrl("");
                  } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : "Install failed";
                    Alert.alert("Install failed", msg);
                  }
                }}
                disabled={installingDict || dictUrl.trim().length === 0}
                style={[
                  styles.confirmButton,
                  {
                    borderColor: theme.accent,
                    backgroundColor:
                      installingDict || dictUrl.trim().length === 0
                        ? "transparent"
                        : `${theme.accent}22`,
                    opacity: installingDict || dictUrl.trim().length === 0 ? 0.5 : 1,
                  },
                ]}
              >
                {installingDict ? (
                  <ActivityIndicator color={theme.accent} />
                ) : (
                  <Text style={[styles.confirmButtonText, { color: theme.accent }]}>
                    Install
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={fontPickerCategory !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFontPickerCategory(null)}
      >
        <View style={styles.modalScrim}>
          <View
            style={[
              styles.confirmPanel,
              {
                backgroundColor: theme.panel,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.confirmTitle, { color: theme.text }]}>
              {fontPickerCategory
                ? `${capitalize(fontPickerCategory)} font`
                : "Reader font"}
            </Text>
            <Text style={[styles.confirmBody, { color: theme.textMid }]}>
              {fontPickerCategory
                ? `Picks apply immediately. Tap a row to compare; tap Done when you're happy.`
                : "Choose the real font behind this in-book category."}
            </Text>
            <ScrollView style={{ maxHeight: 360, marginTop: 12 }}>
              {READER_FONT_OPTIONS.map((font) => {
                const active =
                  fontPickerCategory !== null &&
                  reader.fontMap[fontPickerCategory] === font.id;
                return (
                  <Pressable
                    key={font.id}
                    onPress={() => {
                      if (fontPickerCategory) onPickReaderFont(fontPickerCategory, font.id);
                    }}
                    style={[
                      styles.fontChoice,
                      {
                        borderColor: active ? theme.accent : theme.borderSoft,
                        backgroundColor: active ? `${theme.accent}18` : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color: active ? theme.accent : theme.text,
                        fontFamily: font.nativeFamily ?? FONTS.sans,
                        fontSize: 15,
                      }}
                    >
                      {font.label}
                    </Text>
                    <Text
                      style={{
                        color: theme.textDim,
                        fontFamily: FONTS.mono,
                        fontSize: 9,
                        marginTop: 3,
                        textTransform: "uppercase",
                      }}
                    >
                      {font.category}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => setFontPickerCategory(null)}
                style={[styles.confirmButton, { borderColor: theme.accent, backgroundColor: `${theme.accent}14` }]}
              >
                <Text style={[styles.confirmButtonText, { color: theme.accent }]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function isDeletePhraseAccepted(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  return /deletem(y|i)?librar(y|ie|i)/.test(normalized);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

interface SectionProps {
  theme: ReturnType<typeof useAppTheme>;
  title: string;
  children: React.ReactNode;
}

function Section({ theme, title, children }: SectionProps) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text
        style={{
          color: theme.textFaint,
          fontFamily: FONTS.mono,
          fontSize: 10,
          fontWeight: "600",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          paddingHorizontal: 20,
          paddingVertical: 8,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: theme.panel,
          borderTopColor: theme.border,
          borderBottomColor: theme.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
        }}
      >
        {children}
      </View>
    </View>
  );
}

interface RowProps {
  theme: ReturnType<typeof useAppTheme>;
  label: string;
  subtitle?: string;
  value?: string;
  valueColor?: string;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
  trailing?: React.ReactNode;
  showChev?: boolean;
  first?: boolean;
  danger?: boolean;
}

function Row({
  theme,
  label,
  subtitle,
  value,
  valueColor,
  toggle,
  onToggle,
  onPress,
  trailing,
  showChev = true,
  first,
  danger,
}: RowProps) {
  const inner = (
    <View
      style={[
        styles.row,
        {
          borderTopColor: theme.borderSoft,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: danger ? theme.alert : theme.text,
            fontFamily: FONTS.sans,
            fontSize: 14,
          }}
        >
          {label}
        </Text>
        {subtitle ? (
          <Text
            style={{
              color: theme.textDim,
              fontFamily: FONTS.mono,
              fontSize: 10,
              marginTop: 2,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value !== undefined ? (
        <Text
          style={{
            color: valueColor ?? theme.textDim,
            fontFamily: FONTS.mono,
            fontSize: 11,
            marginLeft: 12,
          }}
        >
          {value}
        </Text>
      ) : null}
      {trailing ? <View style={{ marginLeft: 12 }}>{trailing}</View> : null}
      {toggle !== undefined && onToggle ? (
        <Switch
          value={toggle}
          onValueChange={onToggle}
          trackColor={{ false: theme.border, true: theme.accent }}
          thumbColor={theme.inkInvert}
        />
      ) : null}
      {showChev && toggle === undefined && !trailing && onPress ? (
        <View style={{ marginLeft: 8 }}>
          <Chev theme={theme} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} android_ripple={{ color: theme.surface }}>
      {inner}
    </Pressable>
  );
}

function Chev({ theme }: { theme: ReturnType<typeof useAppTheme> }) {
  return (
    <Text
      style={{
        color: theme.textFaint,
        fontFamily: FONTS.sans,
        fontSize: 16,
        lineHeight: 16,
      }}
    >
      ›
    </Text>
  );
}

function ThemeSwatchRow({
  current,
  onSelect,
}: {
  current: ThemeName;
  onSelect: (t: ThemeName) => void;
}) {
  const opts = THEME_ORDER;
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: "row", padding: 14, gap: 10, flexWrap: "wrap" }}>
      {opts.map(({ key }) => {
        const swatch = SPINE_THEMES[key];
        const active = key === current;
        return (
          <Pressable
            key={key}
            onPress={() => onSelect(key)}
            style={{
              // 5 swatches don't fit in a single row at flex:1; use a
              // fixed minWidth so they wrap to a second row instead of
              // squashing the labels.
              minWidth: 88,
              flexGrow: 1,
              flexBasis: "30%",
              borderRadius: 3,
              overflow: "hidden",
              borderWidth: 2,
              borderColor: active ? theme.accent : theme.border,
            }}
          >
            <View
              style={{
                backgroundColor: swatch.readerBg,
                paddingVertical: 18,
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: swatch.readerInk,
                  fontFamily: FONTS.serif,
                  fontStyle: "italic",
                  fontSize: 17,
                  fontWeight: "600",
                }}
              >
                Aa
              </Text>
            </View>
            <View
              style={{
                paddingVertical: 6,
                alignItems: "center",
                backgroundColor: theme.panel,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: active ? theme.accent : theme.borderSoft,
              }}
            >
              <Text
                style={{
                  color: active ? theme.accent : theme.textMid,
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                  fontWeight: "500",
                }}
              >
                {capitalize(key)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
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
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  backChev: { fontSize: 28, lineHeight: 28, fontWeight: "300" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  confirmPanel: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  confirmTitle: {
    fontFamily: FONTS.serif,
    fontSize: 22,
    fontWeight: "600",
  },
  confirmBody: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  confirmInput: {
    minHeight: 48,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    paddingHorizontal: 12,
    fontFamily: FONTS.sans,
    fontSize: 15,
  },
  confirmActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 16,
  },
  confirmButton: {
    minHeight: 44,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
  },
  confirmButtonText: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    fontWeight: "600",
  },
  fontChoice: {
    minHeight: 54,
    justifyContent: "center",
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 8,
  },
  reorderBtn: {
    width: 36,
    height: 36,
    marginLeft: 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reorderGlyph: {
    fontFamily: FONTS.mono,
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 16,
  },
});
