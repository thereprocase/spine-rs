// Shared bits for the reader chrome panels. The two big additions this
// build are:
//
//   - <XOverlay/> — a diagonal strike across a row that's drawn but not yet
//     wired. The mockups specify a richer chrome than the alpha actually
//     supports (TTS, sleep timer, edition switcher, BIBFRAME, etc.). Rather
//     than hide those rows, we render them with this overlay so the user
//     sees the intended product surface and knows which knobs are live.
//
//   - useChromeSlider — PanResponder hook for the scrubber and brightness
//     sliders. Uses pageX + measureInWindow because Android's
//     PanResponder.nativeEvent.locationX is undefined on Grant/Move.

import { useCallback, useRef } from "react";
import { PanResponder, type View } from "react-native";

import { FONTS, type Theme } from "../themes";

import { Text, View as RNView } from "react-native";

interface XOverlayProps {
  theme: Theme;
  children: React.ReactNode;
}

/** Wraps a chrome row that is rendered for spec parity but not yet wired.
 * Two diagonals + a dim wash signal "drawn on purpose, off on purpose"
 * so the user (and any reviewer) can tell at a glance. */
export function XOverlay({ theme, children }: XOverlayProps) {
  return (
    <RNView style={{ position: "relative" }}>
      <RNView style={{ opacity: 0.42 }}>{children}</RNView>
      <RNView
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          top: 0,
          bottom: 0,
          justifyContent: "center",
        }}
      >
        <RNView
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 1,
            backgroundColor: theme.readerDim,
            transform: [{ rotate: "-4deg" }],
            opacity: 0.55,
          }}
        />
        <RNView
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 1,
            backgroundColor: theme.readerDim,
            transform: [{ rotate: "4deg" }],
            opacity: 0.55,
          }}
        />
      </RNView>
      <RNView
        pointerEvents="none"
        style={{
          position: "absolute",
          right: 14,
          top: "50%",
          marginTop: -8,
          paddingHorizontal: 6,
          paddingVertical: 2,
          backgroundColor: theme.readerBg,
          borderWidth: 1,
          borderColor: theme.readerDim,
        }}
      >
        <Text
          style={{
            color: theme.readerDim,
            fontFamily: FONTS.mono,
            fontSize: 8,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            fontWeight: "700",
          }}
        >
          Soon
        </Text>
      </RNView>
    </RNView>
  );
}

/** PanResponder-driven horizontal slider. Fires onChange(0..1) on Grant
 * + Move + Release. onCommit fires only on Release — use it for actions
 * that should run once when the user lets go (e.g. seeking the reader).
 *
 * Two non-obvious safety details, both load-bearing on Android:
 *   - We capture evt.nativeEvent.pageX SYNCHRONOUSLY inside each
 *     PanResponder callback before doing anything async. Some Android
 *     RN builds null-out the nativeEvent's properties after the handler
 *     returns; reading pageX from inside a setTimeout/measureInWindow
 *     callback can throw, which crashed the whole reader screen on the
 *     warmth slider in 0.2.1.
 *   - PanResponder.create captures whatever onChange/onCommit closures
 *     were in scope on the very first render (we keep the responder in
 *     a useRef across renders). We route through callback refs that
 *     update every render so the responder always invokes the latest
 *     closures. */
export function useChromeSlider(
  onChange: (ratio: number) => void,
  onCommit?: (ratio: number) => void,
) {
  const trackRef = useRef<View | null>(null);
  const trackWidthRef = useRef(0);
  const trackOriginRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  const ratioFromPageX = useCallback((pageX: number) => {
    const w = trackWidthRef.current;
    if (w <= 0) return 0;
    const local = pageX - trackOriginRef.current;
    return Math.max(0, Math.min(1, local / w));
  }, []);

  const measure = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackOriginRef.current = x;
      trackWidthRef.current = w;
    });
  }, []);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const pageX = evt.nativeEvent.pageX;
        trackRef.current?.measureInWindow((x, _y, w) => {
          trackOriginRef.current = x;
          trackWidthRef.current = w;
          onChangeRef.current(ratioFromPageX(pageX));
        });
      },
      onPanResponderMove: (evt) => {
        // Suppress until measureInWindow has populated the track
        // width — otherwise the very first move event reads
        // trackWidthRef=0 and ratioFromPageX returns 0, which would
        // jump the thumb to the far-left for a single frame before
        // the measure callback completes.
        if (trackWidthRef.current <= 0) return;
        const pageX = evt.nativeEvent.pageX;
        onChangeRef.current(ratioFromPageX(pageX));
      },
      onPanResponderRelease: (evt) => {
        if (trackWidthRef.current <= 0) return;
        const pageX = evt.nativeEvent.pageX;
        const ratio = ratioFromPageX(pageX);
        onChangeRef.current(ratio);
        onCommitRef.current?.(ratio);
      },
      onPanResponderTerminate: () => {
        // Termination is something else taking the responder
        // (parent gesture, modal close). Do NOT commit a final
        // ratio here — committing the touch's last position when
        // a sibling modal stole focus would silently set
        // brightness=0 if the user happened to be dragging from
        // the far-left. Just leave the slider where it is.
      },
    }),
  ).current;

  return {
    trackRef,
    panHandlers: responder.panHandlers,
    onLayout: measure,
  };
}
