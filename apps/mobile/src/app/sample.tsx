import Feather from '@expo/vector-icons/Feather';
import { REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, colors, Eyebrow, Screen, typography } from '../components/ui';
import { SampleReveal } from '../components/sample-reveal';

export default function SampleScreen() {
  const close = () => router.canGoBack() ? router.back() : router.replace('/');
  return <Screen bottomSafe>
    <View style={styles.top}><Eyebrow>A sample, just for you</Eyebrow><Pressable accessibilityRole="button" accessibilityLabel="Close sample" hitSlop={8} onPress={close} style={styles.close}><Feather name="x" size={20} color={colors.ink} /></Pressable></View>
    <Text accessibilityRole="header" style={[typography.title, styles.title]}>A moment.{'\n'}Then a memory.</Text>
    <Text style={[typography.body, styles.lede]}>Hold the sample for a glimpse. Let go to hide it.</Text>
    <SampleReveal />
    <View style={styles.rule}><Feather name="clock" size={21} color="#667650" /><View style={styles.ruleCopy}><Text style={styles.ruleTitle}>Up to {REVEAL_BUDGET_MS / 1000} seconds, altogether.</Text><Text style={typography.small}>Every hold uses the same local allowance. Leaving this screen or the app hides the sample.</Text></View></View>
    <View style={styles.notice}><Text style={styles.noticeTitle}>A local interaction demo.</Text><Text style={styles.noticeText}>This public sample illustration is bundled with the app. This sample does not use private sharing, server allowances or capture protection. Revealed content may be saved or captured.</Text></View>
    <Button label="Back to exploring" icon="arrow-left" onPress={close} />
  </Screen>;
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  close: { width: 44, height: 44, borderRadius: 23, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  title: { marginTop: 18, marginBottom: 14 },
  lede: { marginBottom: 24, maxWidth: 280 },
  rule: { flexDirection: 'row', gap: 13, marginVertical: 24 },
  ruleCopy: { flex: 1, gap: 6 },
  ruleTitle: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  notice: { padding: 18, borderRadius: 16, backgroundColor: colors.soft, gap: 7, marginBottom: 22 },
  noticeTitle: { color: '#526448', fontSize: 12, fontWeight: '600' },
  noticeText: { color: '#68765B', fontSize: 11, lineHeight: 18 },
});
