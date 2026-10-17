import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = {
  paper: '#FAF9F5', ink: '#17231D', muted: '#71786F', line: '#E0E3D8',
  lime: '#D9F69D', soft: '#EFF2E8', white: '#FFFFFF',
};

export function Eyes({ large = false, inverse = false }: { large?: boolean; inverse?: boolean }) {
  return <View accessible={false} style={[styles.eyes, large && styles.eyesLarge]}>
    {[0, 1].map(eye => <View key={eye} style={[styles.eye, large && styles.eyeLarge, inverse && { backgroundColor: '#fff' }]}>
      <View style={[styles.pupil, large && styles.pupilLarge, inverse && { backgroundColor: colors.ink }]} />
    </View>)}
  </View>;
}

export function Header() {
  return <View style={styles.header}>
    <View style={styles.brand} accessibilityLabel="Peekalo">
      <Eyes /><Text style={styles.brandName}>peekalo<Text style={styles.brandDot}>.</Text></Text>
    </View>
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
    <Text style={styles.buttonLabel}>{label}</Text><Feather name={icon} color={colors.ink} size={18} />
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
  title: { color: colors.ink, fontSize: 42, lineHeight: 45, letterSpacing: -2.2, fontWeight: '500' },
  body: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  section: { color: colors.ink, fontSize: 17, lineHeight: 24, fontWeight: '600', letterSpacing: -0.4 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 28 },
  content: { width: '100%', maxWidth: 540, alignSelf: 'center' },
  header: { minHeight: 74, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line, gap: 12, marginBottom: 28 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  brandName: { color: colors.ink, fontSize: 28, fontWeight: '800', letterSpacing: -1.7 },
  brandDot: { color: '#839C47' },
  previewPill: { flexDirection: 'row', gap: 5, alignItems: 'center', flexShrink: 0 },
  dot: { height: 5, width: 5, backgroundColor: '#839C47', borderRadius: 4 },
  previewText: { fontSize: 10, color: colors.muted },
  eyes: { flexDirection: 'row', gap: 2 },
  eyesLarge: { gap: 4 },
  eye: { height: 22, width: 13, borderRadius: 9, backgroundColor: colors.ink, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 2 },
  eyeLarge: { height: 35, width: 22, borderRadius: 14, paddingRight: 4 },
  pupil: { height: 8, width: 4, borderRadius: 5, backgroundColor: colors.paper },
  pupilLarge: { height: 12, width: 7 },
  eyebrow: { color: '#667650', fontSize: 10, lineHeight: 16, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase' },
  button: { minHeight: 52, borderRadius: 28, backgroundColor: colors.lime, paddingHorizontal: 22, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 14 },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  buttonLabel: { color: colors.ink, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: 0.65 },
  art: { height: 300, borderRadius: 22, overflow: 'hidden', backgroundColor: '#9AA48C', justifyContent: 'space-between', padding: 20 },
  artCompact: { height: 235 },
  artOrb: { position: 'absolute', top: -60, right: -45, width: 280, height: 280, borderRadius: 180, backgroundColor: '#C5C5A4' },
  artHill: { position: 'absolute', bottom: -120, left: -90, width: 440, height: 300, borderRadius: 190, backgroundColor: '#7F9277', transform: [{ rotate: '-22deg' }] },
  artShape: { position: 'absolute', right: -45, bottom: -45, width: 180, height: 250, borderRadius: 100, backgroundColor: '#A3AC8F', transform: [{ rotate: '28deg' }] },
  artTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  artTag: { color: '#fff', fontSize: 8, letterSpacing: 1, padding: 7, borderWidth: 1, borderColor: '#FFFFFF70', borderRadius: 14 },
  artCenter: { alignItems: 'center', gap: 14 },
  artEyes: { width: 78, height: 78, borderRadius: 40, backgroundColor: '#FFFFFF35', borderWidth: 1, borderColor: '#FFFFFF80', alignItems: 'center', justifyContent: 'center' },
  artScript: { color: '#fff', fontSize: 26, fontFamily: 'Georgia', fontStyle: 'italic', letterSpacing: -0.8 },
  artBottom: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  artCaption: { color: '#fff', fontSize: 10 },
});
