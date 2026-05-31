> ⚠️ **AI-GENERATED REFERENCE** — produced by Claude (Anthropic) as a research-project output, April 2026. Not hand-authored, not peer-reviewed. Treat as a primer: version numbers, API signatures, and library recommendations must be verified against upstream docs before load-bearing use. Useful for orientation and vocabulary; not a substitute for the official React Native / Expo / web-platform documentation.

---

# Responsive & Universal React Reference

*Unified interfaces that work as a standalone mobile app with a companion web/desktop app. Current to April 2026.*

---

## 0. How to read this document

The first reference covered how an interactive element should feel in your hand. This one covers the layer above it: how a single codebase — or two tightly coordinated codebases — can produce a mobile app that feels native on iOS and Android AND a web app that feels like it belongs on a desktop browser at 2560×1440.

Those two goals are in tension. A naïve approach ("just run React Native on web") produces a stretched phone UI that nobody wants to use on a 27" monitor. The opposite naïve approach ("ship two completely separate apps") doubles your work and guarantees divergence. The real answer is nuanced: share aggressively at the data/logic layer, share selectively at the presentation layer, and diverge deliberately where form factor demands it.

This document is organized the way decisions actually happen:

1. First, the strategic decision — one codebase, two codebases, or something between
2. Then the infrastructure — monorepo, toolchain, shared packages
3. Then the fundamentals that apply regardless — layout, breakpoints, fluid units
4. Then the styling strategy that bridges platforms
5. Then the patterns that must diverge by form factor — navigation, data density, interaction model
6. Then the web-only concerns — URLs, SEO, PWA, offline, files, print
7. Finally, the practical application to field inspection — Scribe's mobile-capture-plus-desktop-review architecture

Read front-to-back on a new project. Jump to the relevant section once a project is running. The Quick-Reference section at the end is the cheat sheet for after you've internalized the rest.

Cross-references to the first document appear as §RN-UI.N where N is the section number.

---

## 1. First principles

Five ideas that govern everything else.

### Form factor dominates platform

"iOS vs Android vs Web" is the wrong axis. The real axis is phone, tablet, and desktop — and a Chromebook in tablet mode is closer to an iPad than to a MacBook, even though it's technically a web browser. Design for form factors (one-handed phone, two-handed tablet, pointer-driven desktop) first; then layer platform conventions on top.

This matters because a lot of "responsive design" advice conflates the two. A web app rendered on an iPad needs touch targets, gesture-friendly navigation, and a soft keyboard — the fact that it happens to be rendered via WebKit is the least interesting thing about it. Conversely, a React Native app running on macOS via Catalyst needs a menu bar, keyboard shortcuts, window chrome, and right-click menus — its iOS origin is almost irrelevant.

The implication: stop asking "does this work on web?" and start asking "does this work on desktop, tablet portrait, tablet landscape, and phone?"

### Same product, different expressions

A universal app is one product, expressed differently on different form factors. A web app that is a 1:1 port of the mobile experience is a mobile app running in a browser — not a web app. A mobile app that is a 1:1 port of the web experience is a desktop dashboard crammed onto a 6" screen — not a mobile app.

The test: can you describe the product in a single sentence that makes sense on every form factor? For Scribe: "capture, review, and produce field inspection reports." On the phone, that's mostly capture. On the desktop, that's mostly review and authoring. The shared noun is "field inspection report"; the verbs differ.

Shared model, shared business rules, shared data shapes, shared validation. Divergent layout, divergent navigation, divergent interaction paradigm. Get that split right and the rest follows.

### Responsive, not adaptive

Responsive means fluid — the layout continuously adapts to available space. Adaptive means stepped — the layout snaps between a small number of fixed configurations. Modern CSS and modern React Native both favor responsive, because devices no longer cluster around three screen sizes. There's an Android foldable at 673pt, an iPad Mini at 744pt, a 13" laptop at 1280pt, a 4K monitor at 3840pt. Snapping between "mobile / tablet / desktop" configurations leaves the foldable and the portrait 24" monitor looking broken.

Use breakpoints sparingly — as the moments where the layout's underlying grid changes (one column → two columns, sidebar appears, etc.) — not as the primary mechanism for fit. Between breakpoints, fluid sizing (`clamp()`, `%`, `auto`, `flex`) does the work.

### Progressive enhancement across form factors

Bigger screens get more features, not bigger versions of small-screen features. On the phone, Scribe shows one inspection item at a time. On a tablet, master-detail split view with the item list on the left. On the desktop, the same split view plus a third column for live report preview, keyboard shortcuts for every action, and a command palette. The desktop version is additively richer — the phone version is not a stripped-down desktop version.

This is the opposite of how responsive design is often taught. The mobile-first dogma says "start small, scale up" in terms of CSS. It does not mean "small screens get fewer features" — it means "when layout space allows, add structural affordances that wouldn't fit on small screens." Sidebars, secondary panels, always-visible filters, inline previews — all of these exist on desktop because there's room. They don't exist on mobile because there isn't. The mobile experience is not lesser; it's tighter.

### Don't fight the platform

Users on iOS expect large titles that collapse on scroll, back swipes from the left edge, and a tab bar at the bottom. Users on Android expect a back button at the top-left and Material-style ripple feedback. Users on Windows expect a menu bar, Ctrl+S to save, and right-click context menus. Users on macOS expect ⌘-based shortcuts, traffic lights in the top left, and native-feeling scrollbars.

A universal codebase should *accommodate* these conventions, not flatten them. Expo Router's native tabs adopt iOS liquid glass and Android Material 3 automatically; react-native-screens gives you native stacks; `Platform.OS` checks let you swap icons from SF Symbols to Material Icons. On web, media queries, `@media (hover: hover)`, and feature detection let you adopt desktop conventions without breaking tablet/phone web users.

The instinct to "brand over" every platform ("our buttons should look identical everywhere") is usually wrong for consumer apps. It's sometimes right for branded enterprise tools, but even then the cost is higher than it looks — you're opting out of every accessibility, localization, and OS-feature improvement that comes from platform-native components.

---

## 2. The architecture decision

Before writing a line of code, pick one of three architectures. This choice determines almost everything else. Getting it wrong is an expensive rewrite; getting it right is a force multiplier.

### Option A: RN-first universal (Expo Router + React Native Web)

One Expo codebase targeting iOS, Android, and web. Metro bundles all three. React Native for Web translates `<View>` and `<Text>` into `<div>` and `<span>`. Expo Router handles routing on all three platforms with file-based conventions and `.web.tsx` / `.native.tsx` for per-platform overrides.

**Works well when:** the app is mobile-first and the web version is a companion (common for field tools, social apps, consumer products). Heavy code sharing (>80%). Small team. Same feature set across platforms. Expo Router v6 brings native feel with liquid glass tabs, predictive back, and a Radix-based web fallback.

**Works poorly when:** the web app needs to be SEO-heavy with complex content pages, or needs rich desktop interactions (data-dense tables, multi-pane windows, heavy keyboard shortcuts, drag-and-drop file uploads across regions). React Native Web is fine for app-shell web experiences; it's not ideal for document-heavy marketing sites or deep admin consoles.

**Honest trade-off:** web bundle size is larger than a native React web app (RN Web ships a lot of RN shim code). DOM output is less semantic (everything is `<div>` by default). React Native Web adds a compatibility shim that translates React Native's primitives into react-dom ones, which has drawbacks including a large shim surface and non-standard implementations for things like events.

### Option B: Separate apps, shared core (monorepo)

Two apps — an Expo app for mobile, a Next.js (or Remix, or Vite+React) app for web — sharing business logic, types, schemas, API clients, and utility code through monorepo packages. UI code is largely separate; each platform uses its native idiom (React Native components on mobile, DOM components on web).

**Works well when:** both mobile and web are first-class experiences and diverge meaningfully in interaction. Team has both mobile and web specialists. Web needs heavy SEO, SSR, or desktop-specific features. Long-term maintenance is a primary concern. Solito now renders pure HTML + Next.js components on the web, enabling modern styling solutions like Tailwind and design systems without React Native Web's constraints; the philosophy is that shared code should not come at the cost of platform quality.

**Works poorly when:** small team can't afford to maintain two UI codebases; time-to-market pressure favors shipping both platforms from one tree; features genuinely need to be 1:1 identical.

**Honest trade-off:** roughly 40-60% code sharing instead of 80-90%. Double the UI maintenance, but each side is native-optimized. Getting monorepo tooling right takes a week of setup pain up front.

### Option C: The middle path — universal primitives, platform shells

One codebase using a universal styling/component layer (Tamagui or similar) that genuinely compiles to both CSS-on-web and StyleSheet-on-native. Navigation is platform-specific (Expo Router on mobile, Next.js routing on web) — sometimes glued together via Solito, sometimes kept independent. Business logic and screen components live in shared packages; app shells (entry points, navigation configs, route declarations) are per-platform.

**Works well when:** the team values long-term flexibility more than maximum day-one sharing, and when the UI library has genuine bi-platform excellence. This is how Meta internally approaches its apps, and it's where the industry is heading with React Strict DOM. React Strict DOM is Meta's unified approach to describing UI with React — it's not a replacement for React DOM or React Native, but is built on top of them, and lets teams develop a consistent product vision across platforms while still delivering platform-native experiences.

**Works poorly when:** you need deep customization that the universal library doesn't expose; when you need SSR (Tamagui can do it, but with caveats); when the learning curve for the universal library exceeds the time you have.

**Honest trade-off:** the middle path is real and viable, but it requires discipline. It's easy to accidentally drift into Option A (universal everything, cruft accumulates on web) or Option B (diverging screens, sharing drops to 30%). Treat the universal primitive layer as a contract, not a library.

### Decision framework (blunt version)

- **Mobile dominant, web is a "nice to have" secondary experience:** Option A. Get it shipping fast, accept web is the lesser experience.
- **Web and mobile are both primary, with different user workflows on each:** Option B. Pay the code-duplication tax; win on both form factors.
- **Web and mobile are both primary, with very similar user workflows on each:** Option C. Do it right, once.
- **You don't know yet and the product is young:** Option A, but use Expo Router, keep logic in `packages/` or hooks, avoid tightly coupling UI to screen files. You can evolve toward Option B or C later.

### What this document covers

The rest of this reference assumes **Option B or C** — meaning you have two real form-factor targets and you need to make both of them genuinely good. Option A is a legitimate choice but the guidance for it is mostly the first reference (§RN-UI) plus "test in a browser occasionally." The interesting and hard material is in making divergent experiences coherent, and that's what Options B and C force you to think about.

---

## 3. Baseline stack and monorepo layout

The stack below is the current defensible choice for Option B/C as of April 2026. Swap pieces only if you've read this document and have a specific reason.

### Monorepo infrastructure

**pnpm workspaces** (or Yarn Berry, or Bun — the choice matters less than picking one and sticking with it). pnpm's strict node_modules layout catches the phantom-dependency class of bugs that monorepos are famous for, and its disk savings are real on large monorepos.

**Turborepo** for build orchestration, caching, and task dependency graphs. Alternatives are Nx (more opinionated, better for very large monorepos) and Moon (newer, smaller community). Turborepo is the pragmatic middle — enough to matter, not so much you fight the tool.

**TypeScript** with project references, a root `tsconfig.base.json`, and per-package `tsconfig.json` that extends the base. Strict mode on. Every shared package exports its types.

### Mobile app

- **Expo SDK 55+** with the New Architecture on (default from SDK 52)
- **Expo Router 6+** for file-based routing with native feel — stack, native tabs, zoom transitions, typed routes
- **React Native 0.85+**
- Everything else from the first reference (Reanimated 4, RNGH 3, FlashList v2, @gorhom/bottom-sheet, expo-haptics, safe-area-context, screens)

### Web app

Pick one:

- **Next.js 16+** — the default for most teams. Server Components, SSR, image optimization, mature ecosystem. Pairs with EAS Hosting or Vercel for deployment. Next.js 16 uses Turbopack by default, though some integrations (Serwist for PWA) still require Webpack.
- **Vite + React Router 7** — lighter, faster dev server, no React Server Components story yet but not every app needs one. Good for dashboards, admin panels, and internal tools.
- **Remix (now React Router 7)** — nested routing and data loading that maps cleanly to mobile app patterns. Strong offline-first story.
- **Expo Router with `output: server`** — if Option A or C and you want everything in one tree. Expo Router has experimental support for server-side rendering as of SDK 55, previously only supporting static-site generation.

For Scribe specifically (field inspection tool with authenticated users, not public content), Vite + React Router or Next.js in app-router mode are both fine. Vite gets you moving faster; Next.js gives you more room to grow if you later want public marketing pages, embedded docs, or email-rendering with React.

### Shared packages

The `packages/` directory is where the value of a monorepo actually lives. A typical layout:

```
packages/
  ui/              # Universal components (if Option C)
  core/            # Business logic, domain models, pure functions
  api/             # API client, types, Zod schemas
  db/              # Drizzle/Prisma schemas, migrations, queries
  validation/      # Shared Zod schemas
  config/          # Shared configs (eslint, tsconfig, tailwind preset)
  design-tokens/   # Color, spacing, typography tokens
  features/        # Cross-platform feature modules (auth, inspections, etc.)
```

Not every package is necessary at day zero. Start with `core`, `api`, `validation`, and `design-tokens`. Add the others when they justify their existence.

### Apps directory

```
apps/
  mobile/          # Expo app, entry point, native config
  web/             # Next.js / Vite app, entry point, web config
  desktop/         # (optional) Electron or Tauri wrapping web
  docs/            # (optional) docs site for the product
```

Each app is thin — mostly entry points, routing, and app-shell code. The substantive work lives in `packages/`.

### Tooling baseline

- **Biome** for linting and formatting (faster than ESLint+Prettier, one tool, one config)
- **Syncpack** to keep dependency versions aligned across packages
- **Knip** to find unused dependencies and dead code
- **Changesets** for versioning internal packages (if any need semver)

### Why not just use an existing starter?

You can. `create-t3-turbo` is the best-known Next.js + Expo starter and it remains a reasonable choice (uses Solito for navigation primitives, tRPC for API, pnpm workspaces, Turborepo). The T3 Turbo stack uses Solito for navigation, which has driven meaningful adoption. It opts you into specific choices (tRPC, Clerk auth, Prisma) that may or may not fit. If they do, start there. If not, scaffold from scratch — the setup pain is real but it's a one-week cost, not recurring.

---

## 4. What to share, what to split

The central question of a universal architecture is not "how do I share code" but "where is the seam." Put the seam in the wrong place and you either share too little (and re-implement everything) or share too much (and fight the platform on both sides).

### The natural seams

**Always share:**

- Domain models and types (`Inspection`, `DefectRecord`, `PhotoAttachment`)
- Zod schemas (validation should run identically on both platforms and on the server)
- Pure business logic (scoring, grading, summary calculation, state machines)
- API clients (same fetch wrappers, same auth, same retry logic)
- Constants, enums, and lookup tables (ASTM defect codes, roofing assembly types, unit conversions)
- Error types and error-handling helpers
- Date/time utilities, formatting helpers, text utilities

**Usually share:**

- Feature-level state (Zustand stores, React Query configs, Jotai atoms)
- React Query / tRPC client setup and query definitions
- Authentication logic (session management, token refresh) — though the *storage mechanism* may differ (Keychain/Keystore on native, httpOnly cookies on web)
- Form state (React Hook Form + Zod resolvers work identically on both)
- Design tokens (colors, spacing scale, type scale, semantic tokens)

**Sometimes share, sometimes split:**

- Screen-level components — depends on whether mobile and web share the screen's information architecture
- Navigation configuration — share route *names* and params, split the actual configs (Expo Router config vs Next.js config)
- Icons — share the icon set choice, but iOS wants SF Symbols and web wants Lucide/Phosphor/etc.
- Haptics — available on mobile, mostly unavailable on web (the Vibration API exists but is janky)

**Always split:**

- Platform-specific integrations (push notifications, biometric auth, camera, native file pickers)
- Navigation UI (tab bars, sidebars, headers — these are *form-factor* specific, not just platform)
- Gesture handlers that use RNGH (no equivalent on web, though react-use-gesture exists)
- Entry points, bootstrap files, provider wrappers
- Layout code that uses screen real estate fundamentally differently

### The anti-pattern: "Universal" screens that aren't

A common failure mode is writing a screen component that *technically* renders on both platforms but feels wrong on one. Example: a list screen where each item is a card with a tap target for the detail view. On mobile this works. On desktop, it's wasteful — the user has a mouse, they want a dense table they can scan. A "universal" version that renders the same cards on both is a compromise that makes neither experience great.

The fix is to embrace divergence at the screen level. Export a `InspectionListScreen` from your shared feature package that's actually two different implementations — `InspectionListScreen.native.tsx` (cards, FlashList, pull-to-refresh) and `InspectionListScreen.web.tsx` (table, keyboard nav, column sorting, filter sidebar) — both backed by the same data-layer hook `useInspectionList()`. The hook is shared; the presentation is not.

This is what Solito's creator Fernando Rojo means by "shared code should not come at the cost of platform quality" — the shared parts are the data, state, and logic; the UI can and often should diverge.

### The pragmatic split for Scribe

- **Shared (90% of the code volume):** Inspection data model, defect catalog, ASTM classifications, photo metadata handling, sync engine, conflict resolution, report generation core logic, Zod schemas, API client, auth logic
- **Sometimes shared (10%):** Simple UI primitives (Button, Text, Card, Input) via Tamagui or hand-rolled primitives; form screens where mobile and web share the same information architecture
- **Split (UI volume, less code):** Navigation shells, list/grid screens, the report authoring workspace (desktop-only deep features), the field capture screen (mobile-only optimized for glove use)

---

## 5. Platform extensions and conditional rendering

Three mechanisms decide at runtime or build time which code executes on which platform. Use them in this priority order.

### File extensions (build-time, preferred)

Metro (mobile) and most web bundlers support platform-specific file extensions. Given:

```
Button.tsx         # the default / universal implementation
Button.native.tsx  # overrides on iOS and Android
Button.ios.tsx     # overrides only on iOS
Button.android.tsx # overrides only on Android
Button.web.tsx     # overrides on web
```

…the bundler picks the right file for the target platform. Importing `./Button` gets the most specific match. This is the cleanest approach — the code you don't need isn't in your bundle, and there's no runtime `if (Platform.OS === 'web')` noise.

Use file extensions when the implementation differs substantially (more than 10-20 lines of difference). If the divergence is smaller, use `Platform.select` inline.

Gotcha: make sure your bundler is configured. Metro handles `.native.tsx` out of the box. For Vite, use `vite-plugin-react-native-web` or configure `resolve.extensions`. For Next.js, configure webpack's `resolve.extensions` to include `.web.tsx` before `.tsx`. Solito 5's web-first approach — renders pure HTML plus Next.js components instead of RN-Web — uses `.native.tsx` files for platform-specific code rather than the older `index.web.tsx` pattern, which can simplify monorepo setups.

### Platform.select and Platform.OS (runtime)

For small divergences inline:

```tsx
import { Platform } from 'react-native';

const styles = {
  padding: Platform.select({ ios: 16, android: 14, web: 12, default: 14 }),
};

if (Platform.OS === 'web') {
  // web-only logic
}
```

On React Native Web, `Platform.OS === 'web'`. On native, it's `'ios'` or `'android'`. `Platform.select` with a `default` key is the safer pattern for code you want to maintain as new platforms (macOS, Windows, tvOS) are added.

Don't use `Platform.OS` for form-factor decisions — use viewport or container queries instead. `Platform.OS === 'web'` tells you the runtime environment; it does not tell you the user's screen size. A web app on an iPad is still web, but it's also a tablet.

### useMediaQuery and responsive hooks (runtime, for web primarily)

For responsive decisions — "is the viewport wide enough to show a sidebar?" — use a media query hook, not a platform check:

```tsx
const isDesktop = useMediaQuery('(min-width: 1024px)');
```

React Native Web ships `useWindowDimensions` and media queries work via the DOM. On native, `useWindowDimensions()` gives you width/height; you build breakpoint logic on top of it. Libraries like `react-native-web-hooks` or Tamagui's `useMedia()` provide a unified API.

### Avoid the worst pattern: scattered Platform.OS checks

The worst universal codebases are riddled with `if (Platform.OS === 'web')` and `if (Platform.OS === 'ios')` checks throughout screen components. The checks drift out of sync, tests only cover one branch, and every change risks breaking an unfamiliar platform.

Concentrate platform logic in:
1. File extensions (Button.web.tsx vs Button.native.tsx)
2. A single `platform/` directory of utilities (e.g., `platform/storage.ts` exports `getItem`/`setItem` that delegates to AsyncStorage on native, localStorage on web)
3. A thin layer at the edge (auth storage, navigation config, push notification setup)

Everywhere else, code should be platform-agnostic or obviously shared.

---

## 6. Layout fundamentals

The layout primitives you use on mobile and on web are *almost* the same — and the differences matter more than the similarities.

### Flexbox everywhere, with one twist

Both React Native and CSS implement Flexbox. React Native's implementation is Yoga, which is a subset of CSS Flexbox with one critical default change: **`flexDirection` defaults to `column` on React Native and `row` on web/CSS**. This bites everyone at least once.

In practice:

```tsx
// React Native — implicit column
<View style={{ gap: 8 }}>
  <Text>Line 1</Text>
  <Text>Line 2</Text>
</View>
// Stacks vertically. flexDirection is 'column' by default.

// CSS
<div style={{ display: 'flex', gap: 8 }}>
  <span>Inline 1</span>
  <span>Inline 2</span>
</div>
// Lays out horizontally. flexDirection is 'row' by default.
```

When you share layout code, be explicit: always set `flexDirection` when it matters. Don't rely on defaults.

### React Native only has Flexbox. Web has Flexbox and Grid.

CSS Grid is genuinely useful for desktop layouts — sidebars, dashboard grids, multi-column article layouts, card galleries with intrinsic sizing. React Native does not have Grid (Yoga has experimental grid in 2024-2025 but it's not exposed in RN). This is the first major divergence in layout capabilities.

For a universal app this means: use Flexbox for shared components; on the web app, reach for Grid when appropriate. If you find yourself hand-rolling Grid behavior in Flexbox on the web (columns that auto-wrap, explicit column templates), stop and use Grid.

A common desktop web pattern that has no clean native equivalent:

```css
.dashboard {
  display: grid;
  grid-template-columns: 260px 1fr 320px;
  grid-template-areas: "sidebar main detail";
  height: 100vh;
}
```

On mobile, this is just one column at a time (the "main" area), with sidebar and detail accessed via navigation. Don't pretend otherwise.

### Safe areas on mobile, safe areas on web

On mobile, safe-area insets are essential — the notch, home indicator, status bar, keyboard. Use `react-native-safe-area-context`'s `SafeAreaView` or `useSafeAreaInsets()`.

On web, "safe area" is a different beast: you're thinking about **viewport quirks** (mobile Safari URL bar, Android Chrome taskbar), **viewport units** (`100vh` is broken on mobile Safari, use `100dvh` for dynamic viewport height), and **desktop window chrome** (not your problem — the OS handles it).

Modern viewport units (2026):

- `100vh` — static viewport height; broken on mobile Safari because it doesn't account for the URL bar
- `100dvh` — dynamic viewport height; shrinks/grows with mobile browser chrome. Use this for app-shell layouts.
- `100svh` — small viewport (browser chrome shown); `100lvh` — large viewport (chrome hidden); use these for specific needs
- Support: Safari 15.4+, Chrome 108+, Firefox 101+ — essentially universal now

```css
.app-shell {
  height: 100dvh; /* correct */
  min-height: 100dvh;
}
```

### The viewport meta tag

On web, you must include this in your HTML head. Expo Router's default HTML template does this; Next.js does it via `metadata.viewport`. If you miss it, mobile browsers render the page at 980px and zoom out:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

`viewport-fit=cover` lets you use the full screen including notches, exposing `env(safe-area-inset-*)` CSS variables.

### env() for safe areas on web

When your web app runs on a mobile browser and you want to respect iPhone-style safe areas (PWA in standalone mode, for example), use CSS env variables:

```css
.toolbar-bottom {
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
```

On desktop these evaluate to zero and the `max()` fallback takes over. Clean.

### Container dimensions vs viewport dimensions

In universal code, prefer container-relative sizing over viewport-relative sizing. A card that sizes to its container works when placed in a sidebar; a card that sizes to the viewport doesn't. This is the fundamental argument for container queries (§8), and it extends to pre-container-query layouts: use `%`, `flex`, and `auto` more than `vw`.

### Absolute positioning is identical but think before you use it

`position: absolute` works the same way on both (relative to the nearest positioned ancestor, which is the whole tree in React Native unless a parent has `position: relative`). On web, `position: fixed` and `position: sticky` exist and are useful for headers and footers; on React Native, you achieve similar effects with `zIndex` and manual layout in a wrapper. Modals and overlays are better served by the platform's purpose-built components (§15) than by absolute positioning.

---

## 7. Responsive: breakpoints, container queries, fluid units

The core responsive toolkit has three layers. Use all three.

### Layer 1: fluid units between breakpoints

Fluid means the layout adapts continuously, not in steps. The primary tools:

- `%` widths for elements that should fill their parent proportionally
- `flex: 1` for elements that should absorb leftover space
- `clamp(min, preferred, max)` for values that should scale but within bounds
- `rem` for typography and spacing that should respect user font-size preferences
- `min()` and `max()` for clamping specific values

Fluid typography that scales with viewport:

```css
/* web */
body { font-size: clamp(16px, 1vw + 14px, 20px); }
h1   { font-size: clamp(1.75rem, 4vw + 1rem, 3rem); }
```

`clamp()` is not available in React Native's `StyleSheet` directly, but Tamagui and Unistyles provide equivalents, or you compute responsive values via `useWindowDimensions` and interpolate.

Practical fluid sizing ratios (the "perfect 5th" typography scale, for example: 1.25×) keep text readable on small screens and dignified on large ones. Don't hand-tune every breakpoint — pick a scale, stick to it.

### Layer 2: breakpoints for structural changes

Use breakpoints only where the layout structure itself changes — sidebar appears, columns change count, nav collapses to drawer. Don't use breakpoints for every small tweak; fluid units handle those.

Mobile-first breakpoints (the recommended approach — write base CSS for small screens, add complexity at larger viewports):

```css
/* base: mobile phone, ~320–640px */
.app { padding: 16px; }

/* tablet portrait */
@media (min-width: 600px) {
  .app { padding: 24px; }
}

/* small desktop / tablet landscape */
@media (min-width: 1024px) {
  .app { padding: 32px; display: grid; grid-template-columns: 260px 1fr; }
}

/* large desktop */
@media (min-width: 1440px) {
  .app { max-width: 1600px; margin: 0 auto; }
}
```

The 2026-standard ranges (though best practice emphasizes content-driven breakpoints rather than device-specific ones):

- **320–430px**: mainstream smartphones — flagship devices sit in this sweet spot
- **600–720px**: foldables and mini-tablets — Samsung Z Fold, iPad Mini portrait
- **768–1023px**: tablets portrait, some phones landscape
- **1024–1279px**: small laptops, tablet landscape
- **1280–1536px**: standard desktops
- **1536–2560px**: large desktops
- **2560px+**: ultra-wide and 4K — forgotten zone; max-width containers are essential to prevent text from stretching across a 34" monitor

Set max-widths on content containers for very wide screens. Reading line lengths should stay at 65–75 characters regardless of viewport; an unbounded paragraph on a 4K monitor is unreadable.

### On React Native

There's no media query system in core RN. You build one:

```tsx
import { useWindowDimensions } from 'react-native';

const BREAKPOINTS = { sm: 600, md: 1024, lg: 1280, xl: 1536 };

function useBreakpoint() {
  const { width } = useWindowDimensions();
  if (width >= BREAKPOINTS.xl) return 'xl';
  if (width >= BREAKPOINTS.lg) return 'lg';
  if (width >= BREAKPOINTS.md) return 'md';
  if (width >= BREAKPOINTS.sm) return 'sm';
  return 'base';
}
```

Or use the styling library: Tamagui's `$gtMd` variants, NativeWind's `md:` prefix, Unistyles' breakpoint tokens. Each does roughly the same thing under the hood.

On React Native, these "breakpoints" respond to the app window — which on tablets is the full screen, on phones is the full screen, and on split-screen tablets or Samsung DeX mode may be less. `useWindowDimensions()` updates reactively on rotation and window resize.

### Layer 3: container queries for components

Media queries respond to viewport width. **Container queries** respond to the width of a parent element. This is a profound difference for component design.

Consider a card component placed in three different contexts: a hero area (full width), a two-column grid (half width), a sidebar (narrow). With media queries alone, the card has no way to know its available space — it only knows the overall viewport. Container queries let the card react to the space it actually occupies.

Container queries have been CSS Baseline since 2023, with over 90% global browser support as of 2026. They should be part of your default toolkit.

```css
.card-container {
  container-type: inline-size;
  container-name: card;
}

@container card (min-width: 400px) {
  .card { display: grid; grid-template-columns: 120px 1fr; gap: 16px; }
}

@container card (min-width: 600px) {
  .card { grid-template-columns: 180px 1fr auto; }
}
```

Tailwind 4+ supports them natively via `@container`, `@sm:`, `@md:` variants.

On React Native, there's no native equivalent — you'd use `onLayout` to measure the container and conditionally render. Tamagui has a `<Container>` primitive with media queries scoped to its size on web only. This is one of the capabilities that simply doesn't cross over cleanly; if the component's responsive behavior depends on container queries, split it.

### When to reach for which

- Tweaking a font size, padding, or gap as the screen gets larger → fluid units (`clamp()`, `rem`)
- Hiding or showing a sidebar, switching to a drawer, changing column count at the page level → media queries / viewport breakpoints
- A component's layout changing based on the space IT occupies (not the page) → container queries (web only)
- Swapping interaction paradigms (mouse vs touch, keyboard nav on/off) → media feature queries (`@media (hover: hover)`, `@media (pointer: fine)`) — web only, see §11

---

## 8. Container queries in depth (web)

Because they change how universal components can be built, container queries deserve a section of their own. They are the single biggest CSS layout improvement since Flexbox.

### Why they matter

A media query says "when the viewport is 1024px+, show two columns." A container query says "when this component has 600px+ available, show two columns." The second is what you actually want for reusable components.

Consider Scribe's inspection item row. In three contexts:

1. Phone: viewport 390px, the row occupies ~360px. Shows: photo thumbnail stacked above details.
2. Tablet landscape with two-pane layout: viewport 1280px, but the row is in a 480px list pane. Shows: photo inline with details, comfortable spacing.
3. Desktop with three-pane layout: viewport 1920px, but the row is in a 360px list pane. Shows: same as phone — it's narrow, regardless of viewport.

Media queries can't handle case 3 correctly. Container queries can. The row adapts to its pane width, not the viewport.

### Container syntax in 2026

```css
/* The parent establishes a containment context */
.pane {
  container-type: inline-size;  /* or 'size' for both width and height */
  container-name: pane;         /* optional; default is anonymous */
}

/* Child styles respond to the container */
@container pane (min-width: 500px) {
  .item { display: grid; grid-template-columns: 80px 1fr 120px; }
}

@container pane (max-width: 499px) {
  .item { display: flex; flex-direction: column; }
}
```

`inline-size` is almost always what you want — it only responds to width, not height, which is both cheaper and matches how most layouts work.

### Tailwind integration

```jsx
<div className="@container">
  <div className="@md:grid @md:grid-cols-2 @lg:grid-cols-3">
    {/* lays out based on the parent @container, not the viewport */}
  </div>
</div>
```

Named containers: `@container/sidebar`, then `@md/sidebar:text-lg`. Read Tailwind's docs — the ergonomics are good.

### React Native status

React Native does not have container queries. The closest pattern is:

```tsx
function ResponsiveRow({ children }) {
  const [width, setWidth] = useState(0);
  const isWide = width >= 500;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {isWide ? <WideLayout>{children}</WideLayout> : <NarrowLayout>{children}</NarrowLayout>}
    </View>
  );
}
```

This works but has two hitches: the first render happens at zero width before layout, causing a visible flicker; and re-measuring on every layout change thrashes if many siblings do it. Memoize the breakpoint result, and consider a single measurement at the top of a screen that provides context downward via React Context.

For true container-query parity on mobile, you'd want container query support in Yoga (proposed but not shipped). For now, accept that this is a capability gap — design components that don't *need* container queries on mobile (use layout breakpoints instead), or split implementations per platform.

---

## 9. Fluid typography and the spacing system

Consistent scale across platforms is a quiet superpower. Without it, the web version and the mobile version of your app feel like siblings who got different parents.

### The type scale

Pick a modular scale and apply it everywhere. A 1.25 (major third) scale works well for most apps:

```ts
const typeScale = {
  xs:   12,  // captions, labels
  sm:   14,  // secondary body
  base: 16,  // body
  md:   18,  // emphasized body
  lg:   20,  // subheadings
  xl:   24,  // section headers
  '2xl': 30, // page titles
  '3xl': 38, // hero / display
  '4xl': 48, // feature / landing
};
```

Apply these tokens everywhere — shared design tokens package, consumed by both the mobile and web apps. If your mobile app uses `body` and your web app uses `16px`, they're probably the same number but any drift will silently appear as typographical weirdness.

### Fluid typography with clamp()

On web, typography should scale between breakpoints. The formula:

```css
font-size: clamp(MIN, PREFERRED, MAX);
```

Where `MIN` is the smallest you'll ever go, `MAX` is the largest, and `PREFERRED` is a viewport-dependent value. Tools like `utopia.fyi` generate the formula for you.

For a body text scale of 16→20px over viewport widths 400→1600px:

```css
body { font-size: clamp(1rem, 0.833rem + 0.417vw, 1.25rem); }
```

On mobile, you usually pick ONE size per token for consistency — fluid typography doesn't matter as much on mobile because the viewport range is narrow. Keep `body` at 16 on mobile; let it scale on web.

### Line height and line length

Line height should scale inversely with font size — tight for large, loose for small:

```ts
const lineHeights = {
  tight: 1.1,   // for display / hero
  snug: 1.25,   // for headings
  normal: 1.5,  // for body
  relaxed: 1.625, // for long-form reading
};
```

Line length for long-form prose: **65–75 characters**. On desktop, this means explicit `max-width` on text containers. 65ch is a good shorthand. On mobile, the viewport takes care of it — the screen is narrow enough that line length is fine.

### The spacing scale

Same principle. Pick a scale (usually 4px-based or 8px-based) and use tokens everywhere:

```ts
const spacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
};
```

Tailwind's default is close to this; NativeWind inherits it; Tamagui lets you define your own; Unistyles lets you define tokens. Reuse the same scale.

### Rem on web, px on native (but the same tokens)

Web should use `rem` for typography and spacing so user font-size preferences are respected. `1rem` typically = `16px` but if a user sets their browser to 20px base, everything scales. This is an accessibility requirement, not a preference.

React Native doesn't have `rem`. Values are in density-independent pixels (dp on Android, points on iOS), which are already size-adjusted for device pixel density but not for user text preferences — though iOS Dynamic Type and Android font scale handle that separately (§RN-UI.17).

So: a design token like `spacing.4 = 16` is `16px` on web (written as `1rem` if you prefer) and `16dp` on native. Same conceptual value, same token name, correct on both.

### Dynamic Type on web (user font scaling)

If you want to honor user font-size preferences on web (which you should, for accessibility):

```css
html { font-size: 100%; } /* respects browser preference */
body { font-size: 1rem; } /* scales with the above */
```

Never hard-code `html { font-size: 16px }` — that disables user preferences. Use percentages or omit entirely.

---

## 10. Styling across platforms

This extends and sharpens §RN-UI.15. On a universal project the styling choice matters more — a library that works brilliantly on React Native but stumbles on web is a poor fit, and vice versa.

### The honest comparison

Four serious options for universal styling as of 2026:

| Library | Native perf | Web perf | Universal parity | Compile time | Ecosystem |
|---------|------------|----------|------------------|--------------|-----------|
| **Tamagui** | Excellent (compiled) | Excellent (compiled to atomic CSS) | True universal, same component targets both | Real benefit | Growing, ~90k weekly |
| **NativeWind** | Excellent (compiled to StyleSheet) | Good (Tailwind) | Strong; Tailwind semantics on both | Real benefit | Huge via Tailwind, ~517k weekly |
| **Unistyles** | Excellent (native C++ parser in v3+) | Good | Good; both platforms supported | Minimal | Growing, ~68k weekly |
| **Shopify Restyle** | Excellent | Via RN-Web | Native-focused; web works via compat | Minimal | Smaller, TypeScript-first |

Plus non-universal options:

- **StyleSheet.create + CSS Modules** — two different styling systems per platform, typed tokens shared. Fine if you're comfortable writing styles twice.
- **StyleX** (Meta) — web-only for now, but underpins React Strict DOM
- **Vanilla Extract / Panda CSS** — web-only, great options if you're doing Option B with a separate web app

### Picking for a universal app

**If you want one codebase and maximum UI sharing (Option A/C):** Tamagui. Its optimizing compiler flattens styled components into simple divs with atomic CSS on web — similar to a utility-first framework but with component-based flexibility. On native it optimizes style objects to reduce runtime overhead. It's the only universal solution where the same component works on React Native and Next.js without conditional logic. Learning curve is real; budget a week.

**If your team knows Tailwind and wants that ergonomic on mobile too:** NativeWind. Uses Metro transformer at build time; output is compiled StyleSheet objects with performance equivalent to native. Tailwind's breakpoint and container-query systems work. Less powerful for complex theming than Tamagui, but dramatically easier to adopt.

**If you want fast, small, and unopinionated:** Unistyles 3.x — native C++ StyleSheet parser, no runtime bridge, works with the New Architecture. Low-level; you build your own system.

**If you're doing Option B (separate apps):** different tools per platform is fine. Tailwind on web, NativeWind on mobile — they're compatible, using the same class names for shared primitives. Or CSS Modules + Vanilla Extract on web, StyleSheet + Restyle on mobile. Share only the tokens.

### The Tamagui deep cut

If you pick Tamagui, two patterns make it shine and two make it painful.

**Make it shine:**

1. **Define tokens once in tamagui.config.ts.** Colors, spacing, radii, font scales, themes. Every component consumes tokens; no hard-coded values.
2. **Use `styled()` for variant-heavy components.** Buttons, badges, status chips — components that have a dozen combinations. Tamagui's variant system is its superpower.
3. **Use media variants (`$gtMd`, `$gtLg`) for responsive styles inline.** Cleaner than managing breakpoints externally.
4. **Let the compiler do its job.** Run the optimizing compiler in production builds. Check the output on web — you should see tree-flattened divs with atomic CSS classes, not deeply-nested `<div>` trees.

**Make it painful:**

1. Dynamic runtime-computed styles that the compiler can't analyze — you lose the optimization, and your bundle fills with string concatenation
2. Mixing Tamagui components with bare RN primitives at arbitrary levels — causes inconsistent behavior, especially for props that Tamagui intercepts (like `onPress`)

### The NativeWind path

For teams familiar with Tailwind, NativeWind is almost always the right first choice for the mobile side. Setup:

```bash
npx expo install nativewind tailwindcss react-native-reanimated react-native-safe-area-context
```

Configure `tailwind.config.js` with a shared preset from your `packages/config/` so mobile and web use the same Tailwind theme. Then className props work directly:

```tsx
<View className="flex-row items-center p-4 bg-white rounded-xl shadow-md">
  <Text className="text-base font-semibold text-gray-900">Inspection #142</Text>
</View>
```

The gotchas:

- Not every Tailwind class has an RN equivalent (e.g., `hover:` on native doesn't do anything; gradients need NativeWind v4's specific syntax). Stick to the documented subset.
- Responsive prefixes (`md:`, `lg:`) work and reference viewport breakpoints. Container queries (`@md:`) work on web but not on native.
- Dark mode works via Tailwind's `dark:` prefix; configure a system-preference detector (`useColorScheme`).

### React Strict DOM: the near-future

React Strict DOM (RSD) is Meta's official universal API. It flips the direction: instead of translating React Native to web (RN-Web's approach), RSD defines a web-like API and translates to React Native on native. Strict HTML components are type-safe, tightly integrated with cross-platform styling, and exclude legacy attributes. Styles are defined with `css.create()` (powered by StyleX on web).

```tsx
import { html, css } from 'react-strict-dom';

const styles = css.create({
  button: {
    backgroundColor: { default: 'lightgray', ':hover': 'lightblue' },
    paddingBlock: '0.5rem',
    paddingInline: '1rem',
  },
});

function Button(props) {
  return <html.button {...props} style={styles.button} />;
}
```

RSD is used in production at Meta — rendering web components using React Native on VR for Facebook and Instagram, with hundreds of web components converted — but for external teams, it's still maturing. Not every web API is polyfilled on native yet. Production readiness is closer to "safe for greenfield projects" than "production proven at scale."

Strategic recommendation: if you're starting a universal app in 2026, either:
- **Use NativeWind or Tamagui now** (safe, well-supported) and plan to migrate later
- **Prototype with RSD now** (future-proof, but rough edges) if you can tolerate some instability
- **Use RSD for new components in a mature app**, via the `.native.tsx` / `.web.tsx` gradual-adoption path

### Design tokens: the real universal primitive

Regardless of styling library, the highest-leverage thing you can do is extract all design decisions into a tokens package:

```ts
// packages/design-tokens/src/index.ts
export const colors = {
  // Neutrals
  gray: { 50: '#F9FAFB', 100: '#F3F4F6', /* ... */ 900: '#111827' },
  // Brand
  primary: { 50: '#EFF6FF', /* ... */ 900: '#1E3A8A' },
  // Semantic
  surface: { /* maps to gray in light mode, inverted in dark */ },
  text: { primary: '...', secondary: '...', disabled: '...' },
};

export const spacing = { /* the 4px scale from §9 */ };
export const radii = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 };
export const typography = { /* the scale from §9 */ };
```

Consumed by Tamagui config, Tailwind preset, StyleSheet.create, CSS variables — all of them. One source of truth, every platform.

---

## 11. Navigation across form factors

This is where the biggest divergence happens. The core idea: navigation is the expression of information architecture, and information architecture changes with form factor.

### The canonical patterns

**Phone (≤600px):**
- Tab bar at bottom (3–5 top-level destinations)
- Stack navigation within each tab
- Modals full-screen or as sheets (§15)
- Back: edge swipe (iOS) or back button (Android)

**Tablet portrait (600–899px):**
- Still mostly phone-like, but more room for content density
- Bottom tabs still work; consider larger touch targets and two-column content within screens
- Split views are marginal; most tablet portrait experiences work as scaled-up phone

**Tablet landscape / small laptop (900–1279px):**
- Master-detail split views become the right default (list on left, detail on right)
- Sidebar navigation appears (permanent or collapsible)
- Tab bars move to the top-left as a rail with icons
- Modals become dialog-sized, not full-screen

**Desktop (≥1280px):**
- Full sidebar navigation (permanent)
- Three-column layouts (nav | list | detail) are common
- Modals are smaller still, centered with backdrop
- Keyboard shortcuts and command palette become primary navigation tools for power users (§12)

### Implementing this divergence

Two strategies.

**Strategy 1: same app structure, different shells per platform.**

In Option A (one codebase), define your navigator at the platform level:

```
apps/mobile/app/
  _layout.tsx                 # native tabs
  (tabs)/
    _layout.tsx               # tab bar
    inspections/
      _layout.tsx             # stack within tab
      index.tsx               # list
      [id].tsx                # detail

apps/web/app/
  layout.tsx                  # sidebar + content
  inspections/
    layout.tsx                # list-detail split
    page.tsx                  # list view (mobile) or detail panel (desktop)
    [id]/page.tsx             # detail view
```

Same URLs, same routes, different navigation chrome. Use `_layout.web.tsx` overrides in Expo Router to customize the web layout if using Option A.

**Strategy 2: different navigation libraries per platform.**

In Option B:

- Mobile: Expo Router or React Navigation 7 directly
- Web: Next.js App Router or React Router 7

Routes, URLs, and param shapes should match as closely as possible. Solito helps glue them together — its primitives like Link and typed routes adapt to both environments, while when needed, platform-specific `.native.tsx` / `.web.tsx` files allow for fine-grained behavior without fragmenting the codebase.

### Responsive navigation within a web app

The web app alone has to adapt from phone browsers to 4K monitors. The standard progression:

```tsx
function AppShell({ children }) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isTablet = useMediaQuery('(min-width: 768px)');

  if (isDesktop) return <DesktopShell>{children}</DesktopShell>;
  if (isTablet) return <TabletShell>{children}</TabletShell>;
  return <MobileShell>{children}</MobileShell>;
}
```

Each shell handles its own navigation:

- MobileShell: bottom tab bar + optional drawer
- TabletShell: top nav rail (collapsed sidebar) + content
- DesktopShell: permanent sidebar + content + optional right panel

Define these as separate components. Don't try to make one "responsive shell" that does everything; it becomes unmaintainable.

### Master-detail on desktop

The master-detail pattern is where the web version pulls ahead on productivity. On phone, you tap an item and navigate to its detail page. On desktop, you click an item and the detail appears in the right pane — no navigation, no context loss.

```tsx
function InspectionsPage() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!isDesktop) {
    // mobile: route-based
    return <InspectionList onSelect={(id) => router.push(`/inspections/${id}`)} />;
  }

  return (
    <div className="grid grid-cols-[400px_1fr] h-full">
      <InspectionList selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId ? <InspectionDetail id={selectedId} /> : <EmptyState />}
    </div>
  );
}
```

The selected item can be reflected in the URL via query params (`?id=142`) so back-forward and bookmarking work. Next.js parallel routes and intercepting routes give you this pattern built-in.

### Sidebar design

A good desktop sidebar has:

- Collapsible to icon-only mode (save screen real estate)
- Persistent selection indicator (current section highlighted)
- Keyboard navigable (arrow keys or tab to move between items)
- Sectioned groups (dividers between related items)
- User/account menu at the bottom
- Optional search at the top

Examples to emulate: Linear's sidebar, GitHub's sidebar, Vercel's dashboard. Study the details — the hover states, the collapsed-state tooltips, the keyboard shortcuts.

### The drawer on mobile, not on desktop

A hamburger-menu drawer on mobile is a reasonable pattern (though inferior to a tab bar if you can fit one). A hamburger menu on desktop — hiding the primary navigation behind a click — is almost always wrong. Desktop users want the nav visible. Show it.

### Tab bar on desktop?

Usually no. Bottom tabs are a phone-ergonomic solution to the "users' thumbs can't reach the top of the screen" problem. On desktop, that's not a problem, and bottom tabs waste prime vertical space. If you have a bottom tab bar on mobile, on desktop that content should move to the sidebar, top nav, or rail — wherever it fits the desktop information architecture.

---

## 12. Interaction models — touch, mouse, keyboard unified

The first reference covered touch deeply (§RN-UI.4–8). On a universal app, you also have mouse and keyboard as primary inputs. Handling all three coherently is the core interaction-design problem of universal apps.

### Feature detection for input type

CSS media features let you detect input capability:

```css
@media (hover: hover) { /* devices where hover is a true signal (mouse, trackpad) */ }
@media (hover: none)  { /* touch devices */ }
@media (pointer: fine)   { /* precise input — mouse, stylus */ }
@media (pointer: coarse) { /* imprecise input — touch */ }
@media (any-hover: hover) { /* any connected input can hover — e.g., tablet with mouse attached */ }
```

Use these instead of viewport width to decide interaction patterns. A phone in landscape at 900px is still touch-first; a small 11" laptop at 900px is mouse-first. Viewport width and input type are correlated but not identical.

JavaScript detection via `window.matchMedia`:

```ts
const isHoverCapable = window.matchMedia('(hover: hover)').matches;
const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
```

### Pointer events (the unified API)

Legacy mouse events (`mousedown`, `mouseup`, `click`) and touch events (`touchstart`, `touchend`) have largely been superseded by **pointer events** (`pointerdown`, `pointerup`, `pointermove`). Pointer events fire for mouse, touch, stylus, and pen — same handler, different `pointerType` property.

```tsx
<div
  onPointerDown={(e) => console.log(e.pointerType)} // 'mouse' | 'touch' | 'pen'
  onPointerUp={handleRelease}
/>
```

React Native Web translates `Pressable` and the Gesture Handler primitives to pointer events under the hood. In shared universal code, stick to `Pressable` and gesture composition from react-native-gesture-handler; they do the right thing on both platforms.

For web-specific interactions (drag-and-drop, right-click), drop down to native pointer events.

### Hover state

Hover is the primary mouse-over signal on desktop. It's the key feedback mechanism for discoverability ("this element is interactive"). Use it liberally — every interactive element should change in some visible way on hover.

```tsx
// Pressable on RN supports hover state (RN 0.69+)
<Pressable
  style={({ hovered, pressed }) => [
    styles.base,
    hovered && styles.hover,
    pressed && styles.press,
  ]}
>
  ...
</Pressable>
```

On React Native, `hovered` works on web (via RN-Web) and on platforms with attached pointers (iPad + keyboard/mouse, macOS Catalyst). It's a no-op on touch-only native.

Hover should be subtle — a shade change, a shadow intensity bump, a border color shift. Not dramatic. The user is just exploring.

### Focus state (critical, often missed)

Focus is the keyboard equivalent of hover. It must be visible and distinct. A focused button should look meaningfully different from a non-focused button.

On web, browsers provide default focus rings (blue outlines on Chrome, system colors on macOS). Don't remove them unless you replace them with something better. A common anti-pattern: `outline: none` without a custom focus indicator, which destroys keyboard accessibility.

Use `:focus-visible` on web — it applies focus styles only when keyboard-focused, not on mouse click:

```css
.button { outline: none; }
.button:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
```

On React Native Web, `focusStyle` and `focusedStyle` props on RN-Web versions, or the `&:focus-visible` via CSS-in-JS.

### Touch feedback vs mouse feedback

Same element may need different feedback by input type:

- **Touch:** press-in animation (scale 0.97), optional haptic (§RN-UI.11). No hover state needed.
- **Mouse:** hover state on mouseover, pressed state on click. No haptic.
- **Keyboard:** focus ring when focused. On space/enter, visual press confirmation.

All three can be layered on one component:

```tsx
<Pressable
  style={({ hovered, pressed, focused }) => [
    styles.base,
    hovered && styles.hover,
    pressed && styles.press,
    focused && styles.focus, // if the runtime supports focus state
  ]}
  onHoverIn={/* ... */}
  onPress={/* ... */}
>
```

Stack the states — don't make them mutually exclusive.

### Right-click and long-press: the same intent, different inputs

On desktop, "show me more options" is a right-click. On mobile, it's a long-press. Same mental model. The reveal UI is the same — a menu of contextual actions.

```tsx
function ItemRow({ item }) {
  // Mobile: long-press to open context menu
  const longPress = Gesture.LongPress()
    .minDuration(500)
    .onStart(() => openContextMenu(item));

  // Web: right-click
  const onContextMenu = (e) => {
    e.preventDefault();
    openContextMenu(item, { x: e.clientX, y: e.clientY });
  };

  return (
    <GestureDetector gesture={longPress}>
      <Pressable onContextMenu={onContextMenu}>
        {/* ... */}
      </Pressable>
    </GestureDetector>
  );
}
```

The Zeego library (by Solito's author) provides universal native menus including right-click on web, long-press on mobile, and native iOS UIMenu / Android popup — worth considering if context menus are heavy in your app.

### Drag and drop

Web supports drag and drop natively (`draggable` attribute, DataTransfer API, or libraries like dnd-kit / react-dnd). It's mouse-first but touch-capable on modern browsers.

On mobile, drag is done via pan gestures (§RN-UI.8) — not "drag and drop" in the DataTransfer sense.

Don't try to make these universal; they're different operations. A desktop drag-drop file upload has no mobile equivalent (use a file picker on mobile); a mobile swipe-to-reorder list has no drag-and-drop equivalent on web (but can be replicated with dnd-kit).

### Multi-select

On mobile, multi-select typically requires an explicit mode — long-press to enter select mode, then tap to add/remove items, with a checkbox visible on each row (§RN-UI.5). On desktop, multi-select is ambient — Cmd/Ctrl+click to add to selection, Shift+click for range selection, Cmd+A for select all.

The actions menu that appears when items are selected is similar on both (batch delete, batch tag, export selected). The entry into multi-select mode is fundamentally different.

---

## 13. Keyboard navigation and shortcuts

A desktop web app that doesn't work without a mouse is not a professional tool. A mobile app doesn't need full keyboard nav (though accessibility via external keyboards is required — see §23), but any companion desktop app does. Getting this right is one of the single biggest differentiators between "website" and "serious tool."

### Focus order

The fundamental requirement: Tab moves focus forward, Shift+Tab moves it backward, and the order must be logical — top-left to bottom-right, skipping hidden or disabled elements.

This is mostly automatic if you use semantic HTML. `<button>`, `<a>`, `<input>`, `<select>`, `<textarea>` are all focusable by default. `<div>` and `<span>` are not — if you use them as interactive elements (which is what React Native Web does by default), you must add `tabIndex={0}` and `role="button"` (or appropriate role).

Pressable from RN-Web handles this, but only if you've set `accessibilityRole`. Always set `accessibilityRole="button"` on interactive Pressables; it becomes `role="button"` in the DOM and makes the element keyboard-focusable and announced correctly.

To exclude an element from tab order: `tabIndex={-1}` on web, or `accessible={false}` on RN (with caveats — see §RN-UI.17).

### Focus trap for modals

When a modal or dialog opens, keyboard focus must be trapped inside it. Tab from the last element in the modal should wrap to the first; Shift+Tab from the first should wrap to the last. Escape should close the modal and return focus to the element that opened it.

Implementing a focus trap correctly is subtle — use a library. `react-focus-lock` or `@radix-ui/react-dialog` do this well on web. @gorhom/bottom-sheet handles it on mobile (iOS/Android respect keyboard events for accessibility but don't need a visual focus trap to the same degree).

### Arrow-key navigation within components

Inside a component like a menu, list, or radio group, arrow keys should move between items. Tab should not — it should move to the next component. This is the "roving tabindex" pattern.

Example: a list of inspections, each item focusable:

- Tab: enters the list (focuses the first item)
- Arrow Down/Up: moves between items
- Enter/Space: opens the focused item
- Tab again: leaves the list, moves to the next focusable region

Radix UI, React Aria, and Ark UI implement this correctly. Rolling your own is a gauntlet of edge cases — don't.

### Keyboard shortcuts

Shortcuts turn a usable tool into a fast tool. Desktop users expect them; power users require them.

Guidelines:

- **Single-key shortcuts** for frequent actions in text-free contexts (list view, canvas). Gmail does this well — `j`/`k` for navigate, `e` for archive, `#` for delete.
- **Cmd/Ctrl + letter** for modal/global actions: ⌘S save, ⌘N new, ⌘F find, ⌘K command palette, ⌘/ shortcuts help
- **Shift + arrows** for selection extension in lists
- **Esc** to dismiss modals, cancel edits, exit modes
- Use **⌘ on Mac, Ctrl on Windows/Linux** — libraries normalize via `event.metaKey || event.ctrlKey`, or simply `event.key` + detection

Use a library for this too. `react-hotkeys-hook` is the pragmatic choice. `tinykeys` if you want something smaller.

```tsx
import { useHotkeys } from 'react-hotkeys-hook';

function InspectionList() {
  useHotkeys('n', () => createNew());
  useHotkeys('mod+k', () => openCommandPalette()); // 'mod' = Cmd on Mac, Ctrl elsewhere
  useHotkeys('mod+f', (e) => { e.preventDefault(); focusSearch(); });
  // ...
}
```

Show shortcuts in tooltips (`⌘K` next to the command palette trigger), in the command palette itself, and in a dedicated keyboard-shortcuts help modal (conventionally triggered by `?` or `⌘/`).

### Platform convention for shortcut symbols

Mac users see `⌘ ⌥ ⇧ ⌃` (Command, Option, Shift, Control). Windows/Linux users see `Ctrl` `Alt` `Shift`. Detect the platform and render accordingly:

```tsx
const isMac = navigator.platform.toLowerCase().includes('mac');
const modKey = isMac ? '⌘' : 'Ctrl';
```

React Aria has built-in utilities for this. As does `detect-mac` or similar micro-packages.

### Command palette (⌘K)

The command palette is the single most effective productivity feature for a desktop app. Linear's is the gold standard; Raycast, Superhuman, Notion, Figma all have them. Command palettes solve the tension between feature-rich applications and clean interfaces — instead of cluttering screens with buttons and menus, they consolidate functionality into a searchable, keyboard-driven interface that appears on demand.

A command palette is:

- Triggered by ⌘K (primary; standard)
- An overlay centered on the screen
- A search input + filtered list of actions
- Actions include: navigate to screen, trigger an operation, open a recent item, search content
- Fully keyboard-navigable (arrow keys, enter to execute, esc to close)
- Fuzzy-searchable by command name

For React, use **cmdk** (by Paco Coursey, adopted by shadcn/ui and many others). It's unstyled and composable; style it to match your app. Typical structure:

```tsx
<Command.Dialog open={open} onOpenChange={setOpen}>
  <Command.Input placeholder="Type a command or search..." />
  <Command.List>
    <Command.Empty>No results.</Command.Empty>
    <Command.Group heading="Actions">
      <Command.Item onSelect={newInspection}>New inspection</Command.Item>
      <Command.Item onSelect={exportReport}>Export report</Command.Item>
    </Command.Group>
    <Command.Group heading="Navigate">
      <Command.Item onSelect={() => router.push('/settings')}>Settings</Command.Item>
    </Command.Group>
    <Command.Group heading="Recent inspections">
      {recent.map(i => <Command.Item key={i.id} onSelect={() => open(i)}>{i.name}</Command.Item>)}
    </Command.Group>
  </Command.List>
</Command.Dialog>
```

Register commands from across the app via a provider/hook so each feature area contributes its own commands.

On mobile, a command palette is less essential (no keyboard for search) but can still appear as a search modal. If your mobile app doesn't have one, that's fine — it's a desktop power-user feature.

### The question mark: shortcut help

Pressing `?` (or `⌘/`) should open a keyboard shortcuts cheat sheet. This is a near-universal convention (Gmail, GitHub, Linear, Slack). Even if your shortcut list is small, implementing this creates the expectation of depth.

---

## 14. Forms across form factors

Forms are deceptively divergent. A form that works great on a phone often feels wasteful on a desktop, and vice versa. The underlying data model is identical; the presentation and interaction differ more than first-timers expect.

### The shared foundation

React Hook Form + Zod resolvers work identically on both platforms. The form state, validation, submission logic — all shared:

```ts
// packages/features/inspections/hooks/useInspectionForm.ts
export function useInspectionForm(defaultValues?: Partial<InspectionForm>) {
  return useForm<InspectionForm>({
    resolver: zodResolver(inspectionSchema),
    defaultValues,
    mode: 'onBlur',
  });
}
```

Both apps import this hook. The screen components render different UIs around it.

### Mobile form patterns

- **One field per screen** for long forms (wizard pattern). Reduces overwhelm; handles keyboard expansion cleanly. Navigation via next/back buttons.
- **Vertical stack** of fields when short (<5). Full-width inputs.
- **Large touch targets** (min 44pt per §RN-UI.4). Input height ~48–56dp.
- **Keyboard management**: auto-advance between fields on enter/next; `KeyboardAvoidingView` wraps the form; scroll to focused input.
- **Inline validation** on blur, not on every keystroke (too noisy). Show errors below the field.
- **Autofill and autocomplete**: set `autoComplete`, `keyboardType`, `textContentType` props on TextInput for iOS/Android-native autofill.
- **Commit affordance** pinned to the bottom, not buried at the end of a scroll.

### Desktop form patterns

- **Multi-column forms** become appropriate when space permits. Related fields side-by-side (first/last name, city/state/zip).
- **Compact field sizes** — input height 36–40px is standard on desktop; 44+ is mobile-coded and looks clunky.
- **Tab order through fields** must be perfect.
- **Autofocus** the first field on form load (on mobile, this triggers the keyboard and is often unwanted; on desktop, it's expected).
- **Inline validation** can be more aggressive on desktop (validation on every keystroke is OK for certain fields like password strength; on blur for most).
- **Save via ⌘S** or an equivalent shortcut. Save is usually a button, but users expect ⌘S to work too.
- **Larger forms benefit from sections**, collapsible groups, in-page navigation ("Jump to: Contact | Assembly | Defects"), or a side-rail with progress.

### Inputs that diverge by platform

**Date picker.** Mobile: native date picker (DateTimePicker on RN, or expo-datetime-picker). Desktop: a popover calendar (react-day-picker, @radix-ui/react-calendar). Don't use the mobile-native picker on desktop; it's cramped and non-keyboard-friendly.

**Select / dropdown.** Mobile: native picker wheel (iOS) or modal list (Android). Desktop: custom dropdown with keyboard navigation (Radix Select, Headless UI Listbox). Native `<select>` on web is technically an option but has poor styling control and poor search UX.

**Numeric input.** Mobile: `keyboardType="numeric"` on TextInput to get the numeric keyboard. Desktop: `type="number"` on input, but use custom increment/decrement buttons instead of the browser-default spinner (which is ugly everywhere). Consider shadcn-style stepper components.

**Search / autocomplete.** Mobile: full-screen search modal triggered by a search button. Desktop: inline combobox with dropdown. Both should be debounced; both should show recent searches and suggestions.

**File upload.** Mobile: camera + photo library pickers via expo-image-picker. Desktop: drag-and-drop target + file browser button via `<input type="file">` or react-dropzone. See §19.

**Rich text editor.** On mobile, rich text is painful and rarely worth building. Plain text or Markdown is the usual choice. On desktop, a real editor (Tiptap, Lexical, ProseMirror, Slate) is reasonable. If you need rich text on both, think hard about whether the mobile need is real — often a simple `<TextInput multiline>` is enough on mobile, with rich authoring reserved for the desktop authoring experience.

### Autosave vs explicit save

Mobile forms almost always benefit from autosave — network is unreliable, users may be interrupted, and losing a partial inspection is infuriating. Autosave locally, sync when possible (§23).

Desktop forms are a mix. Document-like forms (writing a report) should autosave (Google Docs model). Transactional forms (settings, account info) often benefit from explicit save with a clear "unsaved changes" indicator and a save button.

### Error display

Universal pattern that works on both:

- Inline error below each field, in a distinct color (red 500) with an icon (not just color — accessibility)
- Summary at the top of the form if submission fails ("Please fix 3 errors below")
- Focus moves to the first errored field on submission failure

Don't use only toasts or only alert dialogs for form errors. They separate the error from the field that caused it.

---

## 15. Data density and information architecture

A phone can show a list. A desktop can show a table with 20 columns. The shape of the information architecture changes with form factor, and forcing one to behave like the other produces bad experiences on both.

### Mobile: the list paradigm

Mobile is a list culture. One column, vertical scroll, rich cells.

- Each row is a rich "card" with primary info (title), secondary info (metadata), and optional action
- Tapping opens the detail view
- Filtering happens at the top (search bar, filter chips) or via a modal
- Sorting via a modal or picker
- Pagination: infinite scroll, not numbered pages (§RN-UI.12)

Scribe mobile shows inspections as rows with: title, date, client, status chip, defect count. That's enough for the mobile context.

### Desktop: the table paradigm

Desktop can show dense tables with columns that are sortable, filterable, and resizable. This is the default expectation for data-heavy tools (Linear, Airtable, GitHub, Salesforce).

Table must-haves on desktop:

- **Sortable columns** — click header to sort, click again to reverse. Sort indicators visible.
- **Filterable columns** — filter per-column via popover, or global filter bar
- **Resizable columns** — drag column edges, persist user preferences
- **Keyboard navigation** — arrows to move between cells, Enter to open row
- **Multi-select** — checkboxes in first column, Shift+click for range, ⌘A for all
- **Bulk actions** — toolbar appears when rows selected
- **Column visibility toggle** — let users show/hide columns
- **Density toggle** — comfortable, compact, very compact spacing options

For React, **TanStack Table** is the default choice — headless, extremely flexible, performant, handles virtualization, sorting, filtering, and selection. Pair with **TanStack Virtual** for virtualization (essential for tables over a few hundred rows).

**AG Grid** is heavier but includes everything (Excel-like editing, pivoting, row grouping, CSV export) — appropriate for serious data tools where users expect a spreadsheet-grade experience.

**Mantine DataTable**, **shadcn/ui Table**, **@radix-ui/react-table** are lighter options; can be hand-assembled with TanStack Table underneath.

### The responsive table problem

Tables don't naturally collapse. At narrow widths, a table with 8 columns becomes unusable — tiny text, horizontal scroll, lost column headers.

Three strategies:

1. **Horizontal scroll with sticky first column.** The first column (usually the "name" or identifier) stays pinned as users swipe right. Acceptable for moderately narrow widths; not great on phones.
2. **Column prioritization.** Hide non-essential columns at narrow widths via CSS or query. Users still see the important 2–3 columns.
3. **Convert to card list at narrow widths.** Below a breakpoint (~768px), the table becomes a list of cards, with columns reflowed as labeled key-value pairs inside each card. This is the native-feeling version but requires a second rendering path.

Most professional apps use strategy 3 on web when supporting mobile browsers, and strategy 2 as a fallback for slightly narrow desktop widths. Strategy 1 is fine for embedded tables where you can't change the surrounding layout.

The best implementations use container queries to switch strategies based on the table's available width rather than the viewport — particularly when the table lives inside a panel that can be resized.

### Heavy data interfaces

Analytics dashboards, admin panels, CRMs face the hardest responsive challenge because tables and charts don't naturally collapse. The best implementations use container queries to switch chart types at narrow widths — a bar chart becomes a sparkline, a data grid becomes a summary card stack, filters collapse from a sidebar into a drawer.

### Summary / aggregation

A detail-heavy table often benefits from a summary row or card showing totals, averages, or counts. On desktop, this appears as a sticky footer row in the table or a banner above. On mobile, it's typically a summary card above the list.

For Scribe: an inspection list on desktop might have a footer row showing "42 inspections, 127 defects, 8 critical, last updated 5 min ago." On mobile, the same info appears as a compact summary at the top of the screen.

### Information density modes

Serious tools let users choose density. Linear has comfortable/compact; Gmail has comfortable/cozy/compact. This is a user preference that should persist.

```ts
type Density = 'comfortable' | 'compact' | 'condensed';
const spacing = {
  comfortable: { rowHeight: 48, cellPadding: 16 },
  compact:     { rowHeight: 36, cellPadding: 12 },
  condensed:   { rowHeight: 28, cellPadding: 8  },
};
```

Implement it via CSS variables or a context provider that passes density down.

---

## 16. Modals, sheets, popovers, drawers

These containers are where mobile and desktop patterns differ most sharply. Same conceptual role, different physical expressions.

### The five container types

1. **Bottom sheet** — slides up from the bottom, can be partially visible (draggable height). Mobile-primary. On desktop, becomes a side drawer or standard modal.
2. **Modal dialog** — centered overlay with backdrop. Both platforms, though sized differently.
3. **Popover / menu** — floats near its trigger. Desktop-primary; on mobile often becomes a full-screen sheet or action sheet.
4. **Drawer / sidebar** — slides in from an edge, persistent or dismissible. Both platforms.
5. **Inline panel** — replaces or augments part of the current screen. Desktop-primary; on mobile means navigation.

### Pattern by form factor

| Intent | Mobile | Desktop |
|--------|--------|---------|
| Quick action menu | Action sheet from bottom | Dropdown/popover at trigger |
| Settings or detail editing | Full-screen modal or navigate to new screen | Centered modal dialog |
| Picking from a list | Full-screen list or bottom sheet | Dropdown with search |
| Confirmation | Alert dialog | Alert dialog (smaller) |
| Filter controls | Bottom sheet or full-screen modal | Inline sidebar or popover |
| Auxiliary info | Bottom sheet | Side drawer or tooltip |

### Implementation by layer

**On mobile:**
- `@gorhom/bottom-sheet` for all sheet patterns (§RN-UI.13)
- `Modal` from RN or `Alert.alert()` for confirmation
- Context menus via Zeego or custom long-press handlers

**On desktop:**
- **Radix UI Dialog** for modals — handles focus trap, escape, backdrop, ARIA
- **Radix UI Popover** for popovers — handles positioning via Floating UI
- **Radix UI Dropdown Menu** for menus
- **Radix UI Context Menu** for right-click
- **vaul** for drawers (Paco Coursey's modern drawer component; on mobile browsers, gives you bottom-sheet feel)
- **cmdk** for command palettes (§13)

### Universal wrapper pattern

If you're doing Option A/C and need a component that does the right thing on both:

```tsx
// packages/ui/components/Sheet.tsx
import { Platform } from 'react-native';

export const Sheet = Platform.select({
  native: require('./Sheet.native').Sheet,
  web: require('./Sheet.web').Sheet,
});
```

Where `Sheet.native.tsx` uses @gorhom/bottom-sheet and `Sheet.web.tsx` uses Radix Dialog (or vaul if you want bottom-sheet feel on mobile web). The API is the same; the implementation diverges.

### Modal sizing

On desktop, modals should be sized to their content with sensible min/max:

- **Small** (alerts, confirmations): ~400–500px wide
- **Medium** (forms, simple content): ~600–700px wide
- **Large** (complex forms, rich content): ~900–1000px wide, with max-height and internal scroll
- **Full** (heavy workflows): near-fullscreen, ~90vw × 90vh, used sparingly

On mobile, modals are almost always full-screen or bottom sheet. Centered modals on a phone look cramped.

### The dismiss pattern

Every modal needs multiple dismiss paths:

- Close button (X) in the top right (desktop) or top left (iOS-style)
- Escape key (desktop)
- Tap/click the backdrop (default behavior, sometimes disabled for important modals)
- Swipe down on bottom sheet (mobile)

Radix Dialog handles all desktop paths automatically. Configure backdrop-click to dismiss only for low-stakes modals; disable it for forms with unsaved changes (or prompt "Discard changes?").

### Toast notifications

Ephemeral feedback. Shouldn't block the UI.

- Bottom-center on mobile (so thumbs don't cover them)
- Top-right on desktop (where users expect them)
- Auto-dismiss after 4–8 seconds
- Include an action where relevant ("Deleted. [Undo]")

Libraries: `sonner` (Paco Coursey again — he does good work) for desktop; `react-native-toast-message` or similar for mobile. Sonner has a React Native port that works well.

### Snackbars vs toasts

Subtle distinction, both web patterns:

- **Toast**: standalone notification, self-dismissing
- **Snackbar** (Material): low-priority bottom notification with optional action

Most teams collapse these into a single "toast" abstraction. Fine to do so.

---

## 17. Images, icons, and responsive media

### Images on the web

Web gives you tools mobile doesn't: responsive images, modern formats, lazy loading, CDN-aware optimization.

**The `<img>` tag with modern attributes:**

```html
<img
  src="hero.webp"
  srcset="hero-400.webp 400w, hero-800.webp 800w, hero-1600.webp 1600w"
  sizes="(min-width: 1024px) 50vw, 100vw"
  width="1600" height="900"
  alt="Roof condition overview"
  loading="lazy"
  decoding="async"
/>
```

- `srcset` + `sizes`: browser picks the appropriate image for the viewport
- `width` + `height`: prevents layout shift (CLS in Core Web Vitals)
- `loading="lazy"`: defers offscreen images
- `decoding="async"`: non-blocking decode

**Use `<picture>` when you need format fallback or art direction** (different crops at different widths):

```html
<picture>
  <source media="(min-width: 900px)" srcset="landscape.avif" type="image/avif">
  <source media="(min-width: 900px)" srcset="landscape.webp" type="image/webp">
  <source srcset="portrait.avif" type="image/avif">
  <img src="portrait.jpg" alt="Building elevation">
</picture>
```

**Image formats in 2026:**

- **AVIF** — best compression, broadest modern browser support. Slightly slower decode than WebP.
- **WebP** — universal support, good compression. Safe default.
- **JPEG XL** — better compression than AVIF but Safari-only. Don't bet on it yet.
- **PNG** — for images with transparency or sharp edges; or use WebP with transparency
- **SVG** — for icons, logos, and illustrations

### Image frameworks

**Next.js `<Image>`**: handles srcset, sizes, lazy loading, blur-up placeholder, automatic format selection. Use it unless you have a reason not to.

**expo-image**: on mobile, the modern image component. Caching (memory + disk), placeholder, fade transitions, content fit modes, GIF/WebP/AVIF support, long-term performance better than RN's built-in `<Image>`.

```tsx
import { Image } from 'expo-image';

<Image
  source={{ uri: photo.url }}
  placeholder={photo.blurhash}
  contentFit="cover"
  transition={200}
  cachePolicy="memory-disk"
  style={{ width: 200, height: 200 }}
/>
```

Universal images: if you want the same component to work on both, write a thin wrapper that dispatches to `next/image` on web and `expo-image` on native (or Tamagui's `Image` which handles this).

### Icons universally

Icons are small images. They divide into three strategies:

**1. Universal icon libraries that work on both:**

- **Lucide** — most popular React icon set, MIT licensed, large catalog. `lucide-react` for web, `lucide-react-native` for native. Same icon names across both.
- **Phosphor** — similarly versatile, stylistically opinionated. `phosphor-react` and `phosphor-react-native`.
- **Tabler Icons** — enormous set (4000+), consistent visual style.

Pick one and use it everywhere for non-platform-specific icons. Lucide is the pragmatic default.

**2. Platform-specific icons:**

- **SF Symbols** on iOS — Apple's native icon set, access via `expo-symbols` or `react-native-sfsymbols`. Integrates with iOS system (tinting, weight, scale, SF Pro typography).
- **Material Symbols** on Android — Google's equivalent, available via `@expo/vector-icons` or direct font loading.

For native tabs and navigation, **use platform-native icons**. Expo Router v6's Native Tabs expect SF Symbols on iOS and Material icons on Android. The home icon on iOS should look like the iOS home icon.

**3. Custom brand icons** — SVG components. For web, inline SVG or SVG imports. For native, `react-native-svg` renders SVGs as real native shapes (sharper than bitmaps, animatable). Tools like `svgr` convert SVG files to React components.

### Vector icons via SVG on both platforms

For custom icons, the cleanest universal approach is SVG + react-native-svg:

```tsx
// packages/ui/icons/InspectionIcon.tsx
import Svg, { Path } from 'react-native-svg'; // works on both via react-native-web

export function InspectionIcon({ size = 24, color = 'currentColor' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="..." stroke={color} strokeWidth="2" fill="none" />
    </Svg>
  );
}
```

One component, same SVG path, works on web (native SVG) and native (react-native-svg). Stroke-width, size, color are props; theme those to your design tokens.

### Icon sizing

Icons should use a discrete scale: 16, 20, 24, 32, 40. Don't render icons at weird sizes (23px, 31px). Match the icon size to the adjacent text:

- 14–16px icons for 14px body text
- 20–24px icons for 16–18px UI text
- 32–40px icons for feature/hero contexts

### Backgrounds and decorative images

For decorative backgrounds, CSS is ideal on web — gradients, patterns, tiled images, blend modes all work natively. On RN, you're more limited; use `expo-linear-gradient` for gradients, `ImageBackground` for tiled images. For patterns, consider `react-native-svg` with a Pattern element.

### Video

On web, `<video>` works well. On mobile, `expo-video` (modern, SDK 52+) or `react-native-video`. Universal wrapping is possible but often not worth it — video requirements usually differ enough between form factors that you split.

Autoplay conventions differ:
- Web: autoplay is allowed only if muted and the tab is visible; enforced by browser
- iOS: autoplay muted video allowed; unmuted requires user interaction
- Android: autoplay generally allowed

Always ship video with `muted autoplay` unless you need sound, and provide play/pause controls.

---

## 18. Web-only concerns: URLs, SEO, SSR, metadata

These are what makes a web app feel native to the web — and they have no mobile equivalent. Neglecting them marks a web app as a "mobile app running in a browser."

### URLs as state

On mobile, URLs mostly don't matter (deep links excepted). On web, URLs are the primary navigation state and a major part of UX:

- **Shareable.** A user should be able to copy the URL, send it to a colleague, and the colleague lands on the same view.
- **Bookmarkable.** Frequently-used views should have stable URLs that survive sessions.
- **Browser history.** Back and forward should work correctly. Selecting an item in a list should push history; deselecting should pop.
- **Refreshable.** A page reload should restore the same state.

Encode meaningful state in the URL:

- Current route (obvious)
- Selected item ID (e.g., `/inspections?selected=142`)
- Open panel, filter selections, sort order, search query
- Pagination or scroll position (for deep lists, a "pageToken" query param)

Don't put every piece of state in the URL — ephemeral UI state (tooltip open? hover on what?) belongs in React state. The test: "should this survive a page reload?" If yes → URL. If no → React state.

### URL structure

Good URLs are legible, hackable, and stable:

- `/inspections/142/defects/3` — clear hierarchy
- `/inspections?status=open&sort=date&view=compact` — query params for filters/view
- `/inspections/142/export?format=pdf` — actions as path segments when they warrant a full page

Avoid:

- Opaque IDs for important resources: `/i/a8f7c2` is harder to use than `/inspections/ABC-142`
- Verb-heavy paths: `/getInspection?id=142` is an API style, not a URL style
- State in hash fragments unless you're doing SPA routing without server control (`#/inspections/142`) — modern frameworks use real paths

### SEO (if applicable)

Scribe, being a tool for authenticated users, doesn't need SEO. But many apps have a marketing site or public content.

Basics:

- **Title tag** per page, unique and descriptive (50–60 chars)
- **Meta description** (150–160 chars) for search engine snippets
- **Open Graph tags** (`og:title`, `og:description`, `og:image`) for rich link previews
- **Twitter Card tags** for Twitter previews
- **Canonical URL** to prevent duplicate content issues
- **Structured data** (JSON-LD) for rich results in Google
- **Sitemap** and `robots.txt`

Next.js `metadata` API handles most of this. Expo Router's `<Head>` component handles title/meta tags and during server-side rendering these are extracted and included in the initial HTML response.

### Server-side rendering (SSR)

SSR generates HTML on the server so the browser gets a rendered page immediately, before JavaScript downloads and hydrates. Benefits:

- **Initial paint** is faster (HTML arrives first, styled and laid out)
- **SEO** — search engines see real content without waiting for JS
- **Perceived performance** on slow connections
- **Accessibility for no-JS users** (rare but real)

Costs:

- **Server infrastructure** — you need a runtime, not just a CDN
- **Complexity** — data fetching happens in two worlds (server, client)
- **Cache invalidation** — classic

2026 options:

- **Next.js** with App Router — mature, rich data-loading patterns (React Server Components, loaders, generateStaticParams)
- **Remix / React Router 7** — cleaner mental model for data loading, nested routes
- **Expo Router 55+** with `output: server` — experimental but working. Server rendering requires a deployed server; unlike static rendering, no HTML files are pre-generated. EAS Hosting supports SSR out of the box.

For Scribe, SSR is largely unnecessary — it's an authenticated app. Static site generation (SSG) for a few marketing pages, plus SPA behavior for the authenticated app, is the right shape. Use Next.js with a mix of static and client-rendered routes, or just SPA.

### React Server Components (RSC)

A separate concept from SSR, though related. RSC lets you write components that run only on the server, fetching data and returning a serialized tree that the client renders. No JavaScript for those components ships to the client.

Next.js App Router is built on RSC. Expo Router has early support for RSC on all platforms, still in beta.

For Scribe's web app, RSC is useful for:
- Pages that render from database queries (report list, inspection detail server-rendered initial state)
- Admin-only views where server-side filtering is easier than shipping all data to the client

But don't over-invest. A lot of the RSC hype outpaces the practical value for small app teams. Keep simple client-rendered pages simple.

### Static rendering / SSG

For pages that don't change often — documentation, marketing, help content — generate HTML at build time and serve from CDN. Fastest possible load, cheapest hosting.

Expo Router enables build-time static rendering on web. Next.js's `generateStaticParams` plus `dynamic = 'force-static'` does the same. Great for: documentation, changelogs, blog posts, help articles, public-facing landing pages.

### Metadata and social sharing

When someone pastes a URL into Slack, iMessage, Twitter, etc., the preview comes from Open Graph tags. A minimum viable set:

```html
<meta property="og:title" content="Inspection #142 — Main Building Roof" />
<meta property="og:description" content="NC State, completed 2026-03-14" />
<meta property="og:image" content="https://cdn.example.com/og/inspection-142.png" />
<meta property="og:url" content="https://scribe.example.com/inspections/142" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
```

For internal tools, auto-generated OG images are a nice polish — a service like `@vercel/og` generates them from your React components at the edge, giving you rich link previews with zero design overhead.

---

## 19. PWA and offline patterns on the web

Progressive Web Apps turn a website into an installable, offline-capable app. For tools where users return daily, PWA is the right shape even when you have a native mobile app — the web app becomes a "good enough" mobile fallback and a first-class desktop app. For Scribe specifically, a PWA companion for desktop Chrome / Edge / Arc lets reviewers and managers work without installing anything, with near-native polish.

### The PWA trifecta

Three things make a web app a PWA:

1. **Web app manifest** (`manifest.json`) — metadata: name, icons, theme colors, display mode
2. **Service worker** — background script that intercepts network requests, enabling offline
3. **HTTPS** — required for service workers, except on localhost

### Web app manifest

```json
{
  "name": "Scribe",
  "short_name": "Scribe",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0F172A",
  "theme_color": "#0F172A",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- `display: standalone` — opens as an app window without browser chrome (the primary PWA feel)
- `display: fullscreen` — full immersive; rarely correct
- `display: minimal-ui` — small browser chrome; middle ground
- Maskable icon (purpose: "maskable") lets Android and iOS apply their own icon shape

Link from HTML: `<link rel="manifest" href="/manifest.json">`.

### Install prompts

Chromium browsers show a native install prompt when the page meets PWA criteria. You can intercept and defer the event to show your own prompt UI:

```ts
let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallButton();
});

async function handleInstallClick() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
}
```

iOS Safari doesn't support `beforeinstallprompt` — users manually add to home screen. Show them instructions when you detect Safari + mobile.

### Service worker basics

A service worker runs in a separate thread, intercepts requests, and can serve responses from cache:

```ts
// sw.ts
const CACHE = 'scribe-v1';
const SHELL = ['/', '/index.html', '/app.js', '/app.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  // remove old caches
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (e) => {
  // cache-first for app shell, network-first for data
  if (SHELL.includes(new URL(e.request.url).pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
```

Don't hand-roll service worker logic. Use **Workbox** (Google's library) or the newer **Serwist** (Workbox-inspired, modernized, native Next.js integration). They handle cache strategies, versioning, and common patterns correctly.

### Caching strategies

Standard strategies (all named by Workbox):

- **Cache First** — check cache, fall back to network. For static assets (JS, CSS, images, fonts).
- **Network First** — try network, fall back to cache. For data that might change (API calls where staleness is acceptable).
- **Stale While Revalidate** — return from cache immediately, fetch network in background, update cache. Great for things that can be slightly stale (avatars, lists).
- **Network Only** — no cache. For write operations, auth.
- **Cache Only** — no network. For truly static content after installation.

### Offline-first architecture

True offline (not just cached pages, but the ability to *work* offline) requires more: an IndexedDB-based local store and a sync engine.

The architecture:

1. **Primary store is local.** Reads come from IndexedDB, not the network. The UI renders from local data at all times.
2. **Writes are queued.** When the user creates or edits, the write goes to IndexedDB immediately (UI updates), and is queued for sync.
3. **Sync engine** runs in the background. When online, it replays queued writes to the server, handles conflicts, and updates local state with server changes.
4. **Conflict resolution policy is explicit.** Last-write-wins, manual-merge, or CRDT — pick one per data type.

### IndexedDB basics

Native IndexedDB is verbose. Use a wrapper:

- **idb** (by Jake Archibald) — tiny promise-based wrapper, closest to native API
- **Dexie.js** — higher-level, query-oriented, more ergonomic
- **PouchDB** — if you want automatic sync with CouchDB on the backend
- **Replicache / Zero / Instant.db** — commercial offline-first sync engines, handle everything

For Scribe, Dexie.js is a reasonable default — it's clean, handles indexes, supports migrations, and is well-documented.

```ts
import Dexie, { Table } from 'dexie';

export class ScribeDB extends Dexie {
  inspections!: Table<Inspection>;
  photos!: Table<Photo>;
  syncQueue!: Table<SyncQueueItem>;

  constructor() {
    super('scribe');
    this.version(1).stores({
      inspections: 'id, updatedAt, syncStatus',
      photos: 'id, inspectionId',
      syncQueue: 'id, timestamp, status',
    });
  }
}

export const db = new ScribeDB();
```

### The sync queue pattern

```ts
interface SyncQueueItem {
  id: string;
  operation: 'create' | 'update' | 'delete';
  entityType: 'inspection' | 'photo' | 'defect';
  entityId: string;
  payload?: any;
  timestamp: number;
  retryCount: number;
  status: 'pending' | 'syncing' | 'failed' | 'completed';
}

async function enqueueWrite(op: SyncQueueItem) {
  await db.syncQueue.add(op);
  triggerSync(); // kick the sync engine if online
}

async function runSync() {
  const pending = await db.syncQueue.where('status').equals('pending').toArray();
  for (const item of pending) {
    try {
      await db.syncQueue.update(item.id, { status: 'syncing' });
      await sendToServer(item);
      await db.syncQueue.update(item.id, { status: 'completed' });
    } catch (e) {
      await db.syncQueue.update(item.id, {
        status: 'failed',
        retryCount: item.retryCount + 1,
      });
    }
  }
}
```

Trigger sync on: app load, online events (`window.addEventListener('online', ...)`), periodic background sync (Background Sync API), and after every local mutation.

### Background Sync API

The Background Sync API defers tasks to be run in a service worker until the user has stable network connectivity. When a user performs an action offline, instead of failing immediately, the request is queued and automatically retried when connectivity is restored.

Support is limited — Chrome/Edge yes, Safari no, Firefox no. Treat it as progressive enhancement: if available, great; if not, rely on explicit sync triggers.

```ts
// register a sync tag
navigator.serviceWorker.ready.then(reg => reg.sync.register('sync-inspections'));

// in service worker
self.addEventListener('sync', (e) => {
  if (e.tag === 'sync-inspections') {
    e.waitUntil(runSync());
  }
});
```

### Shared sync logic between mobile and web

The sync engine is one of the highest-value shared packages. The mobile app (SQLite-based) and the web app (IndexedDB-based) have different storage layers but identical queue semantics, conflict resolution, and server protocol. Abstract the storage behind an interface:

```ts
interface SyncStore {
  enqueue(op: SyncOp): Promise<void>;
  getPending(): Promise<SyncOp[]>;
  markSyncing(id: string): Promise<void>;
  markCompleted(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}
```

Mobile implements this against SQLite; web implements against Dexie. The sync engine itself — retry policy, backoff, batching, conflict resolution — is platform-agnostic code in `packages/sync/`.

This matches Scribe's `.scribe` package format and offline-first architecture — you already have the model on mobile; the web app should reuse the engine and adapt the store.

### Measuring reliability

For offline apps, the metric that matters is sync success rate. Track:

- % of queued writes that succeed on first attempt when online
- % that require retry
- % that fail permanently (conflicts, validation errors)
- Average time from local write to server confirmation

Production offline-first apps routinely achieve 99%+ first-try success on restored connectivity. Below 95% is a bug.

---

## 20. File handling: upload, drag-drop, clipboard, download, print

Files are deeply different between form factors. Mobile users pick photos from a library or take them with the camera; desktop users drag files from Finder/Explorer. Mobile sharing is "share sheet"; desktop is "download file" or "copy link." Universal handling requires real divergence.

### File input on web

The basic file input:

```html
<input type="file" accept="image/*" multiple />
```

`accept` takes MIME types (`image/jpeg`), MIME wildcards (`image/*`), or extensions (`.pdf`). `multiple` allows multi-select. `capture="environment"` (mobile) directly opens the camera.

Styled file input pattern: hide the input, trigger from a button:

```tsx
const inputRef = useRef<HTMLInputElement>(null);
return (
  <>
    <input ref={inputRef} type="file" hidden onChange={handleFiles} />
    <button onClick={() => inputRef.current?.click()}>Add photos</button>
  </>
);
```

### Drag-and-drop on web

HTML5 drag-and-drop is usable but the API is hostile. Use a library:

- **react-dropzone** — the standard. Handles drag-over states, validation, multi-file, disabled state.
- **@uploadthing/react** — if you're using UploadThing for storage
- **react-aria's useDrop** — part of React Aria, accessible, composable

```tsx
import { useDropzone } from 'react-dropzone';

const { getRootProps, getInputProps, isDragActive } = useDropzone({
  accept: { 'image/*': ['.jpeg', '.png', '.webp'] },
  maxSize: 10 * 1024 * 1024, // 10 MB
  onDrop: handleFiles,
});

return (
  <div {...getRootProps()} className={cn('drop-zone', isDragActive && 'active')}>
    <input {...getInputProps()} />
    <p>Drop files here or click to browse</p>
  </div>
);
```

Visual feedback during drag:

- Idle state: subtle border, light background
- Drag-over state: bright border, tinted background, "Drop here" message
- Error state (rejected file): red border, clear error message

Desktop drag-and-drop has no mobile equivalent. On mobile, the fallback is the file picker button (which will open the camera roll / files app).

### Clipboard

Reading and writing to the clipboard is available on both platforms but differs significantly.

**On web:**

```ts
// Copy
await navigator.clipboard.writeText('some text');

// Paste (requires user interaction, not always granted)
const text = await navigator.clipboard.readText();

// Rich content (images, HTML)
await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
```

Requires HTTPS and (usually) a user gesture. Browser support for non-text clipboard is uneven.

**On mobile:**

```ts
import * as Clipboard from 'expo-clipboard';

await Clipboard.setStringAsync('some text');
const text = await Clipboard.getStringAsync();
await Clipboard.setImageAsync(base64Image);
```

Universal helper:

```ts
// packages/core/src/clipboard.ts
import { Platform } from 'react-native';

export const clipboard = {
  copy: Platform.select({
    web: (text: string) => navigator.clipboard.writeText(text),
    native: (text: string) => require('expo-clipboard').setStringAsync(text),
  }),
};
```

### Download patterns

**On web**, to trigger a download:

```ts
const blob = new Blob([content], { type: 'application/pdf' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'inspection-142.pdf';
a.click();
URL.revokeObjectURL(url);
```

For larger files or server-generated downloads, a link to a server endpoint is simpler: `<a href="/api/inspections/142/report.pdf" download>Download PDF</a>`.

**On mobile**, there's no "download to file system" concept. Instead, you save to the app's sandbox and then share:

```ts
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

const uri = FileSystem.documentDirectory + 'report.pdf';
await FileSystem.writeAsStringAsync(uri, content, { encoding: 'base64' });
await Sharing.shareAsync(uri);
```

The share sheet is the mobile equivalent of "download" — users save to Files, AirDrop, email, etc.

### Print styling for reports

On desktop, users will print reports to PDF or to paper. A good print stylesheet is not optional for any report-generating tool.

```css
@media print {
  /* Hide everything that isn't the report */
  .app-nav, .app-sidebar, .app-header, .print-hide { display: none; }

  /* Reset colors for ink */
  * { color: black !important; background: white !important; }

  /* Ensure page breaks make sense */
  h1, h2, h3 { page-break-after: avoid; }
  table { page-break-inside: avoid; }
  .page-break { page-break-before: always; }

  /* Readable type on paper */
  body { font-size: 11pt; line-height: 1.4; font-family: serif; }

  /* Margins are page-controlled, but suggest defaults */
  @page { margin: 0.75in; }

  /* URLs after links in printed output */
  a[href^="http"]::after { content: " (" attr(href) ")"; }

  /* Avoid image overflow */
  img { max-width: 100% !important; height: auto !important; }
}
```

Also consider `@page` rules for headers, footers, page numbers:

```css
@page {
  margin: 0.75in;
  @top-center { content: "Inspection Report — Client Name"; }
  @bottom-right { content: "Page " counter(page); }
}
```

Not all browsers fully support `@page` margin boxes (Chrome has good support; Firefox partial; Safari limited). For reliable print output, generate a server-side PDF instead (Puppeteer, or ReactPDF, or a proper PDF library).

### Print vs PDF

For professional reports (which Scribe produces), don't rely on browser print. Generate PDFs server-side:

- **Server-side Puppeteer** — render the report to PDF using headless Chrome. Pixel-perfect if your CSS is right.
- **React PDF** (`@react-pdf/renderer`) — declarative PDF generation with React components. Good for simple layouts.
- **ReportLab** (Python, which Scribe already uses) — professional typography, exact control.

Server-generated PDFs are consistent across browsers and operating systems; browser-printed PDFs vary. For a deliverable report, consistency matters.

### Print preview UX

If you do rely on browser print, give users a preview:

1. Render the report in a "print view" route (`/inspections/142/print`) with print styles applied even in the browser
2. Provide a prominent "Download PDF" button that either calls `window.print()` (which shows the OS print dialog with PDF as a destination) or calls your server-side PDF generator

Users tend to trust server-generated PDFs more than browser-printed ones, in my experience.

---

## 21. Desktop-specific concerns

A few patterns that are desktop-only and that mobile-primary developers sometimes miss.

### Window resizing

Desktop windows resize continuously. Your layout must respond in real time. Most CSS and flex-based layouts do this naturally; the traps are:

- Fixed-width elements that cause horizontal scroll when the window is narrow
- Canvas or SVG charts that don't observe their container size (use ResizeObserver)
- Modals/popovers that don't reposition when the window resizes
- Virtualized lists that cache the viewport height and stop rendering correctly

`ResizeObserver` is the right tool for observing element size changes:

```ts
useEffect(() => {
  if (!ref.current) return;
  const observer = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    updateDimensions({ width, height });
  });
  observer.observe(ref.current);
  return () => observer.disconnect();
}, []);
```

### Multi-monitor awareness

Users have multiple monitors with different resolutions and scaling. A few things to watch:

- **CSS pixels vs device pixels** — `window.devicePixelRatio` tells you the scaling. High-DPI images need `@2x` or vector equivalents.
- **Popovers and menus** — position them relative to viewport, not screen. Floating UI handles this.
- **Fullscreen** — `document.requestFullscreen()` on web, supported, rarely used except for media.

### Scroll bars

Desktop scroll bars take up space. On macOS with "Show scroll bars: When scrolling," they don't — but on Windows default settings, they do. The right approach:

- Use `overflow-y: auto` on scrolling regions
- Use `scrollbar-gutter: stable` to reserve space so content doesn't shift when scrollbars appear
- On mobile, scroll bars are always overlay; no adjustments needed

For heavily customized scroll regions, libraries like `overlayscrollbars` give you consistent styling across platforms. Don't go overboard — users are used to platform-native scroll bars and usually prefer them.

### Context menu (right-click)

Desktop users right-click for context. Deliver it:

```tsx
<div onContextMenu={(e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
}}>
  {/* ... */}
</div>
```

Use Radix's ContextMenu primitive — handles positioning, keyboard navigation, dismiss, accessibility.

On mobile, right-click maps to long-press (§12). On desktop web, also support long-press as a fallback for users without a right mouse button (some laptops, some touchscreens).

### Focus and tab management

Beyond the basics in §13:

- **Return focus after modal close.** When a user closes a dialog, focus should return to the element that opened it.
- **Auto-focus carefully.** Auto-focusing on page load is fine for a single primary input (search box on the dashboard); it's intrusive if the user is trying to scroll.
- **Skip links.** For accessibility, provide a "Skip to main content" link at the top of the page, visible on focus.

### Window title

The browser tab title is useful navigation. Update it to reflect the current view:

```tsx
useEffect(() => {
  document.title = `${inspection.name} — Scribe`;
}, [inspection]);
```

Next.js metadata API handles this declaratively; `react-helmet-async` is the library route.

### Document visibility

Users alt-tab, minimize, switch browser tabs. Respect their attention:

- Pause expensive ongoing work when the tab is hidden (`document.visibilityState === 'hidden'`)
- Resume on `visibilitychange`
- For real-time data, reduce polling frequency when hidden

```ts
useEffect(() => {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      refetchLatest();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}, []);
```

### Electron and Tauri wrappers

If you want the web app to be installable as a true desktop app (menu bar, OS integration, system tray, auto-update), wrap it:

- **Electron** — mature, Chrome-based, large bundle, works everywhere. Slack, VS Code, Discord.
- **Tauri** — Rust-based, uses system webview, small bundle, growing fast. 1Password 8, Warp.
- **Nextron** — Next.js + Electron starter if you want a unified project

For Scribe, a Tauri wrapper around the web app would give desktop users a real app icon, file associations, a menu bar with shortcuts, auto-updates, and access to the filesystem for importing/exporting reports. Low effort for a real desktop feel. This is a reasonable path if Scribe's desktop review workflow becomes heavy enough to justify it, especially given its offline-first nature (Tauri can bundle SQLite and sync with the `.scribe` format natively).

---

## 22. Performance across form factors

Performance bottlenecks differ between platforms. Understanding where each platform hurts lets you allocate optimization effort correctly.

### Mobile bottlenecks

From §RN-UI.18, the main ones:

- **JS thread contention** — the JavaScript thread blocks animations if it's busy
- **Bridge/JSI overhead** — though much improved with the New Architecture
- **Startup time** — initial JS bundle parsing, bootstrap
- **Memory pressure** — especially on older Android devices
- **Battery** — sustained CPU or network use is a real cost

### Web bottlenecks

Different profile:

- **Initial load** — JS bundle size, number of round trips, render-blocking resources
- **Core Web Vitals** — LCP (Largest Contentful Paint), INP (Interaction to Next Paint), CLS (Cumulative Layout Shift)
- **Network conditions** — users are on a spectrum from gigabit fiber to 2 bars of LTE
- **Main thread blocking** — long tasks freeze the UI
- **Memory** — fewer constraints than mobile but real on low-end Chromebooks
- **Hydration cost** — SSR or RSC content needs hydration to become interactive

### The metrics that matter

**On web (Core Web Vitals):**

- **LCP ≤ 2.5s** — largest content element visible within 2.5s. Hero images, primary headings, main content.
- **INP ≤ 200ms** — user interactions respond within 200ms. Covers all interactions, not just the first.
- **CLS ≤ 0.1** — layout shouldn't shift unexpectedly. Always include `width`/`height` on images and reserve space for dynamic content.

Google's own tooling (PageSpeed Insights, Lighthouse, Chrome DevTools) reports these. Real-user metrics via `web-vitals` library (track p75 in production).

**On mobile:** JS thread FPS and UI thread FPS (§RN-UI.18), time-to-interactive, cold start time.

### Bundle size for web

Bundle size directly affects initial load. Keep it honest:

- Measure with `next build` output or `vite-bundle-visualizer`
- Aggressive code splitting by route (default in Next.js App Router)
- Lazy-load non-critical components with `React.lazy` + `Suspense`
- Inspect third-party libraries — `date-fns` over `moment` (tree-shakable), `zustand` over `redux-toolkit` for small stores
- Don't ship `react-native` code to web via RN-Web unless you're committed to that path

### Lazy loading

```tsx
const ReportEditor = React.lazy(() => import('./ReportEditor'));

function InspectionDetail() {
  return (
    <Suspense fallback={<Skeleton />}>
      <ReportEditor />
    </Suspense>
  );
}
```

Code-split heavy features (WYSIWYG editor, data visualization, PDF generator) so they don't bloat the initial bundle.

### Image optimization

Already covered in §17. Recap:

- Use `next/image` or `expo-image`
- Serve appropriate sizes via srcset
- Modern formats (AVIF/WebP)
- Lazy load offscreen images
- Include width/height to prevent CLS
- Use a CDN for static images

### Virtualization

For long lists on web, use `TanStack Virtual` or `react-window`. On mobile, `FlashList` v2 (§RN-UI.12). Both avoid rendering off-screen DOM/views.

A rule of thumb: if a list can contain more than 100 items, it should be virtualized. Below 100, it usually doesn't matter.

### Rendering optimization

Both platforms benefit from:

- **Memoization** (`useMemo`, `useCallback`, `React.memo`) where expensive work happens on every render. Don't over-memoize — most components don't need it.
- **Stable keys on lists** — never use index as key if items can change order or be added/removed
- **Avoiding unnecessary state updates** — selector-based state (Zustand's selector pattern, Jotai's atoms) instead of broad re-renders
- **Deferred updates** (`useDeferredValue`, `startTransition`) — keep the UI responsive during heavy updates

### Network

- **HTTP/2 or HTTP/3** on the server (automatic on Vercel, EAS Hosting)
- **Compression** (Brotli preferred, Gzip fallback)
- **Caching headers** — long max-age on static assets (with content hashing for invalidation)
- **API response caching** — `Cache-Control` headers, or a client cache like TanStack Query with sensible stale times

### Measuring in production

- **Web**: `web-vitals` library, Sentry Performance, Vercel Speed Insights, PostHog
- **Mobile**: React Native performance monitor, Firebase Performance, Sentry for RN
- **API**: server-side tracing (OpenTelemetry + your observability platform)

Don't optimize blindly. Measure, find the actual bottleneck, fix it, measure again.

---

## 23. Testing universal apps

Testing a universal app is testing one product through multiple expressions. The shared logic gets tested once; the platform-specific expressions each need their own coverage. Budget accordingly.

### Testing the shared core

Business logic, validators, state machines, utilities — all pure TypeScript with no platform dependencies. Test with **Vitest** (faster than Jest, better ESM support, same API). Run in Node. High coverage is achievable and worth it.

```ts
// packages/core/src/defectGrading.test.ts
import { describe, it, expect } from 'vitest';
import { gradeDefect } from './defectGrading';

describe('gradeDefect', () => {
  it('returns critical for sev >= 8', () => {
    expect(gradeDefect({ severity: 8 })).toEqual({ grade: 'critical', requiresAction: true });
  });
});
```

These tests run fast (ms each), are deterministic, and catch most business-logic bugs.

### Testing React components

Two strategies:

**Unit tests with React Testing Library.** Renders components in JSDOM, asserts on output. Works for web components and (with extra config) for shared components that render in JSDOM.

```ts
import { render, screen } from '@testing-library/react';
import { InspectionCard } from './InspectionCard';

test('shows inspection name and status', () => {
  render(<InspectionCard inspection={{ name: 'Roof inspection', status: 'open' }} />);
  expect(screen.getByText('Roof inspection')).toBeInTheDocument();
  expect(screen.getByText('open')).toBeInTheDocument();
});
```

For React Native components specifically, `@testing-library/react-native` renders to a virtual tree (no JSDOM). Same API, different targets.

**Visual regression tests with Chromatic / Playwright / Percy.** Renders components in real browsers, captures screenshots, compares against baselines. Catches visual regressions that unit tests miss. Essential for UI libraries and any app where pixel-perfect output matters.

### Testing end-to-end (web)

- **Playwright** is the current default. Fast, reliable, multi-browser, great debugging tools. Supports mobile viewports for "mobile web" testing.
- **Cypress** is the alternative; aging but still used.

E2E tests are expensive (slow, flaky-prone). Keep them for critical user flows:

- Sign in → create inspection → sync → sign out
- Import data → edit → export report
- Offline mode → actions queued → come online → sync completes

### Testing end-to-end (mobile)

- **Detox** for React Native — runs on device/simulator, actual app interactions
- **Maestro** — cleaner, YAML-driven, works across platforms
- **EAS E2E** — Expo's hosted E2E service, integrates with Maestro

Both mobile and web E2E should share test data fixtures and test scenarios where possible. The user flow is the same; the test runner differs.

### Responsive testing

For web, Playwright can emulate viewports:

```ts
test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('navigation collapses to hamburger', async ({ page }) => { /* ... */ });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('sidebar is visible', async ({ page }) => { /* ... */ });
});
```

Run both viewports in CI. Real-device testing (BrowserStack, LambdaTest) catches OS-specific issues that emulation misses — touch behavior, font rendering, network conditions. Test on at least one mid-range Android device as it represents a large share of global mobile traffic and is frequently under-tested.

### Accessibility testing

- **axe-core** (`@axe-core/playwright`, `jest-axe`) — automated accessibility rules
- **Screen reader testing** — manual with VoiceOver (macOS/iOS) and TalkBack (Android), NVDA or JAWS (Windows)
- **Keyboard-only navigation** — unplug the mouse, tab through the app

Automated tools catch ~30% of accessibility issues. The rest require manual testing.

### Contract testing between packages

In a monorepo, changes to shared packages can silently break consumers. Contract tests — tests that live in the shared package and verify the public API — catch this:

```ts
// packages/api/src/api.contract.test.ts
describe('API contract', () => {
  it('Inspection type is exported with expected shape', () => {
    const sample: Inspection = { id: '1', name: '...', defects: [], /* ... */ };
    expect(sample).toHaveProperty('id');
  });
});
```

Run these tests on every change to the package.

### CI strategy

- **Fast feedback for PRs**: typecheck, lint, unit tests (<2 min)
- **Full test suite on main**: integration tests, E2E (<15 min)
- **Nightly**: visual regression, performance regression, full multi-browser matrix

Use Turborepo's remote caching to speed up CI — skip tasks that haven't changed.

---

## 24. Accessibility unified across form factors

Accessibility covers §RN-UI.17 for mobile. On web there's more surface area and more specific legal/standards context. The unified view is that one accessibility strategy should serve both platforms — with some details that only apply to one or the other.

### The shared foundation

Three things must be true on every form factor:

1. **Every interactive element is reachable.** Keyboard on desktop, screen reader on mobile, touch on both.
2. **Every interactive element is understandable.** Clear label, clear state, clear purpose.
3. **Every interactive element is operable.** Enough size, enough contrast, enough time.

These map to WCAG 2.2 level AA, which is the practical compliance target for most apps. WCAG 2.2 AA covers the baseline; going to AAA is project-specific and usually overkill.

### Shared design decisions that help accessibility

- **Color contrast** — WCAG AA requires 4.5:1 for normal text, 3:1 for large text (18pt+ or 14pt bold). Use a contrast checker during design; violations compound.
- **Target size** — WCAG 2.2 adds a minimum of 24×24 CSS pixels for touch targets; iOS/Android HIG recommends 44–48pt. The higher value wins.
- **Focus indicators** — §13. Visible on every focusable element.
- **Motion** — respect `prefers-reduced-motion` (§RN-UI.17). Web: `@media (prefers-reduced-motion: reduce)`. Native: `AccessibilityInfo.isReduceMotionEnabled`.
- **Font size** — never hard-code `html { font-size: 16px }` on web. Support Dynamic Type on iOS and font scale on Android.

### Web-specific: semantic HTML

On web, semantic HTML is the foundation. Every decision about `<div>` vs `<button>` vs `<a>` matters:

- `<button>` for actions; `<a>` for navigation
- `<h1>` through `<h6>` for the document outline (one `<h1>` per page; no skipping levels)
- `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<section>` for landmarks — screen readers use these to navigate
- `<ul>` / `<ol>` for lists (semantics matter for screen reader announcements like "list, 12 items")
- `<form>` with labels associated via `<label for>`

React Native Web emits `<div>` for `<View>` and `<p>` for `<Text>` by default — **no semantic structure**. You must add `accessibilityRole` props liberally to get reasonable output:

```tsx
<View accessibilityRole="main">
<View accessibilityRole="navigation">
<Pressable accessibilityRole="button">
<Text accessibilityRole="heading" aria-level={1}>
```

This is one of React Native Web's biggest friction points. React Strict DOM's HTML-first approach solves it by using `html.main`, `html.button`, etc., but that's not widely deployed yet.

### ARIA attributes

Use ARIA only when you can't achieve the same with semantic HTML. The first rule of ARIA is: don't use ARIA. The second is: if you must, use it correctly.

Common cases where ARIA is necessary:

- **Live regions** (`aria-live="polite"` or `aria-live="assertive"`) — announces dynamic content changes. Essential for loading states, notifications, error messages.
- **States** — `aria-expanded`, `aria-selected`, `aria-checked`, `aria-disabled` on custom controls
- **Relationships** — `aria-labelledby`, `aria-describedby`, `aria-controls`
- **Landmarks** — `role="search"`, `role="navigation"` when you can't use the semantic element

React Native's `accessibilityState` prop maps to several ARIA states on web, which is convenient. For anything more specific, drop to ARIA on web directly via `{...(Platform.OS === 'web' ? { 'aria-expanded': true } : {})}`.

### Screen reader testing

You can't skip this. Automated tools miss too much.

- **iOS**: VoiceOver (Settings → Accessibility → VoiceOver). Triple-click home button to toggle.
- **Android**: TalkBack (Settings → Accessibility → TalkBack).
- **macOS**: VoiceOver (⌘F5).
- **Windows**: NVDA (free download, widely used) or JAWS (paid, enterprise).

For any significant feature, run through it with a screen reader once. You'll find issues automated tests miss (wrong reading order, redundant announcements, traps).

### Keyboard-only testing

Unplug the mouse (or disable the trackpad). Navigate your web app entirely by keyboard. Can you:

- Reach every interactive element with Tab?
- See a visible focus indicator at each step?
- Activate every control with Enter or Space?
- Escape out of any modal or menu?
- Understand where you are in the app at every moment?

Any "no" is a bug.

### Color and non-color cues

Don't rely on color alone to convey state. A red error needs an icon; a green success needs a checkmark. This protects both colorblind users and users where color rendering is compromised (bright sunlight, low-contrast displays, printed output).

### Dynamic content

Loading states, notifications, and any content that appears without user action should be announced:

```tsx
<div aria-live="polite" aria-atomic="true">
  {status === 'loading' && 'Loading inspections'}
  {status === 'success' && `Loaded ${count} inspections`}
  {status === 'error' && 'Failed to load inspections'}
</div>
```

`aria-live="polite"` announces when the screen reader is idle. `aria-live="assertive"` interrupts — use sparingly, only for critical alerts.

### Form accessibility

- Every input has a visible label (placeholder is not a label)
- Associate labels with inputs via `<label for>` or nesting
- Required fields marked with `aria-required` and visually
- Error messages linked via `aria-describedby`
- Error state via `aria-invalid`
- Focus moves to the first error on submit failure

### Motion and animation

Respect `prefers-reduced-motion`. Animations that work for most users induce nausea in some. Offer:

- Crossfades instead of slides
- No parallax when reduced motion is on
- Still images instead of autoplay video
- No animated scroll behavior (`scroll-behavior: smooth` respects reduced motion in modern browsers)

### Time limits

If your app has time-sensitive interactions (session timeouts, autosave debounces, loading timeouts), give users control:

- Allow extension of session timeouts
- Notify before logging out ("You'll be logged out in 2 minutes [Stay signed in]")
- Don't time out saves — save indefinitely until success

### Testing tools

- **axe DevTools** browser extension — instant feedback on the page you're looking at
- **Lighthouse** accessibility audit (built into Chrome DevTools)
- **Wave** — similar to axe, different heuristics
- **Contrast checkers**: Stark (Figma), WebAIM Contrast Checker, Chrome DevTools contrast indicator
- **Storybook a11y addon** — runs axe against each story

Integrate at least one automated tool into CI. It won't catch everything, but it'll catch the easy regressions.

---

## 25. Scribe specifics: mobile capture + desktop review

The abstract patterns meet the concrete product here. Scribe's architecture — offline-first field inspection mobile app, with a companion desktop app for review and report authoring — is a textbook case for Option B or C (real divergence between form factors, meaningful code sharing at the data layer).

### The fundamental asymmetry

The mobile and desktop users of Scribe are often the same person at different moments, or different people in the same workflow:

- **Mobile (field inspector):** outdoors, on a roof or in a building enclosure, wearing gloves, with sun glare and often no connectivity. Primary tasks: capture photos, annotate, dictate or type observations, classify defects per ASTM conventions, sketch locations, measure (drone/lidar data may be imported later).
- **Desktop (reviewer, report author, PM):** indoors, at a desk, keyboard and mouse, big monitor, reliable connection. Primary tasks: review captured data, cross-reference with other inspections, compose narrative sections, apply templates, produce final deliverables (PDF, docx), share with clients, track project status.

These are different jobs. The product serves both.

### The shared package structure

```
packages/
  core/
    domain/            # Inspection, Defect, Photo, Project, Client models
    grading/           # ASTM classification logic, severity calculation
    units/             # Imperial/metric conversions, area calculations
    templates/         # Report templates as data
  db/
    schema/            # Drizzle schema for SQLite (mobile) and PostgreSQL (server)
    migrations/
    queries/           # Typed queries that run against either target
  sync/
    engine/            # Platform-agnostic sync queue, conflict resolution
    adapters/          # SQLite adapter, Dexie adapter (for web offline)
    protocol/          # Wire format for `.scribe` bundles and server sync
  validation/
    schemas/           # Zod schemas for every domain type
  api/
    client/            # Fetch wrappers, auth, retry, tRPC or REST client
    types/             # Shared API types
  reports/
    core/              # Report composition logic, section ordering, evidence linking
    templates/         # Template interpreters (can run on both)
    pdf/               # Server-side PDF generation (uses ReportLab-style)
  design-tokens/
  ui/                  # Only universal UI primitives (Button, Text, Card) if Option C
```

Substantial shared surface area. Mobile and web diverge at the screens, not the models.

### Mobile-primary screens (stripped down on web, or absent)

- **Field capture screen** — camera-first, large capture buttons, photo strip, quick-tag buttons, voice-to-text for notes, inspection-in-progress indicator. This is a mobile experience; on web, a "manual capture" form is a pale substitute. Consider not porting this to web at all — desktop users don't do field capture.
- **On-site sketch tool** — finger-drawn annotations on photos or floor plans. Has a desktop equivalent (trackpad or stylus input) but design the mobile version first.
- **Offline status banner** — persistent "offline — 4 items queued to sync" banner. On web too, but less visually prominent.

### Desktop-primary screens (absent or minimal on mobile)

- **Report authoring workspace** — three-column layout (section nav | editor | live preview). Rich text editing, template switching, evidence drag-from-library, cross-reference insertion. This is fundamentally a desktop experience.
- **Project management dashboard** — table view of inspections, filterable/sortable by client, status, date, severity. Heavy data density. On mobile, becomes a simple list.
- **Bulk operations** — export selected to PDF, apply template to multiple inspections, merge evidence libraries. Desktop-only workflow.
- **Archive and historical search** — full-text search across years of inspections with filters. Large text input, lots of results. On mobile, a simpler search.

### Shared screens with divergent implementations

- **Inspection list** — both platforms. Mobile: FlashList of cards, pull-to-refresh, filter chip at top, swipe-to-archive. Desktop: TanStack Table with sortable columns, checkbox multi-select, bulk action toolbar, filter sidebar.
- **Inspection detail** — both platforms. Mobile: stack screen with tabs or sections for overview/photos/defects/notes. Desktop: multi-pane view with sidebar, main content, and detail panel.
- **Photo detail / defect detail** — both platforms. Mobile: full-screen photo viewer with pinch-zoom, swipe-between-photos, info overlay. Desktop: photo viewer with side panel for metadata, zoom/pan controls, keyboard shortcuts for next/previous.

### The sync-and-review flow

The daily flow illustrates the coordination:

1. **Morning:** inspector plans the day on desktop (assigns inspections, reviews prior visits, prints or downloads pre-filled templates)
2. **Field:** inspector captures on mobile (offline, in the ambulance-turned-dive-support-vehicle, on a roof, wherever)
3. **Sync:** when back in signal, mobile syncs to server. Queued writes drain. Photos upload. Conflicts (if any) flagged.
4. **Review:** back at desk, inspector or PM opens the desktop app. Same inspection data is there, automatically. Review photos, annotate further, write narrative, produce final report.

At every step, the user trusts that what was captured on mobile appears on desktop and vice versa, immediately once synced. The offline-first architecture is invisible when working — it only reveals itself as resilience during connectivity drops. This is Scribe's core promise.

### Report generation

This is where your Python desktop companion currently does the heavy lifting. Architecturally, two paths forward:

**Path A: keep Python for report generation.** The desktop companion remains a separate artifact; users export a `.scribe` bundle from the web app and open it in the Python tool to produce final PDFs/docx. Pragmatic; leverages existing work.

**Path B: server-side report generation.** The web app calls a server endpoint that generates the report. Server can run Python (ReportLab) or Node (React PDF, Puppeteer). Users don't touch a separate tool; PDFs are downloaded from the browser. Reduces operational burden; increases server complexity.

**Path C: client-side generation in the web app.** Use ReactPDF or similar to generate PDFs in the browser. Possible for simple reports; limited for complex typography or large photo bundles. Probably not the right choice for Scribe's report quality bar.

Path B is the cleaner long-term architecture. Path A is the faster migration path. They're not mutually exclusive — run Python server-side as your report renderer, called from the web app.

### Design system alignment with existing SGH Dark

You already have the SGH Dark design system built as a reusable Python module + design tokens JSON + style guide for Python-generated reports. That JSON is your source of truth. Every new UI — mobile and web — consumes it:

```
packages/design-tokens/tokens.json  →  Tamagui config, Tailwind preset, Python report theme
```

Document this as the canonical token source; a CI check that the Python-generated reports and the web/mobile apps all render the same brand colors and typography is a fair integration test.

### Performance targets for Scribe specifically

- **Mobile cold start:** target <2s from tap to field-capture-ready on mid-range Android. Critical for the "on the roof, need to capture now" moment.
- **Photo capture:** <500ms from tap to captured photo in the app's local store. Nothing else matters as much.
- **Sync throughput:** able to sync a day's inspection (300+ photos, 50 defects) in <2 min over LTE.
- **Desktop list render:** 500+ inspection table renders in <500ms with sorting, filtering.
- **Report generation:** 20-page PDF with 40 photos in <15s server-side.

These are product-specific targets that inform architecture choices. Write them down, measure them, defend them.

### Authentication considerations

Mobile: biometric unlock (Face ID, Touch ID, fingerprint) backed by a long-lived refresh token in Keychain/Keystore. Works offline.

Web: HttpOnly + Secure + SameSite=Lax cookies, backed by a refresh token. Works in the browser security model; doesn't work offline for an initial sign-in, but once signed in, tokens persist.

The auth protocols are identical; the storage mechanisms differ. The shared `packages/auth` package defines the protocol (how to get/refresh tokens); the platform-specific adapter handles storage.

### What to build now vs later

If you're staging the web build-out:

**Phase 1 (MVP web app):** inspection list (table view), inspection detail (read-only), report download button (server-generated PDF). No authoring, no field capture. This gives remote reviewers value immediately.

**Phase 2 (basic authoring):** edit inspection metadata, update defect descriptions, attach/reorder photos. Shared Zod validation, shared React Hook Form.

**Phase 3 (report workspace):** the three-column report authoring view, template selection, narrative editing with rich text, live preview.

**Phase 4 (power features):** command palette, bulk operations, archive search, advanced filtering, cross-inspection analytics.

Each phase is usable product on its own. Don't wait until Phase 4 to ship; ship Phase 1 and iterate.

---

## 26. Migration paths

Very few universal apps are greenfield. Most start as a mobile app, a web app, or both-but-separate, and evolve toward universality.

### Adding web to an existing mobile app

You have Expo + Scribe's mobile work. Three options in order of increasing investment:

**Option 1: Expo Router with web output.** Flip the switch. `expo export --platform web` generates a web build from your existing code. React Native Web handles translation. Depending on your component choices, the result ranges from "works but looks mobile-native on web" to "needs significant adjustment." Low effort, immediate existence.

Good first step for internal beta, quick demo, or validating user demand. Not a final architecture unless the web usage is genuinely secondary.

**Option 2: Introduce a monorepo and a real web app while keeping the mobile app's UI.** Set up pnpm workspaces, extract business logic into `packages/`, set up Next.js or Vite app, initially rendering the same components via RN-Web. Then gradually fork critical screens to native-web implementations.

Medium effort. Buys you a real monorepo architecture that grows with you. Good mid-point.

**Option 3: Separate web app, shared packages.** Build the web app with web-native tools (DOM components, Tailwind, Radix) and share only the business logic and data layer. Feels like two apps that cooperate; each is optimized for its medium.

High effort upfront, lowest long-term cost. Recommended if web is a primary experience.

### Adding mobile to an existing web app

The reverse problem is usually harder. Mobile has more constraints (battery, screen, offline, touch) that a web app wasn't designed for. Options:

**Option 1: PWA-ize the existing web app.** Add a manifest, add a service worker, add offline support via IndexedDB. Users "install" the web app to their home screen. No app store, no native shell. Works on Android well, on iOS with caveats (Safari's PWA support is real but constrained).

Fast, no new codebase. Appropriate for apps where "app-like on mobile browsers" is good enough.

**Option 2: Build a native app that shares business logic with the web.** Expo app, imports from `packages/core` and `packages/api`, builds a native UI from scratch. The web is unchanged; the mobile app is new.

Medium to high effort. The right path for apps where native mobile is a real product surface (capture tools, field work, frequent-use consumer apps).

**Option 3: Capacitor or similar webview-wrapper.** Wrap the existing web app in a native shell via Capacitor (or older options like Cordova/PhoneGap). Limited native integration, limited performance, but reuses the web codebase entirely.

Pragmatic for internal tools where a "minimum viable mobile experience" is acceptable. Not competitive with native.

### Adding a web app to Scribe (recommended path)

Given Scribe's architecture, I'd recommend:

1. Stand up a pnpm + Turborepo monorepo. Move the existing Expo app into `apps/mobile`.
2. Extract shared logic into `packages/core`, `packages/api`, `packages/validation`. This is a refactor of the existing code; do it carefully, in small PRs.
3. Add `apps/web` as a Vite + React + React Router 7 app (or Next.js if SSR matters; probably not needed for Scribe).
4. Initially target Phase 1 scope (list + detail + report download).
5. Share the Drizzle schema, sync engine (with Dexie adapter), and design tokens from day one.

The sync engine specifically is already heading this way — it's platform-agnostic queue semantics with a storage adapter. Making the Dexie adapter the second adapter (after SQLite) is a natural extension.

### Gradual adoption: don't do it all at once

Whichever direction you're going, migrate incrementally. Pick one feature area or one screen; get it working on the new platform; ship; learn. Don't attempt to port everything at once — you'll miss details and lose momentum.

Solito's adoption guide frames this well: share code should not come at the cost of platform quality. Migrate features where sharing pays off (data-intensive screens, business logic), keep or build native-feeling UI for features that don't translate (heavy field-capture UX, power-user desktop workflows).

### Honest accounting of costs

A realistic timeline for adding a web app to Scribe:

- **Monorepo setup, core extraction, shared packages:** 1–2 weeks
- **Web app scaffold, auth integration, basic routing:** 1 week
- **Phase 1 scope (list + detail + export):** 2–3 weeks
- **Dexie-based offline, sync integration:** 2 weeks
- **Phase 2 scope (basic authoring):** 3–4 weeks
- **Phase 3 scope (report workspace):** 4–6 weeks
- **Polish, testing, accessibility, deployment pipeline:** 2–3 weeks

Total: 3–5 months of focused single-person work for a web app that's genuinely useful. Less time if you cut scope; more if you want Phase 4 features from day one.

This assumes the existing mobile codebase is healthy enough to share logic with; if the mobile app has architectural debt (business logic tangled in screens, hard-coded platform assumptions), add time to pay it down before extracting packages.

---

## 27. Quick-reference matrices

The cheat sheets, extracted.

### Architecture decision

| Question | Option A (RN-Web universal) | Option B (separate apps, shared core) | Option C (universal primitives, platform shells) |
|----------|-----------------------------|---------------------------------------|--------------------------------------------------|
| Code sharing | 80-90% | 40-60% | 60-75% |
| Web bundle size | Larger (RN shim) | Native, smaller | Depends on UI library |
| Native feel mobile | Excellent | Excellent | Excellent |
| Native feel web | Compromised | Excellent | Good with right library |
| SEO / SSR | Limited | Excellent | Good (Tamagui + Next) |
| Team size required | Small | Medium+ | Medium |
| Time to first ship | Fastest | Slowest | Middle |
| Long-term cost | Higher (web constraints) | Lower (each optimized) | Middle |

### Styling library decision

| Need | Best choice |
|------|-------------|
| True universal, one component targets both | Tamagui |
| Team knows Tailwind, mobile-first | NativeWind + Tailwind |
| Lightweight, unopinionated, RN-focused | Unistyles 3.x |
| Separate web and mobile, different libraries OK | Tailwind (web) + NativeWind or Restyle (mobile) |
| Future-proof bet on Meta's direction | React Strict DOM (with caveats) |

### Navigation decision

| Form factor | Primary pattern |
|-------------|-----------------|
| Phone | Bottom tab bar + stack |
| Tablet portrait | Bottom tabs or top rail + stack |
| Tablet landscape | Nav rail or sidebar + master-detail |
| Laptop (1024-1440) | Sidebar + master-detail + optional right pane |
| Desktop (1440+) | Sidebar + three-column + command palette |

### Breakpoint strategy

| Width range | Devices | Typical layout |
|-------------|---------|----------------|
| <600px | Phones | Single column, bottom nav |
| 600-899px | Large phones, small tablets portrait, foldables | Single column, some two-column content |
| 900-1279px | Tablets landscape, small laptops | Two-pane master-detail, nav rail appears |
| 1280-1535px | Standard laptops | Three-pane (nav, list, detail), full sidebar |
| 1536-2559px | Large desktops | Three-pane with margin, max-width content |
| ≥2560px | 4K, ultra-wide | Max-width containers, centered, more whitespace |

### When to share, when to split

| Concern | Share | Sometimes | Split |
|---------|-------|-----------|-------|
| Domain models | ✓ | | |
| Zod schemas | ✓ | | |
| Business logic | ✓ | | |
| API client | ✓ | | |
| Design tokens | ✓ | | |
| Sync engine | ✓ | | |
| Form state (RHF) | ✓ | | |
| React Query config | ✓ | | |
| Simple UI primitives | | ✓ | |
| Feature state stores | | ✓ | |
| Icon choices (set) | | ✓ | |
| Screen components | | | ✓ |
| Navigation chrome | | | ✓ |
| Tab bars / sidebars | | | ✓ |
| Gesture handlers | | | ✓ |
| Platform integrations | | | ✓ |
| Push notifications | | | ✓ |
| File pickers | | | ✓ |

### Interaction patterns by input type

| Intent | Touch | Mouse | Keyboard |
|--------|-------|-------|----------|
| Select | Tap | Click | Enter/Space |
| More options | Long-press | Right-click | Menu key or ⇧F10 |
| Navigate list | Swipe | Scroll | Arrow keys |
| Select range | n/a (multi-select mode) | Shift+click | Shift+arrows |
| Select multiple | Multi-select mode + tap | ⌘/Ctrl+click | ⌘/Ctrl+Space |
| Zoom | Pinch | ⌘/Ctrl+scroll | ⌘/Ctrl + / - |
| Drag | Pan gesture | Drag with mouse | n/a (usually) |
| Undo | Shake or button | ⌘/Ctrl+Z | ⌘/Ctrl+Z |

### Container element by form factor

| Purpose | Phone | Desktop |
|---------|-------|---------|
| Quick menu | Action sheet | Dropdown/popover |
| Settings | Full-screen modal or new screen | Centered dialog |
| Pick from list | Full-screen picker or bottom sheet | Combobox or dialog |
| Confirm action | Alert dialog | Alert dialog |
| Filter panel | Bottom sheet | Sidebar or popover |
| Context menu | Long-press → bottom sheet | Right-click → popover |
| Bulk actions | Toolbar after multi-select mode | Toolbar with selection |

### Performance metrics by form factor

| Metric | Mobile target | Web target |
|--------|--------------|------------|
| Cold start | <2s to interactive | n/a |
| First contentful paint | n/a | <1.8s |
| Largest contentful paint | n/a | <2.5s |
| Interaction to next paint | n/a | <200ms |
| Cumulative layout shift | n/a | <0.1 |
| UI thread FPS | 60fps sustained | n/a (browser-managed) |
| JS thread FPS | 60fps | n/a |
| Bundle size | <5MB app | <200KB initial JS (gzipped) |
| List scroll | 60fps @ 10,000 items (with FlashList) | 60fps @ 10,000 items (with virtualization) |

### Responsive component checklist

Before shipping any universal component, verify:

| Check | Mobile | Web |
|-------|--------|-----|
| Touch targets ≥ 44pt | ✓ | ✓ (if touch-capable viewport) |
| Keyboard focusable | ✓ (external keyboard) | ✓ |
| Focus indicator visible | ✓ (external keyboard) | ✓ |
| Hover state defined | n/a | ✓ |
| Works at 320px width | ✓ | ✓ |
| Works at 2560px width | n/a | ✓ |
| Screen reader label | ✓ | ✓ |
| Reduced motion respected | ✓ | ✓ |
| Dark mode | ✓ | ✓ |
| Dynamic Type / font scale | ✓ | ✓ (respects browser font-size) |
| RTL language support | ✓ | ✓ |
| 4.5:1 contrast | ✓ | ✓ |
| Handles loading state | ✓ | ✓ |
| Handles empty state | ✓ | ✓ |
| Handles error state | ✓ | ✓ |

---

## 28. Curated reading list

The sources worth your time. Organized by topic, with brief annotations.

### Framework and tooling documentation

- **Expo docs** (docs.expo.dev) — Expo Router, SDK, EAS, web. The Router section is essential.
- **Next.js docs** (nextjs.org/docs) — App Router, metadata, RSC, caching. Has depth.
- **React Router docs** (reactrouter.com) — v7+ unified with Remix; nested routes, data APIs.
- **Tailwind CSS docs** (tailwindcss.com) — especially container queries and responsive design sections.
- **MDN Web Docs** (developer.mozilla.org) — reference for every web platform API. Responsive design, service workers, IndexedDB, media queries.

### Universal React libraries

- **Tamagui docs** (tamagui.dev) — the compiler, the animations, the styled-component system. Deep.
- **React Strict DOM repo** (github.com/facebook/react-strict-dom) — the future direction. Read the README and the RFC.
- **Solito docs** (solito.dev) — the methodology section is worth reading even if you don't use Solito.
- **NativeWind docs** (nativewind.dev) — v4 changes are significant; docs are current.
- **Unistyles docs** (unistyles.vadzimv.dev) — fast-moving; check for current version.

### Writing on universal/cross-platform

- **Nicolas Gallagher's RFC** ("React DOM for Native") — the canonical argument for unifying the React API surface. If you care about where the ecosystem is going, read it.
- **Fernando Rojo's Next.js Conf talks** — the Solito methodology, the case for monorepos, the philosophy of "platform quality over maximum sharing."
- **Evan Bacon's blog posts on Expo Router** — the "Universal React Server Components" and "Expo DOM Components" posts.
- **Infinite Red's React Native Radio** podcast — ongoing ecosystem discussion; look for episodes on RSD, universal, and Expo Router.

### Responsive design fundamentals

- **Ethan Marcotte, "Responsive Web Design" (A List Apart, 2010)** — the original article. Still worth reading.
- **Rachel Andrew's writing on CSS Grid and container queries** — the best source for understanding layout fundamentals.
- **Kevin Powell's YouTube channel** — modern CSS, layout, container queries. Free, clearly taught.
- **web.dev articles on Core Web Vitals** — measurement, tools, practical optimization.

### Data and offline

- **Workbox docs** (developer.chrome.com/docs/workbox) — comprehensive service worker patterns.
- **Serwist docs** (serwist.pages.dev) — modern Workbox-inspired, great Next.js integration.
- **Dexie.js docs** (dexie.org) — IndexedDB made pleasant.
- **Jake Archibald's writing on Service Workers** — he invented the specification; his blog posts are the best conceptual explanations.
- **"Designing Data-Intensive Applications" (Kleppmann)** — not universal-app-specific but fundamental for thinking about sync, consistency, and distributed state.

### Accessibility

- **WCAG 2.2 quick reference** (w3.org/WAI/WCAG22/quickref) — the actual standard, searchable.
- **Inclusive Components (Heydon Pickering)** — book-length reference of common components and their accessibility implications.
- **Deque University** (dequeuniversity.com) — training material from the axe-core team.
- **A11y Project** (a11yproject.com) — community-maintained checklists.

### Design system references

- **Radix UI** (radix-ui.com) — unstyled, accessible primitives. Source of truth for desktop component behavior.
- **React Aria** (react-spectrum.adobe.com/react-aria) — hooks for accessible components. Deep, rigorous.
- **shadcn/ui** (ui.shadcn.com) — Radix components + Tailwind, copy-paste. Pragmatic.
- **Headless UI** (headlessui.com) — Tailwind Labs' unstyled primitives.
- **Ark UI** (ark-ui.com) — Zag.js-based, framework-agnostic primitives.

### Command palette and keyboard interaction

- **cmdk docs** (cmdk.paco.me) — the standard React command palette.
- **Linear's "How we built our command palette" posts** — design rationale worth reading.
- **Every keyboard shortcut page on Linear, Raycast, Superhuman** — study them. They're the state of the art.

### Field inspection and offline-first (Scribe-adjacent)

- **ASTM E06.55 documents** — you already know these; relevant for domain model decisions.
- **"Offline-first" patterns, Google developers docs** — the canonical patterns for PWA offline.
- **Replicache/Zero docs** — even if you don't use them, the architectural writing is excellent.
- **Local-first software** (Inkandswitch) — the philosophical foundation for offline-first thinking.

### Performance

- **Chrome DevTools docs** — the tools are deep; learn them properly.
- **"High Performance Browser Networking" (Grigorik)** — free online, the canonical reference.
- **Addy Osmani's writing on JavaScript performance** — "The Cost of JavaScript" essays.
- **Core Web Vitals docs on web.dev** — practical, actionable guidance.

### Conference talks worth watching

- **Nicolas Gallagher — "React Strict DOM: Cross-Platform React Based on the Web"** (React Summit US 2025)
- **Fernando Rojo — "Unifying Next.js and React Native"** (Next.js Conf)
- **Evan Bacon talks on Expo Router** (App.js Conf)
- **"The Age of Universal React"** (GitNation / React Summit) — industry state of the art
- **Una Kravets on container queries** (multiple conferences) — the shift in responsive thinking

Read broadly but not exhaustively. You'll return to the references that matter for your specific work. The list above is enough to stay current without drowning.

---

## Appendix A: Monorepo structure example

A concrete pnpm + Turborepo layout for a Scribe-like universal app.

### Root files

```
scribe-monorepo/
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  biome.json
  .gitignore
  .github/workflows/
    ci.yml
```

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### Root package.json

```json
{
  "name": "scribe-monorepo",
  "private": true,
  "scripts": {
    "dev:mobile": "turbo run dev --filter=@scribe/mobile",
    "dev:web": "turbo run dev --filter=@scribe/web",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "turbo": "^2.5.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "pnpm@10.0.0"
}
```

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**", "build/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Apps and packages layout

```
apps/
  mobile/
    package.json
    tsconfig.json
    app.config.ts
    app/                         # Expo Router routes
      _layout.tsx
      (tabs)/
        _layout.tsx
        inspections/
          index.tsx
          [id].tsx
    package.json includes @scribe/core, @scribe/api, @scribe/ui

  web/
    package.json
    tsconfig.json
    next.config.mjs             # or vite.config.ts
    app/                         # Next.js app router
      layout.tsx
      page.tsx
      inspections/
        layout.tsx              # master-detail layout
        page.tsx
        [id]/page.tsx

packages/
  core/
    package.json                # name: @scribe/core
    tsconfig.json
    src/
      index.ts
      domain/
      grading/
      units/

  api/
    package.json                # name: @scribe/api
    src/
      client.ts
      types.ts

  validation/
    package.json                # name: @scribe/validation
    src/
      inspection.ts
      defect.ts

  design-tokens/
    package.json                # name: @scribe/design-tokens
    src/
      colors.ts
      spacing.ts
      typography.ts
      tokens.json               # consumable by Python reports too

  sync/
    package.json                # name: @scribe/sync
    src/
      engine.ts
      adapters/
        sqlite.ts               # native
        dexie.ts                # web

  ui/
    package.json                # name: @scribe/ui
    src/
      Button.tsx
      Button.web.tsx            # (optional override)
      Button.native.tsx         # (optional override)
      Text.tsx
      Card.tsx

  config/
    package.json                # name: @scribe/config
    tsconfig/
      base.json
      mobile.json
      web.json
      package.json
    tailwind-preset/
      index.js
```

### Per-package package.json example

```json
{
  "name": "@scribe/core",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@scribe/config": "workspace:*",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

### Mobile app config (app.config.ts)

```ts
import { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Scribe',
  slug: 'scribe',
  version: '1.0.0',
  newArchEnabled: true,
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-image-picker',
    'expo-camera',
  ],
  experiments: {
    typedRoutes: true,
  },
  ios: {
    bundleIdentifier: 'com.example.scribe',
    supportsTablet: true,
  },
  android: {
    package: 'com.example.scribe',
  },
};

export default config;
```

---

## Appendix B: Expo web and Next.js config examples

### Expo app.json for web

```json
{
  "expo": {
    "web": {
      "bundler": "metro",
      "output": "static"
    }
  }
}
```

For server rendering (SDK 55+):

```json
{
  "expo": {
    "web": {
      "output": "server"
    },
    "plugins": [
      ["expo-router", { "unstable_useServerRendering": true }]
    ]
  }
}
```

### Next.js config for monorepo with shared packages

```ts
// apps/web/next.config.mjs
import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@scribe/core',
    '@scribe/api',
    '@scribe/ui',
    '@scribe/design-tokens',
    '@scribe/validation',
    '@scribe/sync',
  ],
  webpack: (config) => {
    // Support .web.tsx extension resolution
    config.resolve.extensions = [
      '.web.tsx', '.web.ts', '.web.jsx', '.web.js',
      ...config.resolve.extensions,
    ];
    return config;
  },
};

export default nextConfig;
```

### Vite config for monorepo

```ts
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js'],
    alias: {
      'react-native': 'react-native-web',
    },
  },
  server: {
    fs: { allow: ['..', '../..'] }, // allow monorepo package access
  },
});
```

### Metro config for monorepo

```js
// apps/mobile/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
```

### Shared Tailwind preset

```js
// packages/config/tailwind-preset/index.js
const tokens = require('@scribe/design-tokens/tokens.json');

module.exports = {
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      fontSize: tokens.typography.sizes,
      borderRadius: tokens.radii,
    },
  },
};
```

Consumed by web (Tailwind) and mobile (NativeWind):

```js
// apps/web/tailwind.config.js
module.exports = {
  presets: [require('@scribe/config/tailwind-preset')],
  content: ['./app/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};

// apps/mobile/tailwind.config.js
module.exports = {
  presets: [require('@scribe/config/tailwind-preset')],
  content: ['./app/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};
```

---

## Appendix C: Platform extension patterns

Concrete patterns for the file-extension approach.

### Pattern 1: Thin wrapper with shared types

```tsx
// packages/ui/src/Button/Button.types.ts
export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
}
```

```tsx
// packages/ui/src/Button/Button.native.tsx
import { Pressable, Text } from 'react-native';
import type { ButtonProps } from './Button.types';

export function Button({ label, onPress, variant = 'primary', disabled }: ButtonProps) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[baseStyle, variants[variant]]}>
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}
```

```tsx
// packages/ui/src/Button/Button.web.tsx
import type { ButtonProps } from './Button.types';

export function Button({ label, onPress, variant = 'primary', disabled }: ButtonProps) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className={`btn btn-${variant}`}
    >
      {label}
    </button>
  );
}
```

```tsx
// packages/ui/src/Button/index.ts
export { Button } from './Button';  // bundler picks .native or .web
export type { ButtonProps } from './Button.types';
```

### Pattern 2: Platform-aware storage

```ts
// packages/core/src/storage/index.ts
export { storage } from './storage';

// packages/core/src/storage/storage.native.ts
import * as SecureStore from 'expo-secure-store';

export const storage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  remove: (key: string) => SecureStore.deleteItemAsync(key),
};

// packages/core/src/storage/storage.web.ts
// Uses IndexedDB via idb for larger storage; localStorage for tiny values
import { openDB } from 'idb';

const dbPromise = openDB('scribe-kv', 1, {
  upgrade(db) { db.createObjectStore('kv'); },
});

export const storage = {
  get: async (key: string) => (await dbPromise).get('kv', key),
  set: async (key: string, value: string) => { (await dbPromise).put('kv', value, key); },
  remove: async (key: string) => { (await dbPromise).delete('kv', key); },
};
```

Consumer code never needs to know which platform it's on:

```ts
import { storage } from '@scribe/core';
await storage.set('auth-token', token);
```

### Pattern 3: Platform-specific entry with shared interior

```
Screen/
  Screen.tsx          # shared interior logic, imported by both platforms
  Screen.web.tsx      # thin web wrapper with web-specific layout
  Screen.native.tsx   # thin native wrapper with native-specific layout
```

```tsx
// Screen.tsx
import type { ReactNode } from 'react';

export function useScreenLogic() {
  const { data, isLoading } = useInspectionData();
  const handleAction = () => { /* shared */ };
  return { data, isLoading, handleAction };
}

// Screen.web.tsx
import { useScreenLogic } from './Screen';
import { DesktopLayout } from '../layout/DesktopLayout';

export function Screen() {
  const { data, isLoading, handleAction } = useScreenLogic();
  return (
    <DesktopLayout sidebar={<InspectionList />}>
      {isLoading ? <Skeleton /> : <DesktopDetail data={data} onAction={handleAction} />}
    </DesktopLayout>
  );
}

// Screen.native.tsx
import { useScreenLogic } from './Screen';

export function Screen() {
  const { data, isLoading, handleAction } = useScreenLogic();
  return (
    <SafeAreaView>
      {isLoading ? <ActivityIndicator /> : <MobileDetail data={data} onAction={handleAction} />}
    </SafeAreaView>
  );
}
```

### Pattern 4: Platform-aware hooks that have the same signature

```ts
// useBiometricAuth.native.ts
import * as LocalAuthentication from 'expo-local-authentication';

export async function useBiometricAuth() {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  // ...
}

// useBiometricAuth.web.ts
export async function useBiometricAuth() {
  // WebAuthn or fallback to password prompt
  if ('credentials' in navigator) {
    // WebAuthn flow
  }
  return { supported: false };
}
```

The consuming code is identical; only capabilities differ.

### Anti-pattern: branching inside a single file

```tsx
// DON'T DO THIS
import { Platform } from 'react-native';

export function Button({ label, onPress }) {
  if (Platform.OS === 'web') {
    return <button onClick={onPress}>{label}</button>;
  }
  return <Pressable onPress={onPress}><Text>{label}</Text></Pressable>;
}
```

- Both code paths ship to both bundles (larger bundles)
- TypeScript thinks both are live; refactoring is fragile
- Tests need to mock Platform.OS for both branches

File extensions are always better when the divergence is substantive.

---

## Appendix D: Responsive component checklist

Before considering any universal or responsive component "done," run through this list.

### Sizing and layout

- [ ] Renders correctly at 320px width (smallest supported phone)
- [ ] Renders correctly at 2560px+ width (has max-width or knows how to handle extreme widths)
- [ ] Renders correctly in a narrow container (e.g., inside a 360px sidebar)
- [ ] Renders correctly in a wide container (e.g., inside a 1200px content area)
- [ ] No overflow or clipped content at any width
- [ ] No horizontal scroll introduced by this component at any supported width
- [ ] Text wraps cleanly; no mid-word overflow
- [ ] Images have explicit width/height or aspect-ratio to prevent CLS on web

### Interactive states

- [ ] Idle state defined and visible
- [ ] Hover state defined (web; also native on keyboard-attached tablets)
- [ ] Pressed/active state defined on both
- [ ] Focus state visible with strong contrast
- [ ] Disabled state visually distinct from idle
- [ ] Loading state shown when async work is in progress
- [ ] Error state shown with clear recovery path
- [ ] Empty state shown when no data

### Input handling

- [ ] Works with touch (primary mobile)
- [ ] Works with mouse (primary desktop)
- [ ] Works with keyboard (Tab to focus, Enter/Space to activate)
- [ ] Appropriate contextual action on long-press / right-click (if applicable)
- [ ] Text inputs work with platform-native autofill, autocomplete, password managers
- [ ] Numeric inputs trigger numeric keyboard on mobile (`keyboardType`)
- [ ] Email inputs trigger email keyboard on mobile

### Accessibility

- [ ] Accessible role assigned (button, link, heading, landmark, etc.)
- [ ] Accessible label defined (visible label preferred; aria-label/accessibilityLabel as fallback)
- [ ] State announced (expanded, selected, checked, disabled)
- [ ] Color contrast meets WCAG AA (4.5:1 normal, 3:1 large)
- [ ] Doesn't rely solely on color to convey meaning
- [ ] Respects `prefers-reduced-motion` for any animations
- [ ] Respects user font size preferences
- [ ] Focus order within the component is logical
- [ ] Screen reader reading order makes sense

### Responsive behavior

- [ ] Adapts layout at appropriate breakpoints (if applicable)
- [ ] Uses container queries where content position varies (web)
- [ ] Uses fluid units (clamp, %, flex) between breakpoints
- [ ] Touch targets meet 44pt minimum on touch-capable viewports
- [ ] Spacing scales appropriately with viewport / container size

### Platform-specific polish

- [ ] iOS: haptics on primary interactions (where appropriate)
- [ ] iOS: respects safe area insets
- [ ] Android: Material ripple feedback (if appropriate to design system)
- [ ] Web: keyboard shortcut documented if one exists
- [ ] Web: URL updated appropriately if action changes route state
- [ ] Web: works on iOS Safari (notch, toolbar, 100dvh)
- [ ] Web: works on Chrome, Firefox, Safari, Edge (test all four for customer-facing)

### Performance

- [ ] No unnecessary re-renders (check with React DevTools profiler)
- [ ] Event handlers are stable (useCallback where passed to memoized children)
- [ ] Heavy work memoized or deferred
- [ ] Images lazy-loaded if below the fold
- [ ] Animations use transform/opacity for GPU acceleration
- [ ] No layout thrashing (measuring and mutating in the same frame)

### Testing

- [ ] Unit tests for behavior
- [ ] Visual regression test for appearance
- [ ] E2E test if critical flow
- [ ] Tested on physical mobile device (iPhone + Android), not just simulator
- [ ] Tested on at least one older/slower device
- [ ] Tested with screen reader (VoiceOver on desktop at minimum)
- [ ] Tested with keyboard only (desktop)
- [ ] Tested at 200% browser zoom (accessibility)
- [ ] Tested with slow network throttling

### Documentation

- [ ] Props documented with types and descriptions
- [ ] Example usage documented
- [ ] Platform-specific behavior noted (e.g., "hover state only on desktop")
- [ ] Accessibility notes documented
- [ ] Storybook story (or equivalent) for design review

A component isn't ready until every applicable item is checked. The list feels long; in practice most items are one-time setup per component and verify quickly on subsequent changes.

---

*End of reference. For the interactive mobile component layer that sits below this — gestures, haptics, animations, platform conventions — see the React Native UI reference companion document (§RN-UI).*
## 27. Quick-reference matrices

Tables to bookmark and refer back to. No prose, no hedging, just the calls.

### 27.1 Architecture option decision matrix

| Criterion | Option A: RN-Web universal | Option B: Separate apps + shared core | Option C: Universal primitives + platform shells |
|---|---|---|---|
| Code reuse | ~70–85% | ~40–60% | ~55–75% |
| Mobile feel | Good (native RN) | Excellent (pure native) | Excellent (pure native) |
| Web feel | Compromised (RN primitives translated) | Excellent (pure web) | Excellent (pure web) |
| Dev velocity (new features) | Highest | Lowest | Medium |
| Team size sweet spot | 1–3 | 5+ | 2–5 |
| Polish ceiling | Medium | Highest | High |
| Setup complexity | Low–medium | Low per-app, high overall | Medium–high |
| Debugging surface | Unified | Separate | Partly unified |
| Recommended for Scribe | Maybe | Yes | Yes |

Rule of thumb: if you're one person and the web is a secondary surface, Option A. If you're a real team and both surfaces are first-class, Option C. If web and mobile have genuinely divergent UX and you have the team, Option B.

### 27.2 Cross-platform styling library comparison

| Library | Approach | RN | Web | Compiler? | Weekly DLs (Apr 2026) | Best for |
|---|---|---|---|---|---|---|
| Tamagui | Universal components + tokens | Yes | Yes | Yes (optional but recommended) | ~90k | Teams building true universal apps, want design system |
| NativeWind v4 | Tailwind utilities, cross-platform | Yes | Yes | Yes | ~517k (via Tailwind ecosystem) | Teams already comfortable with Tailwind |
| Unistyles 3.x | StyleSheet-compatible API, native C++ | Yes | Yes | No | ~68k | RN-primary apps wanting performance + web support |
| Restyle | Theme-based, tokens-first | Yes | No | No | Modest | Shopify-style theme discipline, RN-only |
| StyleSheet + Platform.select | Built into RN | Yes | Via RN-Web | No | N/A | Small apps, minimum dependencies |
| Tailwind (web only) + separate RN solution | Split styling | No | Yes | Yes (Tailwind) | Huge | Option B architectures |
| React Strict DOM + StyleX | Meta's universal | Emerging | Yes | Yes | Small but growing | Experimental, long-term bet |

If you want one recommendation for a small team building a universal app in 2026: NativeWind v4 if you like Tailwind, Tamagui if you want a full design system, Unistyles if you're RN-primary and want performance.

### 27.3 Navigation pattern by form factor

| Form factor | Primary navigation | Secondary navigation | Notes |
|---|---|---|---|
| Phone portrait | Bottom tab bar (3–5 items) | Stack within each tab | Platform-appropriate headers (iOS large, Android regular) |
| Phone landscape | Bottom tab bar or rail | Stack within each tab | Landscape is rare for Scribe; minimal optimization |
| Small tablet portrait (≤768) | Bottom tab bar | Stack | Treat as large phone |
| Small tablet landscape / large tablet portrait | Side rail (collapsed) or top tabs | Master-detail within area | First form factor where side nav makes sense |
| Large tablet landscape / small desktop | Sidebar (permanent), collapsible | Master-detail | This is where desktop patterns begin |
| Desktop (≥1280) | Sidebar (permanent) + breadcrumbs | Tab sets within views, contextual menus | Multiple simultaneous views |
| Ultra-wide (≥1920) | Sidebar + three-column layout option | User-customizable panels | Don't force more information; let users opt in |

### 27.4 Breakpoint quick reference

| Label | Width | Target form factors | Primary layout changes |
|---|---|---|---|
| xs | 0–480 | Phone portrait | Single column, bottom nav, full-width inputs |
| sm | 481–768 | Phone landscape, small tablet portrait | Still mostly single column, maybe 2-col for grids |
| md | 769–1024 | Tablet landscape, small laptop | Two columns, sidebar appears, tables possible |
| lg | 1025–1440 | Laptop, small desktop | Three-column option, sidebar permanent, dense tables |
| xl | 1441+ | Desktop, external monitor | Wider content, more simultaneous panels |
| 2xl | 1920+ | Ultra-wide | Cap content width; don't fill the void |

Use these as defaults; override with container queries for component-level responsiveness.

### 27.5 What to share / what to split

| Code category | Share? | Location | Notes |
|---|---|---|---|
| Data models / types | Always | `packages/core` | Single source of truth |
| Validation schemas (Zod) | Always | `packages/validation` | Same rules everywhere |
| Business logic (pure functions) | Always | `packages/core` | Calculations, derivations |
| API client | Always | `packages/api` | HTTP/fetch, type-safe |
| Design tokens | Always | `packages/tokens` | Colors, spacing, typography |
| Sync engine (with adapter interface) | Always | `packages/sync` | Platform-specific adapters |
| React hooks (data fetching, form state) | Usually | `packages/hooks` | Platform-agnostic by default |
| Context providers (auth, theme) | Usually | `packages/providers` | |
| Primitive components (Button, Input, Text) | Depends on approach | `packages/ui` (Option C) or per-app | |
| Feature components (InspectionCard) | Sometimes | `packages/features/*` | If UX matches |
| Screen components | Usually not | `apps/mobile/app`, `apps/web/app` | Layouts diverge |
| Navigation config | Never | Per-app | Tab bar ≠ sidebar |
| Platform integrations (camera, file picker) | Never | Per-app | APIs are incompatible |
| Gesture handlers | Never | Per-app | Swipe vs drag are different |
| Assets (images, icons, fonts) | Usually | `packages/assets` or per-app | Consider formats (SVG on web, PNG on RN) |

### 27.6 When to use what container

| Container type | Mobile | Web desktop | Use case |
|---|---|---|---|
| Bottom sheet | Yes (primary) | No | Mobile secondary actions, detail views |
| Side drawer | Yes (navigation) | No (use sidebar) | Mobile navigation |
| Modal dialog | Yes (small, critical) | Yes (small, critical) | Confirmation, simple forms |
| Sheet / slide-over | Limited | Yes (primary) | Desktop forms, filters, detail panels |
| Popover | Limited (large touch) | Yes | Contextual menus, info tooltips |
| Tooltip | No (no hover) | Yes | Hover-only labels, supplementary info |
| Context menu (right-click) | No (use long-press menu) | Yes | Power-user shortcuts |
| Full-screen overlay | Yes | Rarely | Camera, scanner, onboarding |
| Toast / snackbar | Yes | Yes | Transient feedback |

### 27.7 Input type by form factor

| Input | Mobile | Desktop | Notes |
|---|---|---|---|
| Text (single-line) | Native with `inputMode` | `<input>` | Use `inputMode="numeric"`, `email`, etc. |
| Text (multi-line) | Native `TextInput multiline` | `<textarea>` | Desktop: auto-grow via `field-sizing: content` |
| Date | Native wheel picker | Native picker + calendar | Native on both; custom calendar on web only if needed |
| Time | Native | Native | Fine to use platform default |
| Date range | Custom (two pickers) or wheel | Calendar with range select | Diverge UI completely |
| Numeric | Native numeric keyboard | Number input + stepper | `inputMode="numeric"` on web, custom stepper buttons |
| Select (few options) | Native picker or action sheet | Native `<select>` or custom | Native is fine |
| Select (many options) | Search modal or list | Combobox with search | Roll your own or use Radix/Headless UI |
| Multi-select | Checklist modal | Multi-select combobox or chips | |
| Boolean | Switch | Switch or checkbox | Switch is fine on both; checkbox for form fields |
| File upload | Camera or picker | Drag-drop zone + button | Very different UX; diverge |
| Signature | Canvas with touch | Canvas with pointer | Same shared component with pointer events |
| Sketch / annotation | Canvas with touch + stylus | Canvas with pointer | Mostly shared |
| Rich text | Plain text or minimal | TipTap / ProseMirror | Consider not doing rich text on mobile |
| Code | Monaco is desktop-only | Monaco | Mobile: plain text with monospace |

### 27.8 Performance target reference

| Metric | Mobile target | Web target | Notes |
|---|---|---|---|
| App/page startup | <2s cold, <500ms warm | LCP ≤2.5s | Mobile startup is JS + native init |
| First interaction | <500ms | INP ≤200ms | |
| Frame rate | 60fps (90/120 if device supports) | 60fps | Both should feel smooth |
| Layout stability | No jumps after load | CLS ≤0.1 | Reserve space for images, fonts |
| Bundle size (initial) | N/A (app shell) | ≤200KB gzipped, ideally less | Web: code split aggressively |
| Memory (steady state) | <200MB typical | <300MB typical | Measure in dev tools |
| Battery (1hr active use) | <10% drain | N/A | Mobile only; profile with Instruments/Android Profiler |

Targets are starting points; adjust for your app's expected usage pattern. A field inspection app used for hours at a time has stricter battery targets than a check-in app used for 30 seconds.

### 27.9 Responsive component checklist

Before shipping any universal component, verify:

1. Renders correctly at 320px (small phone), 768px (tablet), 1280px (desktop), 1920px (large desktop).
2. Touch targets ≥44×44pt on mobile; keyboard focus visible on web.
3. No hover-dependent functionality (or graceful degradation for touch).
4. No keyboard shortcuts that block mobile users from core functionality.
5. Text scales reasonably with system font-size settings (iOS Dynamic Type, web browser zoom).
6. Layout handles safe areas (notch, home indicator) on mobile.
7. Layout handles scrollbar-gutter or hidden scrollbar differences on web.
8. Respects `prefers-reduced-motion` (no forced animations).
9. Respects `prefers-color-scheme` or app theme setting.
10. Works with screen readers (VoiceOver on iOS, TalkBack on Android, NVDA/JAWS/VoiceOver on web).
11. Works with keyboard-only navigation on web.
12. Survives rotation on mobile; survives window resize on web.
13. Doesn't depend on platform-specific APIs without fallback.
14. Meets WCAG 2.2 AA contrast (4.5:1 text, 3:1 UI) in both light and dark modes.
15. Loads gracefully when offline or on slow network; shows appropriate empty/error states.

Save the list; run it before each release. It takes ten minutes per component and catches most cross-platform regressions.

### 27.10 Offline sync design checklist

If your app needs offline on web:

1. Service worker registered and caches app shell.
2. Data persisted in IndexedDB (Dexie) with versioned schema.
3. Writes go to local store first, then to sync queue.
4. Sync queue has: idempotency keys, retry with backoff, conflict handling.
5. UI shows online/offline indicator.
6. UI shows sync status (pending, syncing, synced, error).
7. Conflict resolution strategy decided (LWW, CRDT, manual) and consistent with mobile.
8. Background Sync API used where available (Chrome/Edge); graceful fallback elsewhere.
9. Sync logic is shared between mobile and web (same engine, different storage adapter).
10. User can see and retry failed syncs.

---

## 28. Curated reading list

The stuff I'd actually read if I were coming to this fresh. Ordered roughly by importance for the universal-app builder.

### Foundational / framework docs

**Expo documentation** — https://docs.expo.dev
The starting point for everything mobile. Expo Router v6 docs, SDK 55 release notes, config plugin system, EAS Build. If you're doing RN in 2026, you're doing Expo; read the whole "Development" section top to bottom.

**React Native documentation** — https://reactnative.dev
Start with the "Guides" section, specifically "Core Components and APIs," "Animations," and "Accessibility." Skip the "Environment Setup" section if you're using Expo (it handles that for you).

**Next.js documentation** — https://nextjs.org/docs
If you're building a Next.js web companion, read the App Router docs thoroughly. Especially: "Routing," "Data Fetching" (server components, server actions), "Rendering" (static, dynamic, streaming), and "Deploying."

**Vite documentation** — https://vite.dev
If you're going Vite + React Router 7 instead of Next.js, read the Vite docs and the React Router docs side-by-side. Vite's section on "Features" and "Build Optimizations" is worth a careful read.

**MDN Web Docs** — https://developer.mozilla.org
Reference material for web platform APIs. Particularly: CSS (specifically grid, flexbox, container queries, custom properties), Service Workers, IndexedDB, Web Storage, Pointer Events, Intersection Observer, Resize Observer. Bookmark it.

### Cross-platform and universal React

**Solito documentation** — https://solito.dev
Even if you don't use Solito, the docs explain universal-app patterns better than most other sources. Fernando Rojo's architectural thinking is worth absorbing.

**Tamagui documentation** — https://tamagui.dev/docs
Read "Intro" and "Core" even if you end up using NativeWind. The universal-component philosophy and token system are instructive.

**NativeWind documentation** — https://www.nativewind.dev
If you're going this route, read the whole site. It's not long.

**Unistyles documentation** — https://unistyl.es
Worth reading for understanding how native styling engines work. The native C++ parser approach is a different model than most RN styling libraries.

**React Strict DOM** — https://github.com/facebook/react-strict-dom
Meta's repo and docs. Early but watching closely is worthwhile; this is probably where the platform is heading long-term.

### Responsive design and CSS

**Every Layout** by Heydon Pickering and Andy Bell — https://every-layout.dev
The best book on CSS layout, period. Chapters on the Sidebar, Cover, Cluster, and Switcher patterns are directly applicable to responsive component design.

**CSS for JavaScript Developers** by Josh Comeau — https://css-for-js.dev
Paid course but worth it if CSS isn't your primary strength. The section on responsive design is particularly good.

**web.dev / Responsive Design** — https://web.dev/learn/design
Google's guide to modern responsive design. Free, up-to-date, covers container queries, fluid typography, and form factors properly.

**Container queries on MDN** — https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries
The reference. Read it once; come back when you're stuck.

**"Intrinsic Web Design" by Jen Simmons** — various talks, findable on YouTube
The foundational thinking on moving beyond media-query-based responsive design toward content-driven layouts.

### Offline, PWA, and sync

**Serwist documentation** — https://serwist.pages.dev
The successor to the Workbox integrations. If you're building a PWA in 2026, start here.

**Workbox documentation** — https://developer.chrome.com/docs/workbox
Still the reference for service worker patterns. The caching strategies section is essential reading.

**Dexie.js documentation** — https://dexie.org
IndexedDB wrapper docs. Read "Tutorial" and "API Reference"; the "Typescript" section if you care about type safety.

**"Offline-First Progressive Web Apps" on web.dev** — https://web.dev/progressive-web-apps
Google's guide to PWAs. Broad overview, good starting point.

**Ink & Switch's "Local-First Software"** — https://www.inkandswitch.com/local-first/
Essay on local-first principles. Theoretical but shapes how you think about sync architecture. The "Seven Ideals" framework is referenced constantly in this space.

**Automerge documentation** — https://automerge.org
If you're building genuine collaborative editing, read the Automerge docs. CRDT library with excellent primer material.

### Accessibility

**WCAG 2.2** — https://www.w3.org/TR/WCAG22
The actual spec. Dry but authoritative. Read the "Understanding" documents rather than the spec text for accessibility criteria.

**A11y Project** — https://www.a11yproject.com
Practical patterns and checklists. The "Resources" and "Checklist" sections are gold.

**Inclusive Components** by Heydon Pickering — https://inclusive-components.design
Book (and free blog archive) on building accessible components. Patterns for tabs, modals, tooltips, forms — all of them.

**Deque University** — https://dequeuniversity.com
Training materials. Some free, some paid. If you want to get serious about accessibility testing, worth the subscription.

### UI libraries worth knowing

**Radix UI** — https://www.radix-ui.com
Headless React primitives for the web. If you're building web UI in 2026, you're using Radix, shadcn/ui (which is Radix), or something similar. Read the docs for their accessibility approach even if you don't use the library.

**shadcn/ui** — https://ui.shadcn.com
Copy-paste components built on Radix. The "reference implementation" for modern web UI. Worth reading the source of any component you're about to build yourself.

**TanStack** (Table, Query, Router, Form) — https://tanstack.com
Tanner Linsley's ecosystem. TanStack Query is essential; TanStack Table is the best web table library. The docs are excellent.

**cmdk** — https://cmdk.paco.me
Command palette primitive. The docs are short; read them all. Even if you don't use cmdk, understanding it helps you build command-palette patterns.

**Vaul** — https://vaul.emilkowal.ski
Drawer/sheet component for React. Emil Kowalski's components are polished and worth studying.

### Performance

**Web Vitals** — https://web.dev/vitals
Core Web Vitals reference. LCP, INP, CLS — what they are, how to measure, how to fix.

**React Native Performance** — https://reactnative.dev/docs/performance
Official RN performance guide. Skim first; return when profiling.

**React Native Developer Tools** — https://reactnative.dev/docs/react-native-devtools
The new (2024+) unified devtools. Much better than what came before.

**"Measure What Matters" for web** by Addy Osmani, various posts on web.dev
Addy's posts on performance measurement and optimization patterns are consistently excellent.

### People worth following

**Fernando Rojo** (@FernandoTheRojo) — Solito creator, universal React evangelist. Twitter and his Solito blog posts are high signal.

**Dan Abramov** (@dan_abramov2) — React core, various writings on React architecture. His blog at overreacted.io is essential.

**Nicolas Gallagher** — Created React Native for Web, now working on React Strict DOM. His writings on universal React are foundational.

**Evan Bacon** — Expo core, Expo Router architect. His dev logs on the Expo blog and Twitter provide the clearest window into where RN is heading.

**Jake Archibald** (@jaffathecake) — Web platform, service workers, PWAs. His blog posts are the reference for service worker patterns.

**Una Kravets** — CSS, web platform advocate at Google. Container queries, color functions, modern CSS. Her talks are the clearest introductions to new CSS features.

**Josh Comeau** — Frontend, CSS, React. His blog is excellent; his writing style is clear.

### Talks worth watching

**"Universal React" by Fernando Rojo** — various versions at React Conf and React Native EU. Watch the most recent.

**"The Future of React Native" by Nicolas Gallagher** — React Strict DOM and the long-term universal vision.

**"Intrinsic Web Design" by Jen Simmons** — YouTube search; multiple versions exist. Foundational responsive design thinking.

**"Rethinking Responsive Design" by Various** — RWD evolution beyond media queries.

**"Local-First Software" by Peter van Hardenberg and Ink & Switch** — CRDT and sync architecture foundations.

### Specific deep dives for Scribe-like apps

**"Designing Data-Intensive Applications" by Martin Kleppmann** — not a web book, but the chapter on replication and consistency is relevant when you're building a sync engine. The CAP theorem matters; so does your choice of conflict resolution.

**SQLite documentation, specifically the WAL and FTS5 pages** — https://sqlite.org/docs.html
You're using SQLite on device; understanding its performance characteristics matters.

**IndexedDB and the Storage Standard** — https://storage.spec.whatwg.org
If you're persisting real data on web, understand the quota and eviction model. The spec is short; read it.

---

## Appendix A: Monorepo structure example

A minimal but real monorepo structure for a universal app with Scribe-like requirements. Adjust to taste.

```
scribe/
├── package.json               # root; workspaces defined here
├── pnpm-workspace.yaml        # workspace config
├── turbo.json                 # Turborepo config
├── tsconfig.base.json         # shared TS config
├── .gitignore
├── .npmrc                     # pnpm settings
├── README.md
│
├── apps/
│   ├── mobile/                # Expo app
│   │   ├── app/               # expo-router routes
│   │   ├── components/        # mobile-specific components
│   │   ├── app.config.ts
│   │   ├── eas.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                   # Vite + React Router 7 (or Next.js)
│       ├── app/               # routes
│       ├── components/        # web-specific components
│       ├── public/
│       ├── vite.config.ts     # (or next.config.mjs)
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── core/                  # domain models, business logic
│   │   ├── src/
│   │   │   ├── models/
│   │   │   ├── logic/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── validation/            # Zod schemas
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── api/                   # HTTP client, type-safe
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sync/                  # sync engine with storage adapters
│   │   ├── src/
│   │   │   ├── engine.ts          # platform-agnostic
│   │   │   ├── adapters/
│   │   │   │   ├── sqlite.ts      # mobile
│   │   │   │   └── dexie.ts       # web
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tokens/                # design tokens
│   │   ├── src/
│   │   │   ├── colors.ts
│   │   │   ├── spacing.ts
│   │   │   ├── typography.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ui/                    # optional: shared primitives
│   │   ├── src/
│   │   │   ├── Button/
│   │   │   │   ├── Button.tsx         # universal
│   │   │   │   ├── Button.web.tsx     # web override if needed
│   │   │   │   └── index.ts
│   │   │   └── ...
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── hooks/                 # shared React hooks
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── config/                # shared configs (eslint, prettier, tsconfig)
│       ├── eslint-preset.js
│       ├── prettier.config.js
│       └── tsconfig.base.json
│
└── .github/
    └── workflows/
        ├── ci.yml
        └── deploy-web.yml
```

### Root package.json

```json
{
  "name": "scribe",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "type-check": "turbo run type-check",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "type-check": {
      "dependsOn": ["^build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

Each package extends this:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Example package.json for packages/core

```json
{
  "name": "@scribe/core",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "eslint src",
    "type-check": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "date-fns": "^3.0.0"
  },
  "devDependencies": {
    "@scribe/config": "workspace:*",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

For internal packages, pointing `main` and `types` directly at source (`./src/index.ts`) keeps the dev loop fast — no build step between package changes and app consumption. Next.js and Vite transpile them on demand; Metro handles it via `transformIgnorePatterns`.

---

## Appendix B: Platform-specific configuration snippets

### Expo config (app.config.ts)

```typescript
import { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Scribe',
  slug: 'scribe',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0A0E1A',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'co.nth.scribe',
    infoPlist: {
      NSCameraUsageDescription: 'Scribe uses the camera to document field inspections.',
      NSPhotoLibraryUsageDescription: 'Scribe accesses your photo library to attach existing photos.',
      NSLocationWhenInUseUsageDescription: 'Scribe tags photos with location for site documentation.',
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0A0E1A',
    },
    package: 'co.nth.scribe',
    permissions: ['CAMERA', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
  },
  web: {
    bundler: 'metro',
    output: 'static',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-camera',
    'expo-image-picker',
    'expo-sqlite',
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '15.1', useFrameworks: 'static' },
        android: { compileSdkVersion: 35, targetSdkVersion: 35, minSdkVersion: 24 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
```

### Next.js config (next.config.mjs)

```javascript
import createWithTM from 'next-transpile-modules';

const withTM = createWithTM([
  '@scribe/core',
  '@scribe/api',
  '@scribe/validation',
  '@scribe/sync',
  '@scribe/tokens',
  '@scribe/ui',
  '@scribe/hooks',
]);

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.scribe.nth.co' },
    ],
  },
  experimental: {
    ppr: 'incremental',  // partial prerendering
    reactCompiler: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withTM(config);
```

Next.js 13+ handles workspace packages without `next-transpile-modules` in most cases; include it only if you hit transpilation errors.

### Vite config (vite.config.ts) for Vite + React Router 7

```typescript
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'Scribe',
        short_name: 'Scribe',
        description: 'Field inspection and reporting',
        theme_color: '#0A0E1A',
        background_color: '#0A0E1A',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.scribe\.nth\.co\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'esnext',
    cssMinify: 'lightningcss',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          router: ['react-router'],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
});
```

### Metro config (metro.config.js) for monorepo-aware Expo

```javascript
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files in the monorepo
config.watchFolders = [workspaceRoot];

// 2. Let Metro know where to resolve packages, and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Force Metro to resolve (sub)dependencies only from the `nodeModulesPaths`
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
```

Without this, Expo can't find workspace packages. With it, everything Just Works (famous last words).

---

## Appendix C: Platform extension patterns

Patterns for file-extension-based platform splits. Metro and Webpack/Vite both resolve these automatically when configured.

### Simple platform split

```
components/
  Camera/
    Camera.ts          # exports, types
    Camera.tsx         # universal fallback (or default)
    Camera.web.tsx     # web-specific implementation
    Camera.native.tsx  # mobile-specific implementation
```

In `Camera.ts`:

```typescript
export type CameraProps = {
  onCapture: (uri: string) => void;
  facing?: 'front' | 'back';
  quality?: 'low' | 'medium' | 'high';
};

// Re-export; Metro/Vite picks the right implementation
export { Camera } from './Camera';
```

In `Camera.native.tsx`:

```typescript
import { CameraView } from 'expo-camera';
import type { CameraProps } from './Camera';

export function Camera({ onCapture, facing = 'back', quality = 'medium' }: CameraProps) {
  // Native RN implementation
  return <CameraView /* ... */ />;
}
```

In `Camera.web.tsx`:

```typescript
import type { CameraProps } from './Camera';

export function Camera({ onCapture }: CameraProps) {
  // Web implementation: file input + optional getUserMedia
  return (
    <input
      type="file"
      accept="image/*"
      capture="environment"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onCapture(URL.createObjectURL(file));
      }}
    />
  );
}
```

### Platform extension order

Metro's default resolution order (as of recent versions):

1. `.ios.tsx` / `.ios.ts` / `.ios.jsx` / `.ios.js` — iOS only
2. `.android.tsx` / etc. — Android only
3. `.native.tsx` / etc. — any native platform (iOS + Android)
4. `.web.tsx` / etc. — web only
5. `.tsx` / `.ts` / `.jsx` / `.js` — universal fallback

So you can layer: a universal `Foo.tsx` with an `.ios.tsx` override for iOS-specific cases, a `.native.tsx` for all-native, and a `.web.tsx` for web.

### Conditional imports within a file

When a platform split is small:

```typescript
import { Platform } from 'react-native';

export const shadowStyle = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  android: {
    elevation: 4,
  },
  web: {
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
  },
});
```

`Platform.select` is fine inline; don't go file-based for trivial splits.

### useMediaQuery for responsive-only splits

When the split is size-based, not platform-based:

```typescript
import { useMediaQuery } from '@scribe/hooks';

export function NavigationShell({ children }: { children: React.ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  return isDesktop ? (
    <SidebarLayout>{children}</SidebarLayout>
  ) : (
    <TabBarLayout>{children}</TabBarLayout>
  );
}
```

Both `SidebarLayout` and `TabBarLayout` live in the same file or are imported; no extension splitting needed since they work on all platforms (though `TabBarLayout` will be simpler on web).

### When to use which

- **Different implementations needed per platform?** File extensions.
- **Same implementation with small styling differences?** `Platform.select` or CSS-in-JS conditionals.
- **Same implementation with size-based differences?** `useMediaQuery` or container queries.
- **Platform-only feature (camera, file system, etc.)?** File extensions, with a stub/null implementation for platforms that can't do it.

---

## Appendix D: Universal component checklist

Fifteen checks to run before declaring a component "done" for both mobile and web. Steal this, adapt it, save it as a PR template.

1. **Renders at minimum viewports.** 320px wide (small phone), 768px (tablet portrait), 1024px (small laptop), 1440px (desktop), 1920px (large desktop). No horizontal scroll, no clipped content.

2. **Touch targets on mobile are ≥44×44pt.** Measured, not estimated. If the visible element is smaller, padding or `hitSlop` makes the hit area larger.

3. **Keyboard navigation works on web.** Tab order is logical. Focus indicator is visible (outline at least 2px, contrast against background). Enter/Space activate. Escape closes modals/menus.

4. **Screen reader labels are present and correct.** iOS: `accessibilityLabel`, `accessibilityHint`, `accessibilityRole`. Web: ARIA attributes or semantic HTML. Test with VoiceOver / TalkBack / NVDA.

5. **Hover states (web) do not break without hover.** Icon-only buttons have labels that appear on focus as well as hover. Tooltips are not the only way to discover a feature. Works for keyboard users.

6. **Platform-specific behavior is justified.** If the component behaves differently on mobile vs. web, there's a reason. If not, unify.

7. **Respects system preferences.** `prefers-reduced-motion`, `prefers-color-scheme` (if you support theming), font-size settings. Doesn't force motion or fight the system.

8. **Works in both light and dark modes.** If you support both. Contrast meets WCAG AA in each. Icons are visible in both.

9. **Degrades gracefully when offline or slow.** Empty states are informative. Loading states are shown. Errors are recoverable (retry button, not a dead end).

10. **Survives orientation changes (mobile) and window resizes (web).** Layout doesn't break at any intermediate width. No content is lost during reflow.

11. **Platform-native patterns where they matter.** Back button on Android, iOS swipe-to-go-back, browser back/forward on web. Don't reinvent navigation.

12. **Form inputs respect platform conventions.** `inputMode` for numeric, email, etc. `autocomplete` hints on web. Spell-check/autocorrect appropriate to the field.

13. **Copy does not assume a form factor.** "Tap" on mobile, "click" on web — or use a neutral verb ("select"). Error messages don't reference "screens" that may not exist.

14. **Performance is acceptable.** On mobile: interactions are ≤16ms where possible. On web: no layout shift, images don't cause reflow. Measured, not assumed.

15. **The component has a visible test story.** A Storybook story, a Playwright test, or a manual test plan in the PR. You know how to verify it without the original developer available.

The list is deliberately one-page-printable. Put it next to your monitor; run through it before pushing. Ten minutes per component catches the issues that would otherwise show up in QA or, worse, from users.

---

*End of document. Companion reference to `react-native-ui-reference.md`; together they cover both depths of the universal-app problem — how mobile UI should feel, and how shared-code mobile+web apps should be architected.*

*Feedback, corrections, "you're wrong about X" — all welcome. This is version 0.1; it will be wrong about things by version 1.0 that haven't happened yet. 2026 is early for parts of this landscape.*
