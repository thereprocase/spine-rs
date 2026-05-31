// Post-build verifier. Prints the APK's versionName + versionCode + a
// short hash so a stale/cached/ghost build is immediately obvious in
// the build output instead of silently shipping yesterday's APK.
//
// Why this exists: between 0.2.8 and 0.2.15 every release silently
// produced a bit-for-bit identical 0.2.7 APK because Gradle's task
// fanout reported BUILD SUCCESSFUL on upstream tasks while the actual
// Kotlin compile failed at the very end. The wrapper script only
// watched the tail. Eight builds shipped, none changed. This guard
// catches that case at the surface: the printed version and mtime
// must move on every real build.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const apkPath = resolve(
  projectRoot,
  "android/app/build/outputs/apk/release/app-release.apk",
);

let stat;
try {
  stat = statSync(apkPath);
} catch {
  console.error(`✗ verify-apk: no APK at ${apkPath}`);
  process.exit(2);
}

const bytes = readFileSync(apkPath);
const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);

// Pull versionName / versionCode out of the source-of-truth files
// rather than reaching into the APK with aapt (which isn't on every
// dev box's PATH). Mismatch between source and what's on disk is a
// separate problem the consumer can investigate.
let appJson;
try {
  appJson = JSON.parse(readFileSync(resolve(projectRoot, "app.json"), "utf8"));
} catch {
  appJson = { expo: { version: "?", android: { versionCode: "?" } } };
}
const expectedVersion = appJson.expo?.version ?? "?";
const expectedCode = appJson.expo?.android?.versionCode ?? "?";

// ASSERT mode (default for build-and-verify pipeline) — fail non-zero
// if any of the version literals across the four source-of-truth files
// disagree. Previously this script only PRINTED the values, so a build
// that drifted (package.json:0.1.4, app.json:0.2.18) still exited 0
// and the bump silently shipped wrong. Use --no-assert to keep the
// printout-only behavior for ad-hoc inspection.
const assertMode = !process.argv.includes("--no-assert");
const driftErrors = [];
if (assertMode) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    );
  } catch (e) {
    driftErrors.push(`package.json: ${e.message}`);
  }
  if (pkgJson && pkgJson.version !== expectedVersion) {
    driftErrors.push(
      `package.json version "${pkgJson.version}" ≠ app.json "${expectedVersion}"`,
    );
  }

  let buildGradle;
  try {
    buildGradle = readFileSync(
      resolve(projectRoot, "android/app/build.gradle"),
      "utf8",
    );
  } catch (e) {
    driftErrors.push(`build.gradle: ${e.message}`);
  }
  if (buildGradle) {
    const gName = buildGradle.match(/versionName\s+"([^"]+)"/);
    const gCode = buildGradle.match(/versionCode\s+(\d+)/);
    if (!gName || gName[1] !== expectedVersion) {
      driftErrors.push(
        `build.gradle versionName "${gName?.[1] ?? "missing"}" ≠ app.json "${expectedVersion}"`,
      );
    }
    if (!gCode || gCode[1] !== String(expectedCode)) {
      driftErrors.push(
        `build.gradle versionCode "${gCode?.[1] ?? "missing"}" ≠ app.json "${expectedCode}"`,
      );
    }
  }
}

// Modification time relative to now — older than ~5 min after a build
// completed is a smell.
const ageSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
const ageStr =
  ageSec < 60 ? `${ageSec}s ago` :
  ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` :
  `${Math.floor(ageSec / 3600)}h ago`;

let installedHint = "";
try {
  const out = execSync(`git -C "${projectRoot}/../.." log -1 --format=%cs:%h`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  installedHint = ` · git ${out}`;
} catch {
  /* no git context */
}

console.log("");
console.log("──── APK verify ────────────────────────────────────────");
console.log(`  path     ${apkPath}`);
console.log(`  size     ${(bytes.length / 1_000_000).toFixed(2)} MB`);
console.log(`  mtime    ${ageStr}  (${stat.mtime.toISOString()})`);
console.log(`  sha256   ${sha}`);
console.log(`  version  ${expectedVersion}  versionCode ${expectedCode}${installedHint}`);
if (driftErrors.length > 0) {
  console.log("────────────────────────────────────────────────────────");
  console.log("✗ VERSION DRIFT — sources of truth disagree:");
  for (const e of driftErrors) console.log(`    ${e}`);
  console.log("  Run: pnpm run sync:version  to repair from app.json.");
  console.log("────────────────────────────────────────────────────────");
  console.log("");
  process.exit(3);
}
console.log("────────────────────────────────────────────────────────");
console.log("");
