import Feather from '@expo/vector-icons/Feather';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, colors, Eyebrow, Screen, typography } from '../../components/ui';
import { ShareCapture } from '../../components/share-capture';
import { Conversations, MomentComments } from '../../components/social';
import { ReceivedMoment } from '../../components/received-moment';
import { SafetyPanel, type SafetyTarget } from '../../components/safety';
import { apiRequest, getSharingClient } from '../../lib/sharing-client';

type InboxItem = { postId: string; kind: 'photo' | 'video'; senderUsername: string | null; senderAccountId?: string; requestState: 'pending' | 'accepted'; remainingMs?: number | null };
export default function InboxScreen() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [commentSafety, setCommentSafety] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyTarget | null>(null);
  const [account, setAccount] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const identity = useRef<string | null | undefined>(undefined);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const busyAction = useRef<'refresh' | 'accept' | null>(null);
  const subscribeAuth = useRef<((client: Awaited<ReturnType<typeof getSharingClient>>) => void) | null>(null);
  const cancelRequests = useCallback(() => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    busyAction.current = null;
  }, []);
  const refresh = useCallback(async () => {
    if (!focused.current || busyAction.current === 'accept') return;
    cancelRequests();
    const controller = new AbortController();
    const turn = generation.current;
    request.current = controller;
    busyAction.current = 'refresh';
    const current = () => focused.current && !controller.signal.aborted && generation.current === turn;
    setBusy(true); setError(null);
    try {
      const client = await getSharingClient(controller.signal);
      if (!current()) return;
      subscribeAuth.current?.(client);
      if (!current()) return;
      const { data, error: sessionError } = await client.auth.getSession();
      if (!current()) return;
      if (sessionError) throw sessionError;
      const accountId = data.session?.user.id ?? null;
      if (identity.current !== accountId) {
        identity.current = accountId;
        setCommentSafety(null); setSelected(null); setSafety(null); setItems([]);
      }
      setSignedIn(!!accountId);
      if (!accountId) { setItems([]); return; }
      const response = await apiRequest<{ items: InboxItem[] }>('/api/inbox', { signal: controller.signal });
      if (current()) setItems(response.items);
    } catch {
      if (current()) setError('Cannot load your inbox. Check your connection and try again.');
    } finally {
      if (current()) { request.current = null; busyAction.current = null; setBusy(false); }
    }
  }, [cancelRequests]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    subscribeAuth.current = client => {
      if (controller.signal.aborted || unsubscribe) return;
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (controller.signal.aborted) return;
        const accountId = session?.user.id ?? null;
        if (identity.current === accountId) return;
        cancelRequests();
        identity.current = accountId;
        setCommentSafety(null); setSelected(null); setSafety(null); setItems([]); setSignedIn(!!accountId); setBusy(false); setError(null);
        // Keep authenticated requests outside Supabase's synchronous auth callback.
        void Promise.resolve().then(() => { if (!controller.signal.aborted) void refresh(); });
      });
      unsubscribe = () => data.subscription.unsubscribe();
    };
    void refresh();
    return () => {
      focused.current = false;
      controller.abort();
      unsubscribe?.();
      subscribeAuth.current = null;
      cancelRequests();
      setCommentSafety(null); setSelected(null); setSafety(null); setItems([]); setBusy(false); setError(null); setAccount(false);
    };
  }, [cancelRequests, refresh]));
  const accept = async (item: InboxItem) => {
    // State updates are asynchronous; the ref closes the double-tap window.
    if (!focused.current || busyAction.current || !identity.current) return;
    const controller = new AbortController();
    const turn = ++generation.current;
    request.current = controller;
    busyAction.current = 'accept';
    const current = () => focused.current && !controller.signal.aborted && generation.current === turn;
    setBusy(true); setError(null);
    try {
      const response = await apiRequest<{ requestState: string }>(`/api/inbox/${item.postId}/accept`, { body: {}, signal: controller.signal });
      if (!current()) return;
      if (response.requestState !== 'accepted') throw new Error('Request not accepted');
      const accepted = { ...item, requestState: 'accepted' as const };
      setItems(previous => previous.map(entry => entry.postId === item.postId ? accepted : entry));
      setCommentSafety(null); setSelected(accepted);
    } catch {
      if (current()) setError('The request could not be accepted. Please try again.');
    } finally {
      if (current()) { request.current = null; busyAction.current = null; setBusy(false); }
    }
  };
  const senderLabel = (item: InboxItem) => item.senderUsername ? `@${item.senderUsername}` : 'Account awaiting review';
  const openSafety = (item: InboxItem) => {
    if (!focused.current || busyAction.current || !identity.current) return;
    // Unmounting ReceivedMoment synchronously ends its reveal and video/audio.
    setCommentSafety(null); setSelected(null); setSafety({ postId: item.postId, username: item.senderUsername, accountId: item.senderAccountId });
  };
  return <Screen>
    <Eyebrow>For your eyes</Eyebrow>
    <Text accessibilityRole="header" style={[typography.title, styles.title]}>{selected ? `From ${senderLabel(selected)}` : 'Your little\nmoments.'}</Text>
    {safety && identity.current ? <SafetyPanel key={`${identity.current}:${safety.postId}`} target={safety} accountId={identity.current} onClose={() => setSafety(null)} onBlocked={() => {
      setItems(previous => previous.filter(item => safety.accountId ? item.senderAccountId !== safety.accountId : item.senderUsername !== safety.username)); setSafety(null); void refresh();
    }} /> : selected ? <>
      <Pressable accessibilityRole="button" style={styles.back} onPress={() => { setCommentSafety(null); setSelected(null); }}><Feather name="arrow-left" size={18} color={colors.text} /><Text style={typography.body}>Back to inbox</Text></Pressable>
      {commentSafety !== selected.postId ? <ReceivedMoment key={selected.postId} postId={selected.postId} kind={selected.kind} /> : null}
      <MomentComments key={`comments:${selected.postId}`} postId={selected.postId} accountId={identity.current!} onSafetyChange={open => setCommentSafety(open ? selected.postId : null)} />
      <Button secondary label="Report or block" onPress={() => openSafety(selected)} />
    </> : <>
      <Text style={typography.body}>Only moments shared with your account appear here.</Text>
      <View style={styles.actions}>
        <Button secondary label={signedIn ? 'Your account' : 'Sign in'} icon="user" onPress={() => setAccount(true)} />
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh inbox" disabled={busy} onPress={() => { void refresh(); }} style={styles.refresh}><Feather name="refresh-cw" size={21} color={colors.text} /></Pressable>
      </View>
      {busy && <ActivityIndicator color={colors.text} accessibilityLabel="Loading inbox" />}
      {!busy && items.length === 0 && <View style={styles.empty}>
        <Feather name="message-circle" size={40} color={colors.text} />
        <Text style={typography.section}>Quiet, for now.</Text>
        <Text style={[typography.body, styles.center]}>{signedIn ? 'Ask a friend to share a moment with your username.' : 'Sign in to receive private moments and accept requests.'}</Text>
      </View>}
      {items.map(item => <View key={item.postId} style={styles.item}>
        <View style={styles.itemMeta}><Feather name={item.kind === 'video' ? 'video' : 'image'} size={21} color={colors.text} />
          <View style={styles.sender}><Text style={typography.section}>{senderLabel(item)}</Text><Text style={typography.small}>{item.requestState === 'pending' ? 'Wants to share a moment' : typeof item.remainingMs === 'number' ? item.remainingMs <= 0 ? 'Viewing time used up' : `Hidden · ${(item.remainingMs / 1000).toFixed(1)}s left` : 'Hidden · viewing time checked when opened'}</Text></View></View>
        <Button secondary label={item.requestState === 'pending' ? 'Accept request' : 'Open moment'} onPress={() => {
          if (!focused.current || busyAction.current || !identity.current) return;
          if (item.requestState === 'pending') void accept(item); else { setCommentSafety(null); setSelected(item); }
        }} />
        <Button secondary label={`Report or block ${senderLabel(item)}`} onPress={() => openSafety(item)} />
      </View>)}
      <Button label="Back to camera" icon="camera" onPress={() => router.navigate('/')} />
      {signedIn && identity.current ? <Conversations key={identity.current} accountId={identity.current} /> : null}
      <Text style={styles.footer}>Moments and conversations have separate acceptance. Viewing time stays with the original moment.</Text>
    </>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <ShareCapture visible={account} capture={null} onClose={() => { setAccount(false); void refresh(); }} />
  </Screen>;
}
const styles = StyleSheet.create({
  title: { marginTop: 14, marginBottom: 18, fontSize: 36, lineHeight: 41 }, actions: { marginTop: 20, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 16 },
  refresh: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' }, empty: { paddingVertical: 42, paddingHorizontal: 20, alignItems: 'center', gap: 16 },
  center: { textAlign: 'center' }, item: { paddingVertical: 20, borderBottomWidth: 1, borderColor: colors.border, gap: 16, marginBottom: 16 },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 14 }, sender: { flex: 1, gap: 4 }, footer: { color: colors.muted, fontSize: 10, textAlign: 'center', lineHeight: 17, marginTop: 20 },
  back: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 16, marginBottom: 14 }, error: { color: colors.danger, marginVertical: 16, lineHeight: 21 },
});
