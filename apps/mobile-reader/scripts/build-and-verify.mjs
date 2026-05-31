// Cross-platform "build then verify" wrapper for the Android release
// APK. Picks the right gradle wrapper for the host OS so this runs on
// both Windows (gradlew.bat) and macOS/Linux (gradlew). Fails loud and
// non-zero if either step fails — the verifier is what saves us from
// the ghost-build episode where 8 builds shipped the same APK because
// gradle reported success while the Kotlin compile silently failed.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const androidDir = resolve(projectRoot, "android");
const isWindows = process.platform === "win32";
const gradleCmd = resolve(androidDir, isWindows ? "gradlew.bat" : "gradlew");

// Run BEFORE Gradle so package.json + build.gradle catch up to whatever
// app.json says. Without this, bumping app.json alone left build.gradle
// stale and Gradle happily reused the cached APK.
console.log("▶ sync version (app.json → package.json + build.gradle)");
const sync = spawnSync(
  process.execPath,
  [resolve(__dirname, "sync-version.mjs")],
  { cwd: projectRoot, stdio: "inherit" },
);
if (sync.status !== 0) {
  console.error(`✗ sync-version exited with ${sync.status}`);
  process.exit(sync.status ?? 1);
}

// Regenerate the inlined reader bundle. The bootstrap (reader-bootstrap.js)
// + epubjs + the HTML shell are base64-packed into src/reader/html.ts
// at this step. Without it, edits to the bootstrap silently SHIP NOTHING
// — Gradle uses html.ts as-is, so a forgotten `build:reader` looks like
// "the bootstrap change had no effect." Cost us a wasted release cycle
// before getting added here.
console.log("▶ build reader bundle (reader-bootstrap.js → html.ts)");
const buildReader = spawnSync(
  process.execPath,
  [resolve(__dirname, "build-reader-html.mjs")],
  { cwd: projectRoot, stdio: "inherit" },
);
if (buildReader.status !== 0) {
  console.error(`✗ build-reader exited with ${buildReader.status}`);
  process.exit(buildReader.status ?? 1);
}

console.log(`▶ build  ${gradleCmd} :app:assembleRelease`);
const build = spawnSync(gradleCmd, [":app:assembleRelease"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWindows,
});
if (build.status !== 0) {
  console.error(`✗ gradle exited with ${build.status}`);
  process.exit(build.status ?? 1);
}

console.log("▶ verify");
const verify = spawnSync(process.execPath, [resolve(__dirname, "verify-apk.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (verify.status !== 0) {
  process.exit(verify.status ?? 1);
}

// Best-effort: copy the verified APK to the network archive. Failures
// are warnings, not errors — the build is still good.
console.log("▶ archive");
spawnSync(process.execPath, [resolve(__dirname, "archive-apk.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});
process.exit(0);
