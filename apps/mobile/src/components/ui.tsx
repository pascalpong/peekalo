import { tokens } from '@peekalo/design';
import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BrandLogo, BrandMark } from './brand';

export const colors = tokens.color;
export { tokens };

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

export function Button({ label, onPress, secondary = false, icon = 'arrow-up-right' }: {
  label: string; onPress: () => void; secondary?: boolean;
  icon?: ComponentProps<typeof Feather>['name'];
}) {
  return <Pressable accessibilityRole="button" onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, pressed && styles.pressed]}>
    <Text style={[styles.buttonLabel, secondary && styles.secondaryLabel]}>{label}</Text><Feather name={icon} color={secondary ? colors.text : colors.onAccent} size={18} />
  </Pressable>;
}

/** Opaque sample art. There is no photograph or original beneath it. */
export function MysteryArt({ compact = false }: { compact?: boolean }) {
  return <View accessible accessibilityLabel="Abstract sample illustration. No real photo is loaded."
    style={[styles.art, compact && styles.artCompact]}>
    <View style={styles.artOrb} /><View style={styles.artHill} /><View style={styles.artShape} />
    <View style={styles.artTop}><Text style={styles.artTag}>SAMPLE MOMENT</Text><Feather name="image" color="#fff" size={16} /></View>
    <View style={styles.artCenter}><View style={styles.artEyes}><Eyes large /></View><Text style={styles.artScript}>A little mystery.</Text></View>
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
  header: { minHeight: 74, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12, marginBottom: 28 },
  previewPill: { flexDirection: 'row', gap: 5, alignItems: 'center', flexShrink: 0 },
  dot: { height: 5, width: 5, backgroundColor: colors.accent, borderRadius: 4 },
  previewText: { fontSize: 10, color: colors.muted },
  eyebrow: { color: colors.accent, fontSize: 10, lineHeight: 16, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase' },
  button: { minHeight: 52, borderRadius: tokens.radius.pill, backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 14 },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryLabel: { color: colors.text },
  buttonLabel: { color: colors.onAccent, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: 0.65 },
  art: { height: 300, borderRadius: tokens.radius.md, overflow: 'hidden', backgroundColor: '#26352b', justifyContent: 'space-between', padding: 20 },
  artCompact: { height: 235 },
  artOrb: { position: 'absolute', top: -60, right: -45, width: 280, height: 280, borderRadius: 180, backgroundColor: '#4a563e' },
  artHill: { position: 'absolute', bottom: -120, left: -90, width: 440, height: 300, borderRadius: 190, backgroundColor: '#344631', transform: [{ rotate: '-22deg' }] },
  artShape: { position: 'absolute', right: -45, bottom: -45, width: 180, height: 250, borderRadius: 100, backgroundColor: '#576643', transform: [{ rotate: '28deg' }] },
  artTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  artTag: { color: '#fff', fontSize: 8, letterSpacing: 1, padding: 7, borderWidth: 1, borderColor: '#FFFFFF70', borderRadius: 14 },
  artCenter: { alignItems: 'center', gap: 14 },
  artEyes: { width: 78, height: 78, borderRadius: 40, backgroundColor: '#FFFFFF35', borderWidth: 1, borderColor: '#FFFFFF80', alignItems: 'center', justifyContent: 'center' },
  artScript: { color: '#fff', fontSize: 26, fontFamily: tokens.font.display, letterSpacing: -0.8 },
  artBottom: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  artCaption: { color: '#fff', fontSize: 10 },
});
