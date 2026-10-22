import Feather from '@expo/vector-icons/Feather';
import { MAX_VIDEO_DURATION_MS, PROVISIONAL_ACTIVE_MEDIA_LIMIT, REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ShareCapture } from '../../components/share-capture';
import { Button, colors, Eyebrow, Eyes, MysteryArt, Screen, tokens, typography } from '../../components/ui';
import { apiRequest, getSharingClient } from '../../lib/sharing-client';

type Account =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'signed_out' }
  | { state: 'signed_in'; email: string | null; username: string | null };

export default function ProfileScreen() {
  const [account, setAccount] = useState<Account>({ state: 'loading' });
  const [panelOpen, setPanelOpen] = useState(false);

  const refresh = useCallback(async () => {
    setAccount(previous => previous.state === 'signed_in' ? previous : { state: 'loading' });
    try {
      const client = await getSharingClient();
      const { data } = await client.auth.getSession();
      if (!data.session) { setAccount({ state: 'signed_out' }); return; }
      const profile = await apiRequest<{ username: string | null }>('/api/profile');
      setAccount({ state: 'signed_in', email: data.session.user.email ?? null, username: profile.username });
    } catch { setAccount({ state: 'unavailable' }); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const signedIn = account.state === 'signed_in';
  const username = signedIn ? account.username : null;
  const title = username ? `@${username}` : signedIn ? 'Almost there.' : 'Hello, you.';
  const subtitle = account.state === 'loading' ? 'Checking your account…'
    : account.state === 'unavailable' ? 'Cannot reach Peekalo right now.'
    : signedIn ? (username ? account.email ?? 'Signed in' : 'Choose a username so friends can send you moments.')
    : 'Sign in to share and receive moments.';

  return <Screen>
    <Eyebrow>Your little corner</Eyebrow>
    <View style={styles.identity}>
      <View style={styles.avatar}>{username ? <Text style={styles.initial}>{username[0].toUpperCase()}</Text> : <Eyes large />}</View>
      <View style={styles.nameBlock}>
        <Text accessibilityRole="header" style={styles.name} numberOfLines={1} adjustsFontSizeToFit>{title}</Text>
        <Text style={typography.small} numberOfLines={2}>{subtitle}</Text>
      </View>
      {account.state === 'loading' && <ActivityIndicator color={colors.text} accessibilityLabel="Loading your account" />}
    </View>
    <View style={styles.actions}>
      {account.state === 'unavailable'
        ? <Button secondary label="Try again" icon="refresh-cw" onPress={() => { void refresh(); }} />
        : account.state !== 'loading' && <Button
          secondary={signedIn && !!username}
          label={!signedIn ? 'Sign in or create account' : username ? 'Your account' : 'Choose username'}
          icon="user"
          onPress={() => setPanelOpen(true)} />}
    </View>

    <View style={styles.sectionHeader}><Text style={typography.section}>Your moments</Text><View style={styles.hiddenLabel}><Feather name="eye-off" size={13} color={colors.muted} /><Text style={styles.hiddenText}>Hidden by default</Text></View></View>
    <View style={styles.empty}>
      <Text style={[typography.body, styles.center]}>{signedIn ? 'Capture a photo or video, then tap Share moment to send it.' : 'Your shared moments will live here once you sign in.'}</Text>
      <Button label="Open camera" icon="camera" onPress={() => router.navigate('/')} />
    </View>

    <View style={styles.sectionHeader}><Text style={typography.section}>Try a sample</Text><Text style={styles.demoTag}>DEMO</Text></View>
    <MysteryArt compact />
    <View style={styles.sampleButton}><Button secondary label="Explore this sample" onPress={() => router.push('/sample')} /></View>
    <View style={styles.limits}>
      <View style={styles.rule}><Text style={styles.number}>{PROVISIONAL_ACTIVE_MEDIA_LIMIT}</Text><Text style={styles.ruleLabel}>active moments*</Text></View>
      <View style={styles.rule}><Text style={styles.number}>{MAX_VIDEO_DURATION_MS / 1000}s</Text><Text style={styles.ruleLabel}>maximum video</Text></View>
      <View style={styles.rule}><Text style={styles.number}>{REVEAL_BUDGET_MS / 1000}s</Text><Text style={styles.ruleLabel}>total reveal</Text></View>
    </View>
    <Text style={styles.note}>*Three active moments is a proposed starting limit. Profile editing and text chat are coming later.</Text>
    <ShareCapture visible={panelOpen} capture={null} onClose={() => { setPanelOpen(false); void refresh(); }} />
  </Screen>;
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 24 },
  avatar: { width: 85, height: 85, borderRadius: 44, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 38, fontFamily: tokens.font.display, color: colors.accent },
  nameBlock: { flex: 1, gap: 5 },
  name: { fontSize: tokens.type.title, letterSpacing: -1.4, fontFamily: tokens.font.display, color: colors.text },
  actions: { marginTop: 22, marginBottom: 30 },
  demoTag: { fontSize: 9, letterSpacing: 1, color: colors.accent },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 17 },
  hiddenLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  hiddenText: { color: colors.muted, fontSize: 10 },
  empty: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 22, padding: 20, gap: 16, marginBottom: 30 },
  center: { textAlign: 'center' },
  sampleButton: { marginTop: 14 },
  limits: { marginTop: 26, flexDirection: 'row', paddingVertical: 22, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
  rule: { flex: 1, gap: 6, alignItems: 'center' },
  number: { fontSize: 25, color: colors.text, letterSpacing: -1, fontFamily: tokens.font.display },
  ruleLabel: { fontSize: 9, color: colors.muted, textAlign: 'center' },
  note: { marginTop: 16, fontSize: 10, lineHeight: 17, color: colors.muted },
});
