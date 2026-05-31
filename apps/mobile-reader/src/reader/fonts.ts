export type ReaderFontCategory = "book" | "clear" | "code";

export type ReaderFontId =
  | "systemSerif"
  | "systemSans"
  | "systemMono"
  | "atkinsonHyperlegible"
  | "firaCodeNerd"
  | "hackNerd"
  | "mesloNerd"
  | "mononokiNerd"
  | "robotoMonoNerd"
  | "ubuntuMonoNerd"
  | "victorMonoNerd";

export interface ReaderFontOption {
  id: ReaderFontId;
  label: string;
  category: ReaderFontCategory;
  cssFamily: string;
  assetFile?: string;
  nativeFamily?: string;
}

export const READER_FONT_CATEGORIES: Array<{
  key: ReaderFontCategory;
  label: string;
  caption: string;
}> = [
  { key: "book", label: "Book", caption: "serif / literary" },
  { key: "clear", label: "Clear", caption: "accessible sans" },
  { key: "code", label: "Code", caption: "mono / technical" },
];

export const READER_FONT_OPTIONS: ReaderFontOption[] = [
  {
    id: "systemSerif",
    label: "System Serif",
    category: "book",
    cssFamily:
      'Georgia, "Iowan Old Style", "Apple Garamond", "Times New Roman", serif',
  },
  {
    id: "systemSans",
    label: "System Sans",
    category: "clear",
    cssFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
  {
    id: "systemMono",
    label: "System Mono",
    category: "code",
    cssFamily: '"SF Mono", Menlo, Consolas, "Courier New", monospace',
  },
  {
    id: "atkinsonHyperlegible",
    label: "Atkinson Hyperlegible",
    category: "clear",
    cssFamily: '"Spine Atkinson Hyperlegible", system-ui, sans-serif',
    nativeFamily: "Spine Atkinson Hyperlegible",
    assetFile: "AtkinsonHyperlegible-Regular.ttf",
  },
  {
    id: "firaCodeNerd",
    label: "FiraCode Nerd",
    category: "code",
    cssFamily: '"Spine FiraCode Nerd", "SF Mono", monospace',
    nativeFamily: "Spine FiraCode Nerd",
    assetFile: "FiraCodeNerdFont-Regular.ttf",
  },
  {
    id: "hackNerd",
    label: "Hack Nerd",
    category: "code",
    cssFamily: '"Spine Hack Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Hack Nerd",
    assetFile: "HackNerdFont-Regular.ttf",
  },
  {
    id: "mesloNerd",
    label: "Meslo Nerd",
    category: "code",
    cssFamily: '"Spine Meslo Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Meslo Nerd",
    assetFile: "MesloLGNerdFont-Regular.ttf",
  },
  {
    id: "mononokiNerd",
    label: "Mononoki Nerd",
    category: "code",
    cssFamily: '"Spine Mononoki Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Mononoki Nerd",
    assetFile: "MononokiNerdFont-Regular.ttf",
  },
  {
    id: "robotoMonoNerd",
    label: "Roboto Mono Nerd",
    category: "code",
    cssFamily: '"Spine Roboto Mono Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Roboto Mono Nerd",
    assetFile: "RobotoMonoNerdFont-Regular.ttf",
  },
  {
    id: "ubuntuMonoNerd",
    label: "Ubuntu Mono Nerd",
    category: "code",
    cssFamily: '"Spine Ubuntu Mono Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Ubuntu Mono Nerd",
    assetFile: "UbuntuMonoNerdFont-Regular.ttf",
  },
  {
    id: "victorMonoNerd",
    label: "Victor Mono Nerd",
    category: "code",
    cssFamily: '"Spine Victor Mono Nerd", "SF Mono", monospace',
    nativeFamily: "Spine Victor Mono Nerd",
    assetFile: "VictorMonoNerdFont-Regular.ttf",
  },
];

export const DEFAULT_READER_FONT_MAP: Record<ReaderFontCategory, ReaderFontId> = {
  book: "systemSerif",
  clear: "atkinsonHyperlegible",
  code: "firaCodeNerd",
};

const FONT_BY_ID = new Map(READER_FONT_OPTIONS.map((font) => [font.id, font]));

export function getReaderFont(id: ReaderFontId | string | undefined): ReaderFontOption {
  return FONT_BY_ID.get(id as ReaderFontId) ?? FONT_BY_ID.get("systemSerif")!;
}

export function getReaderFontLabel(id: ReaderFontId | string | undefined): string {
  return getReaderFont(id).label;
}

export function getReaderFontCssFamily(id: ReaderFontId | string | undefined): string {
  return getReaderFont(id).cssFamily;
}

export function readerFontForCategory(
  category: ReaderFontCategory,
  fontMap: Partial<Record<ReaderFontCategory, ReaderFontId>> | undefined,
): ReaderFontOption {
  return getReaderFont(fontMap?.[category] ?? DEFAULT_READER_FONT_MAP[category]);
}

export function normalizeReaderFontCategory(value: unknown): ReaderFontCategory {
  if (value === "book" || value === "clear" || value === "code") return value;
  if (value === "sans") return "clear";
  if (value === "mono") return "code";
  return "book";
}

export function normalizeReaderFontMap(
  value: unknown,
): Record<ReaderFontCategory, ReaderFontId> {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<Record<ReaderFontCategory, ReaderFontId>>)
      : {};
  return {
    book: FONT_BY_ID.has(raw.book as ReaderFontId) ? raw.book! : DEFAULT_READER_FONT_MAP.book,
    clear: FONT_BY_ID.has(raw.clear as ReaderFontId) ? raw.clear! : DEFAULT_READER_FONT_MAP.clear,
    code: FONT_BY_ID.has(raw.code as ReaderFontId) ? raw.code! : DEFAULT_READER_FONT_MAP.code,
  };
}

export const READER_NATIVE_FONT_SOURCES = {
  "Spine Atkinson Hyperlegible": require("../../assets/fonts/AtkinsonHyperlegible-Regular.ttf"),
  "Spine FiraCode Nerd": require("../../assets/fonts/FiraCodeNerdFont-Regular.ttf"),
  "Spine Hack Nerd": require("../../assets/fonts/HackNerdFont-Regular.ttf"),
  "Spine Meslo Nerd": require("../../assets/fonts/MesloLGNerdFont-Regular.ttf"),
  "Spine Mononoki Nerd": require("../../assets/fonts/MononokiNerdFont-Regular.ttf"),
  "Spine Roboto Mono Nerd": require("../../assets/fonts/RobotoMonoNerdFont-Regular.ttf"),
  "Spine Ubuntu Mono Nerd": require("../../assets/fonts/UbuntuMonoNerdFont-Regular.ttf"),
  "Spine Victor Mono Nerd": require("../../assets/fonts/VictorMonoNerdFont-Regular.ttf"),
} as const;
