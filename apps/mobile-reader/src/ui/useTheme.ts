import { usePrefs } from "../store/prefs";
import { SPINE_THEMES, type Theme } from "../themes";

export function useAppTheme(): Theme {
  const name = usePrefs((s) => s.appTheme);
  return SPINE_THEMES[name];
}

export function useReaderTheme(): Theme {
  const name = usePrefs((s) => s.reader.theme);
  return SPINE_THEMES[name];
}
