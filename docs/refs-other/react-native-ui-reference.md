> ⚠️ **AI-GENERATED REFERENCE** — produced by Claude (Anthropic) as a research-project output, April 2026. Not hand-authored, not peer-reviewed. Treat as a primer: version numbers, API signatures, and library recommendations must be verified against upstream docs before load-bearing use. Useful for orientation and vocabulary; not a substitute for the official React Native / Reanimated / Gesture Handler documentation.

---

# React Native UI Interaction Reference

**A state-of-the-art guide to touch, press, selection, gestures, swipes, and polish in React Native — assembled as a project reference.**

Last revised: April 2026. Targets: React Native 0.85, Reanimated 4, Gesture Handler 3, React Navigation 7 / Expo Router 5, FlashList 2, the New Architecture as a given.

---

## Table of contents

1. [How to read this document](#1-how-to-read-this-document)
2. [First principles](#2-first-principles)
3. [The baseline stack (what to install, and why)](#3-the-baseline-stack)
4. [Touch handling primitives](#4-touch-handling-primitives)
5. [Selection states (selected / unselected / indeterminate)](#5-selection-states)
6. [Press feedback (pressed / unpressed / highlighted / focused / hovered)](#6-press-feedback)
7. [Disambiguating touches (multi-gesture composition)](#7-disambiguating-touches)
8. [The gesture catalog](#8-the-gesture-catalog)
9. [Swiping between screens (navigation transitions)](#9-swiping-between-screens)
10. [Animation with Reanimated 4](#10-animation-with-reanimated-4)
11. [Haptics — what, when, and how much](#11-haptics)
12. [Lists that feel fluid](#12-lists-that-feel-fluid)
13. [Bottom sheets and modals](#13-bottom-sheets-and-modals)
14. [Navigation polish (swipe-back, predictive back, large titles, blur headers)](#14-navigation-polish)
15. [Styling approaches](#15-styling-approaches)
16. [Component libraries](#16-component-libraries)
17. [Accessibility (the non-negotiable layer)](#17-accessibility)
18. [Performance debugging and common pitfalls](#18-performance-debugging)
19. [Field-inspection-app specifics](#19-field-inspection-app-specifics)
20. [Quick-reference matrices](#20-quick-reference-matrices)
21. [Curated reading list](#21-curated-reading-list)

---

## 1. How to read this document

This is a reference, not a tutorial. It assumes you know React and the basics of React Native. It tries to be opinionated where opinions are warranted and neutral where they aren't. Each section follows a loose pattern:

- **What it is** — the concept, the mental model.
- **How to do it** — the recommended approach, with code.
- **Alternatives** — what else exists and when you'd pick it instead.
- **Pitfalls** — what will bite you.

Numbers and version choices reflect the ecosystem as of April 2026. The fast-moving libraries — Reanimated, Gesture Handler, Expo SDK, React Native itself — ship new minors every few months. The architectural advice should age well; specific version numbers won't. When in doubt, `npm view <package>` and the library's release notes are your friends.

The recommendations skew toward **Expo + managed workflow**, because that's where the ecosystem's momentum is, and because it makes the right choices easy. Everything here works in bare React Native too, with a bit more setup.

---

## 2. First principles

Before any library, before any code, there are four things the UI has to do well. These come straight from the React Native docs' gesture responder guidance and haven't changed in a decade because they're fundamentals of mobile UX:

**1. Feedback.** Every touch must show the user which element caught it. An un-acknowledged tap feels broken. This is *why* press states exist — not decoration, but confirmation.

**2. Cancellability.** While pressing, the user must be able to abort by sliding off. If your button commits on touch-down instead of touch-up, you've built a mine field.

**3. Determinism.** Given the same sequence of touches, the UI must respond the same way every time. "Usually works" is a latent bug.

**4. Predictability.** The interaction should match what similar interactions do elsewhere on the platform. A swipe-right-to-go-back should actually go back. A long-press should reveal a menu, not delete the item.

These four are *load-bearing*. If any of them breaks, the app feels cheap. Reanimated-powered 120fps animations can't save a button that fires on press-down. Haptic feedback can't save a swipe that sometimes goes back and sometimes doesn't.

### The thread model (why this matters)

React Native runs your JavaScript on a separate thread from the one rendering UI. The OS renders at 60 Hz (or 90, or 120 on modern Android and iPhone Pro models). If your JS thread is busy — computing, fetching, re-rendering — and animations are driven from JS, they stutter. That stutter *is* the difference between "feels polished" and "feels like a web page pretending to be an app".

Two practical consequences:

- **Any interaction driven by the user's finger should run on the UI thread**, not bounce through JS. That means Reanimated + Gesture Handler, which together give you worklet-based UI-thread execution. The older `Animated` API with `useNativeDriver: true` also runs natively but is limited to a subset of properties.
- **Re-rendering React components is expensive.** When a Pressable is pressed, try to express the feedback with a Reanimated shared value reacting to press state, not by re-rendering the whole tree with a new `style` prop. This is especially true inside lists.

### Respect the platform

iOS and Android have different gesture vocabularies. Apple users expect a swipe from the left edge to go back; Android users expect the system back gesture (or button) and as of Android 14 expect the **predictive back animation**. iOS tab bars live at the bottom; Android apps increasingly live at the bottom too but with Material You styling. Don't fight these — lean into them by using platform-native navigators (which React Navigation's native stack gives you for free).

When you must pick one platform's metaphor for cross-platform, document it. But the default should be "whatever's native on each."

### 60 vs 120 fps

A 60 Hz screen gives you 16.67 ms per frame. 120 Hz gives you 8.33 ms. If anything on the JS thread takes longer than that budget, frames drop. Reanimated and Gesture Handler were specifically built so that the *interactive* parts of your UI don't care what the JS thread is doing. For everything else — list items updating from store changes, screen transitions that involve new data — you optimize re-renders.

---

## 3. The baseline stack

This is the skeleton nearly every polished React Native app in 2026 uses. Starting from scratch, install these first:

### Core

- **React Native 0.85+** — New Architecture is assumed default. Expo SDK 54+ tracks this.
- **Expo** (managed) — unless there's a specific reason not to. `expo` unlocks the rest of the stack without manual pod/gradle fiddling.

### Animation and gesture

- **`react-native-reanimated` 4.x** — the animation engine. Shared values, worklets, UI-thread animations, layout animations, and in v4 a CSS-compatible declarative API. Requires the New Architecture. Per the Software Mansion docs, Reanimated 4 is API-compatible with 3 for most code, so migrations are usually clean.
- **`react-native-gesture-handler` 3.x** — gesture recognition on the native side. Replaces the built-in JS responder system for anything non-trivial. V3 introduced composition *hooks* (`useTapGesture`, `useSimultaneousGestures`, etc.) alongside the legacy `Gesture.Race/Simultaneous/Exclusive` API.
- **`react-native-worklets`** — Reanimated 4's underlying worklet runtime. Installed alongside Reanimated; Reanimated 3 *won't work* if this is present, so don't mix versions.

### Navigation

- **React Navigation 7** *or* **Expo Router 5** — Expo Router is a file-based layer on top of React Navigation, so picking Router still gives you all of React Navigation's transitions and gestures. Pick Router for file-based routing and built-in deep links; pick raw React Navigation for maximum control and custom navigator compositions.
- **`react-native-screens`** — makes stack navigators use native screen containers (enables proper swipe-back, predictive back, memory savings).
- **`react-native-safe-area-context`** — everywhere you have insets (notch, home indicator, status bar, Dynamic Island).

### Lists

- **`@shopify/flash-list` 2.x** — replaces `FlatList` for anything non-trivial. V2 requires the New Architecture, is a JS-only solution (no native dependencies anymore), and famously no longer needs `estimatedItemSize`. Per Shopify's announcement, it eliminates estimates entirely and delivers pixel-perfect scrolling on the New Architecture.

### Feedback

- **`expo-haptics`** — official haptics wrapper for iOS Taptic Engine, Android Vibrator/Haptics, and the Web Vibration API. If you need Core Haptics patterns (AHAP files, custom envelopes, Android Composition API), use `react-native-haptic-feedback` instead.

### Styling (pick one)

- **`StyleSheet.create`** — ships with RN. Fastest cold start, no setup. Verbose at scale.
- **`nativewind`** 4.x — Tailwind syntax, build-time compiled to StyleSheet objects. The current ecosystem default if you like Tailwind.
- **`tamagui`** — universal design system with an optimizing compiler. Picks if you're going cross-platform to web and want to share components.
- **`react-native-unistyles`** 3.x — low-level, runtime, responsive-first, theming-first.
- **`@shopify/restyle`** — theme-constrained `Box`/`Text` primitives, TypeScript-first. Tiny, opinionated, excellent if you buy its model.

### Extras (install as needed)

- **`@gorhom/bottom-sheet`** — the bottom sheet. Snap points, dynamic sizing, keyboard handling, scrollable content.
- **`expo-image`** — drop-in `Image` replacement with caching, transitions, and `contentFit` that works sanely.
- **`@shopify/react-native-skia`** — GPU-accelerated 2D graphics, custom shaders, Lottie-via-Skottie.
- **`lottie-react-native`** or **`react-native-skottie`** — Lottie playback. Skottie is faster (~60%+ in Shopify's benchmarks) but supports fewer features.
- **`react-native-pager-view`** — horizontal paging primitive used by tab-view libraries and usable standalone.

### What I'd skip in 2026

- Anything written against the old architecture only.
- `react-native-navigation` (Wix) — still alive, but the ecosystem has consolidated around React Navigation.
- `NativeBase` — deprecated; it morphed into Gluestack. If you were on NativeBase, either migrate to Gluestack or to one of the newer options.
- Pure `Animated` API for anything gesture-driven. Use Reanimated. Keep `Animated` only for the simplest declarative transitions where the dependency cost of Reanimated isn't warranted — and that's a narrow window.
- `TouchableOpacity` et al. for new code. See the next section.

---

## 4. Touch handling primitives

There are three generations of touch primitives in React Native. You will encounter code from all three.

### Generation 1: Gesture Responder System (built-in, low-level)

The original JS-based touch system. It's still there, still works, and you rarely want to use it directly. It lives on the JS thread (latency penalty), requires manual responder negotiation between parent and child views, and has subtle edge-cases with termination (OS taking over for Control Center, etc.).

Use it only when you genuinely need the raw touch stream and can't express what you want with Pressable or Gesture Handler. In practice: almost never.

Key handlers if you must: `onStartShouldSetResponder`, `onMoveShouldSetResponder`, `onResponderGrant`, `onResponderMove`, `onResponderRelease`, `onResponderTerminate`, `onResponderTerminationRequest`. Capture-phase variants (`*Capture`) exist if a parent needs to steal the gesture before it bubbles to a deeper child.

### Generation 2: Touchable* family (legacy, still in core)

`TouchableOpacity`, `TouchableHighlight`, `TouchableWithoutFeedback`, `TouchableNativeFeedback` (Android-only). These wrap the responder system and add feedback:

- `TouchableOpacity` — dims the child on press.
- `TouchableHighlight` — overlays a color on press.
- `TouchableNativeFeedback` — Android ripple (a real Material ripple, not a JS fake).
- `TouchableWithoutFeedback` — press detection with no visual feedback. Use sparingly.

They still work. They're not deprecated. But they're superseded by `Pressable` for new code. The main reason: they bake in the feedback style, so if you want anything other than "fade the whole child", you're composing workarounds.

### Generation 3: Pressable (core component, current recommendation)

`Pressable` is the native-core "tap this thing" primitive. It gives you press state as a render-time value you can map to any style you want. It's platform-aware, accessibility-aware, and gives you hooks for every press lifecycle event.

```tsx
import { Pressable, Text, View } from 'react-native';

<Pressable
  onPress={handlePress}
  onPressIn={handlePressIn}
  onPressOut={handlePressOut}
  onLongPress={handleLongPress}
  delayLongPress={500}
  hitSlop={8}
  pressRetentionOffset={20}
  disabled={!canPress}
  accessibilityRole="button"
  accessibilityLabel="Save inspection"
  style={({ pressed }) => [
    styles.button,
    pressed && styles.buttonPressed,
  ]}
>
  <Text>Save</Text>
</Pressable>
```

The full prop landscape (abbreviated):

| Prop | What it does |
|---|---|
| `onPress` | Fires on press release (the "commit" event). |
| `onPressIn` | Fires on press down. Use for **immediate** feedback (scale, color). |
| `onPressOut` | Fires on release, whether it became a press or was cancelled. |
| `onLongPress` | Fires after `delayLongPress` ms (default 500) of pressing. Suppresses `onPress`. |
| `onHoverIn` / `onHoverOut` | Web / iPadOS pointer. |
| `hitSlop` | Extends the touch area outward (number or `{top,left,bottom,right}`). |
| `pressRetentionOffset` | Extends how far the finger can drift beyond the view while still keeping the press live. |
| `delayLongPress` | ms before `onLongPress` fires. Default 500. |
| `disabled` | When true, no press events fire. Also exposed to accessibility. |
| `android_ripple` | `{color, borderless, radius, foreground}` for native ripple on Android. Borderless works nicely on icon buttons. |
| `style` | Function `({pressed, hovered, focused}) => ViewStyle` for conditional styling. |
| `children` | Can also be a function with the same state object. |

**Two non-obvious props that dramatically improve feel:**

- **`hitSlop`** — the touch area can extend past the visible view. Apple's HIG says 44×44 points; Material Design says 48dp. Most real-world icon buttons are smaller than that visibly. `hitSlop` gives you the larger tap target without the visual bulk. Use it on every icon button.
- **`pressRetentionOffset`** — if the user presses down, then drags their finger slightly off the button *without releasing*, should the button still trigger on release? PressRetention extends the "if released here, still counts" zone. Without it, users who drift during a tap see their tap silently ignored.

The boundary condition: even with `hitSlop`, the touch area never extends past the parent view's bounds, and Z-index ties go to the front-most sibling. If you have overlapping touch targets, you're going to have a bad time regardless of hitSlop.

**Under the hood**, Pressable uses the `Pressability` state machine, which handles the touch-start / move / release / cancel flow and debounces edge cases like OS interruptions. You rarely need to think about it, but it's there.

### Generation 3.5: Gesture Handler's `<Pressable>`

`react-native-gesture-handler` also ships a `Pressable` component that's a drop-in replacement for the core one but routes through the native gesture system. Benefits:

- Press state updates run on the UI thread.
- Better integration with Gesture Handler's `simultaneousHandlers` / `waitFor` / `blocksExternalGesture` relationships, so you can have Pressable alongside other gestures without conflicts.
- The same props you already know — `hitSlop`, `pressRetentionOffset`, `android_ripple`, `delayLongPress`, `onPress`, `onLongPress`, etc. — plus a `disallowInterruption` prop that controls whether a parent gesture (e.g., a ScrollView) can steal the press mid-way.

**Recommendation:** for apps that already depend on `react-native-gesture-handler` (which in 2026 is almost all of them), prefer the RNGH `Pressable` everywhere. It behaves identically to the core one from the user's perspective, but plays better with the rest of the gesture system and is harder to accidentally break.

Wrap your app root with `GestureHandlerRootView`:

```tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function Root() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <App />
    </GestureHandlerRootView>
  );
}
```

Without this wrapper, gesture-handler Pressable and all Gesture.* components silently fail. It's the #1 setup gotcha.

### Touch target sizing

Both platform HIGs have specific minimums. Follow them:

| Platform | Minimum tap target | Unit |
|---|---|---|
| iOS | 44 × 44 | points |
| Android (Material) | 48 × 48 | dp |

Points and dp are effectively the same thing for purposes of sizing decisions in React Native. Make your touch targets at least 44 on the short dimension. If your icon button is visually 24×24, pad to 44×44 (`padding: 10` or equivalent) or use `hitSlop={10}`. Both work; padding affects layout and visible hit feedback, hitSlop doesn't.

For dense UIs where 44 points of padding everywhere would make things look crowded, prefer hitSlop. For primary actions where the visible area *should* be large, prefer real padding.

### `pointer-events` and pointer-target hygiene

Use the `pointerEvents` prop (or style in modern RN) to control whether a view catches touches. Common uses:

- `pointerEvents="none"` on overlays that should be visually present but not intercept touches.
- `pointerEvents="box-only"` to make a view catch touches but not forward them to children (the inverse of the default `box-none`).
- `pointerEvents="auto"` — default.

This is how you handle "blur overlay on top of content" or "loading spinner over a form" without blocking underlying interactions when you don't want to.

### The short version

For 90% of touch targets, the decision is:

1. **Is it just a button?** → `Pressable` (from RNGH if you have it, core otherwise). Use `onPressIn` for immediate feedback, `onPress` for commit, `hitSlop`/`pressRetentionOffset` generously.
2. **Is it a tap that needs to coexist with other gestures, or a non-tap gesture?** → Jump to Gesture Handler's `Gesture.Tap()`, `Gesture.Pan()`, etc. See Section 8.
3. **Do you need legacy Touchable* behavior?** → You probably don't. But they still work.

---

## 5. Selection states

"Selection" is a different concept from "press". Press is transient — it lasts as long as the finger is down. Selection is persistent — it's state you're reading out of your component or data layer, and you render differently because of it.

Selection shows up in several forms:

- **Checkbox** — binary, independent selection (multi-select allowed).
- **Radio button** — single-select from a group.
- **Switch/toggle** — binary with an on/off state and usually an animated thumb.
- **Chip / tag / pill** — compact binary selection, often in filter bars.
- **Segmented control** — N-ary single-select, often replacing a radio group.
- **Card/tile selected state** — selection shown by border/background change on a larger element.
- **List row selected state** — in a multi-select mode on a list (e.g., "select photos to delete").

For each, you need to answer four questions:
1. How is selection shown visually?
2. Is there an intermediate "indeterminate" state?
3. What happens on press (does it *toggle*, or does it open a detail view)?
4. How is it announced to assistive technology?

### Visual design of selection

Selection must be immediately legible without being screamy. The canonical cues:

- **Color fill** — the strongest signal. Unselected = neutral; selected = tint color. Do both a fill *and* a contrasting text/icon color so the difference is not color-alone (accessibility).
- **Border weight or color** — subtler. Works well for cards where you don't want to change the interior color.
- **Check glyph** — explicit. Always unambiguous. Essential for multi-select in lists where users need confidence.
- **Size/scale** — selected items scale slightly larger (e.g., 1.0 → 1.03). Use sparingly; easy to overdo.
- **Shadow/elevation** — selected card lifts slightly. iOS-native feeling.
- **Position** — selected tab gets an underline bar or pill background behind it.

**Rule of thumb:** combine at least two cues, at least one of which is *not* color. Color-blind users exist, and so do dim screens in bright sunlight. A field inspector in full sun on a construction site at 2 PM will thank you.

### Checkbox pattern

React Native doesn't have a built-in checkbox. You can use one from a component library (Paper, Gluestack, RN Reusables) or roll your own.

A minimal, production-quality checkbox:

```tsx
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Check } from 'lucide-react-native';

type Props = {
  value: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
};

export function Checkbox({ value, onChange, label, disabled }: Props) {
  const progress = useSharedValue(value ? 1 : 0);

  // React to prop changes
  React.useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, { duration: 120 });
  }, [value]);

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: progress.value === 0
      ? 'transparent'
      : `rgba(37, 99, 235, ${progress.value})`, // blue-600
    borderColor: progress.value > 0 ? '#2563eb' : '#9ca3af',
  }));

  const checkStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: progress.value }],
  }));

  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: 8 },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Animated.View style={[styles.box, boxStyle]}>
        <Animated.View style={checkStyle}>
          <Check size={14} color="white" strokeWidth={3} />
        </Animated.View>
      </Animated.View>
      {label && <Text>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    width: 20, height: 20,
    borderWidth: 2, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
  },
});
```

Key details that separate this from a throwaway checkbox:

- **`accessibilityRole="checkbox"` + `accessibilityState={{ checked }}`** — VoiceOver and TalkBack announce "Checkbox, checked" or "Checkbox, not checked". This is non-negotiable.
- **`hitSlop={8}`** — the visible box is 20pt but the touch target is now ~36pt. Closer to the 44pt minimum. If the label is included in the Pressable, the whole row is tappable, which is usually correct.
- **Animated check glyph** — scale-in with opacity. 120 ms is the sweet spot for "instant enough to feel responsive, slow enough to register."
- **Indeterminate state**, if needed, is a third value. Model the prop as `boolean | 'indeterminate'` and render a dash glyph instead of check when indeterminate. Commonly used for "select all" parents when children are mixed.

### Radio button pattern

Same as checkbox but the `accessibilityRole` is `'radio'` and selection is exclusive within a group. Mark the group with `accessibilityRole="radiogroup"` on the parent container.

The visual convention is a dot inside a circle. Animation: the inner dot scales from 0 to 1 when selected, 1 to 0 when another option is chosen.

```tsx
<View accessibilityRole="radiogroup">
  {options.map(opt => (
    <Radio
      key={opt.value}
      selected={selected === opt.value}
      onSelect={() => setSelected(opt.value)}
      label={opt.label}
    />
  ))}
</View>
```

### Switch

Use `Switch` from `react-native` — it renders the platform-native toggle (rounded track, animated thumb, proper haptic on iOS). If you need custom styling, `react-native-gesture-handler/Switch` offers the same component with gesture-handler-native touch behavior, or drop to a custom Reanimated implementation.

The platform switches do fire a subtle haptic on iOS automatically. If you're building a custom switch, fire `Haptics.selectionAsync()` on thumb-snap.

### Chip / pill / tag

A chip is a small, rounded-rectangle press target with a label (and sometimes a leading icon). Used heavily in filter bars.

Pattern: unselected chip has a transparent or surface-color fill with a muted border; selected chip inverts — tint-color fill, light-color text. Animate the background color on selection change with Reanimated (`withTiming`, 150 ms).

Compound chips (chip with a close `X`) have a secondary touch target inside. Make the inner `X` its own Pressable with its own hitSlop so fat fingers can reliably hit either target.

### Segmented control

Three canonical approaches:

1. **`@react-native-segmented-control/segmented-control`** — official wrapper around `UISegmentedControl` on iOS and a fallback on Android. Looks native on iOS, adequate on Android.
2. **Custom, cross-platform** — build with a row of Pressables plus a Reanimated-animated "pill" behind them that slides to the selected index. This is the most flexible and gives you identical visuals across platforms.
3. **A Material Top Tab navigator with `tabBarPosition="top"`** — if the segments correspond to whole screens of content, not just a display mode for the same data.

A custom segmented control with a sliding indicator is one of those satisfying 40-line Reanimated exercises. Shared value for the indicator's translateX, `withSpring` for the transition, pressing a segment updates the shared value. Easy, fast, delightful.

### Card / tile selected state

For larger selectables (photo tiles, inspection templates, card pickers), selected state is usually shown with:

- A colored border (2-3pt) or thicker shadow.
- A check badge overlay in a corner.
- Slight scale-up (`1.0 → 1.03`).

Subtlety wins here. The user already knows they just tapped; they need a confirmation, not a fireworks display.

### Multi-select mode in a list

Entering "select mode" in a list is a UX pattern familiar from iOS Photos, Mail, etc. Principles:

- **Enter via long-press** on a row (platform convention) or a "Select" button in the header.
- **Tap behavior changes** while in select mode — a tap toggles selection instead of opening the detail view.
- **Visual shift** — a check circle appears on the left of each row, the header shows action buttons ("Delete", "Share") and a count, and selected rows get a background tint.
- **Haptic** on the mode-enter long-press (medium impact) and on each selection toggle (selection haptic).
- **Exit mode** via a "Cancel" or "Done" button in the header, or after an action completes.

### Focus state (for external keyboards, iPad Stage Manager, Mac Catalyst)

React Native 0.76+ supports keyboard focus on mobile as a first-class concept, and Pressable exposes `focused` in its style/children callback on platforms that have keyboards. On iPads with keyboards and on Android tablets, users can tab through interactive elements, so make sure your focused state has a visible ring (thicker border, glow, or inset).

Focus is not selection. A user can focus an element without committing to selecting it. Treat focus styling as a *third* visual layer on top of pressed and selected.

---

## 6. Press feedback

Press feedback is the animated response to the *transient* act of pressing. It's what tells the user "you hit this and I'm about to do something." Selection is persistent state; press feedback is ephemeral.

The four legit ways to show press feedback, and when to use each:

### Opacity dim (iOS convention, default TouchableOpacity behavior)

The whole element fades to ~0.6 opacity on press, returns to 1.0 on release. Simple, calm, works on any background.

```tsx
<Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}>
```

Good for text buttons, navigation links, items in lists. Default for anything "buttony" on iOS.

### Color change / highlight

Background (or text) color shifts to a darker/lighter variant on press. Most explicit feedback pattern, best for large elements where opacity feels wishy-washy.

```tsx
<Pressable
  style={({ pressed }) => [
    styles.btn,
    { backgroundColor: pressed ? '#1d4ed8' : '#2563eb' },
  ]}
>
```

Good for primary CTA buttons, cards, list rows in Settings-style screens.

### Scale

The element shrinks slightly on press, typically to 0.96 or 0.97. Feels "tactile" and is widely used in custom-designed apps. Should be combined with one of the above (opacity or color) — scale alone is subtle enough to miss.

Animate via Reanimated, not plain React state (which would re-render):

```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

function ScaleButton({ onPress, children }) {
  const scale = useSharedValue(1);

  const tap = Gesture.Tap()
    .onBegin(() => { scale.value = withTiming(0.97, { duration: 80 }); })
    .onFinalize(() => { scale.value = withTiming(1, { duration: 120 }); })
    .onEnd(() => { runOnJS(onPress)(); });

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <GestureDetector gesture={tap}>
      <Animated.View style={[styles.btn, style]}>{children}</Animated.View>
    </GestureDetector>
  );
}
```

This runs on the UI thread. Even if the JS thread is busy parsing a megabyte of JSON, the press animation runs smoothly.

An even cleaner alternative with `Pressable` + Reanimated — use `onPressIn`/`onPressOut` to drive a shared value. Same outcome, shorter code:

```tsx
const scale = useSharedValue(1);
const pressIn = () => (scale.value = withTiming(0.97, { duration: 80 }));
const pressOut = () => (scale.value = withTiming(1, { duration: 120 }));
const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

<Pressable onPressIn={pressIn} onPressOut={pressOut} onPress={onPress}>
  <Animated.View style={[styles.btn, style]}>...</Animated.View>
</Pressable>
```

### Ripple (Android convention)

On Android, the platform convention is a Material ripple — a circular wash that emanates from the touch point. Pressable has native support via `android_ripple`:

```tsx
<Pressable
  android_ripple={{ color: 'rgba(0,0,0,0.12)', borderless: false }}
  style={styles.btn}
>
```

Props:
- `color` — the ripple color, with alpha.
- `borderless` — if true, ripple extends beyond the view's bounds (good for icon buttons without a filled background).
- `radius` — maximum radius.
- `foreground` — if true, ripple renders on top of children (good when children have their own background).

On iOS, `android_ripple` is a no-op, and you'll still want opacity or color feedback. Typical pattern:

```tsx
<Pressable
  android_ripple={{ color: 'rgba(0,0,0,0.12)' }}
  style={({ pressed }) => [
    styles.btn,
    Platform.OS === 'ios' && pressed && { opacity: 0.6 },
  ]}
>
```

This gives each platform its native feedback language.

### Combining feedback channels

The polished approach stacks feedback: scale down *and* opacity dim *and* fire a haptic. But there's a limit — over-feedback feels like the app is desperate. Rules of thumb:

- **Primary buttons** — scale + color change + light haptic on `onPressIn`.
- **Secondary / text buttons** — opacity only.
- **Destructive buttons** — stronger visual feedback (color shift to destructive variant), medium haptic on successful `onPress`.
- **List rows in navigation** — highlight color on press, system platform defaults via native stack (no custom needed).
- **Icon-only buttons** — ripple on Android, opacity on iOS, hitSlop to at least 44 points.
- **Cards / tiles** — subtle scale (0.98) + elevation change, no color shift.

### Press-in vs press-commit: what to animate where

The hierarchy of events:
1. `onPressIn` — finger down. *Animation should start here.*
2. `onPressOut` — finger up, regardless of whether the press commits or is cancelled by dragging off. *Animation should reverse here.*
3. `onPress` — committed press. *Haptic (optional) and the actual action fire here.*
4. `onLongPress` — held too long. *Separate action. `onPress` does NOT fire after `onLongPress`.*

If you fire the action on `onPressIn`, you've built a mine — no way for the user to cancel. Always commit on `onPress`.

### Animating button press with Reanimated 4's CSS API

Reanimated 4 ships a CSS-based animation API as an alternative to worklets. For simple press feedback this is cleaner:

```tsx
// Reanimated 4 CSS API (approximate — check current docs for syntax)
const animatedStyle = {
  animationName: {
    from: { transform: [{ scale: 1 }] },
    to: { transform: [{ scale: 0.97 }] },
  },
  animationDuration: 80,
};
```

This is declarative and Reanimated can optimize it more aggressively than worklets. For simple states driven by prop changes, prefer CSS; for gesture-driven animations, stick with worklets.

### Hover state (iPadOS and Web)

`onHoverIn` and `onHoverOut` on Pressable fire when a pointer (Apple Pencil hover on iPad, mouse on Mac Catalyst, mouse on Web) enters and leaves the view. Use them to preview affordances:

```tsx
style={({ pressed, hovered }) => [
  styles.btn,
  hovered && { backgroundColor: styles.btn.hoverBg },
  pressed && { backgroundColor: styles.btn.pressedBg },
]}
```

For apps only targeting phone-form-factor iOS and Android, you can ignore hover. For anything touching iPad or Web, it's worth the five lines.

### Focus state (keyboard navigation)

Same pattern: `focused` in the style callback. Draw a visible focus ring (2pt border in tint color, or an outset glow). Required for iPad + Magic Keyboard users and Mac Catalyst users and web users.

---


## 7. Disambiguating touches

This is where most apps either feel great or feel broken. The problem: a single touch can be interpreted many ways — a tap, a long press, the start of a pan, a swipe, a double-tap. The UI has to pick the right interpretation, and when multiple elements could legitimately claim the gesture, pick the right *element*.

This section is about composition: how to tell the gesture system *"A and B can happen at once"* or *"B waits for A to fail"* or *"only one of A or B, whoever activates first wins"*.

### The composition vocabulary

Gesture Handler 3 offers two ways to express gesture relationships:

1. **Composition hooks** (RNGH 3 modern API) — `useSimultaneousGestures`, `useExclusiveGestures`, `useRaceGestures` — for when all the gestures are attached to the same component.
2. **Relation properties** (`.simultaneousWithExternalGesture(...)`, `.requireExternalGestureToFail(...)`, `.blocksExternalGesture(...)`) — for when gestures are on different components.

The relation-based API is the one you'll use most often. It has three core relations:

#### Race (default)

Also known as exclusive-race. Only one gesture can win; the first to recognize cancels the others. This is the default behavior between sibling gestures with no explicit relationship.

Used for: single-tap vs. double-tap, pan vs. tap at the same spot, etc.

#### Simultaneous

Both gestures activate and run in parallel. The activation of one does NOT cancel the other.

Used for: pinch + rotate + pan on the same image (photo viewer), swipe + vertical scroll in a carousel cell, etc.

```ts
// All three gestures run at the same time on the same view
const pinch = Gesture.Pinch();
const rotate = Gesture.Rotation();
const pan = Gesture.Pan();
const composed = Gesture.Simultaneous(pinch, rotate, pan);
```

#### Exclusive (with priority)

Only one gesture activates, but the order defines priority. The first gesture in the list has highest priority; if it fails, the second can activate; and so on.

Used for: distinguishing double-tap from single-tap (double-tap has priority; single-tap waits for double-tap to fail), etc.

```ts
const singleTap = Gesture.Tap().onEnd(() => { /* ... */ });
const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => { /* ... */ });
const composed = Gesture.Exclusive(doubleTap, singleTap);
```

Without `Exclusive`, a single tap would fire on every double-tap's first tap. With it, single-tap is held ~300 ms to see if a second tap arrives, then fires if not.

This is why apps that use "tap to like" often feel laggy if double-tap-to-like is also wired in — the single tap is delayed. Design around this: make the primary action the first tap (no double-tap interference), or commit single taps immediately and let double-tap fire an additional action.

### Cross-component relations

When gestures are on different components, use the relation properties:

```ts
// Card inside a ScrollView: pan gesture on the card, native scroll on the list
const scrollGesture = Gesture.Native();
const cardPan = Gesture.Pan()
  .simultaneousWithExternalGesture(scrollGesture);

// Or: pan only activates if scroll has failed (no vertical movement yet)
const cardPan2 = Gesture.Pan()
  .requireExternalGestureToFail(scrollGesture);

// Or: pan blocks the scroll once pan is active
const cardPan3 = Gesture.Pan()
  .blocksExternalGesture(scrollGesture);
```

### Common disambiguation patterns

**Tap vs. double-tap** — `Exclusive(doubleTap, singleTap)`.

**Tap vs. long-press** — these work together by default. Long-press has a built-in delay, so a quick tap fires `onEnd` of Tap before LongPress would activate. No explicit composition needed unless you want the single tap to behave differently when a long-press is also possible.

**Pan inside scroll (vertical scroll, horizontal pan)** — pan with `activeOffsetX: [-10, 10]` and `failOffsetY: [-5, 5]`. This says: "activate if horizontal movement exceeds 10pt; fail if vertical movement exceeds 5pt first." The scroll wins for vertical movement; the pan wins for horizontal.

```ts
const pan = Gesture.Pan()
  .activeOffsetX([-10, 10])
  .failOffsetY([-5, 5])
  .onChange(e => { /* horizontal drag */ });
```

**Carousel inside a modal (both horizontal)** — harder. You can't disambiguate by axis. Options: (a) make the modal's dismiss gesture vertical-only (downward swipe), or (b) require the carousel to be at the edge of its content before the modal's horizontal dismiss activates.

**Press inside a pan-sensitive area** — Pressable has a `disallowInterruption` prop (in RNGH's version) that prevents parent gestures from stealing the press mid-way. Set to `true` for buttons inside sheets, drawers, or scrollviews where the press must complete even if the user drifts.

**Swipeable row with tap** — use a `Gesture.Pan()` for the swipe and a `Gesture.Tap()` for the row tap. Compose with `Race` (default) — whichever activates first wins. Add `activeOffsetX([-10, 10])` to the pan so small accidental drifts don't trigger swipe mode.

**Double-tap to zoom + pan while zoomed** — zoom state in a shared value; pan gesture checks zoom state and only activates when zoomed; double-tap toggles zoom. Two gestures, `Simultaneous` composition.

### The long-press menu pattern

iOS's context menu (peek and pop / context menus): long-press an item to reveal a floating menu with actions. Implemented with `expo-contextmenu` or `react-native-context-menu-view`, both of which wrap the native `UIContextMenuInteraction` on iOS and approximate it on Android.

For a cross-platform "long-press to reveal actions" without going full native context menu, a common pattern is:

1. `Gesture.LongPress()` with `minDuration(400)`.
2. On activation, fire a medium haptic (`Haptics.impactAsync(ImpactFeedbackStyle.Medium)`), scale the element up 1.03, and show a floating menu with the available actions.
3. If the user releases over a menu action, fire it. If they release elsewhere, dismiss.
4. During the long-press-active state, a pan gesture tracks the finger and highlights menu items under it.

This is essentially three gestures composed (LongPress → Pan while active → Tap on menu items). Reanimated worklets make this smooth; doing it with JS state would stutter.

### Gesture state lifecycle

Every gesture goes through these states (named constants in RNGH):

- **UNDETERMINED** — the gesture is not yet started.
- **BEGAN** — touch has started, gesture is being evaluated.
- **ACTIVE** — gesture has been recognized, is currently ongoing.
- **END** — gesture completed successfully.
- **CANCELLED** — gesture was interrupted (e.g., by another gesture winning).
- **FAILED** — gesture's conditions weren't met (e.g., tap timed out into a long press).

You can hook into these with `.onBegin(...)`, `.onStart(...)`, `.onUpdate(...)`, `.onChange(...)`, `.onEnd(...)`, `.onFinalize(...)`. Use `.onFinalize` for cleanup that should always run regardless of success/failure (e.g., resetting animation state).

### `hitSlop` on gestures

Just like on Pressable, gestures support `hitSlop` to extend their active area past the view's visible bounds. Essential for thin interactive elements like sliders:

```ts
Gesture.Pan().hitSlop({ vertical: 20 }) // wide vertical catch area
```

### Worklets and callbacks

By default, Gesture Handler callbacks are workletized when Reanimated is installed — they run on the UI thread. This is why gesture-driven animations are smooth.

If you need JS state updates from a gesture, use `runOnJS`:

```ts
import { runOnJS } from 'react-native-reanimated';

const tap = Gesture.Tap()
  .onEnd(() => {
    // This runs on UI thread
    scale.value = withSpring(1);
    // Call JS-thread function
    runOnJS(setSomeState)(true);
  });
```

Calling a non-worklet function directly inside a worklet callback will crash. `runOnJS` is how you cross back.

### The `.runOnJS(true)` escape hatch

If you have a gesture whose callback absolutely can't be workletized (rare, but happens with certain libraries), `.runOnJS(true)` on the gesture forces all its callbacks to JS. This costs you UI-thread performance but unblocks the integration.

### Putting it together: a swipe-to-delete row

This combines everything:

```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';

const SWIPE_THRESHOLD = -80;

function SwipeableRow({ children, onDelete }) {
  const translateX = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-15, 15])
    .onUpdate(e => {
      translateX.value = Math.min(0, e.translationX);
    })
    .onEnd(() => {
      if (translateX.value < SWIPE_THRESHOLD) {
        translateX.value = withTiming(-500, { duration: 200 }, () => {
          runOnJS(onDelete)();
        });
      } else {
        translateX.value = withSpring(0);
      }
    });

  const tap = Gesture.Tap()
    .onEnd(() => { /* open detail */ });

  const composed = Gesture.Race(pan, tap);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={style}>{children}</Animated.View>
    </GestureDetector>
  );
}
```

Notice the details:

- **`activeOffsetX([-15, 15])` + `failOffsetY([-15, 15])`** — pan only activates on horizontal drift of 15pt, and fails if vertical drift happens first. This keeps the parent scroll usable.
- **Pan only allows leftward translation** (`Math.min(0, ...)`) — swipe-right doesn't do anything.
- **Race composition with tap** — a quick tap opens detail; a longer drag triggers the swipe path.
- **On end, either commit or spring back** — commit animates fully off-screen then calls `onDelete` via `runOnJS`.

---

## 8. The gesture catalog

Gesture Handler provides several specific gestures. You compose from these primitives rather than handling raw touches.

### `Gesture.Tap()`

A single tap (finger down, no significant movement, finger up within a time window).

Configurable:
- `.numberOfTaps(n)` — require n sequential taps (default 1).
- `.maxDuration(ms)` — max time between down and up for this to count as a tap (default 500).
- `.maxDistance(px)` — max finger movement allowed during the tap (default 2).
- `.minPointers(n)` / `.maxPointers(n)` — require multi-finger taps.

Used for: buttons (though Pressable is usually easier), multi-tap gestures (double-tap to like, triple-tap to show debug menu).

### `Gesture.LongPress()`

Press and hold.

Configurable:
- `.minDuration(ms)` — how long before activating (default 500).
- `.maxDistance(px)` — max finger movement allowed; exceeds and it fails (default 10).
- `.numberOfPointers(n)` — multi-finger long-press.

Used for: context menus, drag-to-reorder mode entry, preview/peek.

### `Gesture.Pan()`

Continuous tracking of finger movement.

Configurable:
- `.activeOffsetX([min, max])` / `.activeOffsetY([min, max])` — pan must move this far before activating.
- `.failOffsetX([min, max])` / `.failOffsetY([min, max])` — if movement exceeds this on the orthogonal axis first, pan fails.
- `.minDistance(px)` — total distance to activate.
- `.minPointers(n)` / `.maxPointers(n)`.

Callbacks with worklet-executed event data: `.onStart`, `.onUpdate`, `.onChange`, `.onEnd`. The event gives you `translationX/Y`, `velocityX/Y`, `absoluteX/Y`, `changeX/Y` (delta since last update).

Used for: swipe-to-dismiss, drawers, drag-and-drop, swipeable list rows, scrub through media, draw/paint.

### `Gesture.Pinch()`

Two-finger pinch. Event gives you `scale`, `velocity`, `focalX/Y`, `scaleChange` (delta since last update).

Used for: image viewer zoom, map zoom (though you'll use a map library's built-in gesture).

### `Gesture.Rotation()`

Two-finger rotate. Event gives you `rotation` (radians, absolute), `velocity`, `anchorX/Y`, `rotationChange`.

Used for: image viewer rotation, manipulation of rotatable elements.

### `Gesture.Fling()`

A quick directional swipe. Unlike Pan, Fling fires once at the end when a fast-enough motion in the specified direction is detected.

Configurable:
- `.direction(Directions.LEFT | RIGHT | UP | DOWN)` — which directions to recognize (bitmask).
- `.numberOfPointers(n)`.

Used for: shortcut gestures (swipe up for search), gesture-only navigation (swipe left to go to next item), dismissing modals with a quick down-fling.

### `Gesture.Hover()`

Pointer hover (Apple Pencil, mouse on Mac Catalyst and Web). Fires on enter and exit. No direct touch equivalent — this is for non-touch input.

Used for: tooltips, previews, desktop-class UIs.

### `Gesture.Native()`

Wraps a native view's existing gesture handling (most commonly ScrollView). Used to establish cross-handler relationships with native components that have their own gesture system.

```ts
const scroll = Gesture.Native();
// Now you can reference `scroll` in other gestures' relation properties
```

### `Gesture.Manual()`

Escape hatch for hand-rolled gesture recognition. You get raw touch events and manually transition state via `.onTouchesDown`, `.onTouchesMove`, `.onTouchesUp`, `.onTouchesCancelled`, calling `manager.activate()`, `.fail()`, etc. Only needed for truly custom gestures (I've used it once, for a multi-finger orbit-around-a-point gesture). 99% of apps never touch this.

### Which gesture for which job

| Interaction | Gesture |
|---|---|
| Button tap | `Pressable` (simplest) or `Gesture.Tap()` |
| Double-tap | `Gesture.Tap().numberOfTaps(2)` + `Exclusive` with single tap |
| Long press to reveal menu | `Gesture.LongPress().minDuration(400)` |
| Drag a card to a new position | `Gesture.Pan()` |
| Swipe to dismiss modal (downward) | `Gesture.Pan()` with `activeOffsetY([15, 999])` |
| Swipe to reveal actions | `Gesture.Pan()` with `activeOffsetX`/`failOffsetY` |
| Pinch to zoom an image | `Gesture.Pinch()` + `Gesture.Rotation()` + `Gesture.Pan()`, composed simultaneously |
| Fast flick to skip | `Gesture.Fling().direction(Directions.LEFT)` |
| Pointer hover for tooltip | `Gesture.Hover()` or Pressable's `onHoverIn/Out` |

---


## 9. Swiping between screens

Screen transitions are half of why mobile apps feel different from websites. A React Native app with sluggish or broken transitions feels like a web app wrapped in a WebView, even if it isn't. This section walks through every major transition pattern.

### Two navigation frameworks (that are really one)

As of 2026, there are two options, but they're the same thing underneath:

- **React Navigation 7** — component-based, JavaScript configuration. You define `<Stack.Navigator>`, `<Stack.Screen>`, etc. in code.
- **Expo Router 5** — file-system-based routing. Your `app/` directory structure *is* your navigation. Each file is a screen; `_layout.tsx` files define navigators.

Expo Router is built on top of React Navigation. Under the hood it converts the file structure into React Navigation configuration. This means anything React Navigation can do, Expo Router can do. File-based routing is convention-over-configuration; component-based is more flexible.

**Decision framework:**
- New project, Expo-based, Next.js/SvelteKit experience → **Expo Router**.
- Need unusual navigator compositions, conditional navigators, or migrating from an existing React Navigation app → **React Navigation**.
- Need deep links and universal linking with zero config → **Expo Router** (automatic for every route).
- Want full imperative control → **React Navigation**.

Both are well-maintained. There is no "wrong" choice.

### Native stack vs. JS stack

React Navigation has two stack implementations:

- **Native Stack** (`@react-navigation/native-stack`) — wraps the platform's native navigation containers (`UINavigationController` on iOS, Fragment-based navigation on Android). Fast, platform-authentic transitions, predictive back gesture on Android 14+, iOS large title headers, etc.
- **JS Stack** (`@react-navigation/stack`) — pure JS implementation with full customization via `cardStyleInterpolator` and `transitionSpec`. Slower, but lets you build custom transitions that the native stack can't do.

**Use Native Stack by default.** It's the current recommendation, the default for Expo Router, and gives you native behavior for free. Fall back to JS Stack only when you need a specific custom transition.

### Transition options (Native Stack)

Native Stack transitions are configured via `screenOptions.animation`. Available values include:

- `default` — platform default (slide-from-right on iOS, fade-up on Android).
- `slide_from_right` / `slide_from_left` / `slide_from_bottom` — directional slides.
- `fade` — cross-fade.
- `fade_from_bottom` — slide + fade.
- `flip` — 3D flip (iOS-style modal).
- `none` — no animation.

Plus these presentation modes that affect the *container* (not just the transition):

- `push` (default) — new screen pushes on top of stack.
- `modal` — screen slides up from bottom, the underlying screen scales/fades slightly.
- `transparentModal` — modal with a transparent background.
- `formSheet` (iOS 15+) — iOS's native half-height sheet.
- `fullScreenModal` — modal without the underlying-screen scale effect.

Example:

```tsx
<Stack.Navigator screenOptions={{ animation: 'slide_from_right' }}>
  <Stack.Screen name="Home" component={HomeScreen} />
  <Stack.Screen
    name="Settings"
    component={SettingsScreen}
    options={{ presentation: 'modal' }}
  />
</Stack.Navigator>
```

### Swipe-back gesture

On iOS, users expect to swipe from the left edge to go back. The Native Stack gives you this automatically — it's the platform native behavior. You can control it per screen:

```tsx
<Stack.Screen
  name="CheckoutConfirmation"
  component={ConfirmationScreen}
  options={{ gestureEnabled: false }}  // can't swipe back from here
/>
```

On Android, the system has its own back gesture (swipe from either edge). React Navigation 7 supports **predictive back** on Android 14+, which shows a preview of the previous screen as the user swipes. Enable via `react-native-screens` and target SDK 34+.

### Custom transitions (JS Stack)

If the built-in animations don't cover your case, drop to JS Stack:

```tsx
import { CardStyleInterpolators, TransitionSpecs } from '@react-navigation/stack';

<Stack.Navigator
  screenOptions={{
    transitionSpec: {
      open: TransitionSpecs.TransitionIOSSpec,
      close: TransitionSpecs.TransitionIOSSpec,
    },
    cardStyleInterpolator: ({ current, next, layouts }) => ({
      cardStyle: {
        transform: [
          {
            translateX: current.progress.interpolate({
              inputRange: [0, 1],
              outputRange: [layouts.screen.width, 0],
            }),
          },
        ],
        opacity: current.progress,
      },
    }),
  }}
>
```

`cardStyleInterpolator` receives progress values for the current screen's transition in/out and the next screen's transition in; you return styles for each. This is flexible but easy to get wrong, and the resulting animations aren't hardware-accelerated in the same way as the native stack.

### Tabs

Three tab navigator types:

#### Bottom Tabs (`@react-navigation/bottom-tabs`)

The iOS/Android-convention bottom tab bar. Each tab is a stack of its own. No swipe-to-switch between tabs by default (you tap or navigate programmatically). JS-rendered tab bar with customizable icons and labels.

```tsx
<Tab.Navigator>
  <Tab.Screen name="Home" component={HomeStack} options={{ tabBarIcon: ... }} />
  <Tab.Screen name="Profile" component={ProfileStack} />
</Tab.Navigator>
```

#### Material Top Tabs (`@react-navigation/material-top-tabs`)

Top tab bar, **swipeable**. This is the one when you want horizontal-swipe navigation between sibling screens. Uses `react-native-pager-view` under the hood for native paging performance. Per the React Navigation docs, you get swipe gestures enabled by default and can disable per-screen with `swipeEnabled: false`.

```tsx
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';

const Tab = createMaterialTopTabNavigator();

<Tab.Navigator
  screenOptions={{ swipeEnabled: true, lazy: false }}
  initialLayout={{ width: Dimensions.get('window').width }}
>
  <Tab.Screen name="Feed" component={FeedScreen} />
  <Tab.Screen name="Notifications" component={NotificationsScreen} />
  <Tab.Screen name="Messages" component={MessagesScreen} />
</Tab.Navigator>
```

`initialLayout` avoids a first-frame flicker. `lazy: false` pre-mounts all tabs so swiping between them is instant (pre-rendered). Set to `true` if tabs are expensive to mount; pay a brief loading hit when entering a tab for the first time.

For a custom tab bar animated with the scroll position (the Instagram-style sliding underline), use the `useTabAnimation` hook which returns the pager's current position as an animated value. Hook a Reanimated shared value to it and drive your indicator's `translateX`.

#### Material Bottom Tabs (deprecated in favor of customizing Bottom Tabs + Material Top with `tabBarPosition: 'bottom'`)

Historically Material Bottom Tabs was a separate navigator. In 2026 the cleaner approach is either plain Bottom Tabs (tap-only) or Material Top Tabs with the bar positioned at the bottom:

```tsx
<Tab.Navigator tabBarPosition="bottom" ...>
```

This gives you a bottom tab bar *with* swipe gestures.

### Drawer

`@react-navigation/drawer` — hamburger-menu-style side drawer. Pan from the left edge to reveal. Less common on mobile than it used to be (bottom tabs won the decade), but still appropriate for apps with many top-level sections.

### Horizontal paging inside a screen (not navigation)

For carousels, image galleries, onboarding flows — anywhere you want horizontal swipe-paging *inside* one screen — use `react-native-pager-view` directly:

```tsx
import PagerView from 'react-native-pager-view';

<PagerView
  style={{ flex: 1 }}
  initialPage={0}
  onPageSelected={e => setPage(e.nativeEvent.position)}
>
  <View key="1"><Text>Page 1</Text></View>
  <View key="2"><Text>Page 2</Text></View>
  <View key="3"><Text>Page 3</Text></View>
</PagerView>
```

Native paging, smooth, snaps to pages. Handles the page dots/indicator separately.

Alternatives:
- **FlashList with `horizontal`** — for data-driven galleries with snapping.
- **Reanimated Carousel (`react-native-reanimated-carousel`)** — the most popular JS-side carousel with parallax, loop, auto-play.

### Nested gesture conflicts (pager inside pager inside tabs)

When you nest horizontal-swipe containers (e.g., an image gallery inside a Material Top Tab), the outer container often fails to receive horizontal swipes at the edges of the inner. The React Navigation fix: set the inner pager's `overScrollMode` so at the first/last page it yields control back to the parent. There's been historical iOS-specific jankiness here; test on both platforms. The cleanest solution is often to avoid the nest if possible — use a segmented control for inner switching instead of a swipeable pager.

### Shared element transitions

Shared element transitions (the Hero-like effect where an element animates from one screen to another) are in progress in React Navigation / `react-native-screens`. Status as of 2026:

- **`react-native-shared-element`** — mature, worked for years, currently in maintenance mode.
- **`react-native-screens` native shared elements** — experimental; check current release notes.
- **Reanimated + manual coordination** — rolling your own using Reanimated's `SharedTransition` API (added in v3.6+) and a coordinated shared value on both source and target screen.

For now, if you need shared element transitions, the Reanimated v3+ approach is cleanest:

```tsx
import { SharedElement } from 'react-native-shared-element';
// ... or Reanimated's SharedTransition API directly.
```

The API is stabilizing; check Software Mansion's blog for the current-recommended approach when you build this.

### Modal and bottom sheet

For modals: use the Native Stack's `presentation: 'modal'` or `'formSheet'` for iOS half-height sheets. See Section 13 for bottom sheets.

### Deep linking & back stack

Expo Router gives you deep links for free — every file in `app/` is a URL. React Navigation deep linking needs manual config via a `linking` object passed to `NavigationContainer`.

For mobile apps, deep links go through a custom scheme (`myapp://foo/bar`) or universal/app links (`https://myapp.com/foo/bar`). When a user opens a deep link mid-session, you typically want the back stack to behave like they navigated there naturally — so tapping back goes to the app's home rather than exiting. This is `getStateFromPath` territory; Expo Router handles it automatically.

---


## 10. Animation with Reanimated 4

Reanimated is the animation engine. Reanimated 4, shipped stable in mid-2025, targets the New Architecture exclusively and introduces a CSS-compatible API alongside the familiar worklet-based one. Per the Software Mansion announcement, the API is compatible with Reanimated 3 for most code, so migration is usually clean.

### The three mental models

Reanimated supports three different ways to define an animation. Learn all three; pick the one that fits each case.

#### 1. Shared values + animated styles (imperative / procedural)

The original Reanimated 2/3 pattern, still fully supported. You create a shared value (a JS reference backed by a UI-thread value), update it with animation functions, and derive a style from it:

```tsx
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
} from 'react-native-reanimated';

function Example() {
  const opacity = useSharedValue(1);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[styles.box, style]}>
      <Button onPress={() => (opacity.value = withSpring(0.5))} title="Dim" />
    </Animated.View>
  );
}
```

Use for: gesture-driven animations, animations that depend on complex interpolations, anything where you need the value as a number you can read.

#### 2. Entering / Exiting / Layout animations (declarative transitions)

For animations that happen when a component mounts, unmounts, or resizes:

```tsx
import Animated, {
  FadeIn, FadeOut, Layout, SlideInDown, SlideOutUp,
  BounceIn, ZoomIn, ZoomOut,
} from 'react-native-reanimated';

<Animated.View
  entering={FadeIn.duration(200)}
  exiting={SlideOutUp.duration(150)}
  layout={Layout.springify()}
>
  ...
</Animated.View>
```

Available pre-built animations include `FadeIn/Out`, `SlideIn/Out` (Left/Right/Up/Down), `ZoomIn/Out`, `FlipIn/OutX/Y`, `BounceIn/Out`, `LightSpeedIn/Out`, `PinwheelIn/Out`, `RollIn/Out`, `RotateIn/Out`, and `StretchIn/Out`. They chain: `.duration(ms).delay(ms).springify().damping(n)` etc.

`Layout` animations fire when an Animated.View resizes or moves due to layout changes (e.g., adding an item to a flex container, changing a `width`). Essential for lists where rows should smoothly slide aside when a new row appears.

#### 3. CSS animations (new in Reanimated 4)

Reanimated 4 adds a declarative CSS-animations API that mirrors web CSS animations and transitions:

```tsx
<Animated.View
  style={{
    animationName: {
      from: { opacity: 0, transform: [{ translateY: 20 }] },
      to: { opacity: 1, transform: [{ translateY: 0 }] },
    },
    animationDuration: 300,
    animationTimingFunction: 'ease-out',
  }}
/>
```

Or transitions:

```tsx
<Animated.View
  style={{
    opacity: isVisible ? 1 : 0,
    transitionProperty: 'opacity',
    transitionDuration: 200,
  }}
/>
```

Use for: simple state-driven animations where worklets would be overkill. Reanimated can optimize these more aggressively than worklet-driven styles because it knows exactly what's being animated.

### Spring vs timing

`withTiming(target, { duration, easing })` — time-based. You specify how long and what easing curve.

`withSpring(target, { damping, mass, stiffness, velocity })` — physics-based. You specify the physical properties and the animation resolves when it naturally settles.

When to prefer which:

- **Timing** — UI elements that snap to a state (fade in a modal, slide a drawer to a specific position). Predictable duration.
- **Spring** — elements that feel like they have momentum (a dragged card letting go and settling, a toggle thumb snapping to its new position, a confirmed selection "pop"). Natural, tactile feel.

Spring configuration cheat sheet:

| Damping | Behavior |
|---|---|
| 10 | Very bouncy, several oscillations |
| 15 | Moderate bounce, tasteful |
| 20 | Critical-ish, one small overshoot |
| 30+ | No bounce, just ease-to-target |

Higher `stiffness` makes the spring snappier (gets to target faster). Higher `mass` makes it slower and more "weighty." Defaults in Reanimated (`damping: 10, mass: 1, stiffness: 100`) are a good starting point.

`.springify()` on an entering animation uses spring physics instead of timing.

### Easing functions

Reanimated ships with `Easing`:

- `Easing.linear` — constant rate. Rarely right.
- `Easing.ease` — default curve. Ease-in-ease-out.
- `Easing.in(fn)`, `Easing.out(fn)`, `Easing.inOut(fn)` — apply a base function to in/out/both.
- `Easing.bezier(x1, y1, x2, y2)` — custom cubic bezier.
- Base functions: `quad`, `cubic`, `poly(n)`, `sin`, `circle`, `exp`, `elastic`, `back`, `bounce`.

Common choices:
- **Ease-out** (`Easing.out(Easing.cubic)`) for entering things — starts fast, slows into place.
- **Ease-in** (`Easing.in(Easing.cubic)`) for exiting things — starts slow, accelerates off-screen.
- **Ease-in-out** (`Easing.inOut(Easing.cubic)`) for state changes that aren't entrances/exits.

If you're copying a web design, the CSS `cubic-bezier(0.4, 0, 0.2, 1)` (Material's "standard easing") is `Easing.bezier(0.4, 0, 0.2, 1)` in Reanimated.

### Animation duration guidelines

- **Micro-interactions** (press feedback, checkbox toggle): 80–150 ms
- **Small transitions** (button state changes, small fades): 150–250 ms
- **Large transitions** (screens, modals): 250–400 ms
- **Attention-grabbing entrances** (success confirmations, errors): 300–500 ms
- **Decorative** (splash animations, delight): 400–1000 ms

Anything above ~400 ms starts to feel slow on a modern device. Anything below ~80 ms feels like a jump-cut.

The platform convention: iOS transitions generally run 250–350 ms, Android 200–300 ms. Matching these makes your app feel native.

### Sequencing and delays

`withSequence(anim1, anim2, anim3)` — runs animations back-to-back.

`withDelay(ms, animation)` — starts the animation after a delay.

`withRepeat(animation, count, reverse)` — repeats N times (or infinitely with `-1`), optionally reversing each iteration.

Example: a confirmed-action pulse:

```ts
scale.value = withSequence(
  withTiming(1.1, { duration: 100 }),
  withSpring(1, { damping: 8 })
);
```

### `runOnJS` and `runOnUI`

Reanimated 4 introduced `runOnRuntimeAsync` and `runOnRuntimeSync` for more flexible worklet scheduling, but the everyday tools are still:

- **`runOnJS(fn)(...args)`** — call a JS-thread function from a worklet.
- **`runOnUI(fn)(...args)`** — schedule a worklet to run on the UI thread from JS.

Use `runOnJS` for state updates, navigation calls, etc. in gesture/animation callbacks. Use `runOnUI` when you want to kick off UI-thread work (e.g., updating a shared value) from JS.

### Worklet mistakes that silently break things

A worklet is a JS function Reanimated can serialize and run on the UI thread. Worklets have strict rules:

- They can only call *other* worklets or whitelisted functions.
- They can read React state at definition time (it's captured as closure) but cannot call hooks.
- Regular JS functions inside a worklet throw at runtime.
- Third-party code that isn't worklet-aware won't work.

Symptoms of worklet mistakes:
- "ReferenceError" about variables that exist in your JS code.
- Silent no-ops where the animation just doesn't happen.
- Crashes on Fabric but not on the old architecture (or vice-versa in old code).

When in doubt, wrap the questionable function call in `runOnJS(fn)(...)` to move it back to the JS thread. Performance cost is minor for anything that doesn't run every frame.

### Useful Reanimated hooks beyond the basics

- **`useDerivedValue(() => ...)`** — a shared value that recomputes when its dependencies (other shared values) change. Like a memoized selector for UI-thread values.
- **`useAnimatedReaction(prep, react)`** — run a reaction whenever a computed value changes. Reanimated 4 cleaned up this pattern significantly.
- **`useAnimatedScrollHandler`** — get scroll position as a shared value in real time. Essential for parallax, blur-on-scroll headers, scroll-driven animations.
- **`useAnimatedGestureHandler`** (legacy, Reanimated 2/3 era) — historical API for gesture worklets; in RNGH2+ the Gesture API (`Gesture.Pan()` etc.) is preferred. Don't use this in new code.
- **`interpolate(input, inputRange, outputRange, extrapolation)`** — the core interpolation function inside worklets. Like `Animated.interpolate` but on the UI thread.
- **`interpolateColor(...)`** — same for colors (handles RGB correctly).

### Moti: Reanimated with sugar

[Moti](https://moti.fyi) is a declarative wrapper on top of Reanimated that feels like Framer Motion's web API:

```tsx
import { MotiView } from 'moti';

<MotiView
  from={{ opacity: 0, scale: 0.5 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0 }}
  transition={{ type: 'spring' }}
/>
```

For projects where most animations are simple state-driven transitions, Moti cuts a lot of boilerplate. It's designed to coexist with raw Reanimated, so you can drop down when you need the power.

Worth considering for teams whose animations are 80% fade/slide/scale and don't need gesture-driven complexity.

### Layout animations — the secret weapon

`entering`, `exiting`, and `layout` props on `Animated.View` are criminally under-used. They're the closest thing to "CSS transitions for RN." Adding `layout={Layout.springify()}` to every list item gives you free, smooth slide-aside animations when items are added or removed. No controller code, no keyframes. Use them.

---

## 11. Haptics

Haptics are the physical tap/buzz/click feedback from the device's vibrator (Android) or Taptic Engine (iPhone 7+). Used well, they make the app feel physical and responsive. Used badly, they make it feel like the phone is vibrating in protest.

### The iOS taxonomy (Taptic Engine)

iOS has four semantic haptic types. Per Apple's HIG, each corresponds to a different meaning:

#### Impact (`impactAsync`)

A tactile "bump" — something happened in the UI. Variants by weight:

- `ImpactFeedbackStyle.Light` — light tap, small UI event.
- `ImpactFeedbackStyle.Medium` — medium weight, moderate event.
- `ImpactFeedbackStyle.Heavy` — strong thud, significant event.
- `ImpactFeedbackStyle.Soft` — diffuse, cushioned.
- `ImpactFeedbackStyle.Rigid` — crisp, stiff.

Use for: button presses (Light), sheet snap-to-position (Medium), drag-and-drop pick-up (Medium), destructive action confirmation (Heavy), page turn in a book (Soft).

#### Notification (`notificationAsync`)

A patterned buzz conveying success, warning, or failure. Variants:

- `NotificationFeedbackType.Success` — success haptic.
- `NotificationFeedbackType.Warning` — warning haptic.
- `NotificationFeedbackType.Error` — error haptic.

Use for: form submission success, validation error, warning-level feedback (but sparingly — notifications are the most attention-grabbing).

#### Selection (`selectionAsync`)

A very subtle tick. Meant for continuous selection changes — think scrubbing a time picker's hour wheel, or sliding through a list of options. Fires once per selection change.

Use for: picker wheels, sliding-segment selection, scrolling through discrete options.

### The Android taxonomy

Android's situation is messier. Historically the Vibrator API accepted raw duration/amplitude arrays; modern Android (API 30+) added `HapticFeedbackConstants` and `VibrationEffect.Composition` for semantic haptics similar to iOS.

`expo-haptics` on Android uses the semantic Android haptics API when available (via `performAndroidHapticsAsync`) and falls back gracefully. Constants include:

- `Confirm` — confirmation of success.
- `Reject` — rejection/failure.
- `Clock_Tick` — picker-style tick.
- `Context_Click` — "menu item selected" click.
- `Gesture_Start` / `Gesture_End` — beginning/end of a gesture.
- `Segment_Tick` / `Segment_Frequent_Tick` — discrete selection tick, with the frequent variant being soft enough to fire rapidly.
- `Toggle_On` / `Toggle_Off` — switch haptics.
- `Virtual_Key` — virtual keyboard key press.

The Expo docs specifically recommend `performAndroidHapticsAsync` over the older `Vibrator` API because it matches iOS feel and doesn't require the VIBRATE permission.

### When NOT to fire haptics

- **Any haptic while the user is typing** — the keyboard has its own haptics.
- **Every frame of a continuous gesture** — a pan gesture shouldn't fire a haptic every pixel. Fire on threshold crossings (e.g., snap points, magnetic edges).
- **Background events the user didn't initiate** — a push notification arriving shouldn't trigger a haptic; the OS handles that.
- **When the user has haptics disabled** — respect the setting. Detect via `getSystemHapticStatus()` on the non-Expo libraries, or just accept that iOS returns silently if disabled.
- **Low Power Mode** — iOS disables haptics in Low Power Mode. Your call is a no-op; that's fine, but don't assume haptic fired.

### When TO fire haptics

- **Primary button press** — `Light` impact on `onPressIn`, nothing on release.
- **Toggle / switch flipped** — `Selection` or `Toggle_On/Off`.
- **Long press activation** — `Medium` impact when the long press commits.
- **Drag handle grab** — `Medium` impact on pick-up.
- **Snap-to-position** (cards, sheets, pickers) — `Light` impact on each snap.
- **Pull-to-refresh commits** — `Medium` impact when threshold is crossed.
- **Successful save / form submit** — `Success` notification.
- **Validation error** — `Error` notification (once, not on every keystroke).
- **Destructive confirmation** — `Heavy` impact on confirm button press.
- **Picker wheel tick** — `Selection` per tick.

### Practical hook

A useful custom hook:

```tsx
import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';

export function useHaptics() {
  return {
    tap: useCallback(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), []),
    bump: useCallback(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), []),
    thud: useCallback(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), []),
    select: useCallback(() => Haptics.selectionAsync(), []),
    success: useCallback(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), []),
    warning: useCallback(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning), []),
    error: useCallback(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error), []),
  };
}
```

Then in a component:

```tsx
const haptics = useHaptics();
// ...
<Pressable onPressIn={haptics.tap} onPress={handleSave}>
```

### User preference: make it toggleable

Some users dislike haptics. Respect a user setting. Store an `enableHaptics` preference; wrap your haptic calls:

```tsx
function useHaptic(type: HapticType) {
  const enabled = useSettingsStore(s => s.hapticsEnabled);
  return useCallback(() => {
    if (!enabled) return;
    triggerHaptic(type);
  }, [enabled, type]);
}
```

`react-native-haptic-feedback` has a built-in kill switch (`setEnabled(false)` makes all calls no-ops). With `expo-haptics` you wrap manually.

### Custom patterns (advanced)

For complex patterns — a "heartbeat" pulse, a specific rhythm — you need either:

- **`react-native-haptic-feedback`** with AHAP files (iOS Core Haptics) or Android composition patterns.
- **`expo-ahap`** for AHAP support in Expo projects.

These are Apple's audio-haptic pattern files, a JSON format describing timed haptic events with variable intensity. Overkill for most apps, essential for games or apps where haptics are a feature (meditation timers, rhythm apps).

### The ringer / silent mode question

On Android, the user's ringer state affects haptics — silent mode often disables them. `react-native-haptic-feedback` exposes `getSystemHapticStatus()` so you can detect this. On iOS, the Taptic Engine is separate from the ringer (the iPhone's silent switch does not silence haptics) — so iOS apps can rely on haptics firing when the user has them enabled in settings.

---


## 12. Lists that feel fluid

Lists are where most React Native apps fall apart. They're the hardest component to get right because they interact with every layer: recycling, rendering, layout, scrolling, gesture handling, and memory. A junky list ruins the perception of the whole app.

### The list hierarchy

- **ScrollView** — renders everything at once. Fine for small, fixed-size lists (< ~20 items of simple content). Above that it tanks cold start and memory.
- **FlatList** — built-in, virtualized, uses recycling for simple cases but not aggressively. Acceptable performance on iOS; historically struggled on low-end Android.
- **SectionList** — like FlatList but with section headers. Same underlying engine.
- **FlashList (Shopify)** — `@shopify/flash-list` — drop-in FlatList replacement with aggressive recycling. V2 is the current recommendation for any non-trivial list.
- **LegendList** — newer entrant from Legend App that also targets FlatList replacement; growing ecosystem, worth watching. Not yet mainstream.

**The default for 2026 is FlashList v2** unless the list is trivial.

### FlashList v2

Per Shopify's rollout, FlashList v2 is a complete rewrite targeting the New Architecture. The key developer-facing changes from v1:

- **No more `estimatedItemSize`.** V1 required an estimate; v2 measures dynamically using the New Architecture's synchronous layout measurements. You just pass `data` and `renderItem`.
- **JS-only.** No native module anymore, simpler installation and maintenance.
- **New Architecture only.** Will not run on the old architecture. V1 is maintained separately for legacy apps.
- **New hooks.** `useLayoutState` and `useRecyclingState` help write item components that handle recycling correctly.

Minimal usage:

```tsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={items}
  renderItem={({ item }) => <InspectionRow item={item} />}
  keyExtractor={item => item.id}
  // For heterogeneous item types, provide getItemType for better recycling:
  getItemType={item => item.type}
/>
```

### Making renderItem fast

The single most important optimization: **make your item component cheap**. FlashList recycles item views — when a view scrolls off-screen, instead of unmounting it, FlashList passes it new props and re-renders with new data. This means item components must be:

- **Memoized** (`React.memo`) unless they're already cheap.
- **Prop-stable** — parents pass stable references. Don't create new objects/arrays/functions on each parent render.
- **Not over-decorated with inline functions** — if you pass `onPress={() => navigate(item.id)}`, you're creating a new function every render.

A clean item pattern:

```tsx
const InspectionRow = memo(({ item, onPress }) => {
  const handlePress = useCallback(() => onPress(item.id), [item.id, onPress]);
  return (
    <Pressable onPress={handlePress} style={styles.row}>
      <Text>{item.title}</Text>
      <Text>{item.date}</Text>
    </Pressable>
  );
});
```

And in the parent:

```tsx
const handleRowPress = useCallback((id) => navigate(`/inspection/${id}`), [navigate]);
<FlashList data={items} renderItem={({ item }) => <InspectionRow item={item} onPress={handleRowPress} />} />
```

Per the FlashList v2 docs, memoizing props is *more* important in v2 than v1 — v1 was more selective about re-renders, v2 reacts to prop changes more literally.

### `useMappingHelper`

When you need to `.map()` over an array inside an item component (e.g., rendering tags), React forces you to use `key` props. FlashList provides `useMappingHelper` which returns recycling-aware keys:

```tsx
import { useMappingHelper } from '@shopify/flash-list';

const TagList = ({ tags }) => {
  const { getMappingKey } = useMappingHelper();
  return tags.map((tag, i) => (
    <Tag key={getMappingKey(tag.id, i)}>{tag.name}</Tag>
  ));
};
```

Without this, recycled items with different tag counts can flicker or render stale content.

### Heterogeneous lists

If items have different types (text message, image message, system message), tell FlashList via `getItemType` so it recycles by type:

```tsx
<FlashList
  data={messages}
  getItemType={item => item.type}
  renderItem={({ item }) => {
    switch (item.type) {
      case 'text': return <TextMessage item={item} />;
      case 'image': return <ImageMessage item={item} />;
      default: return null;
    }
  }}
/>
```

### Swipe-to-delete (and swipe actions)

Per-row swipe actions are a huge UX win. Two ways:

#### Option 1: `react-native-gesture-handler/ReanimatedSwipeable`

RNGH 2.x introduced `Swipeable` (updated to Reanimated in RNGH 2.12+):

```tsx
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

<ReanimatedSwipeable
  renderRightActions={(progressAnimatedValue, dragAnimatedValue) => (
    <DeleteAction onPress={handleDelete} />
  )}
  overshootRight={false}
  friction={2}
  rightThreshold={40}
>
  <ListRow item={item} />
</ReanimatedSwipeable>
```

#### Option 2: Custom swipeable row

The one from Section 7 (pan gesture + translateX shared value) gives you full control. Use this when the built-in Swipeable doesn't match your design.

### Pull-to-refresh

Use the built-in `RefreshControl` passed via `refreshControl` prop:

```tsx
<FlashList
  data={items}
  renderItem={renderItem}
  refreshControl={
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={handleRefresh}
      tintColor="#2563eb"
    />
  }
/>
```

For custom pull-to-refresh (e.g., parallax image reveal), there are libraries like `react-native-pull-to-refresh` or roll your own with Reanimated's `useAnimatedScrollHandler`.

### Sticky headers

FlashList supports sticky headers via `stickyHeaderIndices`. Given a flat array where certain indices are section headers, pass their positions:

```tsx
<FlashList
  data={flattenedItems}
  stickyHeaderIndices={headerIndices}
  stickyHeaderConfig={{
    useNativeDriver: true,
    offset: 50,  // stick below a fixed nav header
    backdropComponent: <BlurView style={StyleSheet.absoluteFill} />,
  }}
/>
```

`backdropComponent` is great for iOS-style blurred sticky headers.

### Empty / loading / error states

Every list needs three non-happy-path states:

- **Empty** — there are no items to show. Render a friendly message with an action (e.g., "No inspections yet. Tap + to start one.").
- **Loading** — first fetch in progress. Skeleton rows (animated placeholders) look much better than a spinner for lists.
- **Error** — fetch failed. Error message with a retry button.

FlashList's `ListEmptyComponent` handles the empty case. For loading, conditionally render skeleton rows or a different component. For error, render the error state instead of the list.

Skeleton rows — semi-transparent grey boxes that subtly shimmer — are a polished loading indicator. Use Moti or Reanimated to drive the shimmer, and match the skeleton's shape to the real row for no layout shift when real data arrives.

### Scroll position preservation

When a screen is unmounted and remounted (e.g., tab change), default behavior scrolls back to the top. If you want to preserve scroll position:

- React Navigation's Native Stack preserves scroll position in preserved screens automatically.
- For Expo Router, enable with the `unmountOnBlur: false` default.
- For tabs, `detachInactiveScreens: false` on the tab navigator keeps them mounted.

### Image-heavy lists

If rows contain images:

- **Use `expo-image` instead of `Image`.** Built-in caching, placeholder blur-up, `contentFit` that works, memory-efficient decoding.
- **Set explicit dimensions** on every image. Dynamic-sized images force re-layout.
- **Prefetch upcoming images** when the user scrolls close. `expo-image` has `Image.prefetch(urls)`.
- **Thumbnails first.** If you have multiple sizes, start with the small one and let the big one load asynchronously.

### `onEndReached` and infinite loading

```tsx
<FlashList
  data={items}
  onEndReached={loadMore}
  onEndReachedThreshold={0.5}  // fire when 50% of the last viewport is visible
  ListFooterComponent={isLoadingMore ? <LoadingSpinner /> : null}
/>
```

Don't fire `loadMore` more than once per batch. Debounce or check `isLoadingMore` before issuing a new request.

### Masonry layouts

FlashList supports masonry (Pinterest-style variable-height columns) via `MasonryFlashList`:

```tsx
<MasonryFlashList
  data={photos}
  numColumns={2}
  renderItem={({ item }) => <PhotoCard photo={item} />}
/>
```

Items are packed into columns by height, same recycling and performance characteristics as regular FlashList.

### Horizontal lists and carousels

`horizontal` prop works the same way. For pagination with snapping, add `snapToInterval` and `decelerationRate="fast"`. For carousels with more features (loop, parallax, auto-play), use `react-native-reanimated-carousel` instead.

---

## 13. Bottom sheets and modals

Bottom sheets are the modern mobile convention for modal-ish content that doesn't take over the whole screen. They slide up from the bottom, snap to configurable heights, can be dismissed by swiping down, and sit on top of a dimmed backdrop of the underlying screen.

### `@gorhom/bottom-sheet` — the default

The default choice in 2026 is `@gorhom/bottom-sheet`, which uses Reanimated for UI-thread animations and Gesture Handler for gesture coordination. Per the library's architecture docs, it runs all animations on the UI thread using worklets for native-feeling performance.

Basic setup:

```tsx
import BottomSheet from '@gorhom/bottom-sheet';
import { useRef, useMemo, useCallback } from 'react';

function Screen() {
  const bottomSheetRef = useRef<BottomSheet>(null);

  // Snap points: bottom to top. Must be memoized.
  const snapPoints = useMemo(() => ['25%', '50%', '90%'], []);

  const handleSheetChanges = useCallback((index: number) => {
    console.log('snapped to', index);
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <Button title="Open" onPress={() => bottomSheetRef.current?.expand()} />

      <BottomSheet
        ref={bottomSheetRef}
        index={-1}  // -1 starts closed
        snapPoints={snapPoints}
        enablePanDownToClose
        onChange={handleSheetChanges}
      >
        <BottomSheetView>
          <Text>Sheet content</Text>
        </BottomSheetView>
      </BottomSheet>
    </View>
  );
}
```

### Snap points

Per the library docs, snap points are sorted bottom-to-top and accept numbers (pixels), percentages, or mixes:

```ts
snapPoints={[200, 500]}       // pixels
snapPoints={[200, '50%']}     // mixed
snapPoints={['100%']}          // single snap at full
```

**Dynamic sizing** — the sheet sizes itself to its content height:

```tsx
<BottomSheet enableDynamicSizing>
  <BottomSheetView>
    {/* sheet height = content height */}
  </BottomSheetView>
</BottomSheet>
```

Or use the `useBottomSheetDynamicSnapPoints` hook for content-based sizing with explicit snap points.

### Scrollable content inside a sheet

Nesting a FlatList or FlashList inside a bottom sheet requires special handling — the sheet's pan gesture and the list's scroll gesture must coordinate. Use the library's wrapped components:

```tsx
import { BottomSheetFlatList, BottomSheetScrollView, BottomSheetFlashList } from '@gorhom/bottom-sheet';
```

These wire up the gesture coordination automatically. Without them, scrolling the list would also drag the sheet, or vice versa.

The underlying logic: when the sheet is at its max snap point and the list is scrolled to the top, pulling down drags the sheet. Otherwise the list scrolls. This is handled by `animatedScrollableState` internally.

### Keyboard handling

`keyboardBehavior` prop controls how the sheet responds when the keyboard appears:

- `'extend'` — sheet extends to its max snap point.
- `'fillParent'` — sheet fills the entire screen.
- `'interactive'` — sheet offsets by keyboard height (most common, iOS feel).

`keyboardBlurBehavior` — `'restore'` returns the sheet to its previous position when keyboard dismisses.

For Android, `android_keyboardInputMode` controls whether the underlying layout pans or resizes. `'adjustPan'` is usually what you want.

### Backdrop

By default, no backdrop. Add one via `backdropComponent`:

```tsx
import { BottomSheetBackdrop } from '@gorhom/bottom-sheet';

const renderBackdrop = useCallback(
  props => (
    <BottomSheetBackdrop
      {...props}
      disappearsOnIndex={-1}
      appearsOnIndex={0}
      opacity={0.5}
    />
  ),
  []
);

<BottomSheet backdropComponent={renderBackdrop} ...>
```

The `disappearsOnIndex: -1` and `appearsOnIndex: 0` pair means the backdrop fades as the sheet crosses the first snap point.

### BottomSheetModal (stacked sheets)

For sheets that stack on top of each other (a sheet that opens another sheet), use `BottomSheetModal` inside a `BottomSheetModalProvider`:

```tsx
import { BottomSheetModal, BottomSheetModalProvider } from '@gorhom/bottom-sheet';

<BottomSheetModalProvider>
  <App />
</BottomSheetModalProvider>

// inside a screen:
const ref = useRef<BottomSheetModal>(null);
ref.current?.present();  // shows modal
ref.current?.dismiss();  // hides
```

Modal sheets don't need to be mounted in the layout — `present()` attaches them; `dismiss()` detaches.

### iOS native form sheets (alternative)

As of iOS 15, iOS has a native sheet with snap points (`UISheetPresentationController`). React Navigation's Native Stack exposes this via `presentation: 'formSheet'`:

```tsx
<Stack.Screen
  name="Details"
  component={DetailsScreen}
  options={{
    presentation: 'formSheet',
    sheetAllowedDetents: ['medium', 'large'],
    sheetGrabberVisible: true,
  }}
/>
```

Pros: native iOS feel, no extra library.
Cons: iOS only (falls back to full modal on Android), less flexible than Gorhom for custom behavior.

For iOS-first apps, formSheet can replace Gorhom for simple cases.

### When not to use a bottom sheet

- **For critical confirmations** — use a modal alert (`Alert.alert(...)` or a custom center-screen modal). Bottom sheets can be dismissed accidentally by swiping.
- **For content that fills the screen anyway** — just use a regular modal screen (`presentation: 'modal'`).
- **For anything transient** — use a toast/snackbar, not a sheet.

---


## 14. Navigation polish

The difference between a competent app and a polished app is in navigation details — the small animations, the gesture responsiveness, the headers that behave correctly. These are all handled for you if you use Native Stack, but knowing what the good defaults look like helps when debugging or customizing.

### Swipe-back gesture (iOS)

Enabled by default on iOS Native Stack. From any screen, swiping right from the left edge pops back. The gesture is interruptible — the user can cancel mid-swipe and the screen snaps back into place.

Disable per screen:

```tsx
<Stack.Screen name="Checkout" options={{ gestureEnabled: false }} />
```

Disable for the whole stack:

```tsx
<Stack.Navigator screenOptions={{ gestureEnabled: false }}>
```

Be careful here: disabling the back gesture on iOS removes something users expect. Only do it for screens where back navigation is genuinely not allowed (e.g., a committed payment flow).

`fullScreenGestureEnabled: true` extends the gesture area to the entire screen, not just the left edge — useful for fullscreen views (photo viewer, video player) where the user isn't expected to interact with the content.

### Predictive back (Android 14+)

Android 14 (API 34) and newer support a predictive back gesture that shows a preview of the previous screen as the user drags. Users expect this in modern apps.

Requirements:
- `react-native-screens` v4+.
- Target SDK 34+.
- Expo SDK 51+ if using Expo.

Most apps get this for free by upgrading dependencies — no code changes needed. Verify by running on Android 14 and swiping from either edge.

### Large title (iOS native stack)

iOS's built-in large-title header — the title is large and left-aligned at the top, then shrinks and centers as the user scrolls:

```tsx
<Stack.Screen
  name="Inspections"
  component={InspectionsList}
  options={{
    headerLargeTitle: true,
    headerLargeTitleShadowVisible: false,  // removes the line under the large title
  }}
/>
```

Works automatically with scroll views inside the screen. Ensure the main scrollable component (ScrollView, FlashList) has `contentInsetAdjustmentBehavior="automatic"` or the large title won't collapse correctly.

### Blur header on scroll

iOS apps use a frosted-blur header that becomes solid as the user scrolls. In Native Stack:

```tsx
options={{
  headerTransparent: true,
  headerBlurEffect: 'regular',  // or 'prominent', 'systemChromeMaterial', etc.
  headerStyle: { backgroundColor: 'rgba(255, 255, 255, 0.5)' },
}}
```

For Android or full cross-platform custom, use `expo-blur`'s `BlurView` manually in a custom header.

### Tab bar animations

Bottom Tabs has basic fade-in/out for tabs. For more delightful effects (the bouncy icon animation in Twitter/X, or a tab indicator that slides between tabs):

- Custom `tabBarIcon` functions receive `focused` as a parameter. Drive a Reanimated spring from focused state.
- For a sliding indicator, listen to the tab state and animate a shared value for the indicator's `translateX`.

```tsx
function AnimatedTabIcon({ focused, Icon }) {
  const scale = useSharedValue(focused ? 1.1 : 1);
  useEffect(() => {
    scale.value = withSpring(focused ? 1.15 : 1, { damping: 10 });
  }, [focused]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={style}><Icon color={focused ? '#2563eb' : '#9ca3af'} /></Animated.View>;
}
```

### Header buttons

Always use `Pressable` (or an appropriate icon button component) with proper `hitSlop`. Small header icons are among the worst offenders for missed taps.

React Navigation exposes `headerLeft` and `headerRight` which can be functions returning JSX:

```tsx
options={{
  headerRight: () => (
    <Pressable onPress={save} hitSlop={12}>
      <Check size={24} />
    </Pressable>
  ),
}}
```

### Deep-link back-stack reconstruction

When a deep link opens a screen two levels deep, you want the back button to go to the parent, not exit the app. React Navigation's `getInitialState` and `getStateFromPath` let you construct the correct stack; Expo Router does this automatically for nested routes.

For Expo Router: if you navigate to `/inspection/123` and the inspection is a child of `/inspections`, the router automatically reconstructs a back stack of `[/inspections, /inspection/123]`.

### Focus events

`useFocusEffect` fires when a screen comes into focus, `useIsFocused` returns the current state. Use these to:

- Refresh data when returning to a screen.
- Pause expensive background work when leaving.
- Announce the new screen to screen readers (`AccessibilityInfo.announceForAccessibility(...)`).

```tsx
import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';

useFocusEffect(
  useCallback(() => {
    refreshData();
    return () => {}; // cleanup if needed
  }, [])
);
```

### Header collapse on scroll (collapsing hero)

For Instagram-style profile screens with a hero image that collapses into the header as you scroll, you need a custom header. Build with `useAnimatedScrollHandler` from Reanimated:

```tsx
const scrollY = useSharedValue(0);

const scrollHandler = useAnimatedScrollHandler({
  onScroll: e => { scrollY.value = e.contentOffset.y; }
});

const headerStyle = useAnimatedStyle(() => ({
  height: interpolate(scrollY.value, [0, 200], [300, 60], 'clamp'),
  opacity: interpolate(scrollY.value, [0, 150], [1, 0], 'clamp'),
}));

return (
  <>
    <Animated.View style={[styles.hero, headerStyle]}>
      <Image source={...} />
    </Animated.View>
    <Animated.ScrollView onScroll={scrollHandler} scrollEventThrottle={16}>
      {/* content */}
    </Animated.ScrollView>
  </>
);
```

### Status bar

`react-native/StatusBar` or `expo-status-bar` — set bar style per screen if it changes (dark content on light screens, light content on dark screens). Stack Navigator can sync status bar per screen if you configure it, or set it manually in screen effects.

---

## 15. Styling approaches

Five main styling approaches in the 2026 ecosystem. Pick one per project — mixing them mostly works but complicates onboarding and debugging.

### StyleSheet.create (built-in)

```tsx
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
});
```

**Pros:** Zero dependencies. Fastest cold start. Validates style keys at runtime (catches typos). Works everywhere.

**Cons:** Verbose. No theming. No responsive/dark-mode primitives. Hard to share with web. No variant system.

**Use when:** Small app, no design system needs, team doesn't want to learn a new thing.

### NativeWind (Tailwind for RN)

```tsx
<View className="flex-1 p-4 bg-white">
  <Text className="text-xl font-semibold">Title</Text>
</View>
```

**Pros:** Tailwind muscle memory transfers. Build-time compiled to StyleSheet objects (NativeWind v4 uses a Metro transformer) — performance-equivalent to native. Familiar to any team that's done web. Dark mode out of the box via the `dark:` prefix. Popular: weekly downloads around 500k+.

**Cons:** Build-time compilation can surprise you (especially with dynamic classes). Limited to utilities in `tailwind.config.js`. Not truly universal to web unless you also use Tailwind there.

**Use when:** Team comes from web/Tailwind. Want fast, ergonomic styling with minimal runtime cost.

### Tamagui (universal design system)

```tsx
<YStack padding="$4" backgroundColor="$background">
  <SizableText size="$6">Title</SizableText>
</YStack>
```

**Pros:** True cross-platform (RN + Next.js with the same components). Optimizing compiler flattens component trees at build time. Rich theming, variants, animations. Extensive built-in component set.

**Cons:** Larger bundle impact. Opinionated; Tamagui-flavored. Compiler setup is non-trivial. Steeper learning curve.

**Use when:** Building a universal app targeting both RN and web. Want a comprehensive design system with components, theming, and performance.

### Unistyles (low-level theming-first)

```tsx
import { createStyleSheet, useStyles } from 'react-native-unistyles';

const stylesheet = createStyleSheet(theme => ({
  container: { backgroundColor: theme.colors.background, padding: theme.spacing.md },
  title: { color: theme.colors.text, fontSize: theme.fontSizes.xl },
}));

// in component
const { styles } = useStyles(stylesheet);
```

**Pros:** Fast (benchmarks favorable). Runtime theming with automatic re-render on theme change. Breakpoints, orientation, device-class-aware. Plugin system. Minimal magic.

**Cons:** Smaller ecosystem than NativeWind/Tamagui. Still evolving — v3.x is the current stable as of 2026.

**Use when:** Want strong theming and responsive primitives without buying into a full component system.

### Shopify Restyle

```tsx
import { Box, Text } from '@shopify/restyle';

<Box flex={1} padding="m" backgroundColor="mainBackground">
  <Text variant="header">Title</Text>
</Box>
```

**Pros:** Strongly TypeScript-typed — the theme object is validated, prop names are constrained. Small and focused. Excellent for teams that want compile-time style safety.

**Cons:** Smaller community. Requires buying into `Box`/`Text` primitives instead of raw RN components. Theming is at the center, not optional.

**Use when:** Design-system-heavy project with clearly defined tokens. TypeScript-first team that wants compile-time enforcement.

### StyleSheet vs. the others — performance

The styling library benchmark community has measured these at scale. The short version:

- **StyleSheet.create** is the baseline — fastest, no overhead.
- **Restyle, Tamagui, NativeWind, Unistyles** all come close to StyleSheet on simple tests (renders 250 items fast).
- **Runtime-only utility libraries like twrnc** have measurable overhead with hundreds of dynamically-styled components re-rendering; acceptable for most apps.

Real-world: styling library choice is rarely what breaks app performance. Re-rendering too many components is. Picking a fast styling library doesn't save you from inefficient component trees.

### Dark mode

All five approaches support dark mode. Patterns:

- **NativeWind**: `dark:` prefix (`bg-white dark:bg-neutral-900`).
- **Tamagui**: theme switching (`theme="dark"`).
- **Unistyles**: automatic via color scheme.
- **Restyle**: two themes, switched at the provider level.
- **StyleSheet**: conditional via `useColorScheme()` hook from `react-native`.

The system color scheme lives in `Appearance.getColorScheme()` with a listener — `useColorScheme` wraps this. Respect the system setting by default; offer an in-app override.

### Cross-platform design tokens

Regardless of styling library, think in tokens:

- **Spacing scale** — `xs, sm, md, lg, xl, 2xl` mapped to pixel values (e.g., 4, 8, 16, 24, 32, 48).
- **Color palette** — named roles (`background`, `surface`, `text`, `muted`, `primary`, `danger`) *and* raw colors.
- **Typography scale** — matched to platform conventions (iOS uses San Francisco; Android uses Roboto by default, though you can ship custom fonts).
- **Border radius scale** — `none, sm, md, lg, full`.
- **Elevation / shadow scale** — iOS uses shadow, Android uses elevation, both mapped to the same logical levels.

Write tokens once; expose via your chosen styling library.

---

## 16. Component libraries

A *styling* library gives you tools to compose styles. A *component* library gives you pre-built components (buttons, inputs, modals, etc.). These are complementary; you can use both.

### React Native Paper

Material Design components. Well-maintained, comprehensive. Pre-themed for light/dark.

- Button, Card, Chip, FAB, TextInput, Checkbox, Radio, Switch, Menu, Snackbar, Dialog, DataTable, BottomNavigation, Drawer.
- Material Design 3 (formerly Material You) support.

Use when: you want Material aesthetics and don't want to reimplement a dozen common components.

### Gluestack UI (née NativeBase)

NativeBase's spiritual successor. Universal (RN + Next.js), accessible by default, Tamagui-adjacent.

Use when: you want a large pre-built component set with universal web support.

### UI Kitten

Eva design system-based. Dark-mode-first, theming flexible.

Use when: you like the Eva aesthetic, or need their theming approach.

### React Native Reusables (shadcn-style)

Shadcn/UI's model for RN — components you copy into your repo and own. Based on Radix primitives (for accessibility) and NativeWind (for styling).

- You run `npx @react-native-reusables/cli add button` and the source lands in your project.
- You customize freely without fighting library APIs.

Use when: NativeWind is your styling layer and you want shadcn-like ergonomics. The hip choice in 2026.

### Tamagui (also a component library)

Tamagui ships `@tamagui/core` (styling primitives) and a large library of components (buttons, inputs, sheets, tabs, etc.). Covered above in styling; worth noting it's also a full component kit.

### Expo's own components

Expo ships a growing set of polished components:
- `expo-image` — production-grade image.
- `expo-blur` — platform-native blur.
- `expo-linear-gradient` — gradients that work.
- `expo-av` — video/audio.
- `expo-camera` — camera view.
- `expo-contextmenu` — native context menus.

These aren't a "component library" in the traditional sense but plug gaps the core RN doesn't fill.

### Shoulders of giants: @shopify/flash-list, @gorhom/bottom-sheet

Covered in sections 12 and 13. These two are effectively part of the ecosystem's baseline — a polished app in 2026 uses both.

### What NOT to use

- **NativeBase** (the original) — deprecated. Migrate to Gluestack.
- **react-native-elements / rneui** — still around, still works, but community momentum has moved elsewhere.
- **react-native-material-ui** — unmaintained; use Paper instead.

### Pick one approach, commit

Mixing component libraries is painful. If you use Paper, use Paper for the whole app. If you use Reusables + NativeWind, stay in that lane. Every library has its own theming system and mixing them means two sources of truth for color, typography, spacing.

---


## 17. Accessibility

Accessibility in React Native is not automatic. Unlike the web, where `<button>` gets keyboard focus and screen-reader labeling for free, React Native renders native views and you must explicitly expose semantics via props. If you don't, the screen reader sees a blob of untyped nodes.

### The accessibility tree

Both iOS (VoiceOver) and Android (TalkBack) build an accessibility tree from the props you expose. The tree is navigated by swiping left/right (VoiceOver) or by directional gestures (TalkBack).

Key props:

- **`accessible`** — whether this element is a leaf in the tree. Default true for most interactive elements. Set to `false` to hide from screen reader.
- **`accessibilityLabel`** — the spoken description. "Save inspection" is better than "Save" when context isn't obvious.
- **`accessibilityHint`** — additional context. "Saves the current inspection and returns to the list." Spoken after label.
- **`accessibilityRole`** — the kind of thing it is. Roles include `button`, `link`, `header`, `search`, `image`, `text`, `summary`, `imagebutton`, `keyboardkey`, `adjustable`, `tab`, `tablist`, `radiogroup`, `radio`, `checkbox`, `switch`, `progressbar`, `alert`, `menu`, `menuitem`, `scrollbar`, `spinbutton`, `togglebutton`, `list`, `combobox`.
- **`accessibilityState`** — `{ disabled, selected, checked, busy, expanded }`. Screen reader announces state changes.
- **`accessibilityValue`** — `{ min, max, now, text }`. For sliders and progress indicators.
- **`accessibilityLiveRegion`** (Android) / **`accessibilityViewIsModal`** (iOS) — for dynamic content announcements.
- **`importantForAccessibility`** (Android) — `'auto' | 'yes' | 'no' | 'no-hide-descendants'`.
- **`accessibilityElementsHidden`** (iOS) — same idea.

### Required props for interactive elements

Every interactive element needs, at minimum:

- `accessibilityRole` (e.g., `'button'`)
- `accessibilityLabel` (what it does)
- `accessibilityState` (if it has state, like disabled/selected)

Missing any of these and the screen reader sees "unlabeled button" or worse, the element is invisible entirely.

### Examples

Save button:
```tsx
<Pressable
  onPress={save}
  accessibilityRole="button"
  accessibilityLabel="Save inspection"
  accessibilityHint="Saves changes and returns to the inspection list"
  accessibilityState={{ disabled: isSaving }}
>
  <Text>Save</Text>
</Pressable>
```

Checkbox:
```tsx
<Pressable
  onPress={toggle}
  accessibilityRole="checkbox"
  accessibilityLabel="Include photos in report"
  accessibilityState={{ checked }}
>
```

Slider:
```tsx
<Slider
  accessibilityLabel="Brightness"
  accessibilityValue={{ min: 0, max: 100, now: value }}
/>
```

Tab in a tab bar:
```tsx
<Pressable
  accessibilityRole="tab"
  accessibilityLabel="Inspections"
  accessibilityState={{ selected: isActive }}
/>
```

### Touch target minimums (reprise)

- **iOS HIG**: 44 × 44 points minimum.
- **Android Material**: 48 × 48 dp minimum (standard guidance is actually 48dp though a common baseline cited is 44).
- **WCAG 2.2 AAA**: 44 × 44 CSS pixels.

Use `hitSlop` to achieve this without bloating visible UI.

### Text scaling (Dynamic Type)

iOS and Android both let users scale system text size up to 200% or more. Your app must respect this. Default behavior in React Native: text scales automatically unless you've set `allowFontScaling={false}` somewhere (don't).

Test at the largest text size. If your UI breaks — text clips, buttons overflow — fix the layout, don't disable scaling. Make containers expand, use scrollable layouts, and avoid fixed-height rows with text.

There's also `maxFontSizeMultiplier` on Text if you need to cap the scale for a specific component (e.g., a tiny "legal disclaimer" that must fit). Use sparingly.

### Reduce Motion

Users with vestibular disorders or motion sensitivity can enable "Reduce Motion" (iOS Settings > Accessibility > Motion; Android Settings > Accessibility > Remove animations).

Respect this via `AccessibilityInfo.isReduceMotionEnabled()`:

```tsx
import { AccessibilityInfo } from 'react-native';

const [reduceMotion, setReduceMotion] = useState(false);
useEffect(() => {
  AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
  const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
  return () => sub.remove();
}, []);

// Then in animations:
<Animated.View
  entering={reduceMotion ? FadeIn : SlideInDown}
/>
```

Minimum: replace slide/zoom/parallax effects with simple fades when Reduce Motion is on.

### Screen reader announcements

Announce dynamic changes (a form submitted successfully, a new item in a feed) via:

```tsx
AccessibilityInfo.announceForAccessibility('Inspection saved.');
```

Don't overuse — every announcement interrupts the user's screen reader flow. Reserve for important state changes.

### Focus management

Programmatically move focus (e.g., after a screen transition, shift focus to the screen's heading):

```tsx
const ref = useRef(null);
useEffect(() => {
  const tag = findNodeHandle(ref.current);
  if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
}, []);
```

Useful when: the user just navigated to a new screen and the screen reader hasn't automatically moved focus; after a dynamic dialog appears; after a long operation completes and results should be read.

### Color contrast

WCAG AA requires:
- 4.5:1 contrast ratio for body text.
- 3:1 for large text (18pt or 14pt bold+).
- 3:1 for UI components (icon buttons, border colors).

Use a color-contrast checker (WebAIM, or the `color-contrast` npm package) in your design system's validation tests. Don't rely on look.

### Keyboard navigation (external keyboards, iPad, tvOS)

On iPad with a hardware keyboard (or Mac Catalyst), users Tab through elements. React Native 0.76+ supports keyboard focus on mobile platforms. Ensure:

- Interactive elements receive focus (default for Pressable / TextInput).
- Focus has a visible ring (use Pressable's `focused` state).
- Tab order makes sense (follows layout order by default; use `accessibilityElementsHidden` to exclude decorative elements).

tvOS is its own world — React Native does support Apple TV, but with additional considerations. Out of scope for most apps.

### Language / RTL

If your app supports right-to-left languages (Arabic, Hebrew, Farsi):

- React Native autoflips layouts when RTL is detected.
- Test your layouts — icons and chevrons often don't flip automatically; you must mark them with `I18nManager.isRTL` checks or use `transform: [{ scaleX: I18nManager.isRTL ? -1 : 1 }]`.
- Start/end instead of left/right in styles (`marginStart` instead of `marginLeft`).

### Testing accessibility

Run your app with:
- **VoiceOver on iOS** — Settings → Accessibility → VoiceOver. Triple-press the side/home button to toggle quickly.
- **TalkBack on Android** — Settings → Accessibility → TalkBack. Or enable via Accessibility Scanner for structural checks.
- **Dynamic Type cranked up** — Settings → Display → Text Size (iOS) or Settings → Display → Font Size (Android).
- **Reduce Motion on** — verify motion-sensitive components fall back gracefully.
- **High Contrast on** — some users enable high-contrast modes; check your colors still work.

Running the app blindfolded for five minutes with VoiceOver on will teach you more than any docs.

### Platform differences worth knowing

- iOS announces screen transitions automatically. Android sometimes doesn't — call `AccessibilityInfo.announceForAccessibility` in screen focus effects.
- iOS reads `accessibilityHint` after a short delay; Android reads it immediately. Don't put critical info in hint.
- Android's TalkBack is generally less capable than VoiceOver. Test on Android more.

---

## 18. Performance debugging

Polish is 50% making the right design choices and 50% making sure the app actually runs at 60+ fps. This section is the debugging toolkit.

### Measuring: what to look at

Two frame rates matter:

- **UI FPS** — the native rendering thread. This is what the user sees.
- **JS FPS** — the JavaScript thread. If this drops below 60, animations driven from JS stutter.

Use:

- **Perf Monitor** (shake device menu in dev build → Show Perf Monitor) — shows both frame rates in a floating widget.
- **Flipper** — the historical tool; has been superseded by React Native DevTools as of RN 0.76+.
- **React Native DevTools** — the current recommended debugger. Open with `j` from Metro.
- **Hermes Profiler** — for sampling CPU usage, see where JS time goes.
- **Xcode Instruments / Android Studio Profiler** — the native tools. Essential for understanding memory, native CPU, and rendering. Reach for these when the JS-side tools don't show anything wrong but the app still feels slow.
- **Shopify Performance Monitor** — their open-source lib, surfaces JS/UI FPS and more in-app.

### What to measure

- **Time to first render** — how long after the splash screen does the first screen appear?
- **Time to interactive** — how long until the user can actually do something?
- **Scroll FPS** — in a long list, scroll quickly and watch for drops. Target 60/120 with no dips.
- **Animation FPS during gestures** — drag something while the JS thread is busy. If it stutters, animation is JS-driven.
- **Memory after navigating through 10 screens** — back and forth. If it grows unbounded, you have a leak.

### Common performance bugs

#### Unnecessary re-renders

The #1 killer. Symptoms: ListItem re-renders even though its props didn't change.

Debug tools:
- React DevTools Profiler — shows what rendered and why.
- `why-did-you-render` — logs unnecessary renders to console.

Fixes:
- `React.memo` on heavy components.
- `useCallback` for function props passed to memoized children.
- `useMemo` for expensive computations.
- Split contexts — don't have one giant context that every component subscribes to.
- Use Zustand/Jotai/Valtio for state with fine-grained subscriptions instead of prop-drilling.

#### Large images

Symptoms: scrolling a list with big images chokes.

Fixes:
- Use `expo-image` instead of `Image`. Caching, blur placeholders, smaller memory footprint.
- Size images to display resolution. Don't render a 4000×3000 photo into a 80×80 thumbnail.
- Use CDN image transformation to serve the exact size needed.

#### Too many gesture handlers

Symptoms: touches feel slightly laggy; gestures misfire.

Fixes:
- Don't wrap every row in a new `GestureDetector` if Pressable suffices.
- Use RNGH's Pressable for rows if you need gesture-compatible behavior, but don't create unique gestures per row if you don't need them.

#### Worklet mistakes

Symptoms: animations silently don't run, or cause crashes.

Fixes:
- Verify worklets only call other worklets.
- Use `runOnJS` to bridge to non-worklet functions.
- Check that the Reanimated Babel plugin is configured in `babel.config.js`.

#### Bridge-heavy work during animation

Symptoms: gesture is smooth, but committing the action at the end stutters.

Fixes:
- Do committing work async, after animation completes (animation.start(() => { /* commit */ })).
- Precompute expensive things before the animation starts.
- Use `InteractionManager.runAfterInteractions(() => { ... })` for non-urgent work.

#### Too-large navigator

Symptoms: app slow to boot; time-to-interactive is long.

Fixes:
- Lazy-load non-critical screens. React Navigation supports `lazy: true` for Tab.
- Use dynamic imports for large screens that aren't on the initial route.
- Move heavy computations out of the initial render.

### The New Architecture

As of React Native 0.76+, the New Architecture (Fabric renderer, TurboModules, JSI-based communication) is enabled by default. Performance benefits include:

- Synchronous JSI calls instead of async bridge calls.
- Fabric's synchronous layout measurements (FlashList v2 capitalizes on this).
- Lower startup time.
- Better memory management.

If you're still on the old architecture, migration is worth doing. Most major libraries (Reanimated 4, Gesture Handler 3, FlashList v2) *require* the New Architecture.

### Profile-guided optimization

Don't optimize on feeling. Profile, identify the actual bottleneck, fix that, re-profile. The Hermes sampling profiler is your friend. Record a session, look at the flame graph, find the functions eating CPU.

Common false bottlenecks:
- Styling libraries (real cost is usually tiny).
- Reanimated worklets (they run on the UI thread, not your problem usually).

Common real bottlenecks:
- JSON parsing in response handlers.
- Synchronous work in the render method (sorting, filtering, etc.).
- Re-rendering cascades from store updates.

### Bundle size

Bundle size affects cold start and memory. Check with `expo-atlas` or `react-native-bundle-visualizer`. Biggest offenders are usually:

- Moment.js (use date-fns or Day.js).
- Large icon libraries imported in full (tree-shake with per-icon imports: `import { Check } from 'lucide-react-native'`, not `import * from 'lucide-react-native'`).
- Embedded translations when you ship many languages.

### Memory

Watch Xcode's memory gauge while using the app. Steady state should plateau. If it climbs forever, something's leaking. Common causes:

- Event listeners not removed (forgot to return a cleanup in `useEffect`).
- Images cached without limits (`expo-image` handles this; raw `Image` doesn't as well).
- Stored state with ever-growing arrays.

---


## 19. Field inspection app specifics

Most of this document is generic. This section is opinionated for a field-inspection / offline-first / form-heavy mobile app — the class of app where users are in the field, often outdoors, on imperfect networks, under time pressure, capturing evidence.

### Design principles that actually matter for field use

- **Large touch targets everywhere.** A field inspector wearing gloves, on a roof, in bright sun, is not hitting 24pt buttons. Design to 56+ pt minimum for primary actions. Use `hitSlop` and real padding.
- **High contrast.** Dim screens are common outdoors. Minimum 7:1 contrast for text; avoid light grey on white at all costs. Consider a forced "high contrast outdoor" mode.
- **Fat, unambiguous state indicators.** Selected / unselected / completed / incomplete needs to be readable in 0.3 seconds from arm's length. Double-encode (color + icon + label text).
- **Haptics on every commit.** The user is not looking at the screen half the time; they're looking at what they're inspecting. Haptics tell them the tap landed.
- **Everything async, everything optimistic.** Network is unreliable. Commit UI changes immediately, sync in background, show sync status explicitly.
- **Autosave is non-negotiable.** Every keystroke, every photo, every selection is persisted locally within seconds. A lost field observation is a trip back to the site.

### Form input states

Form fields (text inputs, dropdowns, checkboxes) in a field tool have more states than a typical form. Enumerate them:

- **Untouched** — the user hasn't interacted.
- **Focused** — cursor is in it, actively being edited.
- **Dirty** — has been modified from its initial value.
- **Valid** — passes validation.
- **Invalid** — fails validation; needs feedback.
- **Pending** — awaiting async validation (e.g., server-side uniqueness check).
- **Readonly** — disabled for this user/role but shown for context.
- **Saving** — currently being persisted. Show a subtle indicator.
- **Saved** — confirmed persisted. Brief positive feedback.
- **Failed to save** — offline or server error. Shown with a retry affordance.

You don't need to render all of these, but you need to know which ones apply. For a simple text input in an inspection form, realistic states are: untouched, focused, dirty, valid, invalid, saving, saved, failed to save.

Implementation pattern:

```tsx
type FieldState = 'untouched' | 'focused' | 'dirty' | 'invalid' | 'saving' | 'saved' | 'error';

function InspectionField({ name, value, onChange, error, isSaving, lastSavedAt }: Props) {
  const [focused, setFocused] = useState(false);
  const touched = useRef(false);

  const state: FieldState =
    error ? 'invalid' :
    isSaving ? 'saving' :
    focused ? 'focused' :
    touched.current && !error ? 'dirty' :
    lastSavedAt ? 'saved' :
    'untouched';

  return (
    <View style={[styles.field, styles[`field_${state}`]]}>
      <TextInput
        value={value}
        onChangeText={v => { touched.current = true; onChange(v); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      {state === 'saving' && <SavingIndicator />}
    </View>
  );
}
```

### Photo capture UX

Taking a photo mid-inspection has specific needs:

- **Instant shutter.** The moment the user taps, the photo is captured. No modal that appears first. `expo-camera` or `react-native-vision-camera` for this.
- **Preview in-context.** After capture, show a small preview in the inspection view. Don't take the user out of the flow to confirm.
- **Multi-shot queue.** Capture many photos rapidly; each goes into the inspection.
- **Offline-friendly.** Photos are files on disk with pointers in the local database. Sync uploads in background when connection is available.
- **EXIF preserved.** GPS, timestamp, orientation — critical for evidence documentation. `react-native-vision-camera` makes this explicit.
- **Annotation.** Ability to draw on a photo to circle or arrow a detail. `react-native-sketch-canvas` or roll with Skia.

### Multi-step form flows

Scribe-style field forms often have many questions grouped into sections. UX patterns:

- **Progress indicator** at top — segmented bar showing section completion.
- **Next/Previous** buttons at bottom — persistent.
- **Swipe between sections** — `react-native-pager-view` or Material Top Tabs with a custom non-swipe-when-invalid guard.
- **Per-field validation** on blur, aggregated per-section, with a "summary" view before final submit.
- **Save draft** on every field change; "submit" at the end commits to the server.

### Offline-first interaction patterns

The golden rule: the user should never see a network error mid-work. The app presents as if everything is working; sync happens in background.

- **Optimistic UI.** Show the result of an action immediately, then roll back if the sync fails much later. Field workers can't wait for server round trips.
- **Sync status indicator.** A small badge somewhere (header corner is good) shows sync state: synced, pending, error. Tap for details.
- **Queue management.** Background sync queue that retries with exponential backoff. Visible to the user on demand.
- **Conflict resolution UX.** If the same record was edited on two devices, present the conflict at sync time with a chooser. Rare but critical when it happens.

### Large-text mode / accessibility for older users

Field staff skew older than the typical app user demographic. Test at 150% text scale. Ensure:
- Forms still fit on screen.
- Buttons are still tappable (large text can push them off).
- Icon labels grow with text (use SVG icons with currentColor and font-size-based scaling if possible).

### Battery-conscious design

A field worker's phone needs to last the day. App-level decisions:

- **Don't animate unnecessarily.** Parallax headers, fancy transitions, Lottie animations — all burn battery. Offer a "minimal motion" mode that disables these, not just for accessibility but for battery life.
- **Debounce GPS.** If you're stamping location on captures, use the lowest accuracy that suffices. Continuous high-accuracy GPS destroys battery.
- **Pause background work when inactive.** Use `AppState` to detect backgrounding and pause sync, polling, etc.
- **Compress photos before upload.** Don't upload 12MP originals over cellular when a 4MP compressed version would do.

### Error recovery

If the app crashes mid-inspection, the user must resume where they left off. Requires:
- Persistent drafts written on every change.
- Crash-safe write ordering — new data committed to disk before old data discarded.
- Resume prompt on app launch if an incomplete inspection is detected.

### Typography for field use

- **Minimum 16pt body text.** 14 is too small outdoors.
- **Bold weights** for labels and numeric readouts.
- **Monospace** for dimensions and IDs (tabular alignment).
- **High x-height fonts** — San Francisco, Roboto, Inter all fine. Avoid compressed display fonts.

### Color for field use

- **Destructive actions** — red, but with a confirmation step. No "delete without asking" in the field.
- **Primary actions** — high-saturation blue or brand color; must stand out in bright sun.
- **Warnings / required fields** — amber/yellow with a shape (icon) not just color.
- **Success** — green with check icon. Brief positive reinforcement.

---

## 20. Quick-reference matrices

Cheat-sheet tables for the decisions you'll make repeatedly.

### Touchable* vs. Pressable vs. RNGH Pressable

| Feature | TouchableOpacity | Pressable (core) | Pressable (RNGH) |
|---|---|---|---|
| Opacity on press | Automatic | Manual via `style` | Manual via `style` |
| Custom feedback | Hard | Yes, via `({pressed}) => style` | Yes, via `({pressed}) => style` |
| `onPressIn` / `onPressOut` | Yes | Yes | Yes |
| `onLongPress` | Yes | Yes | Yes |
| `hitSlop` | Yes | Yes | Yes |
| `pressRetentionOffset` | No | Yes | Yes |
| Ripple on Android | No (use `TouchableNativeFeedback`) | Yes (`android_ripple`) | Yes |
| UI thread events | No | No | Yes |
| Integrates with other gestures | Awkward | Awkward | Yes |
| Recommendation | Legacy only | Good default | Best if already using RNGH |

### Haptic type cheat sheet

| Interaction | iOS type | Android (expo) |
|---|---|---|
| Light button press | `Light` impact | `Virtual_Key` or `Light` impact |
| Toggle flipped | `Selection` | `Toggle_On` / `Toggle_Off` |
| Long-press activated | `Medium` impact | `Gesture_Start` |
| Destructive commit | `Heavy` impact | `Heavy` impact |
| Snap to position | `Light` impact | `Segment_Tick` |
| Picker wheel tick | `Selection` | `Clock_Tick` |
| Form saved | `Success` notification | `Confirm` |
| Validation error | `Error` notification | `Reject` |
| Warning | `Warning` notification | (no direct equiv; use notification with custom pattern) |

### Animation library comparison

| Library | When to pick |
|---|---|
| **Reanimated 4** | Default for any serious app. Gesture-driven, layout, CSS-style animations. |
| **Moti** | Wrapper on Reanimated with Framer-Motion ergonomics. Good for decorative and state-driven animations. |
| **built-in Animated** | Legacy. Simple fades/slides where dependencies aren't warranted. |
| **Lottie / lottie-react-native** | Designer-delivered JSON animations (from After Effects). Great for illustrations, splash, onboarding. |
| **Skottie (react-native-skottie)** | Performance-critical Lottie. ~60% faster than lottie-react-native on Android per Margelo's benchmarks. Fewer features. |
| **Rive (rive-react-native)** | State-machine animations from Rive. Interactive, data-driven designer animations. |
| **React Native Skia** | Custom 2D graphics, shaders, GPU-accelerated effects. Overkill for most UIs; essential for charts, games, creative. |
| **React Native Animatable** | Quick pre-built fadeIn/slideInDown/etc. Legacy-ish; Moti covers this better now. |

### Styling library decision matrix

| If your team is… | Pick |
|---|---|
| New to RN, wants simplest thing | StyleSheet |
| Web team, Tailwind-fluent | NativeWind |
| Building RN + Next.js with shared components | Tamagui |
| Strong design-token discipline, TypeScript-first | Restyle |
| Needs responsive breakpoints, plugins | Unistyles |

### Navigation decision matrix

| Use case | Pick |
|---|---|
| File-based routing, Expo, deep links, fresh project | Expo Router |
| Need nested dynamic navigators, or migrating existing RN Navigation | React Navigation 7 |
| Want swipeable tabs | Material Top Tabs (either) |
| Need native iOS feel for stacks | Native Stack (either) |
| Custom screen transitions | Native Stack screenOptions.animation, or JS Stack for deep custom |

### Gesture composition cheat sheet

| Intent | Tool |
|---|---|
| Tap vs. double-tap | `Gesture.Exclusive(doubleTap, singleTap)` |
| Pinch + pan + rotate simultaneously | `Gesture.Simultaneous(pinch, pan, rotate)` |
| Pan only horizontal, let vertical scroll pass | `Gesture.Pan().activeOffsetX([-10, 10]).failOffsetY([-5, 5])` |
| Pan inside a scrollview | `.simultaneousWithExternalGesture(scrollGesture)` or `.requireExternalGestureToFail(scrollGesture)` |
| Disable a gesture temporarily | `.enabled(false)` |

### Recommended install baseline

For a new Expo app in 2026:

```bash
npx create-expo-app@latest my-app
cd my-app
npx expo install \
  react-native-reanimated \
  react-native-gesture-handler \
  react-native-screens \
  react-native-safe-area-context \
  expo-haptics \
  expo-image \
  @shopify/flash-list \
  @gorhom/bottom-sheet

# pick one:
npx expo install nativewind tailwindcss  # OR
yarn add tamagui                          # OR
yarn add react-native-unistyles
```

### Minimum screen-reader-correct button

```tsx
<Pressable
  onPress={handlePress}
  disabled={isDisabled}
  accessibilityRole="button"
  accessibilityLabel="Submit form"
  accessibilityState={{ disabled: isDisabled }}
  hitSlop={10}
  style={({ pressed }) => [
    styles.button,
    pressed && styles.buttonPressed,
    isDisabled && styles.buttonDisabled,
  ]}
>
  <Text style={styles.buttonText}>Submit</Text>
</Pressable>
```

This is the shortest snippet that's (a) accessible, (b) gives visual feedback, (c) has a sufficient touch target, (d) respects disabled state.

---

## 21. Curated reading list

The docs and articles that are actually worth your time. Ordered roughly by priority.

### Official documentation

- **React Native docs** — reactnative.dev. The Pressable, Gesture Responder System, and Accessibility pages are the canonical references.
- **Reanimated docs** — docs.swmansion.com/react-native-reanimated. The fundamentals section and the examples app (showcase in the repo) are the highest-ROI reading.
- **Gesture Handler docs** — docs.swmansion.com/react-native-gesture-handler. The "Gesture composition" and "Relations between gestures" sections are the ones most people skip and then regret skipping.
- **React Navigation docs** — reactnavigation.org. The Native Stack section, especially the `screenOptions.animation` and `presentation` pages.
- **Expo Router docs** — docs.expo.dev/router. Short and comprehensive.
- **FlashList docs** — shopify.github.io/flash-list. The "Performance" and "Usage" pages are both essential.
- **Gorhom Bottom Sheet docs** — gorhom.dev/react-native-bottom-sheet. The Props and Methods references, plus the examples.
- **Expo Haptics docs** — docs.expo.dev/versions/latest/sdk/haptics. Short; covers everything.

### Design guidelines

- **Apple Human Interface Guidelines** — developer.apple.com/design/human-interface-guidelines. Read the Gestures, Feedback, and Accessibility sections.
- **Material Design 3** — m3.material.io. Android-side equivalent. Motion, Color, and Accessibility sections.
- **WCAG 2.2** — w3.org/TR/WCAG22. The accessibility standard. Understand the AA level requirements.

### Books and long-form

- **"Crafting Interfaces"** (various authors, mostly for iOS native but principles transfer) — detailed deep dives into haptics, animation timing, gestures.
- **"Refactoring UI"** (Adam Wathan & Steve Schoger) — not RN-specific; a design-thinking guide that sharpens the eye.

### Video talks

- **App.js Conf** talks — app-js-conf.com. The annual Expo conference; many talks on Reanimated, navigation, performance.
- **React Native EU / React Universe Conf** talks on YouTube — particularly anything by William Candillon (Skia), Krzysztof Magiera (RNGH/Reanimated), Satyajit Sahoo (React Navigation).
- **"William Candillon: Can it be done in React Native?"** — YouTube series. Solved-by-example implementations of complex UI patterns from native apps. The single best resource for seeing what's possible.

### Blogs and communities

- **Software Mansion blog** — blog.swmansion.com. Reanimated, Gesture Handler, and Expo's core maintainers. Release announcements and architectural deep dives.
- **Shopify Engineering blog** — shopify.engineering. FlashList, Skia, mobile architecture posts.
- **Expo blog** — expo.dev/changelog. SDK release notes; often the best source for "what changed in the ecosystem this quarter."
- **React Native Radio podcast** — infinite.red/react-native-radio. Interviews with library maintainers.
- **Infinite Red** and **Software Mansion** newsletters.

### Specific deep dives worth reading

- The Reanimated 4 stable release announcement (Software Mansion blog, 2025) — explains the CSS animations model and migration path.
- The FlashList v2 launch post (Shopify Engineering, 2025) — architectural explanation of how v2 works without estimates.
- React Navigation 7 migration guide — covers the transition from 6 to 7, many breaking changes around native stack.
- Software Mansion's articles on worklets and the Reanimated architecture — the conceptual foundation.

### GitHub repos to browse

- The Reanimated example app (`react-native-reanimated/apps/common-app`) — dozens of working examples.
- The Gesture Handler example app — same, for gestures.
- `react-native-ios-utilities` (dominicstop) — well-engineered iOS-specific components. Good to read for implementation patterns.
- `react-native-screens` source — worth skimming to understand the native-side integration.

### What to skip

- Most tutorial blog posts aimed at beginners. They repeat the same basic material and are often out of date (especially anything on Reanimated before v3, or navigation before v6).
- LinkedIn posts about "the 10 best React Native libraries." Low information density.
- Video courses over 2 hours. The ecosystem moves faster than they can update.

---

## Appendix A: Minimal wiring of the baseline stack

```tsx
// App.tsx
import 'react-native-gesture-handler';  // must be first
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
// For Expo Router projects, _layout.tsx is the equivalent wrapping location.

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <StatusBar style="auto" />
          <AppNavigator />
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

The order matters:
- `GestureHandlerRootView` outermost so all gestures propagate correctly.
- `SafeAreaProvider` before anything that uses `useSafeAreaInsets`.
- `BottomSheetModalProvider` above everything that might present a modal sheet.

## Appendix B: `babel.config.js` for Reanimated

```js
// babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      'react-native-reanimated/plugin', // must be listed LAST
    ],
  };
};
```

Reanimated's Babel plugin workletizes your animation code. It must be the last plugin in the list. Forgetting this is the #2 setup gotcha (after forgetting `GestureHandlerRootView`).

As of Expo SDK 52+, `babel-preset-expo` auto-configures the Reanimated plugin, so you often don't need to add it explicitly. Still worth knowing it exists.

## Appendix C: Metro config for FlashList

FlashList v2 is JS-only and requires no Metro config changes. If you see errors about `NativeLayoutProvider` or similar, you're still referencing FlashList v1 internals; make sure you're on v2.x and the New Architecture is enabled.

## Appendix D: Checklist for a polished interactive element

Work through this list for every primary button / selection target / interactive row in your app:

- [ ] Visual press feedback (opacity, scale, color, or ripple)
- [ ] Feedback driven via Reanimated (UI thread) if animated
- [ ] `onPress` commits, not `onPressIn`
- [ ] `hitSlop` or padding to 44×44 minimum touch target
- [ ] `pressRetentionOffset` on anything likely to be drifted off
- [ ] Haptic on commit (if appropriate — see Section 11)
- [ ] `accessibilityRole` set
- [ ] `accessibilityLabel` set
- [ ] `accessibilityState` set if stateful (selected/disabled/checked)
- [ ] Disabled state has visibly different style, not just `disabled={true}`
- [ ] Test with VoiceOver or TalkBack — is it understandable?
- [ ] Test with Reduce Motion — does the animation gracefully skip?
- [ ] Test with 150% text scale — does the element still fit?
- [ ] Test on low-end Android — is the feedback still smooth?
- [ ] Test offline — does the commit work optimistically?

If all fifteen are true, it's polished. If even one is false, a user somewhere has a worse experience than they should.

---

*End of reference. Revise periodically; the ecosystem moves.*
