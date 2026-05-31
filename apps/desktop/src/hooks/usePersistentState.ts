import { useCallback, useState } from "react";

// useState + localStorage. Reads on mount, writes on every set.
// JSON.parse failures and quota-exceeded writes are swallowed — a user
// who's wiped localStorage mid-session should still see a working UI
// rather than a crash loop.
export function usePersistentState<T>(
  key: string,
  initialValue: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // malformed JSON or access denied (private-mode quirks) — fall through
    }
    return initialValue;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // quota or access denied — state still updates, just doesn't persist
      }
    },
    [key],
  );

  return [value, set];
}
