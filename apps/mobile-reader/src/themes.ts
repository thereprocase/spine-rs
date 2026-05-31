// Theme tokens extracted verbatim from
// internal design notes (spine-mobile-tokens.jsx)
// Three themes: dark (default, matches desktop), light (warm paper), sepia (e-ink).
//
// Reader-specific tokens (readerBg/Ink/Dim/Rule) drive the in-WebView reader CSS.

export type ThemeName =
  | "dark"
  | "light"
  | "sepia"
  | "noir"
  | "stark"
  | "midnight";

export interface Theme {
  name: ThemeName;
  bg: string;
  panel: string;
  canvas: string;
  canvasAlt: string;
  surface: string;
  surfaceHi: string;
  border: string;
  borderSoft: string;
  borderHi: string;
  text: string;
  textMid: string;
  textDim: string;
  textFaint: string;
  inkInvert: string;
  accent: string;
  accentHi: string;
  accentDim: string;
  oxblood: string;
  ok: string;
  warn: string;
  alert: string;
  link: string;
  statusDark: boolean;
  readerBg: string;
  readerInk: string;
  readerDim: string;
  readerRule: string;
}

export const SPINE_THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    bg: "#17171a",
    panel: "#1e1e22",
    canvas: "#232328",
    canvasAlt: "#1a1a1e",
    surface: "#2a2a30",
    surfaceHi: "#34343b",
    border: "#34343b",
    borderSoft: "#2a2a30",
    borderHi: "#45454d",
    text: "#ebeae7",
    textMid: "#b0afac",
    textDim: "#7c7b77",
    textFaint: "#5a5955",
    inkInvert: "#17171a",
    accent: "#c8a15a",
    accentHi: "#e4b84f",
    accentDim: "#6b5430",
    oxblood: "#a83040",
    ok: "#8ab07a",
    warn: "#d4a85a",
    alert: "#d07060",
    link: "#94b0c4",
    statusDark: false,
    readerBg: "#1a1a1c",
    readerInk: "#d8d6d2",
    readerDim: "#7f7e7a",
    readerRule: "#2a2a2e",
  },
  light: {
    name: "light",
    bg: "#ebe8e1",
    panel: "#f3f0e8",
    canvas: "#e6e2d8",
    canvasAlt: "#efebe1",
    surface: "#dcd7ca",
    surfaceHi: "#cec8b8",
    border: "#cec8b8",
    borderSoft: "#dcd7ca",
    borderHi: "#a8a292",
    text: "#23211c",
    textMid: "#55524a",
    textDim: "#7a766c",
    textFaint: "#a29d90",
    inkInvert: "#f3f0e8",
    accent: "#8a6a2e",
    accentHi: "#a8802d",
    accentDim: "#d9c9a8",
    oxblood: "#8a2838",
    ok: "#55782f",
    warn: "#a87a1a",
    alert: "#a83a28",
    link: "#3d5a78",
    statusDark: true,
    readerBg: "#ece8de",
    readerInk: "#2a2720",
    readerDim: "#7a756a",
    readerRule: "#d4ceba",
  },
  sepia: {
    name: "sepia",
    bg: "#e5d6b8",
    panel: "#eddfc3",
    canvas: "#e1d0ad",
    canvasAlt: "#e9dab8",
    surface: "#d8c69e",
    surfaceHi: "#cfbb8e",
    border: "#cfbb8e",
    borderSoft: "#d8c69e",
    borderHi: "#a89469",
    text: "#3a2e1e",
    textMid: "#5e4d33",
    textDim: "#7f6a4a",
    textFaint: "#a08a66",
    inkInvert: "#eddfc3",
    accent: "#7a5a1e",
    accentHi: "#a8802d",
    accentDim: "#c9a969",
    oxblood: "#8a2838",
    ok: "#4a6823",
    warn: "#96701a",
    alert: "#a3341e",
    link: "#3e5a74",
    statusDark: true,
    readerBg: "#e5d6b8",
    readerInk: "#2e2514",
    readerDim: "#7a6a48",
    readerRule: "#c8b687",
  },
  // True #000000 background for AMOLED — pixels are off, battery loves it.
  // Amber ink for the "gold-leaf hardback at 3am" aesthetic. Pairs well
  // with high warmth.
  noir: {
    name: "noir",
    bg: "#000000",
    panel: "#0a0a0c",
    canvas: "#0d0d10",
    canvasAlt: "#000000",
    surface: "#15151a",
    surfaceHi: "#1f1f25",
    border: "#1f1f25",
    borderSoft: "#15151a",
    borderHi: "#2e2e36",
    text: "#f0e7c8",
    textMid: "#bfae7c",
    textDim: "#86764e",
    textFaint: "#5d5237",
    inkInvert: "#000000",
    accent: "#e6b84f",
    accentHi: "#f7cf6a",
    accentDim: "#7a5e2a",
    oxblood: "#9c2030",
    ok: "#92ae6f",
    warn: "#e0b258",
    alert: "#d96448",
    link: "#a7c0d2",
    statusDark: false,
    readerBg: "#000000",
    readerInk: "#e6c07b",
    readerDim: "#86724a",
    readerRule: "#1c1812",
  },
  // Cool counterpart to all the warm/gold themes. Deep desaturated
  // navy (no green tint) with steel-blue ink and a frosted-pewter
  // accent. The mood is "library at midnight, lamp off, moon coming
  // through the window." Pairs poorly with high warmth — leave it at
  // 0 for the intended look.
  midnight: {
    name: "midnight",
    bg: "#0e151c",
    panel: "#13202c",
    canvas: "#162534",
    canvasAlt: "#0f1820",
    surface: "#1c2c3c",
    surfaceHi: "#243648",
    border: "#243648",
    borderSoft: "#1c2c3c",
    borderHi: "#365066",
    text: "#dde6ef",
    textMid: "#a3b3c4",
    textDim: "#6f8094",
    textFaint: "#4d5d70",
    inkInvert: "#0e151c",
    accent: "#7aa3c4",
    accentHi: "#a0c2dd",
    accentDim: "#3a5a78",
    oxblood: "#a44a5c",
    ok: "#7ea884",
    warn: "#c4a268",
    alert: "#cc6e6e",
    link: "#9bbed8",
    statusDark: false,
    readerBg: "#0e151c",
    readerInk: "#c8d3df",
    readerDim: "#6e8094",
    readerRule: "#1f2e3e",
  },
  // Pure white on pure black — AMOLED daylight mode. Bright-environment
  // high-contrast reading (subway, beach, sun-glare). No tint, no warmth.
  stark: {
    name: "stark",
    bg: "#000000",
    panel: "#0a0a0a",
    canvas: "#0d0d0d",
    canvasAlt: "#000000",
    surface: "#161616",
    surfaceHi: "#202020",
    border: "#202020",
    borderSoft: "#161616",
    borderHi: "#303030",
    text: "#ffffff",
    textMid: "#cccccc",
    textDim: "#888888",
    textFaint: "#5a5a5a",
    inkInvert: "#000000",
    accent: "#ffffff",
    accentHi: "#ffffff",
    accentDim: "#888888",
    oxblood: "#cc3344",
    ok: "#88dd88",
    warn: "#ddcc66",
    alert: "#ff5544",
    link: "#88aaff",
    statusDark: false,
    readerBg: "#000000",
    readerInk: "#ffffff",
    readerDim: "#888888",
    readerRule: "#202020",
  },
};

export const DEFAULT_THEME: ThemeName = "dark";
export const READER_DEFAULT_THEME: ThemeName = "sepia";

/** Single source of truth for theme display order in BOTH the app
 * theme picker (settings.tsx) and the reader theme picker
 * (ReaderSettingsSheet.tsx). Previously each list hard-coded its own
 * subset (settings shipped 3, reader shipped 5) and "noir"/"stark"
 * were silently invisible from the global app theme picker for two
 * versions, even though they were valid `ThemeName`s and the WebView
 * reader honored them. Edit here to change in both places. */
export const THEME_ORDER: ReadonlyArray<{ key: ThemeName; label: string }> = [
  { key: "dark", label: "Dark" },
  { key: "sepia", label: "Sepia" },
  { key: "light", label: "Light" },
  { key: "midnight", label: "Midnight" },
  { key: "noir", label: "Noir" },
  { key: "stark", label: "Stark" },
];

// Type families used in mockups. We embed system fallbacks; the alpha does not
// bundle webfonts (Source Serif 4 / Geist) — that lands when we wire expo-font.
export const FONTS = {
  serif:
    'Georgia, "Source Serif 4", "Iowan Old Style", "Apple Garamond", "Times New Roman", serif',
  sans: '"Inter", "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"SF Mono", "Geist Mono", Menlo, Consolas, "Courier New", monospace',
} as const;
