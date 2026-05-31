// Display sheet — mirrors mockup screen 10. Theme picker (Aa swatches), font
// size slider (8–24pt), typeface picker, brightness, warmth.

import { useEffect, useRef } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useChromeSlider } from "./chromeShared";
import type { EdgeInsets } from "react-native-safe-area-context";

import {
  DEFAULT_READER_SETTINGS,
  type ReaderFontFamily,
  type ReaderMode,
  type ReaderSettings,
} from "../store/prefs";
import {
  READER_FONT_CATEGORIES,
  readerFontForCategory,
  type ReaderFontCategory,
} from "./fonts";
import { FONTS, SPINE_THEMES, THEME_ORDER, type Theme, type ThemeName } from "../themes";

interface SheetProps {
  visible: boolean;
  theme: Theme;
  insets: EdgeInsets;
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onClose: () => void;
  onOpenAllSettings: () => void;
}

const FONT_MIN = 8;
const FONT_MAX = 24;

export function ReaderSettingsSheet({
  visible,
  theme,
  insets,
  onOpenAllSettings,
  settings,
  onChange,
  onClose,
}: SheetProps) {
  const slide = useRef(new Animated.Value(visible ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 0 : 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [slide, visible]);

  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.4)" }]} />
      </Pressable>
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.panel,
            borderTopColor: theme.borderHi,
            paddingBottom: insets.bottom + 24,
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 600],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.dragBar}>
          <View style={[styles.dragHandle, { backgroundColor: theme.borderHi }]} />
        </View>

        <View
          style={[
            styles.header,
            { borderBottomColor: theme.borderSoft },
          ]}
        >
          <Text
            style={{
              color: theme.text,
              fontFamily: FONTS.serif,
              fontStyle: "italic",
              fontWeight: "600",
              fontSize: 18,
            }}
          >
            Display
          </Text>
          <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
            <Pressable onPress={onOpenAllSettings} hitSlop={8}>
              <Text
                style={{
                  color: theme.accent,
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                All settings ›
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                // One-tap Reset wiped brightness + warmth + theme +
                // font + size with no warning. Confirm.
                Alert.alert(
                  "Reset display settings?",
                  "Brightness, warmth, font size, typeface, and theme will return to defaults.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Reset",
                      style: "destructive",
                      onPress: () => onChange({ ...DEFAULT_READER_SETTINGS }),
                    },
                  ],
                );
              }}
              hitSlop={8}
            >
              <Text
                style={{
                  color: theme.textDim,
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                Reset
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Mini sheet — only the three controls that benefit from live
            preview (brightness / text size / typeface). The rest live in
            the app Settings screen so this overlay stays under half the
            viewport, leaving the page visible to watch changes apply. */}
        <ScrollView
          style={styles.content}
          contentContainerStyle={{ paddingBottom: insets.bottom + 18 }}
          showsVerticalScrollIndicator
          bounces={false}
        >
          <BrightnessRow theme={theme} value={settings.brightness} onChange={(v) => onChange({ brightness: v })} />
          <WarmthRow theme={theme} value={settings.warmth} onChange={(v) => onChange({ warmth: v })} />
          <FontSizeRow theme={theme} value={settings.fontSize} onChange={(v) => onChange({ fontSize: v })} />
          <TypefaceRow
            theme={theme}
            settings={settings}
            value={settings.fontFamily}
            onChange={(v) => onChange({ fontFamily: v })}
          />
          <ThemeRow theme={theme} value={settings.theme} onChange={(t) => onChange({ theme: t })} />
          {/* Tappable hint — names the features the user is looking for
              and ALSO routes them there. Pippin called out that the prior
              <Text> caption was bait without a click target. */}
          <Pressable
            onPress={onOpenAllSettings}
            style={({ pressed }) => ({
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: 8,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{
                color: theme.accent,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontWeight: "600",
              }}
            >
              Justify · Hyphenate · Drop cap · Scroll mode →
            </Text>
            <Text
              style={{
                color: theme.textDim,
                fontFamily: FONTS.sans,
                fontSize: 11,
                marginTop: 4,
              }}
            >
              Tap to open All Settings
            </Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function SectionLabel({ theme, children }: { theme: Theme; children: string }) {
  return (
    <Text
      style={{
        color: theme.textFaint,
        fontFamily: FONTS.mono,
        fontSize: 10,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        marginBottom: 12,
      }}
    >
      {children}
    </Text>
  );
}

function ThemeRow({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: ThemeName;
  onChange: (t: ThemeName) => void;
}) {
  const opts = THEME_ORDER;
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
      <SectionLabel theme={theme}>Theme</SectionLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {opts.map((opt) => {
          const active = value === opt.key;
          const swatch = SPINE_THEMES[opt.key];
          return (
            <Pressable
              key={opt.key}
              onPress={() => onChange(opt.key)}
              style={[
                styles.swatchOuter,
                {
                  borderColor: active ? theme.accent : theme.border,
                  borderWidth: 2,
                },
              ]}
            >
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: swatch.readerBg },
                ]}
              >
                <Text
                  style={{
                    color: swatch.readerInk,
                    fontFamily: FONTS.serif,
                    fontStyle: "italic",
                    fontWeight: "600",
                    fontSize: 17,
                  }}
                >
                  Aa
                </Text>
              </View>
              <View
                style={{
                  paddingVertical: 6,
                  alignItems: "center",
                  backgroundColor: theme.panel,
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: active ? theme.accent : theme.borderSoft,
                }}
              >
                <Text
                  style={{
                    color: active ? theme.accent : theme.textMid,
                    fontFamily: FONTS.sans,
                    fontSize: 11,
                    fontWeight: "500",
                  }}
                >
                  {opt.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// useSliderResponder removed in 0.2.16 — code review called out the
// duplication with chromeShared's useChromeSlider. Brightness, Warmth,
// and FontSize rows below all use useChromeSlider directly.

function WarmthRow({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: number;
  onChange: (v: number) => void;
}) {
  const ratio = Math.max(0, Math.min(1, value));
  const slider = useChromeSlider((r) => {
    const clamped = Math.max(0, Math.min(1, r));
    if (Math.abs(clamped - value) > 0.005) {
      onChange(Math.round(clamped * 100) / 100);
    }
  });
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <SectionLabel theme={theme}>Warmth</SectionLabel>
        <Text style={{ color: theme.text, fontFamily: FONTS.mono, fontSize: 12 }}>
          {Math.round(ratio * 100)}%
        </Text>
      </View>
      <View
        style={[
          styles.fontSizeWrap,
          { backgroundColor: theme.bg, borderColor: theme.border },
        ]}
      >
        {/* Cool side: snowflake. Warm side: amber circle (color-temp,
            not brightness — keeps the warmth row visually distinct from
            the brightness row's ☀ at this end). */}
        <Text style={{ color: theme.textMid, fontFamily: FONTS.sans, fontSize: 12 }}>
          ❄
        </Text>
        <View
          ref={slider.trackRef}
          style={{ flex: 1, height: 44, justifyContent: "center" }}
          onLayout={slider.onLayout}
          {...slider.panHandlers}
        >
          <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.border, overflow: "hidden" }}>
            <View
              style={{
                width: `${ratio * 100}%`,
                height: "100%",
                backgroundColor: theme.accent,
              }}
            />
          </View>
        </View>
        <View
          style={{
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: "#e6a04a",
            opacity: 0.9,
          }}
        />
      </View>
    </View>
  );
}

function BrightnessRow({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: number;
  onChange: (v: number) => void;
}) {
  const ratio = Math.max(0, Math.min(1, value));

  const slider = useChromeSlider((r) => {
    const clamped = Math.max(0.15, Math.min(1, r));
    if (Math.abs(clamped - value) > 0.005) {
      onChange(Math.round(clamped * 100) / 100);
    }
  });

  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <SectionLabel theme={theme}>Brightness</SectionLabel>
        <Text style={{ color: theme.text, fontFamily: FONTS.mono, fontSize: 12 }}>
          {Math.round(ratio * 100)}%
        </Text>
      </View>
      <View
        style={[
          styles.fontSizeWrap,
          { backgroundColor: theme.bg, borderColor: theme.border },
        ]}
      >
        <Text style={{ color: theme.textMid, fontFamily: FONTS.sans, fontSize: 11 }}>
          ◐
        </Text>
        <View
          ref={slider.trackRef}
          style={{ flex: 1, height: 44, justifyContent: "center" }}
          onLayout={slider.onLayout}
          {...slider.panHandlers}
        >
          <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.border, overflow: "hidden" }}>
            <View
              style={{
                width: `${ratio * 100}%`,
                height: "100%",
                backgroundColor: theme.accent,
              }}
            />
          </View>
        </View>
        <Text style={{ color: theme.textMid, fontFamily: FONTS.sans, fontSize: 14 }}>
          ☀
        </Text>
      </View>
    </View>
  );
}

function FontSizeRow({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: number;
  onChange: (v: number) => void;
}) {
  const ratio = (value - FONT_MIN) / (FONT_MAX - FONT_MIN);

  const slider = useChromeSlider((r) => {
    const v = Math.round(FONT_MIN + r * (FONT_MAX - FONT_MIN));
    if (v !== value) onChange(v);
  });

  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <SectionLabel theme={theme}>Text size</SectionLabel>
        <Text style={{ color: theme.text, fontFamily: FONTS.mono, fontSize: 12 }}>
          {value} pt
        </Text>
      </View>
      <View
        style={[
          styles.fontSizeWrap,
          { backgroundColor: theme.bg, borderColor: theme.border },
        ]}
      >
        <Text style={{ color: theme.textMid, fontFamily: FONTS.serif, fontSize: 12 }}>A</Text>
        <View
          ref={slider.trackRef}
          style={{ flex: 1, height: 44, justifyContent: "center" }}
          onLayout={slider.onLayout}
          {...slider.panHandlers}
        >
          <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.border, overflow: "hidden" }}>
            <View
              style={{
                width: `${ratio * 100}%`,
                height: "100%",
                backgroundColor: theme.accent,
              }}
            />
          </View>
        </View>
        <Text style={{ color: theme.textMid, fontFamily: FONTS.serif, fontSize: 20 }}>A</Text>
      </View>
    </View>
  );
}

function TypefaceRow({
  theme,
  settings,
  value,
  onChange,
}: {
  theme: Theme;
  settings: ReaderSettings;
  value: ReaderFontFamily;
  onChange: (v: ReaderFontCategory) => void;
}) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
      <SectionLabel theme={theme}>Typeface category</SectionLabel>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {READER_FONT_CATEGORIES.map((opt) => {
          const font = readerFontForCategory(opt.key, settings.fontMap);
          const active = opt.key === value;
          return (
            <Pressable
              key={opt.key}
              onPress={() => onChange(opt.key)}
              style={[
                styles.typeBtn,
                {
                  borderColor: active ? theme.accent : theme.border,
                  backgroundColor: active ? `${theme.accent}14` : "transparent",
                },
              ]}
            >
              <Text
                style={{
                  fontFamily: font.nativeFamily ?? FONTS.sans,
                  fontStyle: opt.key === "book" ? "italic" : "normal",
                  fontWeight: "600",
                  fontSize: 18,
                  color: active ? theme.accent : theme.text,
                  marginBottom: 4,
                }}
              >
                Aa
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 10,
                  fontWeight: "500",
                  color: active ? theme.accent : theme.textMid,
                }}
              >
                {opt.label}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 9,
                  color: active ? theme.accent : theme.textDim,
                  marginTop: 2,
                }}
              >
                {opt.caption}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 8,
                  color: active ? theme.accent : theme.textFaint,
                  marginTop: 2,
                }}
              >
                {font.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ToggleRow({
  theme,
  label,
  value,
  onChange,
  first,
  last,
}: {
  theme: Theme;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={[
        styles.toggleRow,
        {
          marginHorizontal: 20,
          borderTopWidth: first ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: theme.borderSoft,
          marginTop: first ? 20 : 0,
          marginBottom: last ? 0 : 0,
        },
      ]}
    >
      <Text style={{ color: theme.text, fontFamily: FONTS.sans, fontSize: 13 }}>{label}</Text>
      <View
        style={[
          styles.toggle,
          { backgroundColor: value ? theme.accent : theme.border },
        ]}
      >
        <View
          style={[
            styles.toggleKnob,
            {
              left: value ? 18 : 2,
              backgroundColor: theme.inkInvert,
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

// Half-screen — leaves the upper half of the page visible so the user can
// watch font size / brightness / typeface changes apply live. Picking 0.55
// because the four controls (brightness, text size, typeface, theme) plus
// the header land just under half the viewport on a Pixel 9 Pro.
const SHEET_MAX_HEIGHT = Dimensions.get("window").height * 0.55;

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    maxHeight: SHEET_MAX_HEIGHT,
    paddingTop: 4,
  },
  dragBar: { paddingTop: 10, paddingBottom: 6, alignItems: "center" },
  dragHandle: { width: 40, height: 4, borderRadius: 2 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: { flexShrink: 1 },
  // 30% width with flex-wrap so 5 swatches lay out as 3+2 across two
  // rows on a phone-width sheet. flex:1 had collapsed all 5 into a
  // squashed single row.
  swatchOuter: { width: "30%", borderRadius: 3, overflow: "hidden" },
  swatch: {
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  fontSizeWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 3,
  },
  typeBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: "center",
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  toggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    position: "relative",
  },
  toggleKnob: {
    position: "absolute",
    top: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
  },
});
