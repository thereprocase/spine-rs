// The displayed app version is sourced from app.json — the same file
// expo prebuild reads to write versionName into android/app/build.gradle.
// Importing JSON directly (Metro supports it) means src/version.ts can
// never drift from the build version. The previous file held a bare
// "0.2.18" literal that had to be hand-edited every release; on 0.2.18
// it actually drifted (package.json said 0.1.4) and CI almost shipped
// the wrong number. The sync script (scripts/sync-version.mjs)
// propagates this same value to package.json and android/app/build.gradle
// so all four end up identical at build time. Verify-apk asserts it.

import appJson from "../app.json";

export const APP_VERSION: string = appJson.expo.version;
