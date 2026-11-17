import * as Crypto from 'expo-crypto';
import { isDevice } from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { allowSimulatorFixtures } from '../lib/simulator-fixtures';
import { performAccountAuth, SharingError } from '../lib/sharing-client';
import { BrandLogo } from './brand';
import { ShareCapture } from './share-capture';
import { VideoReview } from './video-review';
import { colors, tokens } from './ui';

type Draft = { uri: string; kind: 'photo' | 'video' };
const permitted = () => allowSimulatorFixtures(__DEV__, Platform.OS, isDevice,
  process.env.EXPO_PUBLIC_PEEKALO_LOCAL_TESTING, process.env.EXPO_PUBLIC_PEEKALO_SIMULATOR_FIXTURES);

export function SimulatorSharing() {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sharing, setSharing] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Generated test media. Camera capture is deferred.');
  const file = useRef<File | null>(null);
  const epoch = useRef(0);
  const shareOpen = useRef(false);
  const clear = useCallback(() => {
    epoch.current++;
    setDraft(null);
    if (file.current?.exists) file.current.delete();
    file.current = null;
  }, []);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { setFocused(false); if (!shareOpen.current) clear(); };
  }, [clear]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setActive(state === 'active');
      if (state !== 'active' && !shareOpen.current) clear();
    });
    return () => { subscription.remove(); epoch.current++; if (file.current?.exists) file.current.delete(); };
  }, [clear]);

  async function load(kind: Draft['kind']) {
    if (!permitted() || busy) return;
    clear(); const revision = epoch.current;
    setBusy(true);
    const target = new File(Paths.cache, `peekalo-simulator-${Crypto.randomUUID()}.${kind === 'photo' ? 'jpg' : 'mp4'}`);
    try {
      await File.downloadFileAsync(`http://127.0.0.1:4184/${kind}`, target);
      if (revision !== epoch.current || AppState.currentState !== 'active' || !permitted()) { if (target.exists) target.delete(); return; }
      file.current = target;
      setDraft({ uri: target.uri, kind });
      setNotice(`SIMULATOR TEST ${kind.toUpperCase()} · Generated input, normal private upload and sharing.`);
    } catch { if (target.exists) target.delete(); setNotice('Start pnpm simulator:sharing first. The local generated fixture is unavailable.'); }
    finally { setBusy(false); }
  }
  async function signIn(role: 'sender' | 'recipient') {
    if (!permitted() || busy || draft) return;
    setBusy(true);
    let step = 'Fixture lookup';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://127.0.0.1:4184/account/${role}`, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const account = await response.json() as { email: string; password: string; username: string };
      if (!/^sim_[a-f0-9]{8}_(sender|recipient)@example\.invalid$/.test(account.email) || !/^sim_[a-f0-9]{8}_[sr]$/.test(account.username)) throw new Error();
      step = 'Native account sign-in';
      const result = await performAccountAuth(client => client.auth.signInWithPassword({ email: account.email, password: account.password }));
      if (result.error) throw new Error();
      setNotice(`Signed in as ${role} @${account.username}. Use Profile to accept the local fixture terms. Recipient details are shown by the fixture server.`);
    } catch (error) { setNotice(error instanceof SharingError ? error.message : `${step} failed. Check the local fixture server and backend.`); }
    finally { clearTimeout(timeout); setBusy(false); }
  }
  if (!permitted()) return null;
  return <View style={[styles.screen, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 88 }]}>
    <BrandLogo />
    <Text style={styles.label}>SIMULATOR · LOCAL TEST INPUT</Text>
    <Text style={styles.body}>{notice}</Text>
    {draft ? <>
      <View style={styles.media}>
        {active && focused && !sharing && (draft.kind === 'photo' ? <Image source={{ uri: draft.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel="Generated simulator test photo" /> : <VideoReview uri={draft.uri} />)}
      </View>
      <Button label="Share this test moment" disabled={busy} onPress={() => { shareOpen.current = true; setSharing(true); }} />
      <Button label="Discard test input" disabled={busy} onPress={clear} />
      <ShareCapture visible={sharing} capture={draft} onClose={() => { shareOpen.current = false; setSharing(false); }} />
    </> : <>
      <Text style={styles.title}>Try sending a moment.</Text>
      <Button label="Use fixture sender" disabled={busy} onPress={() => { void signIn('sender'); }} />
      <Button label="Use fixture recipient" disabled={busy} onPress={() => { void signIn('recipient'); }} />
      <Button label="Review generated photo" disabled={busy} onPress={() => { void load('photo'); }} />
      <Button label="Review generated 6-second video" disabled={busy} onPress={() => { void load('video'); }} />
      <Text style={styles.body}>Normal Auth, upload, private processing, independent review, grants and viewing budgets. No gallery access. No camera or physical-device privacy evidence.</Text>
    </>}
  </View>;
}
function Button({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.5 }]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: tokens.space.lg, gap: tokens.space.sm },
  label: { color: colors.accent, fontSize: tokens.type.caption, marginTop: tokens.space.sm },
  body: { color: colors.muted, fontSize: tokens.type.caption, lineHeight: 19 },
  title: { color: colors.text, fontFamily: tokens.font.display, fontSize: tokens.type.section, marginVertical: tokens.space.lg },
  button: { padding: tokens.space.md, borderRadius: tokens.radius.pill, backgroundColor: colors.elevated, borderColor: colors.border, borderWidth: 1, alignItems: 'center' },
  buttonText: { color: colors.text, fontSize: tokens.type.body },
  media: { flex: 1, alignSelf: 'center', aspectRatio: 9 / 16, overflow: 'hidden', backgroundColor: colors.surface },
});
