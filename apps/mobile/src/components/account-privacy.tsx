import * as Linking from 'expo-linking';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiRequest, getAuthProviders, performAccountAuth, reauthenticateForDeletion, resolveApiUrl, SharingError, signInWithApple, signInWithGoogle, type AuthProviders } from '../lib/sharing-client';
import { notifyAccountDisabled } from '../lib/account-lifecycle';
import { AppleSignIn } from './apple-sign-in';
import { colors, tokens, typography } from './ui';

export type PrivacyStatus = { termsVersion: string; privacyVersion: string; accepted: boolean; deletionStatus: null | 'pending' | 'complete'; policyReady: boolean };

export function PolicyResources() {
  const [error, setError] = useState('');
  async function open(path: string) {
    try { await Linking.openURL(resolveApiUrl(path)); }
    catch { setError('Cannot open this resource. Check your connection and try again.'); }
  }
  return <View style={styles.group}>
    <Text style={typography.section}>Privacy and account help</Text>
    {([['Privacy notice', '/privacy'], ['Terms of use', '/terms'], ['Support', '/support'], ['Account deletion and retention', '/delete-account']] as const).map(([label, path]) =>
      <Control key={path} label={label} onPress={() => { void open(path); }} />)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

export function TermsAcceptance({ status, accountId, onAccepted }: { status: PrivacyStatus; accountId: string; onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setChecked(false); setBusy(false); setError('');
    return () => { request.current?.abort(); request.current = null; };
  }, [accountId, status.termsVersion, status.privacyVersion]);
  async function accept() {
    if (request.current || !checked || !status.policyReady || status.deletionStatus) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try {
      const result = await apiRequest<{ accepted: boolean }>('/api/account/terms', { method: 'POST', body: { termsVersion: status.termsVersion, privacyVersion: status.privacyVersion }, expectedAccountId: accountId, signal: controller.signal });
      if (!controller.signal.aborted) {
        if (result.accepted !== true) throw new Error('Unconfirmed acceptance');
        onAccepted();
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof SharingError ? failure.message : 'Acceptance was not confirmed. Please try again.');
    } finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  return <View style={styles.group}>
    <Text style={typography.section}>Before you share</Text>
    <Text style={typography.body}>Read the terms and privacy notice, including the safety rules and how deletion works. Revealed media can be captured or retained by recipients; the viewing timer cannot erase delivered bytes.</Text>
    <PolicyResources />
    {status.policyReady ? <>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled: busy }} disabled={busy} onPress={() => setChecked(value => !value)} style={styles.control}>
        <Text style={styles.label}>{checked ? '☑' : '☐'} I agree to the terms and acknowledge the privacy notice.</Text>
      </Pressable>
      <Control label="Accept and continue" disabled={busy || !checked} onPress={() => { void accept(); }} />
    </> : <Text style={typography.body}>Policies, audience and contact arrangements are still being prepared. Sharing remains closed until they are published. Account deletion stays available in Profile.</Text>}
    {busy ? <ActivityIndicator color={colors.text} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

export function AccountPrivacy({ accountId, onDisabled }: { accountId: string | null; onDisabled: () => void }) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [providers, setProviders] = useState<AuthProviders>({ google: null, email: null, apple: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusUrl, setStatusUrl] = useState<string | null>(null);
  const appleAuthorizationCode = useRef<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const disabledAccount = useRef<string | null>(null);
  const revision = useRef(0);
  const disabledCallback = useRef(onDisabled); disabledCallback.current = onDisabled;

  useEffect(() => {
    const turn = ++revision.current;
    operation.current?.abort(); operation.current = null;
    appleAuthorizationCode.current = null;
    setStatus(null); setConfirm(false); setPassword(''); setConfirmation(''); setBusy(false); setError('');
    if (!disabledAccount.current || (accountId && disabledAccount.current !== accountId)) { setNotice(''); setStatusUrl(null); }
    if (!accountId) return;
    const controller = new AbortController(); operation.current = controller;
    const current = () => !controller.signal.aborted && revision.current === turn;
    void Promise.all([apiRequest<PrivacyStatus>('/api/account/privacy', { expectedAccountId: accountId, signal: controller.signal }), getAuthProviders(controller.signal)])
      .then(([result, available]) => { if (current()) { setStatus(result); setProviders(available); } })
      .catch(() => { if (current()) setError('Cannot load account privacy settings. You can still open deletion to retry.'); })
      .finally(() => { if (current()) operation.current = null; });
    return () => { controller.abort(); operation.current?.abort(); appleAuthorizationCode.current = null; revision.current++; };
  }, [accountId]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || !accountId) return;
    const controller = new AbortController(); operation.current = controller;
    const turn = revision.current;
    setBusy(true); setError('');
    try { await action(controller.signal); }
    catch (failure) { if (!controller.signal.aborted && revision.current === turn) setError(failure instanceof SharingError ? failure.message : 'This action was not confirmed. Please try again.'); }
    finally { if (!controller.signal.aborted && revision.current === turn) { operation.current = null; setBusy(false); setPassword(''); } }
  }
  function proof(kind: 'password' | 'google' | 'apple') {
    appleAuthorizationCode.current = null;
    void run(async signal => {
      const success = kind === 'password' ? (await reauthenticateForDeletion(accountId!, password, signal), true)
        : kind === 'google' ? await signInWithGoogle(signal, undefined, accountId!) : await signInWithApple(signal, undefined, accountId!, code => { if (!signal.aborted) appleAuthorizationCode.current = code; });
      if (!signal.aborted && success) setNotice('Identity confirmed. Review the deletion details, then confirm deletion.');
    });
  }
  function remove() {
    if (confirmation !== 'DELETE') return;
    void run(async signal => {
      const owner = accountId!;
      const code = appleAuthorizationCode.current; appleAuthorizationCode.current = null;
      const result = await apiRequest<{ status: string; requestId: string; statusUrl?: string }>('/api/account/delete', { method: 'POST', body: { confirmation: 'DELETE', ...(code ? { appleAuthorizationCode: code } : {}) }, expectedAccountId: owner, signal });
      if (signal.aborted) return;
      if (result.status !== 'pending' || !result.requestId) throw new Error('Unconfirmed deletion');
      disabledAccount.current = owner;
      if (result.statusUrl) {
        try {
          const url = new URL(result.statusUrl);
          if (url.origin === new URL(resolveApiUrl('/')).origin && url.pathname === '/delete-account' && !url.search && /^#requestId=[a-f0-9-]{36}&receipt=[A-Za-z0-9_-]{43}$/.test(url.hash)) setStatusUrl(url.toString());
        } catch { /* Access is disabled; an invalid status link must not undo that fact. */ }
      }
      setPassword(''); setConfirmation(''); setConfirm(false);
      setStatus(previous => previous ? { ...previous, deletionStatus: 'pending' } : null);
      setNotice('Deletion requested. Account access is disabled. Storage, identity and data cleanup remain pending until the server confirms completion.');
      notifyAccountDisabled(owner);
      // Revocation already happened on the server. Never restore a deleted login.
      try {
        const result = await performAccountAuth(async client => {
          const session = await client.auth.getSession();
          if (session.data.session?.user.id !== owner) return { error: null };
          return client.auth.signOut({ scope: 'local' });
        }, undefined, undefined, { restoreOnCancel: false });
        if (result.error) throw new Error('Local signout failed');
      } catch {
        if (!signal.aborted) setError('Server access is disabled, but clearing this device’s sign-in did not finish. Close the app and sign out again.');
      }
      if (!signal.aborted) disabledCallback.current();
    });
  }

  return <View style={styles.group}>
    <PolicyResources />
    {accountId ? <>
      {status && !status.accepted && !status.deletionStatus ? <TermsAcceptance status={status} accountId={accountId} onAccepted={() => setStatus({ ...status, accepted: true })} /> : null}
      {status?.accepted ? <Text style={typography.small}>Terms {status.termsVersion} accepted · privacy notice {status.privacyVersion} acknowledged.</Text> : null}
      {status?.deletionStatus ? <Text style={typography.body}>Deletion {status.deletionStatus === 'complete' ? 'completed according to the server' : 'pending'}. Your account access is disabled. Retained security records and backup handling are described in the deletion notice.</Text> : null}
      {status?.deletionStatus === 'complete' ? null : confirm ? <View style={styles.confirm}>
          <Text style={typography.section}>Delete your Peekalo account?</Text>
          <Text style={typography.body}>This permanently disables your account and revokes access to your moments. Private media, your profile and authentication data enter cleanup. Limited safety and anti-replay records are retained as described in the deletion notice. Bytes already delivered to recipients cannot be erased. This cannot be undone.</Text>
          <Text style={typography.body}>Confirm your identity with the same account if your sign-in is no longer recent. Passwords are sent only to the authentication service.</Text>
          <TextInput accessibilityLabel="Password for deletion confirmation" style={styles.input} value={password} onChangeText={setPassword} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" placeholder="Current password" placeholderTextColor={colors.muted} />
          <Control label="Confirm password" disabled={busy || !password} onPress={() => proof('password')} />
          {providers.google === true ? <Control label="Confirm with Google" disabled={busy} onPress={() => proof('google')} /> : null}
          {Platform.OS === 'ios' && providers.apple === true ? <AppleSignIn disabled={busy} onPress={() => proof('apple')} /> : null}
          <TextInput accessibilityLabel="Type DELETE to confirm account deletion" value={confirmation} onChangeText={setConfirmation} style={styles.input} editable={!busy} autoCapitalize="characters" autoCorrect={false} placeholder="Type DELETE" placeholderTextColor={colors.muted} />
          <Control label="Permanently delete my account" danger disabled={busy || confirmation !== 'DELETE'} onPress={remove} />
          <Control label="Keep my account" disabled={busy} onPress={() => { setConfirm(false); setPassword(''); setConfirmation(''); appleAuthorizationCode.current = null; }} />
        </View> : <Control label={status?.deletionStatus === 'pending' ? 'Retry account deletion verification' : 'Delete my account'} danger disabled={busy} onPress={() => { setConfirm(true); setError(''); setNotice(''); }} />}
    </> : null}
    {busy ? <ActivityIndicator color={colors.text} accessibilityLabel="Updating account privacy settings" /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {statusUrl ? <><Text style={typography.small}>Save this private status link to check cleanup after signing out. Anyone holding it can see this request’s cleanup status. It does not restore access.</Text><Control label="Check deletion status" onPress={() => { void Linking.openURL(statusUrl).catch(() => setError('Cannot open deletion status. Check your connection and try again.')); }} /></> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.body}>{notice}</Text> : null}
  </View>;
}

function Control({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.control, danger && styles.danger, disabled && styles.disabled]}><Text style={[styles.label, danger && styles.dangerLabel]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  group: { gap: 14, marginVertical: 14 }, control: { minHeight: 48, padding: 15, borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, label: { color: colors.text, fontSize: 14, lineHeight: 20 },
  confirm: { gap: 14, padding: 18, borderRadius: tokens.radius.md, borderWidth: 1, borderColor: colors.danger }, danger: { borderColor: colors.danger, backgroundColor: colors.dangerSurface }, dangerLabel: { color: colors.danger }, disabled: { opacity: 0.5 }, error: { color: colors.danger, lineHeight: 22 },
  input: { minHeight: 52, padding: 15, borderRadius: tokens.radius.sm, backgroundColor: colors.elevated, color: colors.text },
});
