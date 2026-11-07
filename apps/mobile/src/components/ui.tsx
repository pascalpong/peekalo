import { tokens } from '@peekalo/design';
import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BrandLogo, BrandMark } from './brand';

export const colors = tokens.color;
export { tokens };

/** Veil's frosted appearance is decorative. Use the opaque variant for covers. */
export const material = StyleSheet.create({
  frosted: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border },
  cameraChrome: { backgroundColor: 'rgba(21, 22, 24, 0.85)', borderWidth: 1, borderColor: 'rgba(239, 239, 237, 0.26)' },
});

export function Eyes({ large = false }: { large?: boolean }) {
  return <BrandMark height={large ? 35 : 22} />;
}

export function Header() {
  return <View style={styles.header}>
    <BrandLogo />
    <View style={styles.previewPill}><View style={styles.dot} /><Text style={styles.previewText}>Early preview</Text></View>
  </View>;
}

export function Screen({ children, bottomSafe = false }: PropsWithChildren<{ bottomSafe?: boolean }>) {
  return <SafeAreaView edges={bottomSafe ? ['top', 'bottom', 'left', 'right'] : ['top', 'left', 'right']} style={styles.safe}>
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.content}><Header />{children}</View>
    </ScrollView>
  </SafeAreaView>;
}

export function Eyebrow({ children }: PropsWithChildren) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function Button({ label, onPress, secondary = false, compact = false, icon = 'arrow-up-right' }: {
  label: string; onPress: () => void; secondary?: boolean; compact?: boolean;
  icon?: ComponentProps<typeof Feather>['name'];
}) {
  return <Pressable accessibilityRole="button" onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, compact && styles.compactButton, pressed && styles.pressed]}>
    <Text style={[styles.buttonLabel, secondary && styles.secondaryLabel]}>{label}</Text><Feather name={icon} color={secondary ? colors.text : colors.onAccent} size={compact ? 15 : 18} />
  </Pressable>;
}

/** Opaque sample art. There is no photograph or original beneath it. */
export function MysteryArt({ compact = false }: { compact?: boolean }) {
  return <View accessible accessibilityLabel="Abstract sample illustration. No real photo is loaded."
    style={[material.frosted, styles.art, compact && styles.artCompact]}>
    <View style={styles.artTop}><Text style={styles.artTag}>SAMPLE MOMENT</Text><Feather name="image" color="#fff" size={16} /></View>
    <View style={styles.artCenter}><Eyes large /><Text style={styles.artScript}>A little mystery.</Text></View>
    <View style={styles.artBottom}><Feather name="eye-off" color="#fff" size={14} /><Text style={styles.artCaption}>An illustration, just for now</Text></View>
  </View>;
}

export const typography = StyleSheet.create({
  title: { color: colors.text, fontFamily: tokens.font.display, fontSize: tokens.type.display, lineHeight: 45, letterSpacing: -1.8 },
  body: { color: colors.muted, fontSize: tokens.type.body, lineHeight: 22 },
  small: { color: colors.muted, fontSize: tokens.type.small, lineHeight: 19 },
  section: { color: colors.text, fontFamily: tokens.font.display, fontSize: tokens.type.section, lineHeight: 24, letterSpacing: -0.4 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, paddingHorizontal: tokens.space.lg, paddingBottom: tokens.space.lg },
  content: { width: '100%', maxWidth: 540, alignSelf: 'center' },
  header: { minHeight: 74, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 },
  previewPill: { flexDirection: 'row', gap: 5, alignItems: 'center', flexShrink: 0 },
  dot: { height: 5, width: 5, backgroundColor: colors.accent, borderRadius: 4 },
  previewText: { fontSize: 10, color: colors.muted },
  eyebrow: { color: colors.accent, fontSize: 10, lineHeight: 16, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase' },
  button: { minHeight: 52, borderRadius: tokens.radius.pill, backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 14 },
  compactButton: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, gap: 8 },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryLabel: { color: colors.text },
  buttonLabel: { color: colors.onAccent, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: 0.65 },
  art: { height: 300, borderRadius: tokens.radius.md, overflow: 'hidden', justifyContent: 'space-between', padding: 20 },
  artCompact: { height: 235 },
  artTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  artTag: { color: '#fff', fontSize: 8, letterSpacing: 1, padding: 7, borderWidth: 1, borderColor: '#FFFFFF70', borderRadius: 14 },
  artCenter: { alignItems: 'center', gap: 14 },
  artScript: { color: '#fff', fontSize: 26, fontFamily: tokens.font.display, letterSpacing: -0.8 },
  artBottom: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  artCaption: { color: '#fff', fontSize: 10 },
});
