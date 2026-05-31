// File-system + AsyncStorage usage statistics for the Settings screen.

import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { BOOKS_DIR, COVERS_DIR } from "../storage";

/** Recursive byte total under a directory. Returns 0 if missing. Stat calls
 * within a directory are issued in parallel so a 100-file library doesn't
 * serialize 100 JSI bridge crossings. */
export async function dirSize(path: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return 0;
  if (!info.isDirectory) {
    const size = (info as { size?: number }).size;
    return typeof size === "number" ? size : 0;
  }
  const entries = await FileSystem.readDirectoryAsync(path);
  const sep = path.endsWith("/") ? "" : "/";
  // allSettled instead of all — a file deleted between readDirectory
  // and getInfoAsync (concurrent delete from another code path) used
  // to fail the whole walk and return 0 for the entire library.
  const results = await Promise.allSettled(
    entries.map((name) => dirSize(`${path}${sep}${name}`)),
  );
  return results.reduce(
    (a, r) => a + (r.status === "fulfilled" ? r.value : 0),
    0,
  );
}

/** Sum of all string lengths stored under AsyncStorage. Approximate. */
export async function asyncStorageBytes(): Promise<number> {
  const keys = await AsyncStorage.getAllKeys();
  if (keys.length === 0) return 0;
  const pairs = await AsyncStorage.multiGet(keys);
  let total = 0;
  for (const pair of pairs) {
    const value = pair[1];
    if (value) total += value.length;
  }
  return total;
}

export async function libraryUsage(): Promise<number> {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) return 0;
  return dirSize(docDir);
}

export async function booksUsage(): Promise<number> {
  return dirSize(BOOKS_DIR);
}

export async function coversUsage(): Promise<number> {
  return dirSize(COVERS_DIR);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
