import Feather from '@expo/vector-icons/Feather';
import { MAX_VIDEO_DURATION_MS, PROVISIONAL_ACTIVE_MEDIA_LIMIT, REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button, colors, Eyebrow, Eyes, MysteryArt, Screen, typography } from '../../components/ui';

export default function ProfileScreen() {
  return <Screen>
    <Eyebrow>Your little corner</Eyebrow>
    <View style={styles.identity}>
      <View style={styles.avatar}><Eyes large /></View>
      <View style={styles.nameBlock}><Text accessibilityRole="header" style={styles.name}>Hello, you.</Text><Text style={typography.small}>@peekalo.demo</Text><Text style={styles.demoTag}>DEMO PROFILE</Text></View>
    </View>
    <Text style={[typography.body, styles.bio]}>A little less scrolling.{'\n'}A little more curiosity.</Text>
    <View style={styles.sectionHeader}><Text style={typography.section}>Your moments</Text><View style={styles.hiddenLabel}><Feather name="eye-off" size={13} color={colors.muted} /><Text style={styles.hiddenText}>Hidden by default</Text></View></View>
    <MysteryArt compact />
    <View style={styles.sampleButton}><Button secondary label="Explore this sample" onPress={() => router.push('/sample')} /></View>
    <View style={styles.limits}>
      <View style={styles.rule}><Text style={styles.number}>{PROVISIONAL_ACTIVE_MEDIA_LIMIT}</Text><Text style={styles.ruleLabel}>active moments*</Text></View>
      <View style={styles.rule}><Text style={styles.number}>{MAX_VIDEO_DURATION_MS / 1000}s</Text><Text style={styles.ruleLabel}>maximum video</Text></View>
      <View style={styles.rule}><Text style={styles.number}>{REVEAL_BUDGET_MS / 1000}s</Text><Text style={styles.ruleLabel}>total reveal</Text></View>
    </View>
    <Text style={styles.note}>Planned limits · *three active moments is a proposed starting limit. Photo/video capture and sharing are connected. This profile is a demo; profile editing and text chat are coming later.</Text>
  </Screen>;
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 24 },
  avatar: { width: 85, height: 85, borderRadius: 44, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  nameBlock: { flex: 1, gap: 5 },
  name: { fontSize: 32, letterSpacing: -1.4, fontWeight: '500', color: colors.ink },
  demoTag: { fontSize: 8, letterSpacing: 1, color: '#68765B', marginTop: 2 },
  bio: { marginTop: 24, marginBottom: 30 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 17 },
  hiddenLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  hiddenText: { color: colors.muted, fontSize: 10 },
  sampleButton: { marginTop: 14 },
  limits: { marginTop: 26, flexDirection: 'row', paddingVertical: 22, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line },
  rule: { flex: 1, gap: 6, alignItems: 'center' },
  number: { fontSize: 25, color: colors.ink, letterSpacing: -1, fontWeight: '500' },
  ruleLabel: { fontSize: 9, color: colors.muted, textAlign: 'center' },
  note: { marginTop: 16, fontSize: 10, lineHeight: 17, color: colors.muted },
});
