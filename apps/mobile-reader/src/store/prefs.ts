// User preferences (theme + reader settings). Persists to AsyncStorage under
// SPINE_PREFS_KEY. Reader settings include theme, font family, font size,
// pagination mode, justify, hyphenate, drop-cap.

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  DEFAULT_READER_FONT_MAP,
  normalizeReaderFontCategory,
  normalizeReaderFontMap,
  type ReaderFontCategory,
  type ReaderFontId,
} from "../reader/fonts";
import { SPINE_PREFS_KEY } from "../storage";
import { DEFAULT_THEME, READER_DEFAULT_THEME, type ThemeName } from "../themes";
import type { HighlightColor } from "../types";

export type ReaderFontFamily = ReaderFontCategory;
export type ReaderMode = "paginated" | "scroll";

export interface ReaderSettings {
  theme: ThemeName;
  fontFamily: ReaderFontFamily;
  fontMap: Record<ReaderFontCategory, ReaderFontId>;
  /** Font size in CSS pt; mockup default = 17. */
  fontSize: number;
  mode: ReaderMode;
  justify: boolean;
  hyphenate: boolean;
  dropCap: boolean;
  /** CSS line-height (unitless). */
  lineHeight: number;
  /**
   * In-app brightness 0..1. Implemented as a black overlay on top of the
   * reader (we don't change the system backlight — that needs a native
   * module). 1.0 = no overlay; 0.3 = heavy dim, good for late-night reading.
   */
  brightness: number;
  /**
   * Color-temperature warmth 0..1. 0 = no tint, 1 = full amber/sepia
   * filter. Implemented as a low-opacity warm overlay on top of the
   * reader, so it composes with brightness rather than replacing it.
   */
  warmth: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: READER_DEFAULT_THEME,
  fontFamily: "book",
  fontMap: DEFAULT_READER_FONT_MAP,
  fontSize: 17,
  mode: "paginated",
  justify: true,
  hyphenate: true,
  dropCap: true,
  lineHeight: 1.6,
  brightness: 1.0,
  warmth: 0,
};

interface PrefsState {
  hydrated: boolean;
  appTheme: ThemeName;
  reader: ReaderSettings;
  /** The color the user picked last for a highlight. Design spec:
   * "the last used IS the setting." Tapping the Highlight button
   * (without opening the picker) applies this color. Defaults to
   * yellow because every paper book the user has ever highlighted
   * was yellow. */
  lastHighlightColor: HighlightColor;
  hydrate: () => Promise<void>;
  setAppTheme: (t: ThemeName) => Promise<void>;
  patchReader: (patch: Partial<ReaderSettings>) => Promise<void>;
  setLastHighlightColor: (color: HighlightColor) => Promise<void>;
}

interface PersistShape {
  appTheme?: ThemeName;
  reader?: Partial<ReaderSettings>;
  lastHighlightColor?: HighlightColor;
}

const VALID_HIGHLIGHT_COLORS: HighlightColor[] = [
  "yellow",
  "pink",
  "green",
  "blue",
  "orange",
];

function normalizeHighlightColor(c: unknown): HighlightColor {
  return typeof c === "string" && (VALID_HIGHLIGHT_COLORS as string[]).includes(c)
    ? (c as HighlightColor)
    : "yellow";
}

async function persist(state: PersistShape): Promise<void> {
  await AsyncStorage.setItem(SPINE_PREFS_KEY, JSON.stringify(state));
}

// Clamp helpers — defensive for hand-edited or schema-migrated
// AsyncStorage values. A persisted fontSize:999 used to pass through
// to the WebView CSS injection unchecked.
function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(min, Math.min(max, v))
    : fallback;
}

function normalizeReaderSettings(reader?: Partial<ReaderSettings>): ReaderSettings {
  const merged = { ...DEFAULT_READER_SETTINGS, ...(reader ?? {}) };
  // Validate mode against the known enum — a corrupted "broken" string
  // would otherwise pass through and the bootstrap would silently fall
  // back to paginated, but the preference UI would show a mismatched
  // state.
  const mode: "paginated" | "scroll" =
    merged.mode === "paginated" || merged.mode === "scroll"
      ? merged.mode
      : DEFAULT_READER_SETTINGS.mode;
  return {
    ...merged,
    fontFamily: normalizeReaderFontCategory(reader?.fontFamily),
    fontMap: normalizeReaderFontMap(reader?.fontMap),
    fontSize: clampNumber(merged.fontSize, 8, 28, DEFAULT_READER_SETTINGS.fontSize),
    lineHeight: clampNumber(merged.lineHeight, 1.0, 2.4, DEFAULT_READER_SETTINGS.lineHeight),
    brightness: clampNumber(merged.brightness, 0.15, 1, DEFAULT_READER_SETTINGS.brightness),
    warmth: clampNumber(merged.warmth, 0, 1, DEFAULT_READER_SETTINGS.warmth),
    mode,
    justify: typeof merged.justify === "boolean" ? merged.justify : DEFAULT_READER_SETTINGS.justify,
    hyphenate: typeof merged.hyphenate === "boolean" ? merged.hyphenate : DEFAULT_READER_SETTINGS.hyphenate,
    dropCap: typeof merged.dropCap === "boolean" ? merged.dropCap : DEFAULT_READER_SETTINGS.dropCap,
  };
}

export const usePrefs = create<PrefsState>((set, get) => ({
  hydrated: false,
  appTheme: DEFAULT_THEME,
  reader: DEFAULT_READER_SETTINGS,
  lastHighlightColor: "yellow",

  hydrate: async () => {
    if (get().hydrated) return;
    const raw = await AsyncStorage.getItem(SPINE_PREFS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistShape;
        set({
          appTheme: parsed.appTheme ?? DEFAULT_THEME,
          reader: normalizeReaderSettings(parsed.reader),
          lastHighlightColor: normalizeHighlightColor(parsed.lastHighlightColor),
        });
      } catch {
        // ignore — keep defaults
      }
    }
    set({ hydrated: true });
  },

  setAppTheme: async (t) => {
    set({ appTheme: t });
    await persist({
      appTheme: t,
      reader: get().reader,
      lastHighlightColor: get().lastHighlightColor,
    });
  },

  patchReader: async (patch) => {
    const next = normalizeReaderSettings({ ...get().reader, ...patch });
    set({ reader: next });
    await persist({
      appTheme: get().appTheme,
      reader: next,
      lastHighlightColor: get().lastHighlightColor,
    });
  },

  setLastHighlightColor: async (color) => {
    const c = normalizeHighlightColor(color);
    set({ lastHighlightColor: c });
    await persist({
      appTheme: get().appTheme,
      reader: get().reader,
      lastHighlightColor: c,
    });
  },
}));
