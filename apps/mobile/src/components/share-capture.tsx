import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apiRequest, getSharingClient, newIdempotencyKey, SharingError } from '../lib/sharing-client';
import { colors, Eyes } from './ui';

type Props = {
  visible: boolean;
  capture: { uri: string; kind: 'photo' | 'video' } | null;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
};
type Stage = 'connecting' | 'unavailable' | 'auth' | 'username' | 'ready';
type Draft = { uri: string; uploadKey: string; linkKey: string; postId?: string; link?: string; userId?: string };

export function ShareCapture({ visible, capture, onClose, onBusyChange }: Props) {
  const [stage, setStage] = useState<Stage>('connecting');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingUp, setSigningUp] = useState(false);
  const [username, setUsername] = useState('');
  const [recipient, setRecipient] = useState('');
  const [hasLink, setHasLink] = useState(false);
  const [lastRecipient, setLastRecipient] = useState('');
  const draft = useRef<Draft | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const callback = useRef(onBusyChange);
  callback.current = onBusyChange;
  const captureUri = capture?.uri;

  useEffect(() => () => { generation.current++; callback.current?.(false); }, []);
  useEffect(() => {
    if (draft.current?.uri !== captureUri) {
      generation.current++;
      busyRef.current = false; setBusy(false); callback.current?.(false);
      draft.current = captureUri ? { uri: captureUri, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() } : null;
      setHasLink(false); setLastRecipient(''); setNotice(''); setError(''); setRecipient('');
    }
  }, [captureUri]);

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const epoch = generation.current;
    const current = () => epoch === generation.current;
    setBusy(true); setError(''); setNotice(''); callback.current?.(true);
    try { await action(current); }
    catch (failure) {
      if (current()) {
        setError(failure instanceof SharingError ? failure.message : 'This action did not finish. Please try again.');
        if (failure instanceof SharingError && failure.code === 'unauthorized') setStage('auth');
      }
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); setProgress(''); callback.current?.(false); }
    }
  }

  async function loadAccount(current: () => boolean) {
    const client = await getSharingClient();
    const { data, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw new SharingError('Your sign-in could not be restored. Please try again.');
    if (!current()) return;
    if (!data.session) { setStage('auth'); return; }
    if (draft.current && draft.current.userId !== data.session.user.id) {
      draft.current = { uri: draft.current.uri, userId: data.session.user.id, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() };
      setHasLink(false);
    }
    const profile = await apiRequest<{ username: string | null }>('/api/profile');
    if (current()) { setUsername(profile.username ?? ''); setStage(profile.username ? 'ready' : 'username'); }
  }

  function connect() {
    setStage('connecting');
    void run(async current => {
      try { await loadAccount(current); }
      catch (failure) { if (current()) setStage('unavailable'); throw failure; }
    });
  }

  useEffect(() => {
    if (visible) connect();
    // A capture's retry keys and uploaded post survive closing/reopening this modal.
  }, [visible, captureUri]);

  function authenticate() {
    void run(async current => {
      const client = await getSharingClient();
      const credentials = { email: email.trim(), password };
      const result = signingUp ? await client.auth.signUp(credentials) : await client.auth.signInWithPassword(credentials);
      if (result.error) {
        const code = result.error.code;
        if (code === 'email_address_not_authorized') throw new SharingError('Signup email delivery is not ready for this address yet. Please contact the app owner.');
        throw new SharingError(code === 'email_not_confirmed' ? 'Confirm your email first, then sign in here.' : code === 'invalid_credentials' ? 'Email or password is incorrect. Please try again.' : code === 'over_email_send_rate_limit' ? 'Please wait before requesting another email.' : 'Sign-in did not finish. Check your details and try again.');
      }
      if (!current()) return;
      setPassword('');
      if (!result.data.session) {
        setSigningUp(false);
        setNotice('Check your email to confirm your account, then return here and sign in.');
        return;
      }
      await loadAccount(current);
    });
  }

  function saveUsername() {
    void run(async current => {
      const name = username.trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new SharingError('Use 3–24 letters, numbers or underscores.');
      await apiRequest('/api/profile', { method: 'POST', body: { username: name } });
      if (current()) { setUsername(name); setStage('ready'); }
    });
  }

  async function upload(current: () => boolean) {
    const currentDraft = draft.current;
    if (!currentDraft || !capture) throw new SharingError('Please close sharing and try again.');
    if (currentDraft.postId) return currentDraft;
    setProgress('Uploading and preparing your capture…');
    const form = new FormData();
    form.append('kind', capture.kind);
    form.append('file', { uri: capture.uri, name: capture.kind === 'photo' ? 'capture.jpg' : 'capture.mp4', type: capture.kind === 'photo' ? 'image/jpeg' : 'video/mp4' } as unknown as Blob);
    const post = await apiRequest<{ postId: string; status: string }>('/api/posts', {
      method: 'POST', body: form, headers: { 'Idempotency-Key': currentDraft.uploadKey },
    });
    if (!current()) throw new SharingError('This capture changed. Please try again.');
    if (post.status !== 'ready' || !post.postId) throw new SharingError('This capture is not ready to share. Please try again.');
    currentDraft.postId = post.postId;
    return currentDraft;
  }

  function createLink() {
    void run(async current => {
      const currentDraft = await upload(current);
      if (!currentDraft.link) {
        setProgress('Creating your private link…');
        const link = await apiRequest<{ url: string; expiresAt: string }>(`/api/posts/${encodeURIComponent(currentDraft.postId!)}/link`, {
          method: 'POST', headers: { 'Idempotency-Key': currentDraft.linkKey }, body: {},
        });
        if (!current()) return;
        const parsed = new URL(link.url);
        if (!/^https?:$/.test(parsed.protocol) || !parsed.hash) throw new SharingError('The link could not be created. Please try again.');
        currentDraft.link = link.url;
        setHasLink(true);
      }
      setProgress('Opening share options…');
      const result = await Share.share({ message: currentDraft.link!, title: 'A moment for you on Peekalo' });
      if (current()) setNotice(result.action === Share.dismissedAction ? 'Your link is ready. Tap Share link to open the options again.' : 'Link ready. Only the first viewer to reveal it can claim it.');
    });
  }

  function sendToRecipient() {
    void run(async current => {
      const name = recipient.trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new SharingError('Enter a valid Peekalo username.');
      const currentDraft = await upload(current);
      setProgress('Sharing with your recipient…');
      const result = await apiRequest<{ requestState: 'pending' | 'accepted' }>(`/api/posts/${encodeURIComponent(currentDraft.postId!)}/recipients`, { method: 'POST', body: { username: name } });
      if (result.requestState !== 'pending' && result.requestState !== 'accepted') throw new SharingError('This share was not confirmed. Please try again.');
      if (current()) setLastRecipient(name);
      if (current()) setNotice(result.requestState === 'pending' ? `Request sent to @${name}. They must accept before they can reveal it.` : `Shared with @${name}. It is available in their Peekalo Inbox.`);
    });
  }

  function revokeLink() {
    void run(async current => {
      const value = draft.current;
      if (!value?.postId) return;
      await apiRequest(`/api/posts/${value.postId}/link`, { method: 'DELETE' });
      if (current()) {
        delete value.link;
        value.linkKey = newIdempotencyKey();
        setHasLink(false);
        setNotice('Link revoked. New viewing requests are blocked.');
      }
    });
  }
  function revokeRecipient() {
    void run(async current => {
      const value = draft.current;
      if (!value?.postId || !lastRecipient) return;
      await apiRequest(`/api/posts/${value.postId}/recipients`, { method: 'DELETE', body: { username: lastRecipient } });
      if (current()) { setLastRecipient(''); setNotice('Recipient access revoked.'); }
    });
  }

  function signOut() {
    void run(async current => {
      const client = await getSharingClient();
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      if (signOutError) throw new SharingError('Sign-out did not finish. Please try again.');
      if (current()) { setUsername(''); setPassword(''); setStage('auth'); setNotice('Signed out on this device.'); }
    });
  }

  const close = () => { if (!busyRef.current) { setPassword(''); onClose(); } };
  return <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="fullScreen">
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}><View style={styles.brand}><Eyes /><Text style={styles.brandText}>peekalo.</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close sharing" disabled={busy} onPress={close} style={styles.close}><Feather name="x" size={24} color={colors.ink} /></Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>{capture ? 'A MOMENT FOR SOMEONE' : 'YOUR PEEKALO ACCOUNT'}</Text>
          <Text style={styles.title}>{capture ? `Share your ${capture.kind}.` : 'A little closer.'}</Text>
          <Text style={styles.body}>{capture ? 'Your capture stays private. Choose a Peekalo recipient or create a single-use link.' : 'Sign in to receive and share moments on Peekalo.'}</Text>
          {stage === 'connecting' && <View style={styles.loading}><ActivityIndicator color={colors.ink} /><Text style={styles.body}>Connecting to Peekalo…</Text></View>}
          {stage === 'unavailable' && <Action label="Try connection again" onPress={connect} disabled={busy} />}
          {stage === 'auth' && <View style={styles.section}>
            <Text style={styles.heading}>{signingUp ? 'Create your account' : capture ? 'Sign in to share' : 'Sign in to Peekalo'}</Text>
            <TextInput style={styles.input} accessibilityLabel="Email" placeholder="Email" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
            <TextInput style={styles.input} accessibilityLabel="Password" placeholder={signingUp ? 'Password (at least 8 characters)' : 'Password'} placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete={signingUp ? 'new-password' : 'current-password'} editable={!busy} />
            <Action label={signingUp ? 'Create account' : 'Sign in'} onPress={authenticate} disabled={busy || !email.trim() || password.length < (signingUp ? 8 : 1)} />
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSigningUp(!signingUp); setError(''); setNotice(''); }} style={styles.textButton}><Text style={styles.textButtonLabel}>{signingUp ? 'Already have an account? Sign in' : 'New here? Create an account'}</Text></Pressable>
          </View>}
          {stage === 'username' && <View style={styles.section}>
            <Text style={styles.heading}>Choose your username</Text><Text style={styles.body}>People can send their moments to this name.</Text>
            <TextInput style={styles.input} accessibilityLabel="Your username" placeholder="your_username" placeholderTextColor={colors.muted} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} maxLength={24} editable={!busy} />
            <Action label="Save username" onPress={saveUsername} disabled={busy || !username.trim()} />
          </View>}
          {stage === 'ready' && <View style={styles.section}>
            <Text style={styles.signedIn}>Signed in as @{username}</Text>
            {capture ? <><View style={styles.option}><Feather name="link" size={25} color={colors.ink} /><Text style={styles.heading}>Create a private link</Text>
              <Text style={styles.body}>The first person to deliberately reveal claims the link. They get ten seconds total. Anyone who receives the link can be that first viewer. Browsers can save revealed media.</Text>
              <Action label={hasLink ? 'Share link' : 'Create & share link'} onPress={createLink} disabled={busy} />
              {hasLink && <Action secondary label="Revoke link" onPress={revokeLink} disabled={busy} />}
            </View>
            <View style={styles.option}><Feather name="send" size={25} color={colors.ink} /><Text style={styles.heading}>Send on Peekalo</Text>
              <Text style={styles.body}>A new recipient must accept your request before viewing.</Text>
              <TextInput style={styles.input} accessibilityLabel="Recipient username" placeholder="@username" placeholderTextColor={colors.muted} value={recipient} onChangeText={setRecipient} autoCapitalize="none" autoCorrect={false} maxLength={25} editable={!busy} />
              {lastRecipient && <Action secondary label={`Revoke @${lastRecipient} access`} onPress={revokeRecipient} disabled={busy} />}
              <Action label="Send to recipient" onPress={sendToRecipient} disabled={busy || !recipient.trim()} secondary />
            </View></> : <View style={styles.option}><Text style={styles.heading}>You’re ready, @{username}.</Text><Text style={styles.body}>Return to Inbox to see moments shared with you.</Text><Action label="Back to Inbox" onPress={close} disabled={busy} /><Action label="Sign out on this device" onPress={signOut} disabled={busy} secondary /></View>}
          </View>}
          {busy && stage !== 'connecting' && <View style={styles.loading}><ActivityIndicator color={colors.ink} /><Text accessibilityLiveRegion="polite" style={styles.body}>{progress || 'Please wait…'}</Text></View>}
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function Action({ label, onPress, disabled, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, secondary && styles.secondary, (pressed || disabled) && styles.dim]}><Text style={styles.actionText}>{label}</Text><Feather name="arrow-up-right" size={19} color={colors.ink} /></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper }, flex: { flex: 1 },
  header: { paddingHorizontal: 24, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line },
  brand: { flexDirection: 'row', gap: 8, alignItems: 'center' }, brandText: { color: colors.ink, fontSize: 28, fontWeight: '800', letterSpacing: -1.7 }, close: { padding: 12 },
  content: { padding: 24, paddingBottom: 48, width: '100%', maxWidth: 540, alignSelf: 'center', gap: 16 },
  eyebrow: { color: '#667650', fontSize: 10, letterSpacing: 1.5, fontWeight: '600' }, title: { color: colors.ink, fontSize: 39, lineHeight: 43, letterSpacing: -1.8, fontWeight: '500' },
  body: { color: colors.muted, fontSize: 14, lineHeight: 22, flexShrink: 1 }, heading: { color: colors.ink, fontSize: 20, fontWeight: '600', letterSpacing: -0.6 },
  section: { gap: 14, marginTop: 6 }, signedIn: { color: colors.muted, fontSize: 12 }, option: { borderWidth: 1, borderColor: colors.line, borderRadius: 22, padding: 20, gap: 14 },
  input: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 14, minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, color: colors.ink, fontSize: 16 },
  action: { minHeight: 54, borderRadius: 28, backgroundColor: colors.lime, paddingHorizontal: 22, paddingVertical: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  actionText: { color: colors.ink, fontSize: 14, fontWeight: '600', flexShrink: 1 }, secondary: { backgroundColor: colors.soft }, dim: { opacity: 0.5 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, textButton: { paddingVertical: 10 }, textButtonLabel: { textAlign: 'center', color: colors.ink, fontSize: 13 },
  error: { color: '#A2382D', lineHeight: 22, fontSize: 14, backgroundColor: '#F8EBE7', padding: 16, borderRadius: 14 }, notice: { color: colors.ink, lineHeight: 22, fontSize: 14, backgroundColor: colors.soft, padding: 16, borderRadius: 14 },
});
