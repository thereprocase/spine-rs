// Floating action bar that surfaces when the user has a live text
// selection in the WebView. Shown above the bottom edge so the user's
// thumb still has room to maneuver — anchoring to the selection rect
// itself would put the bar under the system selection handles.
//
// Buttons (design order, reading direction left→right):
//   Highlight ▾ · Look up · Copy · Share · ✕
//
// Highlight is a split-button: tapping the body applies the user's
// last-used color; tapping the chevron opens a 5-color picker. The
// color choice persists to prefs (lastHighlightColor) so the next
// session starts where the last one ended.
//
// Copy is wired via the WebView's document.execCommand("copy") so we
// don't need to add expo-clipboard as a dependency. Share goes through
// RN's built-in Share API, sending the selected text as `message`.

import { useState } from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONTS, type Theme } from "../themes";
import type { HighlightColor } from "../types";

export const HIGHLIGHT_COLORS: ReadonlyArray<{
  key: HighlightColor;
  // Two CSS color literals: `tint` for the swatch in the picker (full
  // saturation, looks right against any reader theme) and `wash` for
  // the actual text-overlay used by the highlight renderer (low alpha,
  // doesn't drown the ink).
  tint: string;
  wash: string;
  label: string;
}> = [
  { key: "yellow", tint: "#f5d761", wash: "rgba(245,215,97,0.42)", label: "Yellow" },
  { key: "pink", tint: "#e89bb6", wash: "rgba(232,155,182,0.42)", label: "Pink" },
  { key: "green", tint: "#9bc88a", wash: "rgba(155,200,138,0.42)", label: "Green" },
  { key: "blue", tint: "#9abad8", wash: "rgba(154,186,216,0.42)", label: "Blue" },
  { key: "orange", tint: "#e8a766", wash: "rgba(232,167,102,0.42)", label: "Orange" },
];

export function colorWashFor(key: HighlightColor): string {
  return HIGHLIGHT_COLORS.find((c) => c.key === key)?.wash ?? HIGHLIGHT_COLORS[0]!.wash;
}

interface Props {
  theme: Theme;
  insets: EdgeInsets;
  /** Text the user has selected. Null = bar hidden. */
  text: string | null;
  /** Last-used color from prefs. Becomes the default for a one-tap
   * Highlight without opening the picker. */
  defaultColor: HighlightColor;
  /** True when this selection came from a long-press on a single word
   * — the canonical "look up this word" gesture. We bias the bar by
   * showing Look up first in that case (still keeping all five
   * buttons visible). */
  fromLongPress: boolean;
  onHighlight: (color: HighlightColor) => void;
  onLookup: () => void;
  /** Caller (reader screen) injects a "copySelection" command into the
   * WebView, which calls document.execCommand("copy") inside the
   * iframe. Avoids adding expo-clipboard just for this. */
  onCopy: () => void;
  onDismiss: () => void;
}

export function SelectionBar({
  theme,
  insets,
  text,
  defaultColor,
  fromLongPress,
  onHighlight,
  onLookup,
  onCopy,
  onDismiss,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!text) return null;

  const onShare = () => {
    void Share.share({ message: text });
  };

  // Reorder when the gesture was a long-press: Look up takes the
  // leftmost slot because the user almost certainly wants a definition.
  const buttons: Array<{ key: string; node: React.ReactNode }> = [];

  const HighlightSplit = (
    <View
      key="highlight"
      style={[styles.btnGroup, { borderColor: theme.readerRule }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Highlight in ${defaultColor}`}
        onPress={() => onHighlight(defaultColor)}
        style={({ pressed }) => [
          styles.btnBody,
          { backgroundColor: pressed ? `${theme.accent}22` : "transparent" },
        ]}
      >
        <View
          style={[
            styles.colorSwatch,
            { backgroundColor: HIGHLIGHT_COLORS.find((c) => c.key === defaultColor)?.tint },
          ]}
        />
        <Text style={[styles.btnText, { color: theme.readerInk }]}>Highlight</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Pick highlight color"
        onPress={() => setPickerOpen((v) => !v)}
        style={({ pressed }) => [
          styles.btnChevron,
          {
            backgroundColor: pressed ? `${theme.accent}22` : "transparent",
            borderLeftColor: theme.readerRule,
          },
        ]}
      >
        <Text style={[styles.chevText, { color: theme.readerDim }]}>▾</Text>
      </Pressable>
    </View>
  );

  const LookupBtn = (
    <BarButton
      key="lookup"
      theme={theme}
      label="Look up"
      onPress={onLookup}
    />
  );
  const CopyBtn = (
    <BarButton key="copy" theme={theme} label="Copy" onPress={onCopy} />
  );
  const ShareBtn = (
    <BarButton key="share" theme={theme} label="Share" onPress={onShare} />
  );
  const DismissBtn = (
    <Pressable
      key="dismiss"
      accessibilityRole="button"
      accessibilityLabel="Dismiss selection"
      onPress={onDismiss}
      style={({ pressed }) => [
        styles.dismissBtn,
        { backgroundColor: pressed ? `${theme.accent}22` : "transparent" },
      ]}
    >
      <Text style={[styles.dismissText, { color: theme.readerDim }]}>×</Text>
    </Pressable>
  );

  if (fromLongPress) {
    buttons.push({ key: "lookup", node: LookupBtn });
    buttons.push({ key: "highlight", node: HighlightSplit });
    buttons.push({ key: "copy", node: CopyBtn });
  } else {
    buttons.push({ key: "highlight", node: HighlightSplit });
    buttons.push({ key: "lookup", node: LookupBtn });
    buttons.push({ key: "copy", node: CopyBtn });
  }
  buttons.push({ key: "share", node: ShareBtn });
  buttons.push({ key: "dismiss", node: DismissBtn });

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        { paddingBottom: insets.bottom + 16, paddingHorizontal: 12 },
      ]}
    >
      {pickerOpen ? (
        <View
          style={[
            styles.picker,
            {
              backgroundColor: theme.readerBg,
              borderColor: theme.readerRule,
            },
          ]}
        >
          {HIGHLIGHT_COLORS.map((c) => {
            const active = c.key === defaultColor;
            return (
              <Pressable
                key={c.key}
                accessibilityLabel={`Highlight in ${c.label}`}
                onPress={() => {
                  onHighlight(c.key);
                  setPickerOpen(false);
                }}
                style={({ pressed }) => [
                  styles.pickerSwatch,
                  {
                    backgroundColor: c.tint,
                    borderColor: active ? theme.readerInk : "transparent",
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              />
            );
          })}
        </View>
      ) : null}
      <View
        style={[
          styles.bar,
          {
            backgroundColor: theme.readerBg,
            borderColor: theme.readerRule,
          },
        ]}
      >
        {buttons.map((b) => b.node)}
      </View>
    </View>
  );
}

function BarButton({
  theme,
  label,
  onPress,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btnSimple,
        { backgroundColor: pressed ? `${theme.accent}22` : "transparent" },
      ]}
    >
      <Text style={[styles.btnText, { color: theme.readerInk }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 2,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  btnSimple: {
    minHeight: 56,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  btnGroup: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: 4,
    overflow: "hidden",
    borderWidth: 0,
  },
  btnBody: {
    minHeight: 56,
    paddingLeft: 14,
    paddingRight: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  btnChevron: {
    minWidth: 32,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  chevText: {
    fontFamily: FONTS.sans,
    fontSize: 16,
    fontWeight: "600",
  },
  colorSwatch: {
    width: 14,
    height: 14,
    borderRadius: 2,
    marginRight: 10,
  },
  btnText: {
    fontFamily: FONTS.sans,
    fontSize: 15,
    fontWeight: "600",
  },
  dismissBtn: {
    minHeight: 56,
    minWidth: 44,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  dismissText: {
    fontFamily: FONTS.sans,
    fontSize: 26,
    fontWeight: "700",
    lineHeight: 26,
  },
  picker: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    elevation: 6,
  },
  pickerSwatch: {
    width: 32,
    height: 32,
    borderRadius: 4,
    borderWidth: 2,
  },
});
