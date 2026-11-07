import Feather from '@expo/vector-icons/Feather';
import { MAX_VIDEO_DURATION_MS, REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { ShareCapture } from '../../components/share-capture';
import { AccountPrivacy } from '../../components/account-privacy';
import { MomentComments } from '../../components/social';
import { SafetySettings } from '../../components/safety';
import { Button, colors, Eyebrow, Eyes, Screen, tokens, typography } from '../../components/ui';
import { apiRequest, getSharingClient, newIdempotencyKey, resolveApiUrl, SharingError } from '../../lib/sharing-client';

type Account = { state: 'loading' | 'unavailable' | 'signed_out' } | { state: 'signed_in'; email: string | null; username: string | null; reviewState?: string };
type Moment = {
  postId: string; kind: 'photo' | 'video'; status: 'uploading' | 'moderation_pending' | 'ready' | 'rejected' | 'taken_down' | 'failed' | 'deleted'; createdAt: string; cleanupPending: boolean;
  link: { state: 'none' | 'active' | 'claimed' | 'expired' | 'revoked'; expiresAt: string } | null;
  recipients: { accountId?: string; username: string | null; requestState: string; revoked: boolean }[];
};
type Moments = { items: Moment[]; limit: number; activeCount: number; availableSlots: number };
type LinkDraft = { key: string; url?: string; expiresAt?: number; retired?: boolean };

export default function ProfileScreen() {
  const [account, setAccount] = useState<Account>({ state: 'loading' });
  const [moments, setMoments] = useState<Moments | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [recipient, setRecipient] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const focused = useRef(false);
  const identity = useRef<string | null | undefined>(undefined);
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);
  const operation = useRef<'refresh' | 'mutation' | null>(null);
  const linkDrafts = useRef(new Map<string, LinkDraft>());
  const subscribeAuth = useRef<((client: Awaited<ReturnType<typeof getSharingClient>>) => void) | null>(null);

  const cancel = useCallback(() => {
    revision.current++;
    request.current?.abort(); request.current = null; operation.current = null;
  }, []);
  const clearOwner = useCallback(() => {
    setMoments(null); setSelected(null); setConfirmDelete(null); setRecipient(''); setError(''); setNotice('');
    linkDrafts.current.clear();
  }, []);
  const applyInventory = useCallback((result: Moments) => {
    for (const item of result.items) {
      // Only authoritative link states invalidate an uncertain creation key.
      // A failed request by itself keeps its key for an idempotent retry.
      if (linkDrafts.current.has(item.postId) && (item.link?.state === 'revoked' || item.link?.state === 'expired')) {
        linkDrafts.current.set(item.postId, { key: newIdempotencyKey() });
      }
    }
    setMoments(result);
  }, []);
  const refresh = useCallback(async () => {
    if (!focused.current || operation.current === 'mutation') return;
    cancel();
    const controller = new AbortController(); request.current = controller; operation.current = 'refresh';
    const turn = revision.current;
    const current = () => focused.current && !controller.signal.aborted && revision.current === turn;
    setBusy(true); setError('');
    try {
      const client = await getSharingClient(controller.signal);
      if (!current()) return;
      subscribeAuth.current?.(client);
      const { data, error: sessionError } = await client.auth.getSession();
      if (!current()) return;
      if (sessionError) throw sessionError;
      const id = data.session?.user.id ?? null;
      if (identity.current !== id) { identity.current = id; clearOwner(); }
      if (!data.session) { setAccount({ state: 'signed_out' }); return; }
      setAccount({ state: 'signed_in', email: data.session.user.email ?? null, username: null });
      const profile = await apiRequest<{ username: string | null; reviewState?: string }>('/api/profile', { signal: controller.signal, expectedAccountId: id! });
      if (!current()) return;
      setAccount({ state: 'signed_in', email: data.session.user.email ?? null, username: profile.username, reviewState: profile.reviewState });
      const result = await apiRequest<Moments>('/api/posts', { signal: controller.signal, expectedAccountId: id! });
      if (!current()) return;
      applyInventory(result);
      setSelected(previous => result.items.some(item => item.postId === previous) ? previous : null);
    } catch {
      if (current()) {
        setError('Cannot load your moments. Check your connection and try again.');
        setAccount(previous => previous.state === 'signed_in' ? previous : { state: 'unavailable' });
      }
    } finally {
      if (current()) { request.current = null; operation.current = null; setBusy(false); }
    }
  }, [applyInventory, cancel, clearOwner]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    const lifetime = new AbortController();
    let unsubscribe: (() => void) | undefined;
    subscribeAuth.current = client => {
      if (lifetime.signal.aborted || unsubscribe) return;
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (lifetime.signal.aborted) return;
        const id = session?.user.id ?? null;
        if (identity.current === id) return;
        cancel(); identity.current = id; clearOwner(); setBusy(false);
        setAccount(id ? { state: 'loading' } : { state: 'signed_out' });
        void Promise.resolve().then(() => { if (!lifetime.signal.aborted) void refresh(); });
      });
      unsubscribe = () => data.subscription.unsubscribe();
    };
    void refresh();
    return () => {
      focused.current = false; lifetime.abort(); unsubscribe?.(); subscribeAuth.current = null; cancel();
      identity.current = undefined; clearOwner(); setAccount({ state: 'loading' }); setBusy(false); setPanelOpen(false);
    };
  }, [cancel, clearOwner, refresh]));

  async function mutate(action: (signal: AbortSignal, current: () => boolean, owner: string) => Promise<string>) {
    if (!focused.current || operation.current || !identity.current) return;
    const owner = identity.current;
    const controller = new AbortController(); request.current = controller; operation.current = 'mutation';
    const turn = ++revision.current;
    const current = () => focused.current && !controller.signal.aborted && revision.current === turn && identity.current === owner;
    setBusy(true); setError(''); setNotice('');
    try {
      const message = await action(controller.signal, current, owner);
      if (!current()) return;
      setNotice(message);
      // A successful mutation stays confirmed even when its follow-up listing fails.
      const result = await apiRequest<Moments>('/api/posts', { signal: controller.signal, expectedAccountId: owner });
      if (current()) applyInventory(result);
    } catch (failure) {
      if (current()) setError(failure instanceof SharingError ? failure.message : 'This action did not finish. Refresh your moments and try again.');
    } finally {
      if (current()) { request.current = null; operation.current = null; setBusy(false); }
    }
  }
  function createLink(item: Moment) {
    void mutate(async (signal, current, owner) => {
      let draft = linkDrafts.current.get(item.postId);
      if (!draft || draft.retired || (draft.expiresAt !== undefined && draft.expiresAt <= Date.now())) {
        draft = { key: newIdempotencyKey() }; linkDrafts.current.set(item.postId, draft);
      }
      // A deliberate share rechecks this key's state before exposing its URL.
      // Transport failures never fall back to a possibly revoked cached link.
      const result = await apiRequest<{ url: string; expiresAt: string; state?: 'active' | 'claimed' | 'expired' | 'revoked' }>(`/api/posts/${item.postId}/link`, {
        method: 'POST', body: {}, headers: { 'Idempotency-Key': draft.key }, signal, expectedAccountId: owner,
      });
      if (!current()) return '';
      if (result.state === 'revoked' || result.state === 'expired') {
        // Retain the server's idempotent result until another deliberate tap.
        draft.retired = true; delete draft.url;
        throw new SharingError(`That link has ${result.state === 'revoked' ? 'been revoked' : 'expired'}. Tap again to create a replacement.`, result.state);
      }
      const url = new URL(result.url); const expiresAt = Date.parse(result.expiresAt);
      if (url.origin !== new URL(resolveApiUrl('/')).origin || url.pathname !== '/s/view' || url.search || !/^[A-Za-z0-9_-]{43}$/.test(url.hash.slice(1)) || !Number.isFinite(expiresAt)) throw new Error('Invalid link');
      draft.expiresAt = expiresAt;
      if (expiresAt <= Date.now()) throw new SharingError('That link has expired. Tap again to create a replacement.');
      draft.url = url.toString();
      if (!current()) return '';
      const shared = await Share.share({ message: draft.url, title: 'A moment for you on Peekalo' });
      return shared.action === Share.dismissedAction ? 'Your link is ready. Tap Share link to open the options again.' : 'Link ready. Only the first person to reveal can claim it.';
    });
  }
  function revokeLink(item: Moment) {
    void mutate(async (signal, current, owner) => {
      await apiRequest(`/api/posts/${item.postId}/link`, { method: 'DELETE', signal, expectedAccountId: owner });
      if (current()) linkDrafts.current.delete(item.postId);
      return 'Link revoked. New viewing requests are blocked.';
    });
  }
  function grantRecipient(item: Moment) {
    const name = recipient.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,24}$/.test(name)) { setError('Enter 3–24 letters, numbers or underscores for the recipient.'); return; }
    void mutate(async (signal, current, owner) => {
      const result = await apiRequest<{ requestState: string }>(`/api/posts/${item.postId}/recipients`, { method: 'POST', body: { username: name }, signal, expectedAccountId: owner });
      if (!['accepted', 'pending'].includes(result.requestState)) throw new Error('Unconfirmed grant');
      if (current()) setRecipient('');
      return result.requestState === 'pending' ? `Request sent to @${name}. They must accept before revealing.` : `Shared with @${name}. Their existing viewing allowance stays the same.`;
    });
  }
  function revokeRecipient(item: Moment, person: Moment['recipients'][number]) {
    void mutate(async (signal, _current, owner) => {
      await apiRequest(`/api/posts/${item.postId}/recipients`, { method: 'DELETE', body: person.accountId ? { accountId: person.accountId } : { username: person.username }, signal, expectedAccountId: owner });
      return `Access revoked for ${person.username ? `@${person.username}` : 'this account'}. New viewing requests are blocked.`;
    });
  }
  function deleteMoment(item: Moment) {
    void mutate(async (signal, current, owner) => {
      const result = await apiRequest<{ deleted: boolean; cleanupPending: boolean }>(`/api/posts/${item.postId}`, { method: 'DELETE', signal, expectedAccountId: owner });
      if (result.deleted !== true) throw new Error('Unconfirmed deletion');
      if (current()) {
        setConfirmDelete(null); setSelected(result.cleanupPending ? item.postId : null); linkDrafts.current.delete(item.postId);
        // Keep retryable tombstones visible even if the following refresh fails.
        // Slot counts come only from the server's inventory response.
        setMoments(previous => previous ? { ...previous, items: result.cleanupPending
          ? previous.items.map(moment => moment.postId === item.postId ? { ...moment, status: 'deleted', cleanupPending: true } : moment)
          : previous.items.filter(moment => moment.postId !== item.postId) } : previous);
      }
      return result.cleanupPending ? 'Moment deleted and access revoked. Private storage cleanup is pending; you can retry it here.'
        : item.status === 'deleted' ? 'Private storage cleanup completed. The moment remains deleted.' : 'Moment deleted. Its links and recipient access are revoked.';
    });
  }

  const statusLabel = (status: Moment['status']) => status === 'moderation_pending' ? 'Waiting for safety review' : status === 'rejected' ? 'Not approved for sharing' : status === 'taken_down' ? 'Removed by the safety team' : null;
  const signedIn = account.state === 'signed_in';
  const username = signedIn ? account.username : null;
  const title = username ? `@${username}` : signedIn ? 'Almost there.' : 'Hello, you.';
  const subtitle = account.state === 'loading' ? 'Checking your account…' : account.state === 'unavailable' ? 'Cannot reach Peekalo right now.'
    : signedIn ? (username ? account.email ?? 'Signed in' : 'Choose a username so friends can send you moments.') : 'Sign in to share and receive moments.';
  const selectedMoment = moments?.items.find(item => item.postId === selected);
  const actionButton = (label: string, onPress: () => void, danger = false) => <Pressable accessibilityRole="button" disabled={busy}
    accessibilityState={{ disabled: busy }} onPress={onPress} style={[styles.control, danger && styles.dangerControl, busy && styles.disabled]}><Text style={[styles.controlText, danger && styles.dangerText]}>{label}</Text></Pressable>;

  return <Screen>
    <Eyebrow>Profile</Eyebrow>
    <Text accessibilityRole="header" style={typography.title}>Your little corner.</Text>
    <View style={styles.identity}>
      <View style={styles.avatar}>{username ? <Text style={styles.initial}>{username[0].toUpperCase()}</Text> : <Eyes large />}</View>
      <View style={styles.nameBlock}><Text accessibilityRole="header" style={styles.name} numberOfLines={1} adjustsFontSizeToFit>{title}</Text><Text style={typography.small} numberOfLines={2}>{subtitle}</Text></View>
    </View>
    {signedIn && account.reviewState === 'pending' ? <Text style={typography.small}>Your username is awaiting safety approval. It stays out of public profiles and recipient lookup until approved.</Text> : null}
    {signedIn && account.reviewState === 'rejected' ? <Text style={typography.small}>Your username was not approved. Open Your account and choose Change username to submit a different name for review.</Text> : null}
    <View style={styles.actions}>
      {account.state !== 'loading' && <Button secondary label={signedIn ? username ? 'Your account' : 'Choose username' : 'Sign in or create account'} icon="user" onPress={() => { if (!operation.current) setPanelOpen(true); }} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh moments" disabled={busy} onPress={() => { void refresh(); }} style={styles.refresh}><Feather name="refresh-cw" size={21} color={colors.text} /></Pressable>
    </View>
    <View style={styles.sectionHeader}><Text style={typography.section}>Your moments</Text><View style={styles.hiddenLabel}><Feather name="eye-off" size={13} color={colors.muted} /><Text style={styles.hiddenText}>Hidden by default</Text></View></View>
    {busy && <ActivityIndicator color={colors.text} accessibilityLabel="Updating your moments" />}
    {moments && <View style={styles.allowanceGroup}>
      <Text style={styles.allowance}>{moments.activeCount} of {moments.limit} active · {moments.availableSlots} {moments.availableSlots === 1 ? 'slot' : 'slots'} available</Text>
      <View style={styles.slotMeter} importantForAccessibility="no-hide-descendants">
        {Array.from({ length: moments.limit }, (_, index) => <View key={index} style={[styles.slot, index < moments.activeCount && styles.slotFilled]} />)}
      </View>
    </View>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
    {selectedMoment ? <View style={styles.detail}>
      {actionButton('Back to your moments', () => { setSelected(null); setConfirmDelete(null); setRecipient(''); })}
      <View style={styles.placeholder}><Eyes large /><Text style={typography.section}>{selectedMoment.status === 'deleted' ? 'Deleted ' : ''}{selectedMoment.kind === 'video' ? 'Video' : 'Photo'} moment</Text><Text style={typography.small}>{selectedMoment.status === 'deleted' ? 'Deleted · access revoked' : 'Private · hidden by default'}</Text></View>
      {selectedMoment.status === 'ready' ? <>
        <Text style={typography.section}>Single-use link</Text>
        <Text style={typography.body}>{selectedMoment.link && selectedMoment.link.state !== 'none' ? `Link ${selectedMoment.link.state}${selectedMoment.link.expiresAt ? ` · expires ${new Date(selectedMoment.link.expiresAt).toLocaleString()}` : ''}` : 'No link created.'}</Text>
        {actionButton(selectedMoment.link?.state === 'active' ? 'Share link' : selectedMoment.link?.state === 'claimed' ? 'Share claimed link' : 'Create a single-use link', () => createLink(selectedMoment))}
        {selectedMoment.link?.state === 'active' || selectedMoment.link?.state === 'claimed' ? actionButton('Revoke link', () => revokeLink(selectedMoment)) : null}
        <Text style={typography.small}>A claimed link stays with its first viewer. Revoking prevents future requests; delivered bytes cannot be erased.</Text>
        <Text style={typography.section}>Recipients</Text>
        {selectedMoment.recipients.length === 0 && <Text style={typography.body}>You haven’t sent this moment to anyone yet.</Text>}
        {selectedMoment.recipients.map(person => <View key={person.accountId ?? person.username} style={styles.person}>
          <Text style={typography.body}>{person.username ? `@${person.username}` : 'Account awaiting review'} · {person.revoked ? 'revoked' : person.requestState}</Text>
          {!person.revoked && actionButton(person.username ? `Revoke @${person.username}` : 'Revoke account access', () => revokeRecipient(selectedMoment, person))}
        </View>)}
        <TextInput accessibilityLabel="Recipient username" editable={!busy} style={styles.input} value={recipient} onChangeText={setRecipient} autoCapitalize="none" autoCorrect={false} placeholder="@username" placeholderTextColor={colors.muted} maxLength={25} />
        {actionButton('Send on Peekalo', () => grantRecipient(selectedMoment))}
        {identity.current ? <MomentComments key={`comments:${selectedMoment.postId}:${identity.current}`} postId={selectedMoment.postId} accountId={identity.current} owner /> : null}
      </> : <Text style={typography.body}>{selectedMoment.status === 'deleted' ? (selectedMoment.cleanupPending ? 'This moment is deleted and its links and recipient access are revoked. Private storage cleanup is still pending. Retry cleanup without restoring the moment.' : 'This moment is deleted and its links and recipient access are revoked.') : statusLabel(selectedMoment.status) ? `${statusLabel(selectedMoment.status)}. Sharing is unavailable. Refresh to check its status or delete the moment.` : selectedMoment.status === 'failed' ? 'The upload failed. Retry from your retained camera draft, or delete this moment and capture again.' : 'This moment is still being prepared. Refresh to check its status.'}</Text>}
      {selectedMoment.status === 'deleted' ? (selectedMoment.cleanupPending ? actionButton('Retry storage cleanup', () => deleteMoment(selectedMoment)) : null) : confirmDelete === selectedMoment.postId ? <View style={styles.confirm}>
        <Text style={typography.section}>Delete this moment?</Text><Text style={typography.body}>This revokes every link and recipient’s access, removes the moment and frees its active slot. Delivered bytes cannot be erased.</Text>
        {actionButton('Delete this moment permanently', () => deleteMoment(selectedMoment), true)}
        {actionButton('Keep moment', () => setConfirmDelete(null))}
      </View> : actionButton('Delete moment', () => setConfirmDelete(selectedMoment.postId), true)}
    </View> : <>
      {moments?.items.map((item, index) => <Pressable key={item.postId} accessibilityRole="button" accessibilityLabel={item.status === 'deleted' ? `Manage cleanup for deleted ${item.kind} moment ${index + 1}` : `Manage ${item.kind} moment ${index + 1}`} disabled={busy} style={styles.moment} onPress={() => { setSelected(item.postId); setConfirmDelete(null); setError(''); setNotice(''); }}>
        <View style={styles.tile}><Feather name="eye-off" size={25} color={colors.muted} /></View>
        <View style={styles.momentCopy}><Text style={typography.section}>{item.kind === 'video' ? 'Video' : 'Photo'} moment</Text><Text style={typography.small}>{item.status === 'deleted' ? item.cleanupPending ? 'Deleted · storage cleanup pending' : 'Deleted' : item.status === 'ready' ? 'Ready · manage sharing' : statusLabel(item.status) ?? (item.status === 'failed' ? 'Upload failed' : 'Preparing…')}</Text><Text style={typography.small}>{new Date(item.createdAt).toLocaleString()}</Text></View>
        <Feather name="chevron-right" size={20} color={colors.text} />
      </Pressable>)}
      {!busy && (!moments || moments.items.length === 0) && !error && <View style={styles.empty}><Text style={[typography.body, styles.center]}>{signedIn ? 'Capture a photo or video, then tap Share moment to send it.' : 'Your shared moments will live here once you sign in.'}</Text></View>}
      <Button label="Open camera" icon="camera" onPress={() => router.navigate('/')} />
    </>}
    <View style={styles.limits}><Text style={typography.small}>Up to 3 active moments. Delete one to free a slot. Videos up to {MAX_VIDEO_DURATION_MS / 1000}s; recipients get up to {REVEAL_BUDGET_MS / 1000}s total across holds.</Text></View>
    <AccountPrivacy accountId={signedIn ? identity.current ?? null : null} onDisabled={() => { cancel(); clearOwner(); setPanelOpen(false); void refresh(); }} />
    <SafetySettings key={identity.current ?? 'signed-out'} accountId={signedIn ? identity.current ?? null : null} />
    <Button secondary label="Explore the sample" onPress={() => router.push('/sample')} />
    <ShareCapture visible={panelOpen} capture={null} onClose={() => { setPanelOpen(false); void refresh(); }} />
  </Screen>;
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 24 }, avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 25, fontFamily: tokens.font.display, color: colors.accent }, nameBlock: { flex: 1, gap: 5 }, name: { fontSize: 22, letterSpacing: -0.7, fontFamily: tokens.font.display, color: colors.text },
  actions: { marginTop: 22, marginBottom: 30, flexDirection: 'row', alignItems: 'center', gap: 12 }, refresh: { minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 17 }, hiddenLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 }, hiddenText: { color: colors.muted, fontSize: 10 },
  allowanceGroup: { gap: 10, marginBottom: 18 },
  allowance: { color: colors.text, fontSize: 13 },
  slotMeter: { flexDirection: 'row', gap: 6 },
  slot: { height: 3, flex: 1, borderRadius: 2, backgroundColor: colors.border },
  slotFilled: { backgroundColor: colors.accent }, empty: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 22, padding: 20, marginBottom: 20 }, center: { textAlign: 'center' },
  error: { color: colors.danger, lineHeight: 21, marginVertical: 14 }, notice: { color: colors.text, lineHeight: 21, marginVertical: 14 }, detail: { gap: 16 }, placeholder: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border, padding: 28, borderRadius: tokens.radius.md, gap: 14, alignItems: 'center' },
  control: { minHeight: 48, padding: 15, borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' }, controlText: { color: colors.text, fontSize: 14, fontWeight: '600' }, dangerControl: { borderColor: colors.danger, backgroundColor: colors.dangerSurface }, dangerText: { color: colors.danger }, disabled: { opacity: 0.55 },
  person: { gap: 9, borderBottomWidth: 1, borderColor: colors.border, paddingBottom: 14 }, input: { minHeight: 50, borderRadius: tokens.radius.sm, backgroundColor: colors.elevated, color: colors.text, paddingHorizontal: 16, fontSize: 15 }, confirm: { padding: 18, borderWidth: 1, borderColor: colors.danger, borderRadius: tokens.radius.md, gap: 14 },
  moment: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 17, borderBottomWidth: 1, borderColor: colors.border, marginBottom: 12 }, tile: { width: 60, height: 86, borderRadius: tokens.radius.sm, backgroundColor: colors.elevated, justifyContent: 'center', alignItems: 'center' }, momentCopy: { flex: 1, gap: 5 }, limits: { borderTopWidth: 1, borderColor: colors.border, marginTop: 26, paddingVertical: 22 },
});
