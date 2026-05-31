// Translucent overlay that visualises the reader's tap-zone layout.
// Triggered by the "?" button in the top chrome. Mirrors the live
// gesture overlay's logic in app/reader/[id].tsx:
//   - Left third of device width  → "Previous page"
//   - Center third                 → "Show / hide chrome"
//   - Right third of device width  → "Next page"
//   - Top 15%, bottom 15% (CENTER column only) → also chrome toggle
//   - Horizontal swipe ≥60px       → page turn
//
// Borders between zones are 80% opacity; the zone fills are 20%.
// Any tap dismisses the overlay so it's hard to get stuck.

import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS, type Theme } from "../themes";

interface Props {
  visible: boolean;
  theme: Theme;
  onClose: () => void;
}

export function TapZoneHelpOverlay({ visible, theme, onClose }: Props) {
  const ink = theme.readerInk;
  const accent = theme.accent;
  // Helper for borders + fills with the requested opacities.
  // RGBA-via-hex-suffix works for Android: "#RRGGBBAA".
  const borderColor = `${ink}CC`; // ~80%
  const fillLeft = `${accent}33`; // ~20%
  const fillCenter = `${ink}26`; // ~15% (subtler middle)
  const fillRight = `${accent}33`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        {/* Whole-screen 3-column band: left third / center third / right third. */}
        <View style={styles.row}>
          <View
            style={[
              styles.zone,
              {
                backgroundColor: fillLeft,
                borderRightColor: borderColor,
                borderRightWidth: 1,
              },
            ]}
          >
            <Text style={[styles.bigLabel, { color: ink }]}>‹</Text>
            <Text style={[styles.label, { color: ink }]}>Previous page</Text>
            <Text style={[styles.subLabel, { color: ink }]}>Tap or swipe-right</Text>
          </View>
          <View
            style={[
              styles.zone,
              {
                backgroundColor: fillCenter,
              },
            ]}
          >
            <Text style={[styles.bigLabel, { color: ink }]}>•••</Text>
            <Text style={[styles.label, { color: ink }]}>Show / hide chrome</Text>
            <Text style={[styles.subLabel, { color: ink }]}>
              Center column. Top &amp; bottom 15% also work.
            </Text>
          </View>
          <View
            style={[
              styles.zone,
              {
                backgroundColor: fillRight,
                borderLeftColor: borderColor,
                borderLeftWidth: 1,
              },
            ]}
          >
            <Text style={[styles.bigLabel, { color: ink }]}>›</Text>
            <Text style={[styles.label, { color: ink }]}>Next page</Text>
            <Text style={[styles.subLabel, { color: ink }]}>Tap or swipe-left</Text>
          </View>
        </View>

        {/* Top edge band */}
        <View
          pointerEvents="none"
          style={[
            styles.edgeBand,
            {
              top: 0,
              borderBottomColor: borderColor,
              borderBottomWidth: 1,
            },
          ]}
        />
        <View
          pointerEvents="none"
          style={[
            styles.edgeBand,
            {
              bottom: 0,
              borderTopColor: borderColor,
              borderTopWidth: 1,
            },
          ]}
        />

        {/* Header + dismiss hint */}
        <View pointerEvents="none" style={styles.header}>
          <Text style={[styles.title, { color: ink }]}>Tap zones</Text>
          <Text style={[styles.subLabel, { color: ink, marginTop: 4 }]}>
            Tap anywhere to dismiss
          </Text>
        </View>

        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={[styles.closeBtn, { borderColor: borderColor }]}
        >
          <Text style={{ color: ink, fontSize: 18, lineHeight: 18, fontWeight: "600" }}>×</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
  zone: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  bigLabel: {
    fontFamily: FONTS.serif,
    fontSize: 56,
    lineHeight: 60,
    fontWeight: "300",
    marginBottom: 12,
  },
  label: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  subLabel: {
    fontFamily: FONTS.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    textAlign: "center",
    marginTop: 4,
    opacity: 0.8,
  },
  edgeBand: {
    position: "absolute",
    left: 0,
    right: 0,
    height: "15%",
  },
  header: {
    position: "absolute",
    top: 36,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  title: {
    fontFamily: FONTS.serif,
    fontStyle: "italic",
    fontSize: 18,
    fontWeight: "600",
  },
  closeBtn: {
    position: "absolute",
    top: 32,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
});
