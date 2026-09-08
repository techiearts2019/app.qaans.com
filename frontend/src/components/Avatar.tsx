import { Image } from "expo-image";
import { StyleSheet, Text, View, ViewStyle } from "react-native";

import { colors } from "@/src/theme/colors";

type Props = {
  photo?: string | null;
  name?: string | null;
  size?: number;
  style?: ViewStyle;
  testID?: string;
};

// Deterministic pastel palette so the same person's initials stay the same
// colour across renders / screens.
const PALETTE = [
  "#2563EB", // blue
  "#7C3AED", // violet
  "#DB2777", // pink
  "#DC2626", // red
  "#EA580C", // orange
  "#CA8A04", // amber
  "#16A34A", // green
  "#0891B2", // cyan
  "#4F46E5", // indigo
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  return Math.abs(h);
}

/**
 * Renders the employee photo when available; falls back to a coloured
 * circle with the person's initials so the card never looks broken.
 *
 * Handles all photo formats we currently store:
 *  - http(s):// URLs (Unsplash, Pexels, external avatars)
 *  - data:image/…;base64,… (photos captured on-device and uploaded)
 *  - undefined / null / empty string → initials placeholder
 */
export function Avatar({ photo, name, size = 52, style, testID }: Props) {
  const showImage =
    !!photo &&
    (photo.startsWith("http://") ||
      photo.startsWith("https://") ||
      photo.startsWith("data:"));

  const key = name ?? "";
  const color = PALETTE[hashCode(key) % PALETTE.length];

  const commonStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  };

  if (showImage) {
    return (
      <View style={[commonStyle, style]} testID={testID}>
        <Image
          source={{ uri: photo! }}
          style={styles.img}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
        />
      </View>
    );
  }

  return (
    <View style={[commonStyle, style]} testID={testID}>
      <Text
        style={[
          styles.initials,
          { fontSize: Math.max(12, Math.floor(size * 0.38)) },
        ]}
      >
        {initialsOf(name ?? "")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { width: "100%", height: "100%" },
  initials: {
    color: colors.white,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
});
