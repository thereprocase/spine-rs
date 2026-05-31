// Zustand store fronting src/dictionaries.ts. Components subscribe to
// the meta list; install/uninstall write through to disk + state.

import { create } from "zustand";

import {
  type DictionaryHit,
  type DictionaryMeta,
  installFromUrl as installFromUrlMod,
  loadDictionaries,
  lookup as lookupMod,
  reorderDictionaries as reorderMod,
  uninstall as uninstallMod,
} from "../dictionaries";

interface DictionariesState {
  hydrated: boolean;
  /** True iff an install is in flight. Used by the URL modal to
   * disable buttons + show the in-modal spinner. */
  installing: boolean;
  /** URL of the install currently in flight, or null. Lets the
   * Settings list show the activity spinner ONLY on the row that's
   * actually downloading instead of on every curated entry. */
  installingUrl: string | null;
  dicts: DictionaryMeta[];
  hydrate: () => Promise<void>;
  installFromUrl: (
    url: string,
    hint?: { name?: string; lang?: string },
  ) => Promise<DictionaryMeta>;
  uninstall: (id: string) => Promise<void>;
  /** Move the dict at `id` up or down by one slot in priority order.
   * No-op if already at the boundary. */
  movePriority: (id: string, direction: "up" | "down") => Promise<void>;
  lookup: (word: string) => Promise<DictionaryHit[]>;
}

// Single-flight queue for install/uninstall. Two parallel installs of
// the same URL would both claim the same canonical filename via
// uniqueFilename's racey readDir → set check, then both rename atop
// each other. Serialise.
let queue: Promise<unknown> = Promise.resolve();

export const useDictionaries = create<DictionariesState>((set, get) => ({
  hydrated: false,
  installing: false,
  installingUrl: null,
  dicts: [],

  hydrate: async () => {
    if (get().hydrated) return;
    const dicts = await loadDictionaries();
    set({ dicts, hydrated: true });
  },

  installFromUrl: async (url, hint) => {
    set({ installing: true, installingUrl: url });
    const tail: Promise<DictionaryMeta> = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          const meta = await installFromUrlMod(url, hint);
          // Re-read from disk so we don't fork the source of truth on
          // a concurrent uninstall that landed mid-install (unlikely
          // but cheap to guard).
          const fresh = await loadDictionaries();
          set({ dicts: fresh, installing: false, installingUrl: null });
          return meta;
        } catch (e) {
          set({ installing: false, installingUrl: null });
          throw e;
        }
      });
    queue = tail.catch(() => undefined);
    return tail;
  },

  uninstall: async (id) => {
    const tail = queue
      .catch(() => undefined)
      .then(async () => {
        await uninstallMod(id);
        const fresh = await loadDictionaries();
        set({ dicts: fresh });
      });
    queue = tail;
    return tail;
  },

  movePriority: async (id, direction) => {
    const tail = queue
      .catch(() => undefined)
      .then(async () => {
        const sorted = [...get().dicts].sort((a, b) => a.priority - b.priority);
        const idx = sorted.findIndex((d) => d.id === id);
        if (idx < 0) return;
        const swapWith = direction === "up" ? idx - 1 : idx + 1;
        if (swapWith < 0 || swapWith >= sorted.length) return;
        const next = [...sorted];
        const tmp = next[idx]!;
        next[idx] = next[swapWith]!;
        next[swapWith] = tmp;
        await reorderMod(next.map((d) => d.id));
        const fresh = await loadDictionaries();
        set({ dicts: fresh });
      });
    queue = tail;
    return tail;
  },

  lookup: async (word) => {
    return lookupMod(word, get().dicts);
  },
}));
