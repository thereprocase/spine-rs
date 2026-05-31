// Root-level import-progress banner. Sits at the top of the screen
// regardless of which route the user is on so a long ZIP unpack from
// "Open with" or "Share to" is visible from home, library, settings,
// AND the reader. Clicking through to read while a background import
// runs is the desired UX — without this banner the user landed on home
// after sharing and saw no signal that 194 EPUBs were unpacking.

import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { useLibrary } from "../store/library";
import { FONTS, type Theme } from "../themes";

interface Props {
  theme: Theme;
  insets: EdgeInsets;
  /** When true (e.g. user is reading immersively), render a thin
   * progress strip without the activity-indicator row. Avoids yanking
   * the user out of immersive reading mode for an import they already
   * kicked off. */
  compact?: boolean;
}

export function ImportProgressBanner({ theme, insets, compact = false }: Props) {
  // Two selectors instead of an object literal — without a shallow
  // equality fn, an object selector would force a new reference (and
  // re-render) on every store update regardless of whether either
  // field changed.
  const importing = useLibrary((s) => s.importing);
  const progress = useLibrary((s) => s.importProgress);
  if (!importing) return null;

  // Defensive ratio: NaN/Infinity from a 0-total race should render as
  // 0%, never as `NaN%` or an unbounded width.
  const rawRatio =
    progress && progress.total > 0 ? progress.current / progress.total : 0;
  const ratio = Number.isFinite(rawRatio)
    ? Math.max(0, Math.min(1, rawRatio))
    : 0;

  if (compact) {
    return (
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 2,
          backgroundColor: `${theme.accent}30`,
          zIndex: 100,
          elevation: 6,
        }}
      >
        <View
          style={{
            width: progress && progress.total > 0 ? `${ratio * 100}%` : "100%",
            height: "100%",
            backgroundColor: theme.accent,
            opacity: progress && progress.total > 0 ? 1 : 0.5,
          }}
        />
      </View>
    );
  }

  return (
    <View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          paddingTop: insets.top + 8,
          backgroundColor: theme.panel,
          borderBottomColor: theme.borderHi,
        },
      ]}
    >
      <View style={styles.row}>
        <ActivityIndicator color={theme.accent} size="small" />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{
              color: theme.text,
              fontFamily: FONTS.sans,
              fontSize: 13,
              fontWeight: "600",
            }}
          >
            {progress
              ? `Importing ${progress.current} of ${progress.total}`
              : "Importing…"}
          </Text>
          {progress?.label ? (
            <Text
              numberOfLines={1}
              style={{
                color: theme.textDim,
                fontFamily: FONTS.mono,
                fontSize: 10,
                letterSpacing: 0.4,
                marginTop: 2,
              }}
            >
              {progress.label}
            </Text>
          ) : null}
        </View>
      </View>
      {progress && progress.total > 0 ? (
        <View
          style={[
            styles.bar,
            { backgroundColor: theme.borderSoft },
          ]}
        >
          <View
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              backgroundColor: theme.accent,
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 100,
    elevation: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
  },
  bar: {
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
    marginTop: 8,
  },
});
