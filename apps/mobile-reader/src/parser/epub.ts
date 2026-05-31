// Pure-TS EPUB metadata extractor. RN-compatible (no Node fs / Buffer / zlib
// native bindings — jszip + fast-xml-parser only). Reads:
//   - META-INF/container.xml -> rootfile path
//   - the OPF -> dc:title, dc:creator, dc:language, manifest cover ref
//   - the cover image bytes (if found)
//
// EPUB 2 cover discovery: <meta name="cover" content="<id>"/> in <metadata>.
// EPUB 3 cover discovery: <item properties="cover-image"/> in <manifest>.
// Both supported; EPUB 3 takes priority when both are present.

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

import type { ParsedEpub } from "../types";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // strip dc:, opf: etc.
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false,
});

const COVER_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function firstText(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    // fast-xml-parser places text under "#text" when attrs exist.
    const obj = node as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return (obj["#text"] as string).trim() || null;
  }
  return null;
}

function joinPath(dir: string, rel: string): string {
  // OPF hrefs are relative to the OPF directory. Normalize to a zip-internal
  // posix-style path. Strip any leading "./" or fragments. We resolve `..`
  // segments but never let the result escape the zip root — `..` that pops
  // past the start is silently dropped.
  const cleaned = rel.replace(/^\.\//, "").split("#")[0]!.split("?")[0]!;
  const base = dir ? dir.replace(/\/$/, "").split("/") : [];
  const tail = cleaned.split("/");
  const out: string[] = [...base];
  for (const p of tail) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length > 0) out.pop();
    } else {
      out.push(p);
    }
  }
  return out.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/**
 * Parse EPUB metadata from raw bytes.
 *
 * @throws if the file is not a valid zip or lacks a parseable OPF.
 */
export async function parseEpubMetadata(
  bytes: ArrayBuffer | Uint8Array,
  fallbackTitle: string,
): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(bytes);

  // 1. container.xml -> OPF path
  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) throw new Error("EPUB missing META-INF/container.xml");
  const containerXml = await containerEntry.async("string");
  const containerDoc = xml.parse(containerXml);
  const rootfiles = asArray(containerDoc?.container?.rootfiles?.rootfile);
  const opfPath = rootfiles[0]?.["@_full-path"] as string | undefined;
  if (!opfPath) throw new Error("EPUB container.xml has no rootfile@full-path");

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found at ${opfPath}`);
  const opfXml = await opfEntry.async("string");
  const opfDoc = xml.parse(opfXml);

  const pkg = opfDoc?.package;
  const metadata = pkg?.metadata ?? {};
  const manifestItems = asArray(pkg?.manifest?.item) as Array<Record<string, unknown>>;

  // 2. Title — prefer first dc:title.
  const title =
    asArray(metadata.title).map(firstText).find((t): t is string => Boolean(t)) ??
    fallbackTitle;

  // 3. Author — first dc:creator. EPUB allows multiple.
  const creators = asArray(metadata.creator).map(firstText).filter((s): s is string => Boolean(s));
  const author = creators.length > 0 ? creators.join(", ") : "Unknown author";

  // 4. Language — first dc:language.
  const language =
    asArray(metadata.language).map(firstText).find((t): t is string => Boolean(t)) ?? null;

  const subjects = Array.from(
    new Set(
      asArray(metadata.subject)
        .flatMap((node) => (firstText(node) ?? "").split(/[;,]/))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );

  // 5. Cover discovery.
  const opfDir = dirOf(opfPath);
  let coverHref: string | null = null;
  let coverMime: string | null = null;

  // EPUB 3: properties="cover-image"
  for (const item of manifestItems) {
    const props = (item["@_properties"] as string | undefined) ?? "";
    if (props.split(/\s+/).includes("cover-image")) {
      coverHref = (item["@_href"] as string | undefined) ?? null;
      coverMime = (item["@_media-type"] as string | undefined) ?? null;
      break;
    }
  }

  // EPUB 2: <meta name="cover" content="<id>"/>
  if (!coverHref) {
    const metas = asArray(metadata.meta) as Array<Record<string, unknown>>;
    const coverIdMeta = metas.find(
      (m) => (m["@_name"] as string | undefined)?.toLowerCase() === "cover",
    );
    const coverId = (coverIdMeta?.["@_content"] as string | undefined) ?? null;
    if (coverId) {
      const item = manifestItems.find((m) => m["@_id"] === coverId);
      if (item) {
        coverHref = (item["@_href"] as string | undefined) ?? null;
        coverMime = (item["@_media-type"] as string | undefined) ?? null;
      }
    }
  }

  // Fallback heuristic: any image item with id or href containing "cover".
  if (!coverHref) {
    const guess = manifestItems.find((m) => {
      const mt = (m["@_media-type"] as string | undefined) ?? "";
      const href = ((m["@_href"] as string | undefined) ?? "").toLowerCase();
      const id = ((m["@_id"] as string | undefined) ?? "").toLowerCase();
      return mt.startsWith("image/") && (href.includes("cover") || id.includes("cover"));
    });
    if (guess) {
      coverHref = (guess["@_href"] as string | undefined) ?? null;
      coverMime = (guess["@_media-type"] as string | undefined) ?? null;
    }
  }

  let cover: ParsedEpub["cover"] = null;
  if (coverHref) {
    const coverPath = joinPath(opfDir, coverHref);
    const coverEntry = zip.file(coverPath);
    if (coverEntry) {
      const data = await coverEntry.async("uint8array");
      const mediaType = coverMime ?? "image/jpeg";
      const ext = COVER_EXT_BY_MIME[mediaType.toLowerCase()] ?? "jpg";
      cover = { data, mediaType, ext };
    }
  }

  return { title, author, language, subjects, cover };
}
