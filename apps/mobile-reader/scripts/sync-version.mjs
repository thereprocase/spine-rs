// Propagate the version from app.json (single source of truth) into
// package.json and android/app/build.gradle. Run before every release
// build via `pnpm run build:android`. Fails non-zero on parse errors.
//
// Why: through 0.2.18 we kept three separate version literals and they
// silently drifted — package.json sat at 0.1.4 while shipping APKs as
// 0.2.18. Any tool that reads package.json (npm publish, sentry,
// crash reporters keyed by package version) would attach reports to
// the wrong release. src/version.ts now imports app.json directly, so
// it can't drift; this script keeps the two files Expo CLI / Gradle
// don't import in lockstep.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const appJsonPath = resolve(projectRoot, "app.json");
const packageJsonPath = resolve(projectRoot, "package.json");
const buildGradlePath = resolve(
  projectRoot,
  "android/app/build.gradle",
);

const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
const targetVersion = appJson.expo?.version;
const targetVersionCode = appJson.expo?.android?.versionCode;
if (!targetVersion || typeof targetVersion !== "string") {
  console.error("✗ sync-version: app.json missing expo.version");
  process.exit(2);
}
if (typeof targetVersionCode !== "number") {
  console.error("✗ sync-version: app.json missing expo.android.versionCode");
  process.exit(2);
}

let changes = 0;

// package.json
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== targetVersion) {
  console.log(
    `  package.json     ${packageJson.version}  →  ${targetVersion}`,
  );
  packageJson.version = targetVersion;
  writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8",
  );
  changes += 1;
}

// android/app/build.gradle — line-replace versionCode and versionName
let gradle = readFileSync(buildGradlePath, "utf8");
const codeMatch = gradle.match(/versionCode\s+(\d+)/);
const nameMatch = gradle.match(/versionName\s+"([^"]+)"/);
if (!codeMatch || !nameMatch) {
  console.error(
    "✗ sync-version: couldn't locate versionCode / versionName in build.gradle",
  );
  process.exit(2);
}
if (codeMatch[1] !== String(targetVersionCode)) {
  console.log(
    `  build.gradle code  ${codeMatch[1]}  →  ${targetVersionCode}`,
  );
  // /g so a future build-flavor block doesn't silently desync after the
  // first match is updated.
  gradle = gradle.replace(
    /versionCode\s+\d+/g,
    `versionCode ${targetVersionCode}`,
  );
  changes += 1;
}
if (nameMatch[1] !== targetVersion) {
  console.log(
    `  build.gradle name  ${nameMatch[1]}  →  ${targetVersion}`,
  );
  gradle = gradle.replace(
    /versionName\s+"[^"]+"/g,
    `versionName "${targetVersion}"`,
  );
  changes += 1;
}
writeFileSync(buildGradlePath, gradle, "utf8");

if (changes === 0) {
  console.log(`✓ sync-version: all in sync at ${targetVersion} (${targetVersionCode})`);
} else {
  console.log(
    `✓ sync-version: ${changes} file(s) updated to ${targetVersion} (${targetVersionCode})`,
  );
}
