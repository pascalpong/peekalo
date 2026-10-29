import AntDesign from '@expo/vector-icons/AntDesign';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { apiRequest, getAuthProviders, getSharingClient, newIdempotencyKey, performAccountAuth, resolveApiUrl, SharingError, signInWithGoogle, signInWithApple, type AuthProviders } from '../lib/sharing-client';
import { AppleSignIn } from './apple-sign-in';
import { requestEmailConfirmation, subscribeEmailConfirmation } from '../lib/auth-confirmation';
import { colors, tokens } from './ui';
import { BrandLogo } from './brand';
import { requestPasswordRecovery, subscribePasswordRecovery } from '../lib/auth-recovery';

type Props = {
  visible: boolean;
  capture: { uri: string; kind: 'photo' | 'video' } | null;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
};
type Stage = 'connecting' | 'unavailable' | 'auth' | 'username' | 'ready';
type Draft = { uri: string; uploadKey: string; linkKey: string; postId?: string; postStatus?: string; link?: string; linkExpiresAt?: number; userId?: string };

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
  const lastRecipientAccountId = useRef<string | undefined>(undefined);
  const [uploaded, setUploaded] = useState(false);
  const [retry, setRetry] = useState<{ action: 'link' | 'recipient' | 'revokeLink' | 'revokeRecipient'; username?: string } | null>(null);
  const accountId = useRef<string | null | undefined>(undefined);
  const [providers, setProviders] = useState<AuthProviders>({ google: null, email: null });
  const operation = useRef<AbortController | null>(null);
  const draft = useRef<Draft | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const committingRef = useRef(false);
  const [committing, setCommitting] = useState(false);
  function commitChanged(value: boolean) { committingRef.current = value; if (mountedRef.current) setCommitting(value); }
  const generation = useRef(0);
  const callback = useRef(onBusyChange);
  callback.current = onBusyChange;
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const captureUri = capture?.uri;

  function cancelOperation() {
    generation.current++;
    operation.current?.abort();
    operation.current = null;
    busyRef.current = false;
    callback.current?.(false);
  }
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; cancelOperation(); }; }, []);
  useEffect(() => {
    if (!visible) return;
    const dismiss = () => {
      cancelOperation(); setBusy(false); setPassword('');
      // A native Modal otherwise covers the new reset route on a warm link.
      closeCallback.current();
    };
    const recovery = subscribePasswordRecovery(dismiss);
    const confirmation = subscribeEmailConfirmation(dismiss);
    return () => { recovery(); confirmation(); };
  }, [visible]);
  useEffect(() => {
    if (draft.current?.uri !== captureUri) {
      cancelOperation(); setBusy(false);
      draft.current = captureUri ? { uri: captureUri, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() } : null;
      setHasLink(false); setLastRecipient(''); lastRecipientAccountId.current = undefined; setNotice(''); setError(''); setRecipient(''); setUploaded(false); setRetry(null);
    }
  }, [captureUri]);

  async function run(action: (current: () => boolean, signal: AbortSignal) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    operation.current = controller;
    const epoch = generation.current;
    const current = () => epoch === generation.current && !controller.signal.aborted;
    setBusy(true); setError(''); setNotice(''); callback.current?.(true);
    try { await action(current, controller.signal); }
    catch (failure) {
      if (current()) {
        setError(failure instanceof SharingError ? failure.message : 'This action did not finish. Please try again.');
        if (failure instanceof SharingError && failure.code === 'unauthorized') setStage('auth');
      }
    } finally {
      if (current()) { operation.current = null; busyRef.current = false; setBusy(false); setProgress(''); callback.current?.(false); }
    }
  }

  async function loadAccount(current: () => boolean, signal: AbortSignal) {
    const client = await getSharingClient(signal);
    const { data, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw new SharingError('Your sign-in could not be restored. Please try again.');
    if (!current()) return;
    accountId.current = data.session?.user.id ?? null;
    if (!data.session) {
      const available = await getAuthProviders(signal);
      if (current()) { setProviders(available); setStage('auth'); }
      return;
    }
    if (draft.current && draft.current.userId !== data.session.user.id) {
      draft.current = { uri: draft.current.uri, userId: data.session.user.id, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() };
      setHasLink(false); setLastRecipient(''); lastRecipientAccountId.current = undefined; setRecipient(''); setUploaded(false); setRetry(null);
    }
    const profile = await apiRequest<{ username: string | null; reviewState?: string }>('/api/profile', { signal, expectedAccountId: data.session.user.id });
    if (current()) { setUsername(profile.username ?? ''); setStage(profile.username ? 'ready' : 'username'); if (profile.reviewState === 'pending') setNotice('Your username is waiting for safety approval. It stays out of public profiles and recipient lookup until approved.'); else if (profile.reviewState === 'rejected') setNotice('Your username was not approved. Choose Change username and submit a different name for safety review.'); }
  }

  function connect() {
    setStage('connecting');
    void run(async (current, signal) => {
      try { await loadAccount(current, signal); }
      catch (failure) { if (current()) setStage('unavailable'); throw failure; }
    });
  }

  useEffect(() => {
    if (visible) connect();
    else { cancelOperation(); setBusy(false); setProgress(''); setPassword(''); }
    // A capture's retry keys and uploaded post survive closing/reopening this modal.
  }, [visible, captureUri]);

  useEffect(() => {
    if (!visible) return;
    const setup = new AbortController();
    let unsubscribe: (() => void) | undefined;
    void getSharingClient(setup.signal).then(client => {
      if (setup.signal.aborted) return;
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (setup.signal.aborted) return;
        const next = session?.user.id ?? null;
        const changed = accountId.current !== undefined && next !== accountId.current;
        accountId.current = next;
        // Own login commits are serialized by sharing-client and loadAccount.
        if (!changed || committingRef.current) return;
        cancelOperation(); setBusy(false); setUploaded(false); setRetry(null);
        draft.current = captureUri ? { uri: captureUri, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() } : null;
        setHasLink(false); setLastRecipient(''); lastRecipientAccountId.current = undefined; setRecipient(''); setUsername('');
        void Promise.resolve().then(() => { if (!setup.signal.aborted) connect(); });
      });
      unsubscribe = () => data.subscription.unsubscribe();
    }).catch(() => undefined);
    return () => { setup.abort(); unsubscribe?.(); };
  }, [visible, captureUri]);

  function authenticate() {
    void run(async (current, signal) => {
      const credentials = { email: email.trim(), password };
      if (signingUp) {
        const message = await requestEmailConfirmation(credentials.email, credentials.password, signal);
        if (current()) { setPassword(''); setSigningUp(false); setNotice(message); }
        return;
      }
      const result = await performAccountAuth(client => client.auth.signInWithPassword(credentials), signal, commitChanged);
      if (!current()) return;
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
      await loadAccount(current, signal);
    });
  }

  function continueWithGoogle() {
    void run(async (current, signal) => {
      const signedIn = await signInWithGoogle(signal, commitChanged);
      if (signedIn && current()) await loadAccount(current, signal);
    });
  }

  function continueWithApple() {
    void run(async (current, signal) => {
      const signedIn = await signInWithApple(signal, commitChanged);
      if (signedIn && current()) await loadAccount(current, signal);
    });
  }
  function resendConfirmation() {
    setPassword('');
    void run(async (current, signal) => {
      const message = await requestEmailConfirmation(email, null, signal);
      if (current()) setNotice(message);
    });
  }

  function forgotPassword() {
    setPassword('');
    void run(async (current, signal) => {
      const message = await requestPasswordRecovery(email, signal);
      if (current()) setNotice(message);
    });
  }

  function saveUsername() {
    void run(async (current, signal) => {
      const name = username.trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new SharingError('Use 3–24 letters, numbers or underscores.');
      const profile = await apiRequest<{ reviewState?: string }>('/api/profile', { method: 'POST', body: { username: name }, signal, expectedAccountId: accountId.current ?? undefined });
      if (current()) { setUsername(name); setStage('ready'); if (profile?.reviewState === 'pending') setNotice('Your username is saved and waiting for safety approval. It stays out of public profiles and recipient lookup until approved.'); else if (profile?.reviewState === 'rejected') setNotice('This username was not approved. Choose Change username and submit a different name for safety review.'); }
    });
  }

  async function upload(current: () => boolean, signal: AbortSignal) {
    const currentDraft = draft.current;
    if (!currentDraft || !capture) throw new SharingError('Please close sharing and try again.');
    if (currentDraft.postId) {
      if (currentDraft.postStatus === 'ready') return currentDraft;
      setProgress('Checking safety review…');
      const inventory = await apiRequest<{ items: { postId: string; status: string }[] }>('/api/posts', { signal, expectedAccountId: currentDraft.userId });
      if (!current()) throw new SharingError('This capture changed. Please try again.');
      const status = inventory.items.find(item => item.postId === currentDraft.postId)?.status;
      if (status === 'ready') { currentDraft.postStatus = 'ready'; return currentDraft; }
      if (status === 'moderation_pending') throw new SharingError('Your moment is waiting for safety review. Check again here later, or manage it in Profile. No recipient or link has been created.', 'moderation_pending');
      throw new SharingError(status === 'rejected' ? 'This moment was not approved for sharing. You can delete it from Profile.' : status === 'taken_down' ? 'This moment was removed by the safety team.' : 'This moment is unavailable. Check its status in Profile.', status ?? 'unavailable');
    }
    setProgress('Uploading and preparing your capture…');
    const form = new FormData();
    form.append('kind', capture.kind);
    form.append('file', { uri: capture.uri, name: capture.kind === 'photo' ? 'capture.jpg' : 'capture.mp4', type: capture.kind === 'photo' ? 'image/jpeg' : 'video/mp4' } as unknown as Blob);
    const post = await apiRequest<{ postId: string; status: string }>('/api/posts', {
      method: 'POST', body: form, headers: { 'Idempotency-Key': currentDraft.uploadKey }, signal, expectedAccountId: currentDraft.userId,
    });
    if (!current()) throw new SharingError('This capture changed. Please try again.');
    if (!post.postId) throw new SharingError('This capture is not ready to share. Please try again.');
    currentDraft.postId = post.postId;
    setUploaded(true);
    currentDraft.postStatus = post.status;
    if (post.status === 'moderation_pending') throw new SharingError('Your moment is waiting for safety review. Check again here later, or manage it in Profile. No recipient or link has been created.', 'moderation_pending');
    if (post.status !== 'ready') throw new SharingError('This moment is unavailable. Check its status in Profile.', post.status);
    return currentDraft;
  }

  function createLink() {
    setRetry({ action: 'link' });
    void run(async (current, signal) => {
      const currentDraft = await upload(current, signal);
      if (!current()) return;
      if (currentDraft.link && currentDraft.linkExpiresAt !== undefined && currentDraft.linkExpiresAt <= Date.now()) {
        delete currentDraft.link; delete currentDraft.linkExpiresAt;
        currentDraft.linkKey = newIdempotencyKey(); setHasLink(false);
        throw new SharingError('That link has expired. Tap Create a single-use link again to create a new one.', 'expired');
      }
      {
        setProgress(currentDraft.link ? 'Checking your link…' : 'Creating your private link…');
        const link = await apiRequest<{ url: string; expiresAt: string; state?: string }>(`/api/posts/${encodeURIComponent(currentDraft.postId!)}/link`, {
          method: 'POST', headers: { 'Idempotency-Key': currentDraft.linkKey }, body: {}, signal, expectedAccountId: currentDraft.userId,
        });
        if (!current()) return;
        const parsed = new URL(link.url);
        if (parsed.origin !== new URL(resolveApiUrl('/')).origin || parsed.pathname !== '/s/view' || parsed.search || !/^#[A-Za-z0-9_-]{43}$/.test(parsed.hash)) throw new SharingError('The link could not be created. Please try again.');
        const expires = Date.parse(link.expiresAt);
        if (!Number.isFinite(expires)) throw new SharingError('The link could not be confirmed. Please try again.');
        if (link.state === 'revoked') {
          delete currentDraft.link; delete currentDraft.linkExpiresAt;
          currentDraft.linkKey = newIdempotencyKey(); setHasLink(false);
          throw new SharingError('That link was revoked. Tap Create a single-use link again to create a new one.');
        }
        if (expires <= Date.now() || link.state === 'expired') {
          delete currentDraft.link; delete currentDraft.linkExpiresAt; setHasLink(false);
          currentDraft.linkKey = newIdempotencyKey();
          throw new SharingError('That link has expired. Tap Create a single-use link again to create a new one.', 'expired');
        }
        currentDraft.link = link.url;
        currentDraft.linkExpiresAt = expires;
        setHasLink(true);
      }
      if (!current()) return;
      setProgress('Opening share options…');
      const result = await Share.share({ message: currentDraft.link!, title: 'A moment for you on Peekalo' });
      if (current()) setNotice(result.action === Share.dismissedAction ? 'Your link is ready. Tap Share link to open the options again.' : 'Link ready. Only the first viewer to reveal it can claim it.');
    });
  }

  function sendToRecipient(retryName?: string) {
    const requested = retryName ?? recipient;
    setRetry({ action: 'recipient', username: requested });
    void run(async (current, signal) => {
      const name = requested.trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new SharingError('Enter a valid Peekalo username.');
      const currentDraft = await upload(current, signal);
      if (!current()) return;
      setProgress('Sharing with your recipient…');
      const result = await apiRequest<{ requestState: 'pending' | 'accepted'; accountId?: string }>(`/api/posts/${encodeURIComponent(currentDraft.postId!)}/recipients`, { method: 'POST', body: { username: name }, signal, expectedAccountId: currentDraft.userId });
      if (result.requestState !== 'pending' && result.requestState !== 'accepted') throw new SharingError('This share was not confirmed. Please try again.');
      if (current()) { setLastRecipient(name); lastRecipientAccountId.current = result.accountId; }
      if (current()) setNotice(result.requestState === 'pending' ? `Request sent to @${name}. They must accept before they can reveal it.` : `Shared with @${name}. It is available in their Peekalo Inbox.`);
    });
  }

  function revokeLink() {
    setRetry({ action: 'revokeLink' });
    void run(async (current, signal) => {
      const value = draft.current;
      if (!value?.postId) return;
      await apiRequest(`/api/posts/${value.postId}/link`, { method: 'DELETE', signal, expectedAccountId: value.userId });
      if (current()) {
        delete value.link; delete value.linkExpiresAt;
        value.linkKey = newIdempotencyKey();
        setHasLink(false);
        setNotice('Link revoked. New viewing requests are blocked.');
      }
    });
  }
  function revokeRecipient() {
    setRetry({ action: 'revokeRecipient' });
    void run(async (current, signal) => {
      const value = draft.current;
      if (!value?.postId || !lastRecipient) return;
      await apiRequest(`/api/posts/${value.postId}/recipients`, { method: 'DELETE', body: lastRecipientAccountId.current ? { accountId: lastRecipientAccountId.current } : { username: lastRecipient }, signal, expectedAccountId: value.userId });
      if (current()) { setLastRecipient(''); lastRecipientAccountId.current = undefined; setNotice('Recipient access revoked.'); }
    });
  }

  function signOut() {
    void run(async (current, signal) => {
      const { error: signOutError } = await performAccountAuth(client => client.auth.signOut({ scope: 'local' }), signal, commitChanged, { restoreOnCancel: false });
      if (signOutError) throw new SharingError('Sign-out did not finish. Please try again.');
      if (current()) {
        draft.current = captureUri ? { uri: captureUri, uploadKey: newIdempotencyKey(), linkKey: newIdempotencyKey() } : null;
        setHasLink(false); setLastRecipient(''); lastRecipientAccountId.current = undefined; setRecipient(''); setUploaded(false); setRetry(null); setUsername(''); setPassword('');
        setStage('auth'); setNotice('Signed out on this device.');
        const available = await getAuthProviders(signal);
        if (current()) setProviders(available);
      }
    });
  }

  const close = () => { if (committingRef.current) return; cancelOperation(); setBusy(false); setProgress(''); setPassword(''); onClose(); };
  return <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="fullScreen">
    {/* A native modal has its own window; measure its insets independently of the tab screen. */}
    <SafeAreaProvider style={styles.safe}>
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}><BrandLogo />
          <Pressable accessibilityRole="button" accessibilityLabel="Close sharing" disabled={committing} accessibilityState={{ disabled: committing }} onPress={close} style={styles.close}><Feather name="x" size={24} color={colors.text} /></Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {committing && <Text accessibilityRole="alert" style={styles.body}>Finishing your account change. Please keep this screen open for a moment.</Text>}
          <Text style={styles.eyebrow}>{capture ? 'A MOMENT FOR SOMEONE' : 'YOUR PEEKALO ACCOUNT'}</Text>
          <Text style={styles.title}>{capture ? `Share your ${capture.kind}.` : 'A little closer.'}</Text>
          <Text style={styles.body}>{capture ? 'Your capture stays private. Choose a Peekalo recipient or create a single-use link.' : 'Sign in to receive and share moments on Peekalo.'}</Text>
          {stage === 'connecting' && <View style={styles.loading}><ActivityIndicator color={colors.text} /><Text style={styles.body}>Connecting to Peekalo… The free test server may take about a minute to wake up. You can close this and try again.</Text></View>}
          {stage === 'unavailable' && <Action label="Try connection again" onPress={connect} disabled={busy} />}
          {stage === 'auth' && <View style={styles.section}>
            <Text style={styles.heading}>{signingUp ? 'Create your account' : capture ? 'Sign in to share' : 'Sign in to Peekalo'}</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || providers.google === false }} disabled={busy || providers.google === false} onPress={continueWithGoogle} style={({ pressed }) => [styles.google, (pressed || busy || providers.google === false) && styles.dim]}>
              <AntDesign name="google" size={20} color={colors.text} /><Text style={[styles.actionText, styles.secondaryText]}>Continue with Google</Text>
            </Pressable>
            {providers.google === false && <Text style={styles.body}>Google sign-in is not configured on this test backend yet.</Text>}
            {Platform.OS === 'ios' && <AppleSignIn disabled={busy || providers.apple !== true} onPress={continueWithApple} />}
            {Platform.OS === 'ios' && providers.apple !== true && <Text style={styles.body}>Apple sign-in is unavailable until this backend and iOS build are configured.</Text>}
            <Text style={styles.divider}>or use email</Text>
            {providers.email === false && <Text style={styles.body}>Email sign-in is disabled on this backend.</Text>}
            {signingUp && providers.email !== false && <Text style={styles.body}>Confirm your email before signing in. If the email does not arrive, ask the app owner to check email delivery.</Text>}
            <TextInput style={styles.input} accessibilityLabel="Email" placeholder="Email" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
            <TextInput style={styles.input} accessibilityLabel="Password" placeholder={signingUp ? 'Password (at least 8 characters)' : 'Password'} placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete={signingUp ? 'new-password' : 'current-password'} editable={!busy} />
            <Action label={signingUp ? 'Create account' : 'Sign in'} onPress={authenticate} disabled={busy || providers.email === false || !email.trim() || password.length < (signingUp ? 8 : 1)} />
            {!signingUp && <Pressable accessibilityRole="button" disabled={busy || providers.email === false || !email.trim()} onPress={resendConfirmation} style={styles.textButton}><Text style={styles.textButtonLabel}>Resend confirmation email</Text></Pressable>}
            {!signingUp && <Pressable accessibilityRole="button" disabled={busy || providers.email === false} onPress={forgotPassword} style={styles.textButton}><Text style={styles.textButtonLabel}>Forgot password?</Text></Pressable>}
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSigningUp(!signingUp); setError(''); setNotice(''); }} style={styles.textButton}><Text style={styles.textButtonLabel}>{signingUp ? 'Already have an account? Sign in' : 'New here? Create an account'}</Text></Pressable>
          </View>}
          {stage === 'username' && <View style={styles.section}>
            <Text style={styles.heading}>Choose your username</Text><Text style={styles.body}>People can send their moments to this name.</Text>
            <TextInput style={styles.input} accessibilityLabel="Your username" placeholder="your_username" placeholderTextColor={colors.muted} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} maxLength={24} editable={!busy} />
            <Action label="Save username" onPress={saveUsername} disabled={busy || !username.trim()} />
          </View>}
          {stage === 'ready' && <View style={styles.section}>
            <Text style={styles.signedIn}>Signed in as @{username}</Text>
            <Action secondary label="Change username" disabled={busy} onPress={() => { setError(''); setNotice(''); setStage('username'); }} />
            {capture ? <><Text style={styles.body}>Three active moments per account, including moments waiting for safety review. Deleting one in Profile frees a slot. Every capture needs manual approval before recipients or links can be created. Retry here after approval to finish the same sharing action.</Text><View style={styles.option}><Feather name="send" size={25} color={colors.text} /><Text style={styles.heading}>Send on Peekalo</Text>
              <Text style={styles.body}>Your recipient accepts this moment in their Inbox before viewing.</Text>
              <TextInput style={styles.input} accessibilityLabel="Recipient username" placeholder="@username" placeholderTextColor={colors.muted} value={recipient} onChangeText={setRecipient} autoCapitalize="none" autoCorrect={false} maxLength={25} editable={!busy} />
              {lastRecipient && <Action secondary label={`Revoke @${lastRecipient} access`} onPress={revokeRecipient} disabled={busy} />}
              <Action label="Send to recipient" onPress={() => sendToRecipient()} disabled={busy || !recipient.trim()} />
            </View>
            <View style={styles.option}><Feather name="link" size={25} color={colors.text} /><Text style={styles.heading}>Create a single-use link</Text>
              <Text style={styles.body}>The first person to deliberately reveal claims the link. They get ten seconds total. Anyone who receives the link can be that first viewer. Browsers can save revealed media.</Text>
              <Action label={hasLink ? 'Share link' : 'Create a single-use link'} onPress={createLink} disabled={busy} secondary />
              {hasLink && <Action secondary label="Revoke link" onPress={revokeLink} disabled={busy} />}
            </View></> : <View style={styles.option}><Text style={styles.heading}>You’re ready, @{username}.</Text><Text style={styles.body}>Moments shared with you appear in Inbox.</Text><Action label="Done" onPress={close} disabled={busy} /><Action label="Sign out on this device" onPress={signOut} disabled={busy} secondary /></View>}
          </View>}
          {busy && stage !== 'connecting' && <View style={styles.loading}><ActivityIndicator color={colors.text} /><Text accessibilityLiveRegion="polite" style={styles.body}>{progress || 'Please wait…'}</Text></View>}
          {!!error && <><Text accessibilityRole="alert" style={styles.error}>{error}</Text>
            {capture && stage === 'ready' && <Text style={styles.body}>{uploaded ? 'Your moment is saved in Profile. The action above was not confirmed; retrying uses that same moment.' : 'Your capture is kept while this sharing screen is available. Retrying uses the same upload; it does not create another moment.'}</Text>}
            {retry && stage === 'ready' && <Action secondary label="Try the same action again" disabled={busy} onPress={() => {
              if (retry.action === 'link') createLink();
              else if (retry.action === 'recipient') sendToRecipient(retry.username);
              else if (retry.action === 'revokeLink') revokeLink();
              else revokeRecipient();
            }} />}
          </>}
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

function Action({ label, onPress, disabled, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, secondary && styles.secondary, (pressed || disabled) && styles.dim]}><Text style={[styles.actionText, secondary && styles.secondaryText]}>{label}</Text><Feather name="arrow-up-right" size={19} color={secondary ? colors.text : colors.onAccent} /></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 },
  header: { paddingHorizontal: 24, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.border },
  close: { padding: 12 },
  content: { padding: 24, paddingBottom: 48, width: '100%', maxWidth: 540, alignSelf: 'center', gap: 16 },
  eyebrow: { color: colors.accent, fontSize: 10, letterSpacing: 1.5, fontWeight: '600' }, title: { color: colors.text, fontSize: 39, lineHeight: 43, letterSpacing: -1.8, fontFamily: tokens.font.display },
  body: { color: colors.muted, fontSize: 14, lineHeight: 22, flexShrink: 1 }, heading: { color: colors.text, fontSize: 20, fontFamily: tokens.font.display, letterSpacing: -0.6 },
  section: { gap: 14, marginTop: 6 }, signedIn: { color: colors.muted, fontSize: 12 }, option: { borderWidth: 1, borderColor: colors.border, borderRadius: 22, padding: 20, gap: 14 },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, color: colors.text, fontSize: 16 },
  action: { minHeight: 54, borderRadius: 28, backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  secondaryText: { color: colors.text },
  actionText: { color: colors.onAccent, fontSize: 14, fontWeight: '600', flexShrink: 1 }, secondary: { backgroundColor: colors.surface }, dim: { opacity: 0.5 },
  google: { minHeight: 54, borderRadius: 28, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 22, paddingVertical: 15, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 12 },
  divider: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, textButton: { paddingVertical: 10 }, textButtonLabel: { textAlign: 'center', color: colors.text, fontSize: 13 },
  error: { color: colors.danger, lineHeight: 22, fontSize: 14, backgroundColor: colors.dangerSurface, padding: 16, borderRadius: 14 }, notice: { color: colors.text, lineHeight: 22, fontSize: 14, backgroundColor: colors.surface, padding: 16, borderRadius: 14 },
});
