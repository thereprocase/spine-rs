// Offline dictionaries — downloaded JSON blobs the user installs from
// Settings → Dictionaries. Kept out of the APK on purpose: a single
// English dictionary can run 30+ MB, and most readers want at most
// one or two languages. Each install is a single .json file under
// documentDirectory/dictionaries/ with the meta record persisted in
// AsyncStorage. Lookups fan out across every installed dict in the
// order they were installed (first-installed wins ties when shown).
//
// File format (UTF-8 JSON):
//   {
//     "name": "Webster's GCIDE — abridged",
//     "lang": "en",
//     "version": "1.0",
//     "entries": {
//       "abandon": "to give up entirely; relinquish",
//       "abandoned": ["forsaken", "given up to vice"]
//     }
//   }
//
// Headwords are matched lower-case. Definition values may be a string
// or an array of strings (one per sense). Anything else is dropped.

import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";

interface NativeZipEntry {
  entryName: string;
  displayName: string;
  size: number;
}

interface SpineZipModule {
  listEntries(zipPath: string): Promise<NativeZipEntry[]>;
  extractEntry(zipPath: string, entryName: string, destPath: string): Promise<number>;
  deleteFile(path: string): Promise<boolean>;
}

const SpineZip = NativeModules.SpineZip as SpineZipModule | undefined;

export const SPINE_DICTIONARIES_KEY = "spine.dictionaries.v1";
export const DICTIONARIES_DIR = `${FileSystem.documentDirectory}dictionaries/`;

const FS_ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;

export interface DictionaryMeta {
  /** uuid v4, lives in AsyncStorage. */
  id: string;
  /** Display name pulled from the dictionary's "name" field, or
   * derived from the URL/filename if the JSON didn't carry one. */
  name: string;
  /** BCP-47 / ISO 639 language tag from the source, or "und" if unknown. */
  lang: string;
  /** Filename inside DICTIONARIES_DIR (stem + .json). Kept stable
   * across renames so the installed-meta pointer never goes stale. */
  filename: string;
  /** Source URL the user pasted, kept for "where did this come from"
   * UX in Settings. Null for files added by other means in future. */
  sourceUrl: string | null;
  /** Author-declared schema version from the file ("version" field). */
  version: string | null;
  /** Number of headwords. Cached at install so the Settings row can
   * show "12,847 entries" without re-reading the file. */
  entryCount: number;
  /** Filesize in bytes — for the Settings size column and the
   * Dictionaries data-line summary. */
  sizeBytes: number;
  /** ISO date string of install. */
  addedAt: string;
  /** Sort key — lookup iterates in ascending order, so a smaller
   * priority means "results from this dict appear first in the
   * Look up sheet". Reorderable by the user in Settings. New
   * installs land at max(priority)+1, so the Webster's already on
   * disk stays where it is when a modern dict is added later.
   * Older records without this field migrate to addedAt order. */
  priority: number;
  schemaVersion: 1;
}

export interface DictionaryHit {
  meta: DictionaryMeta;
  headword: string;
  /** One-or-many definitions. Always normalised to an array on read so
   * the sheet doesn't have to handle the union. */
  definitions: string[];
}

function uuidv4(): string {
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else if (i === 19) s += ((Math.random() * 4) | 0 | 8).toString(16);
    else s += ((Math.random() * 16) | 0).toString(16);
  }
  return s;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DICTIONARIES_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DICTIONARIES_DIR, { intermediates: true });
  }
}

function dictPath(filename: string): string {
  return `${DICTIONARIES_DIR}${filename}`;
}

function isMeta(v: unknown): v is DictionaryMeta {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.filename === "string" &&
    r.schemaVersion === 1
  );
}

export async function loadDictionaries(): Promise<DictionaryMeta[]> {
  const raw = await AsyncStorage.getItem(SPINE_DICTIONARIES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isMeta);
    // Migrate older records that pre-date `priority`. Use install
    // order so the existing list keeps its visual order on first
    // load after the upgrade. Re-stamps in memory; the next save
    // (any install/uninstall/reorder) writes them through.
    let nextPriority = 0;
    return valid.map((m) => {
      if (typeof m.priority !== "number" || !Number.isFinite(m.priority)) {
        const out = { ...m, priority: nextPriority };
        nextPriority += 1;
        return out;
      }
      nextPriority = Math.max(nextPriority, m.priority + 1);
      return m;
    });
  } catch {
    return [];
  }
}

export async function saveDictionaries(dicts: DictionaryMeta[]): Promise<void> {
  await AsyncStorage.setItem(SPINE_DICTIONARIES_KEY, JSON.stringify(dicts));
}

interface ParsedFile {
  name?: string;
  lang?: string;
  version?: string;
  entries: Record<string, unknown>;
}

// Normalised payload after the install-time format adapter runs. Lookups
// only ever see the Spine native format because we re-serialise to it
// on install — no per-format branches in the hot lookup path.
interface NormalisedDict {
  name?: string;
  lang?: string;
  version?: string;
  entries: Record<string, string | string[]>;
}

function looksLikeNativeDict(parsed: unknown): parsed is ParsedFile {
  if (!parsed || typeof parsed !== "object") return false;
  const r = parsed as Record<string, unknown>;
  if (!r.entries || typeof r.entries !== "object") return false;
  return true;
}

/** Adapter for whatever shape the downloaded JSON arrived in. We accept:
 *
 *   1. Spine native — { name?, lang?, version?, entries: { word: def | def[] } }
 *   2. Webster's flat — { word: definition, … } (matthewreagan, adambom,
 *      and most public-domain Webster's 1913 mirrors). Detected when the
 *      object has NO `entries` key but every value is a string.
 *   3. Array of records — [{word, definition}, …]
 *
 * Throws with a human-readable reason on shape mismatch — surfaced in
 * the install modal so the user knows why a paste failed. */
function normaliseDict(parsed: unknown): NormalisedDict {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Not a JSON object or array");
  }

  // Format 3 — array of {word, definition} records.
  if (Array.isArray(parsed)) {
    const entries: Record<string, string | string[]> = {};
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const word = typeof r.word === "string" ? r.word : null;
      if (!word) continue;
      const defField = r.definition ?? r.def ?? r.meaning;
      if (typeof defField === "string") {
        entries[word] = defField;
      } else if (Array.isArray(defField)) {
        const defs = defField.filter((v): v is string => typeof v === "string");
        if (defs.length > 0) entries[word] = defs;
      }
    }
    if (Object.keys(entries).length === 0) {
      throw new Error("Array has no {word, definition} records");
    }
    return { entries };
  }

  // Format 1 — native Spine format.
  if (looksLikeNativeDict(parsed)) {
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      lang: typeof parsed.lang === "string" ? parsed.lang : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      entries: parsed.entries as Record<string, string | string[]>,
    };
  }

  // Format 2 — Webster's-style flat object. Detect by sampling: if the
  // top-level has no `entries` key but at least 80% of its values are
  // strings (definitions), treat the whole thing as the entries map.
  // Sample size of 50 keeps this O(1) regardless of dictionary size.
  const r = parsed as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length === 0) {
    throw new Error("JSON object is empty");
  }
  // Cap at 50 to avoid scanning a 100k-entry dict twice.
  const sample = keys.slice(0, Math.min(50, keys.length));
  let stringHits = 0;
  for (const key of sample) {
    const v = r[key];
    if (typeof v === "string") stringHits += 1;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) stringHits += 1;
  }
  if (stringHits / sample.length >= 0.8) {
    // Cheap normalisation: keep object reference, callers use it as-is.
    return { entries: r as Record<string, string | string[]> };
  }

  throw new Error('JSON is missing an "entries" object');
}

function sanitizeFileStem(raw: string): string {
  const cleaned = raw
    .replace(FS_ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (cleaned.length === 0) return "dictionary";
  return cleaned.slice(0, 80);
}

async function uniqueFilename(stem: string): Promise<string> {
  const sanitized = sanitizeFileStem(stem);
  let existing: Set<string>;
  try {
    const entries = await FileSystem.readDirectoryAsync(DICTIONARIES_DIR);
    existing = new Set(entries.map((e) => e.toLowerCase()));
  } catch {
    existing = new Set();
  }
  const candidate = `${sanitized}.json`;
  if (!existing.has(candidate.toLowerCase())) return candidate;
  for (let n = 2; n < 10000; n++) {
    const variant = `${sanitized} (${n}).json`;
    if (!existing.has(variant.toLowerCase())) return variant;
  }
  return `${sanitized} (${Date.now()}).json`;
}

function nameFromUrl(url: string): string {
  try {
    const last = url.split("?")[0]!.split("/").pop() ?? url;
    return decodeURIComponent(last).replace(/\.json$/i, "");
  } catch {
    return "dictionary";
  }
}

/** Two-pass merge for Open English WordNet's "plus-json" release.
 *
 * The release ships ~73 sharded files inside the ZIP:
 *   - entries-{0,a..z}.json — lemma → POS → senses[].synset (the "index")
 *   - {noun,verb,adj,adv}.<category>.json — synset_id → { definition: [...] }
 *
 * Neither half is a dictionary on its own; we walk the index, look up
 * each synset's definitions, and produce a flat {lemma: definitions[]}.
 * Definitions are deduped per lemma so a noun + verb sense of the same
 * word don't both surface "to abandon something".
 *
 * Extracted shards are added to `tempCleanup` so the caller's error
 * handlers and final cleanup can drop them.
 *
 * Memory budget: peak ~80 MB while both maps coexist; production output
 * compresses to ~6–10 MB on disk. Acceptable for an install-time op. */
async function mergeWordNetShards(
  rawZipPath: string,
  jsonEntries: NativeZipEntry[],
  tempCleanup: string[],
): Promise<Record<string, string[]>> {
  if (!SpineZip) throw new Error("SpineZip native module unavailable");

  const entriesShards = jsonEntries.filter((e) =>
    /^entries-[0a-z]\.json$/i.test(e.displayName),
  );
  const synsetShards = jsonEntries.filter((e) =>
    /^(noun|verb|adj|adv)\..+\.json$/i.test(e.displayName),
  );

  // Pass 1: build synset_id → definitions[] from the POS/category shards.
  const synsetDefs = new Map<string, string[]>();
  for (const shard of synsetShards) {
    const out = dictPath(`~staging-${uuidv4()}.json`);
    tempCleanup.push(out);
    await SpineZip.extractEntry(rawZipPath, shard.entryName, out.replace(/^file:\/\//, ""));
    const text = await FileSystem.readAsStringAsync(out, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [synsetId, val] of Object.entries(parsed)) {
      if (!val || typeof val !== "object") continue;
      const defField = (val as Record<string, unknown>).definition;
      let defs: string[] = [];
      if (typeof defField === "string") defs = [defField];
      else if (Array.isArray(defField)) {
        defs = defField.filter((d): d is string => typeof d === "string");
      }
      if (defs.length > 0) synsetDefs.set(synsetId, defs);
    }
    // Reclaim memory before the next shard parse — JSON.parse holds the
    // raw string + object graph in scope until the function returns
    // otherwise. Letting the loop iteration end + GC isn't reliable
    // under React Native's Hermes; explicit drop helps the heap stay
    // under 80 MB across all 73 shards.
    await FileSystem.deleteAsync(out, { idempotent: true });
  }

  // Pass 2: walk the lemma index, dereference each synset, accumulate
  // unique definitions per lemma.
  const lemmaDefs = new Map<string, string[]>();
  for (const shard of entriesShards) {
    const out = dictPath(`~staging-${uuidv4()}.json`);
    tempCleanup.push(out);
    await SpineZip.extractEntry(rawZipPath, shard.entryName, out.replace(/^file:\/\//, ""));
    const text = await FileSystem.readAsStringAsync(out, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [lemma, byPos] of Object.entries(parsed)) {
      if (!byPos || typeof byPos !== "object") continue;
      const collected = lemmaDefs.get(lemma) ?? [];
      const seen = new Set(collected);
      for (const posVal of Object.values(byPos as Record<string, unknown>)) {
        if (!posVal || typeof posVal !== "object") continue;
        const senses = (posVal as Record<string, unknown>).sense;
        if (!Array.isArray(senses)) continue;
        for (const sense of senses) {
          if (!sense || typeof sense !== "object") continue;
          const synsetId = (sense as Record<string, unknown>).synset;
          if (typeof synsetId !== "string") continue;
          const defs = synsetDefs.get(synsetId);
          if (!defs) continue;
          for (const def of defs) {
            if (!seen.has(def)) {
              seen.add(def);
              collected.push(def);
            }
          }
        }
      }
      if (collected.length > 0) lemmaDefs.set(lemma, collected);
    }
    await FileSystem.deleteAsync(out, { idempotent: true });
  }

  // Convert Map to plain object for the canonical-format writer.
  const merged: Record<string, string[]> = {};
  for (const [lemma, defs] of lemmaDefs) merged[lemma] = defs;
  return merged;
}

/** Download + validate + persist. Throws on any failure (network,
 * non-200, JSON parse, unrecognised format).
 *
 * Optional second arg lets the caller pin a display name and/or
 * language tag — used by the curated-install path so a Webster's-flat
 * file (no `name` field) still gets a friendly label. The hand-typed
 * URL path passes nothing and falls back to URL-derived name + "und". */
export async function installFromUrl(
  url: string,
  hint?: { name?: string; lang?: string },
): Promise<DictionaryMeta> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL must start with http:// or https://");
  }
  await ensureDir();
  const stem = sanitizeFileStem(hint?.name || nameFromUrl(url) || "dictionary");

  // ZIP support: if the URL ends in .zip OR the content-type comes back
  // application/zip, we download to a staging .zip, list its entries,
  // pick the largest .json (heuristic — the WordNet release ships one
  // big english-wordnet-2025.json plus tiny metadata blobs), extract
  // it, then continue the normal install path. Anything else: download
  // straight to a staging .json and parse.
  const lowerUrl = url.toLowerCase().split("?")[0]!;
  const looksZip = lowerUrl.endsWith(".zip");

  // Stage to a temp name first so a failed/aborted download doesn't
  // leave a half-written file under the canonical name.
  const tmpFilename = `~staging-${uuidv4()}.${looksZip ? "zip" : "json"}`;
  const tmpPath = dictPath(tmpFilename);
  const dl = await FileSystem.downloadAsync(url, tmpPath);
  if (dl.status < 200 || dl.status >= 300) {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true });
    throw new Error(`Download failed: HTTP ${dl.status}`);
  }

  // ZIP path: extract the largest .json entry to a second temp file
  // and rebind tmpPath to it. The original .zip is removed once the
  // JSON is on disk so we never carry both.
  let normalised: NormalisedDict;
  let workingPath = tmpPath;
  // Track temp files we need to clean up at the end of any branch.
  // Multi-shard WordNet extracts dozens of files; the single-blob path
  // only ever has one. Either way, delete on any error path.
  const tempCleanup: string[] = [];

  if (looksZip) {
    if (Platform.OS !== "android" || !SpineZip) {
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      throw new Error("ZIP dictionaries are only supported in the Android build");
    }
    // strip the file:// prefix that FileSystem returns; the native
    // module's pathFromArg accepts both, but cleaner to pass raw paths.
    const rawZipPath = tmpPath.replace(/^file:\/\//, "");
    let zipEntries: NativeZipEntry[];
    try {
      zipEntries = await SpineZip.listEntries(rawZipPath);
    } catch (e) {
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      throw new Error(
        `Could not read ZIP: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const jsonEntries = zipEntries.filter((e) =>
      e.displayName.toLowerCase().endsWith(".json"),
    );
    if (jsonEntries.length === 0) {
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      throw new Error("ZIP contains no .json file");
    }

    // WordNet detection. The Open English WordNet "plus-json" release
    // ships ~73 sharded files: lemma index in entries-*.json, synset
    // definitions in <pos>.<cat>.json (noun.animal.json, verb.weather.json,
    // etc.). No single file is the dictionary — both halves have to be
    // joined to produce {word: definitions}. Detect by checking for
    // the lemma-index shard pattern AND at least one POS/category file.
    const hasEntriesShards = jsonEntries.some((e) =>
      /^entries-[0a-z]\.json$/i.test(e.displayName),
    );
    const hasSynsetShards = jsonEntries.some((e) =>
      /^(noun|verb|adj|adv)\..+\.json$/i.test(e.displayName),
    );
    const isWordNet = hasEntriesShards && hasSynsetShards;

    if (isWordNet) {
      try {
        const merged = await mergeWordNetShards(rawZipPath, jsonEntries, tempCleanup);
        normalised = {
          name: hint?.name ?? "Open English WordNet",
          lang: hint?.lang ?? "en",
          version: undefined,
          entries: merged,
        };
      } catch (e) {
        await FileSystem.deleteAsync(tmpPath, { idempotent: true });
        for (const p of tempCleanup) {
          await FileSystem.deleteAsync(p, { idempotent: true });
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
      // ZIP no longer needed — every shard has been parsed into memory.
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      workingPath = ""; // signal "no single .json on disk to clean later"
    } else {
      // Single-blob path (the original behaviour). Pick the largest
      // .json entry — covers Webster's-flat zips and similar packages
      // that ship one data file plus tiny LICENSE/README extras.
      const sorted = [...jsonEntries].sort((a, b) => b.size - a.size);
      const target = sorted[0]!;
      const extractedPath = dictPath(`~staging-${uuidv4()}.json`);
      try {
        await SpineZip.extractEntry(
          rawZipPath,
          target.entryName,
          extractedPath.replace(/^file:\/\//, ""),
        );
      } catch (e) {
        await FileSystem.deleteAsync(tmpPath, { idempotent: true });
        await FileSystem.deleteAsync(extractedPath, { idempotent: true });
        throw new Error(
          `Could not extract ${target.displayName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      workingPath = extractedPath;
      tempCleanup.push(extractedPath);
    }
  }

  // Single-blob path: read + parse + normalise. WordNet path skips
  // this since `normalised` was already populated from the multi-shard
  // merge above.
  if (workingPath) {
    let parsed: unknown;
    try {
      const text = await FileSystem.readAsStringAsync(workingPath, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      parsed = JSON.parse(text);
    } catch (e) {
      for (const p of tempCleanup) {
        await FileSystem.deleteAsync(p, { idempotent: true });
      }
      throw new Error(`Not a JSON file: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      normalised = normaliseDict(parsed);
    } catch (e) {
      for (const p of tempCleanup) {
        await FileSystem.deleteAsync(p, { idempotent: true });
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  } else {
    // Belt-and-suspenders TS: WordNet path always assigns normalised
    // before clearing workingPath.
    if (!normalised!) throw new Error("internal: no dictionary parsed");
  }
  const entryCount = Object.keys(normalised.entries).length;
  if (entryCount === 0) {
    for (const p of tempCleanup) {
      await FileSystem.deleteAsync(p, { idempotent: true });
    }
    throw new Error("Dictionary has no entries");
  }

  // Re-serialise to the canonical native format so loadEntries doesn't
  // need to handle multiple shapes at lookup time. Carries hints
  // (display name, language) supplied by the caller — those let a
  // curated install of a Webster's-flat file land with a real name.
  const displayName =
    normalised.name?.trim() ||
    hint?.name?.trim() ||
    nameFromUrl(url) ||
    "Dictionary";
  const displayLang =
    normalised.lang?.trim() || hint?.lang?.trim() || "und";
  const canonical = {
    name: displayName,
    lang: displayLang,
    version: normalised.version ?? null,
    entries: normalised.entries,
  };

  const finalFilename = await uniqueFilename(sanitizeFileStem(displayName) || stem);
  await FileSystem.writeAsStringAsync(dictPath(finalFilename), JSON.stringify(canonical), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  // Always remove temp files after writing the canonical one (we
  // never moveAsync — the on-disk shape is the re-serialised form,
  // not the source bytes — so the temp files aren't the "real" output).
  for (const p of tempCleanup) {
    await FileSystem.deleteAsync(p, { idempotent: true });
  }
  const info = await FileSystem.getInfoAsync(dictPath(finalFilename));
  const sizeBytes = (info as { size?: number }).size ?? 0;
  const dicts = await loadDictionaries();
  // New installs land at the bottom of the priority list. Reordering
  // is a separate user action so a newly-installed modern dict
  // doesn't displace a Webster's the user just spent five minutes
  // arranging at top.
  const nextPriority = dicts.length === 0
    ? 0
    : Math.max(...dicts.map((d) => d.priority)) + 1;
  const meta: DictionaryMeta = {
    id: uuidv4(),
    name: displayName,
    lang: displayLang,
    filename: finalFilename,
    sourceUrl: url,
    version: typeof normalised.version === "string" ? normalised.version : null,
    entryCount,
    sizeBytes,
    addedAt: new Date().toISOString(),
    priority: nextPriority,
    schemaVersion: 1,
  };
  await saveDictionaries([...dicts, meta]);
  // Drop any cached entries for this slot (defensive — fresh install
  // shouldn't have a cache hit, but a reinstall with the same id won't).
  ENTRY_CACHE.delete(meta.id);
  return meta;
}

// Curated downloads. URL must point at one of the formats normaliseDict
// recognises — Webster's-flat for matthewreagan / adambom, native Spine
// format for anything we host ourselves later.
//
// Licensing intent: every curated entry must be license-consistent
// with the app (permissive — public domain, MIT, BSD, CC0, or CC BY).
// CC BY-SA / GPL-only data is intentionally NOT baked in because
// downstream attribution + ShareAlike requirements would propagate
// through the user's library exports in surprising ways.
//
// Hosting note: we link to raw.githubusercontent.com directly instead
// of bundling. Each entry is public domain or a permissively-licensed
// project that's been stable for years. If a URL rots (the project
// renames its master branch, deletes the file), the install still
// fails cleanly through the existing error path.
export interface CuratedDictionary {
  id: string;
  name: string;
  lang: string;
  /** Short note shown under the row — what the dict is, who made it,
   * and the on-disk size to set expectations before tapping Install. */
  description: string;
  /** Plain-text license tag shown on the install row + confirm dialog.
   * Examples: "Public domain", "MIT", "CC BY 4.0". */
  license: string;
  /** "classic" = pre-modern source (Webster's 1913, OPTED, etc.).
   *  "modern"  = present-day lexicon (WordNet, Wiktionary extracts). */
  era: "classic" | "modern";
  approxSizeMb: number;
  url: string;
}

export const CURATED_DICTIONARIES: ReadonlyArray<CuratedDictionary> = [
  {
    id: "websters-1913-compact",
    name: "Webster's Revised Unabridged (1913)",
    lang: "en",
    description:
      "Public-domain Webster's 1913 — the dictionary people grew up calling 'a real dictionary'. Compact JSON port by Matthew Reagan, ~85k entries.",
    license: "Public domain (PD wrapper: MIT)",
    era: "classic",
    approxSizeMb: 5,
    url: "https://raw.githubusercontent.com/matthewreagan/WebstersEnglishDictionary/master/dictionary_compact.json",
  },
  {
    id: "websters-1913-adambom",
    name: "Webster's Dictionary — full",
    lang: "en",
    description:
      "Same Webster's 1913 source, fuller JSON port by adambom. Heavier than the compact version but carries longer entries.",
    license: "Public domain (PD wrapper: MIT)",
    era: "classic",
    approxSizeMb: 24,
    url: "https://raw.githubusercontent.com/adambom/dictionary/master/dictionary.json",
  },
  {
    id: "english-wordnet-2025",
    name: "Open English WordNet 2025",
    lang: "en",
    description:
      "Modern lexical database from en-word.net — present-day senses, synonyms, hypernyms, and definitions. Pairs well with a Webster's for shade-of-meaning lookups. Distributed as a ZIP; Spine extracts the JSON automatically.",
    license: "CC BY 4.0",
    era: "modern",
    // ZIP is ~30 MB on the wire; the extracted JSON is larger.
    // The installer downloads the ZIP, picks the largest .json
    // entry inside, and ingests it normally.
    approxSizeMb: 30,
    url: "https://en-word.net/static/english-wordnet-2025-plus-json.zip",
  },
];

export async function uninstall(id: string): Promise<void> {
  const dicts = await loadDictionaries();
  const target = dicts.find((d) => d.id === id);
  if (!target) return;
  await FileSystem.deleteAsync(dictPath(target.filename), { idempotent: true });
  await saveDictionaries(dicts.filter((d) => d.id !== id));
  ENTRY_CACHE.delete(id);
}

/** Set priorities to match the order of the supplied id list. The list
 * MUST be a permutation of the currently-installed dict ids; ids
 * present in storage but missing from the list keep their relative
 * order at the bottom. Renumbers from 0 so values stay tight as the
 * user reorders. */
export async function reorderDictionaries(orderedIds: string[]): Promise<void> {
  const dicts = await loadDictionaries();
  const byId = new Map(dicts.map((d) => [d.id, d] as const));
  const next: DictionaryMeta[] = [];
  let p = 0;
  for (const id of orderedIds) {
    const m = byId.get(id);
    if (!m) continue;
    next.push({ ...m, priority: p });
    p += 1;
    byId.delete(id);
  }
  // Anything not named in the list gets appended in addedAt order.
  const leftover = Array.from(byId.values()).sort((a, b) =>
    a.addedAt.localeCompare(b.addedAt),
  );
  for (const m of leftover) {
    next.push({ ...m, priority: p });
    p += 1;
  }
  await saveDictionaries(next);
}

// Entries cache: reading + parsing a multi-MB JSON every lookup is wasteful
// when the user is repeatedly tapping Look up while reading. First lookup
// pays the cost; all subsequent lookups for the same dict hit memory.
// Cache is keyed by meta.id and cleared on uninstall.
const ENTRY_CACHE = new Map<string, Map<string, string[]>>();

async function loadEntries(meta: DictionaryMeta): Promise<Map<string, string[]>> {
  const cached = ENTRY_CACHE.get(meta.id);
  if (cached) return cached;
  const text = await FileSystem.readAsStringAsync(dictPath(meta.filename), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  const parsed = JSON.parse(text) as ParsedFile;
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (typeof key !== "string" || key.length === 0) continue;
    const lc = key.toLowerCase();
    if (typeof value === "string") {
      out.set(lc, [value]);
    } else if (Array.isArray(value)) {
      const defs = value.filter((v): v is string => typeof v === "string");
      if (defs.length > 0) out.set(lc, defs);
    }
  }
  ENTRY_CACHE.set(meta.id, out);
  return out;
}

/** Lookup `word` across every installed dictionary. Strips trailing
 * punctuation (commas, periods, quotes) the user might've grabbed when
 * they long-pressed; falls through to a couple of cheap morphological
 * fallbacks (plural -s, past -ed, -ing) so common verb forms still hit
 * a base entry. */
export async function lookup(
  word: string,
  dicts: DictionaryMeta[],
): Promise<DictionaryHit[]> {
  // Sort by priority (ascending) so the user-pinned "first results
  // from" dict shows up first in the paged sheet.
  const ordered = [...dicts].sort((a, b) => a.priority - b.priority);
  const cleaned = word
    .toLowerCase()
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  if (!cleaned) return [];
  const candidates = [cleaned];
  // Cheap morphological fallback. Don't be clever — each variant only
  // fires if the exact form missed in every installed dict.
  const trimmed = cleaned.endsWith("'s") ? cleaned.slice(0, -2) : null;
  if (trimmed) candidates.push(trimmed);
  if (cleaned.endsWith("ies") && cleaned.length > 4) {
    candidates.push(`${cleaned.slice(0, -3)}y`);
  }
  if (cleaned.endsWith("es") && cleaned.length > 3) {
    candidates.push(cleaned.slice(0, -2));
  }
  if (cleaned.endsWith("s") && cleaned.length > 2) {
    candidates.push(cleaned.slice(0, -1));
  }
  if (cleaned.endsWith("ed") && cleaned.length > 3) {
    candidates.push(cleaned.slice(0, -2));
    candidates.push(cleaned.slice(0, -1));
  }
  if (cleaned.endsWith("ing") && cleaned.length > 4) {
    candidates.push(cleaned.slice(0, -3));
    candidates.push(`${cleaned.slice(0, -3)}e`);
  }

  const hits: DictionaryHit[] = [];
  for (const meta of ordered) {
    let entries: Map<string, string[]>;
    try {
      entries = await loadEntries(meta);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      const def = entries.get(candidate);
      if (def && def.length > 0) {
        hits.push({ meta, headword: candidate, definitions: def });
        break;
      }
    }
  }
  return hits;
}

export async function dictionariesUsage(): Promise<number> {
  const info = await FileSystem.getInfoAsync(DICTIONARIES_DIR);
  if (!info.exists) return 0;
  let total = 0;
  try {
    const entries = await FileSystem.readDirectoryAsync(DICTIONARIES_DIR);
    const stats = await Promise.allSettled(
      entries.map((name) => FileSystem.getInfoAsync(`${DICTIONARIES_DIR}${name}`)),
    );
    for (const s of stats) {
      if (s.status === "fulfilled") {
        const sz = (s.value as { size?: number }).size ?? 0;
        total += sz;
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}
