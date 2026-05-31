// Copy the freshly-built APK to the network archive so every release
// build has a recoverable copy off the dev box. Named with version +
// versionCode + sha so we can pull "the apk that was on my phone in
// April 2026" without guessing.
//
// SPINE_APK_ARCHIVE env var overrides the default path — handy when
// the share isn't mounted (CI, fresh laptop, debugging copy itself).
// If the archive path isn't reachable, this script logs a warning
// and exits 0 — the build itself is fine, the archive copy is best-effort.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const apkPath = resolve(
  projectRoot,
  "android/app/build/outputs/apk/release/app-release.apk",
);

const DEFAULT_ARCHIVE = ""; // set SPINE_APK_ARCHIVE to your network archive path
const archiveDir = process.env.SPINE_APK_ARCHIVE || DEFAULT_ARCHIVE;

if (!existsSync(apkPath)) {
  console.error(`✗ archive-apk: no APK at ${apkPath}`);
  process.exit(2);
}

let appJson;
try {
  appJson = JSON.parse(readFileSync(resolve(projectRoot, "app.json"), "utf8"));
} catch (e) {
  console.warn(`⚠ archive-apk: couldn't read app.json (${e.message}); using "?" placeholders`);
  appJson = { expo: { version: "?", android: { versionCode: "?" } } };
}
const version = appJson.expo?.version ?? "?";
const versionCode = appJson.expo?.android?.versionCode ?? "?";

const bytes = readFileSync(apkPath);
const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const filename = `spine-${version}-vc${versionCode}-${sha}.apk`;

try {
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
} catch (e) {
  console.warn(
    `⚠ archive-apk: archive dir ${archiveDir} unreachable (${e.message}); skipping copy`,
  );
  process.exit(0);
}

const dest = join(archiveDir, filename);
if (existsSync(dest)) {
  // Same sha + same name → identical bytes already on the share.
  // Cheap idempotency: rebuilding the same commit twice doesn't
  // duplicate or fail.
  const existingSize = statSync(dest).size;
  if (existingSize === bytes.length) {
    console.log(`✓ archive-apk: already present  ${filename}`);
    process.exit(0);
  }
}

try {
  copyFileSync(apkPath, dest);
  console.log(`✓ archive-apk: copied  ${filename}  →  ${archiveDir}`);
} catch (e) {
  console.warn(`⚠ archive-apk: copy failed (${e.message}); build artifact still in android/app/build/outputs/`);
  process.exit(0);
}
