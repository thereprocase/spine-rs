// Entry shim. Expo Router's `entry.js` is the canonical entry point, but
// pointing `package.json#main` at "expo-router/entry" makes the Gradle
// embed step compute a relative path that the Metro server can't resolve
// inside this pnpm-workspace layout (it ends up looking 2 dirs above the
// workspace root). Shipping a local file as the entry sidesteps that whole
// resolution dance.
import "expo-router/entry";
