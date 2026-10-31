import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiRequest, getSharingClient, newIdempotencyKey } from '../lib/sharing-client';
import { createSocialResource, readSocial, socialPageUrl, subscribeSocialSignals, type Comment, type Conversation, type Message, type SocialCursor, type SocialPage, type SocialSnapshot } from '../lib/social-client';
import { ReceivedMoment } from './received-moment';
import { colors, tokens, typography } from './ui';

function Action({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, danger && styles.danger, disabled && styles.disabled]}><Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text></Pressable>;
}
function Input({ label, value, onChange, disabled, max = 1000 }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; max?: number }) {
  return <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.muted} multiline={max > 64} maxLength={max} value={value} onChangeText={onChange} editable={!disabled} autoCapitalize={max > 64 ? 'sentences' : 'none'} autoCorrect={max > 64} style={styles.input} />;
}
const peerLabel = (username: string | null) => username ? `@${username}` : 'Account awaiting review';

/** Private channel content is ignored. Every update returns through authorized HTTP. */
function useSocial<T>(path: string, accountId: string, onInterrupted?: () => void) {
  const interrupted = useRef(onInterrupted); interrupted.current = onInterrupted;
  const [state, setState] = useState<SocialSnapshot<T>>({ data: null, busy: true, error: null });
  const resource = useRef<ReturnType<typeof createSocialResource<T>> | null>(null);
  const requestRefresh = useRef<(() => void) | null>(null);
  useFocusEffect(useCallback(() => {
    const lifetime = new AbortController();
    const controller = createSocialResource<T>({ load: signal => readSocial<T>(path, accountId, signal), changed: snapshot => { setState(snapshot); if (snapshot.error && !snapshot.data) interrupted.current?.(); } });
    resource.current = controller;
    let active = AppState.currentState === 'active';
    let releaseSignal: (() => void) | undefined;
    let client: Awaited<ReturnType<typeof getSharingClient>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let permitted = true;
    let booting = false;
    const refresh = () => {
      if (!active || !permitted || lifetime.signal.aborted) return;
      if (!client || !unsubscribe) void initialize();
      else void controller.refresh();
    };
    requestRefresh.current = refresh;
    const closeChannel = () => { releaseSignal?.(); releaseSignal = undefined; };
    const subscribe = () => {
      if (!client || releaseSignal || !active || !permitted || lifetime.signal.aborted) return;
      releaseSignal = subscribeSocialSignals(client, accountId, refresh);
    };
    const app = AppState.addEventListener('change', value => {
      active = value === 'active';
      if (!active) { controller.clear(); interrupted.current?.(); closeChannel(); }
      else { subscribe(); refresh(); }
    });
    const poll = setInterval(refresh, 15_000);
    async function initialize() {
      if (booting || lifetime.signal.aborted || !permitted) return;
      booting = true;
      try {
        client = await getSharingClient(lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (!unsubscribe) {
          const auth = client.auth.onAuthStateChange((_event, session) => {
            if (lifetime.signal.aborted) return;
            if (session?.user.id !== accountId) { permitted = false; controller.clear(); interrupted.current?.(); closeChannel(); }
          });
          unsubscribe = () => auth.data.subscription.unsubscribe();
        }
        const session = await client.auth.getSession();
        if (lifetime.signal.aborted || !permitted) return;
        if (session.error || session.data.session?.user.id !== accountId) { permitted = false; controller.clear(); interrupted.current?.(); return; }
        subscribe(); refresh();
      } catch { if (!lifetime.signal.aborted) { controller.clear(); interrupted.current?.(); setState({ data: null, busy: false, error: 'Cannot connect to this discussion. Refresh to try again.' }); } }
      finally { booting = false; }
    }
    void initialize();
    return () => {
      lifetime.abort(); controller.dispose(); if (resource.current === controller) { resource.current = null; requestRefresh.current = null; }
      clearInterval(poll); app.remove(); unsubscribe?.(); closeChannel();
      setState({ data: null, busy: false, error: null }); interrupted.current?.();
    };
  }, [accountId, path]));
  return { ...state, refresh: () => { requestRefresh.current?.(); }, mutate: (action: (signal: AbortSignal) => Promise<unknown>) => resource.current?.mutate(action) ?? Promise.resolve(false) };
}
function State({ busy, error }: { busy: boolean; error: string | null }) {
  return <>{busy ? <ActivityIndicator color={colors.text} accessibilityLabel="Checking discussion access" /> : null}{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</>;
}
function Pagination({ cursor, onPage }: { cursor: SocialCursor | null | undefined; onPage: (cursor: SocialCursor | null) => void }) {
  return <View style={styles.row}><Action label="Newest" onPress={() => onPage(null)} />{cursor ? <Action label="Older" onPress={() => onPage(cursor)} /> : null}</View>;
}
function useRequestKey() {
  const pending = useRef<{ content: string; key: string } | null>(null);
  return Object.assign((content: string) => {
    if (pending.current?.content !== content) pending.current = { content, key: newIdempotencyKey() };
    return pending.current!.key;
  }, { reset: () => { pending.current = null; } });
}

export function Conversations({ accountId }: { accountId: string }) {
  const [cursor, setCursor] = useState<SocialCursor | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [username, setUsername] = useState('');
  const keyFor = useRequestKey();
  const state = useSocial<SocialPage<Conversation>>(socialPageUrl('/api/social/conversations', cursor), accountId);
  // Details are re-read separately. A vanished conversation never keeps old text.
  const selectedCurrent = selected && state.data?.items.find(item => item.conversationId === selected.conversationId);
  async function start() {
    const target = username.trim().replace(/^@/, ''); if (!target) return;
    const ok = await state.mutate(signal => apiRequest('/api/social/conversations', { body: { username: target, requestKey: keyFor(target) }, signal, expectedAccountId: accountId }));
    if (ok) { keyFor.reset(); setUsername(''); }
  }
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={typography.section}>Conversations</Text>
    <Text style={typography.small}>Text waits for safety review. A new sender needs your acceptance. Moment access is accepted separately in Shared with you.</Text>
    {selected && (selectedCurrent || state.busy) ? <>
      <Action label="Back to conversations" onPress={() => setSelected(null)} />
      <ConversationDetail key={selected.conversationId} accountId={accountId} conversation={selectedCurrent || selected} authorized={!!selectedCurrent} onChanged={state.refresh} />
    </> : <>
      <Input label="Conversation username" value={username} onChange={setUsername} max={32} disabled={state.busy} />
      <Action label="Request a conversation" disabled={state.busy || !username.trim()} onPress={() => { void start(); }} />
      {state.data?.items.length === 0 ? <Text style={typography.body}>No conversations yet.</Text> : null}
      {state.data?.items.map(item => <View key={item.conversationId} style={styles.card}>
        <Text style={typography.section}>{peerLabel(item.peerUsername)}</Text>
        <Text style={typography.small}>{item.requestState === 'accepted' ? 'Conversation accepted' : item.requestState === 'declined' ? 'Request declined' : item.incoming ? 'Wants to talk to you' : 'Waiting for acceptance'}</Text>
        <Action label={`Open conversation with ${peerLabel(item.peerUsername)}`} disabled={state.busy} onPress={() => setSelected(item)} />
      </View>)}
      <Pagination cursor={state.data?.nextCursor} onPage={setCursor} />
    </>}
    <Action label="Refresh conversations" onPress={state.refresh} disabled={state.busy} />
    <State {...state} />
  </View>;
}
function ConversationDetail({ accountId, conversation, authorized, onChanged }: { accountId: string; conversation: Conversation; authorized: boolean; onChanged: () => void }) {
  const [cursor, setCursor] = useState<SocialCursor | null>(null);
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<{ kind: 'message' | 'account'; id: string } | null>(null);
  const [viewing, setViewing] = useState<{ postId: string; kind: 'photo' | 'video' } | null>(null);
  const keyFor = useRequestKey();
  const path = `/api/social/conversations/${conversation.conversationId}`;
  const state = useSocial<SocialPage<Message>>(socialPageUrl(`${path}/messages`, cursor), accountId, () => { setText(''); setTarget(null); setViewing(null); setPicking(false); });
  async function respond(accept: boolean) {
    const ok = await state.mutate(signal => apiRequest(`${path}/respond`, { body: { accept }, signal, expectedAccountId: accountId }));
    if (ok) onChanged();
  }
  async function send(postId?: string) {
    const body = text.trim(); if (!body && !postId) return;
    const ok = await state.mutate(signal => apiRequest(`${path}/messages`, { body: { requestKey: keyFor(postId ? `post:${postId}` : `text:${body}`), ...(postId ? { postId } : { body }) }, signal, expectedAccountId: accountId }));
    if (ok) { keyFor.reset(); setText(''); setPicking(false); }
  }
  async function open(message: Message) {
    if (!message.postId) return;
    let result: { kind: string; state: string } | undefined;
    const ok = await state.mutate(async signal => { result = await apiRequest('/api/view/direct/status', { body: { postId: message.postId }, signal, expectedAccountId: accountId }); });
    if (ok && result && ['available', 'exhausted'].includes(result.state) && (result.kind === 'photo' || result.kind === 'video')) setViewing({ postId: message.postId, kind: result.kind });
  }
  if (!authorized) return <Text style={typography.small}>Checking conversation access…</Text>;
  if (target) return <SocialSafety accountId={accountId} target={target} peerAccountId={conversation.peerAccountId} onClose={() => setTarget(null)} onBlocked={() => { setTarget(null); onChanged(); }} />;
  // An invalidation removes the viewer together with the authorized discussion.
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={typography.section}>{peerLabel(conversation.peerUsername)}</Text>
    {conversation.requestState === 'pending' && conversation.incoming ? <View style={styles.row}><Action label="Accept conversation" disabled={state.busy} onPress={() => { void respond(true); }} /><Action label="Decline conversation" disabled={state.busy} onPress={() => { void respond(false); }} /></View> : null}
    {viewing && state.data ? <><Action label="Close moment" onPress={() => setViewing(null)} /><ReceivedMoment key={viewing.postId} {...viewing} /></> : null}
    {state.data?.items.map(message => <View key={message.messageId} style={styles.card}>
      <Text style={typography.small}>{message.authorAccountId === accountId ? 'You' : peerLabel(conversation.peerUsername)} · {message.status === 'moderation_pending' ? 'Waiting for safety review' : message.status === 'rejected' ? 'Not approved' : message.status === 'removed' ? 'Removed' : 'Approved'}</Text>
      {message.kind === 'moment' ? <><Text style={typography.section}>Hidden moment</Text><Text style={typography.small}>This references the original moment. Only its owner can grant access. Acceptance and remaining viewing time are checked when opened.</Text>{message.postId && message.authorAccountId !== accountId ? <Action label="Open referenced moment" disabled={state.busy} onPress={() => { void open(message); }} /> : null}{!message.postId ? <Text style={typography.small}>This moment reference is unavailable. Check Shared with you for any owner-created access request.</Text> : null}</> : message.body ? <Text selectable style={styles.body}>{message.body}</Text> : null}
      {message.authorAccountId === accountId && message.status !== 'removed' ? <Action label="Delete message" disabled={state.busy} onPress={() => { void state.mutate(signal => apiRequest(`/api/social/messages/${message.messageId}`, { method: 'DELETE', signal, expectedAccountId: accountId })); }} /> : null}
      {message.authorAccountId !== accountId && message.status === 'approved' ? <Action label="Report message" disabled={state.busy} onPress={() => { setViewing(null); setTarget({ kind: 'message', id: message.messageId }); }} /> : null}
    </View>)}
    {state.data?.items.length === 0 ? <Text style={typography.body}>No approved messages yet.</Text> : null}
    <Pagination cursor={state.data?.nextCursor} onPage={setCursor} />
    {conversation.requestState !== 'declined' ? <>
      <Input label="Write a message" value={text} onChange={setText} disabled={state.busy || !state.data} />
      <Action label="Send text for review" disabled={state.busy || !state.data || !text.trim()} onPress={() => { void send(); }} />
      <Action label={picking ? 'Hide your moments' : 'Choose an existing moment'} disabled={state.busy} onPress={() => setPicking(value => !value)} />
      {picking ? <MomentPicker accountId={accountId} onSend={postId => { void send(postId); }} disabled={state.busy} /> : null}
    </> : <Text style={typography.body}>This conversation request was declined.</Text>}
    <Action label="Report or block this account" onPress={() => { setViewing(null); setTarget({ kind: 'account', id: conversation.peerAccountId }); }} />
    <Action label="Refresh messages" disabled={state.busy} onPress={state.refresh} />
    <State {...state} />
  </View>;
}
function MomentPicker({ accountId, onSend, disabled }: { accountId: string; onSend: (id: string) => void; disabled: boolean }) {
  const state = useSocial<{ items: { postId: string; kind: string; status: string }[] }>('/api/posts', accountId);
  return <View style={styles.card}><Text style={typography.small}>Choose one of your already captured moments. A reference never grants access or resets viewing time. Manage recipient access from Profile.</Text>
    {state.data?.items.filter(item => item.status === 'ready').map((item, index) => <Action key={item.postId} label={`Send ${item.kind} moment reference ${index + 1}`} disabled={disabled || state.busy} onPress={() => onSend(item.postId)} />)}
    {state.data && !state.data.items.some(item => item.status === 'ready') ? <Text style={typography.body}>No approved moments available. Capture from Camera first.</Text> : null}<State {...state} />
  </View>;
}

export function MomentComments({ postId, accountId, owner = false, onSafetyChange }: { postId: string; accountId: string; owner?: boolean; onSafetyChange?: (open: boolean) => void }) {
  const [cursor, setCursor] = useState<SocialCursor | null>(null);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<{ kind: 'comment'; id: string; authorAccountId: string } | null>(null);
  const keyFor = useRequestKey();
  const path = `/api/social/posts/${postId}/comments`;
  const state = useSocial<SocialPage<Comment>>(socialPageUrl(path, cursor), accountId, () => { setText(''); setTarget(null); onSafetyChange?.(false); });
  async function send() {
    const body = text.trim(); if (!body) return;
    const ok = await state.mutate(signal => apiRequest(path, { body: { body, requestKey: keyFor(body) }, signal, expectedAccountId: accountId }));
    if (ok) { keyFor.reset(); setText(''); }
  }
  if (target) return <SocialSafety accountId={accountId} target={target} peerAccountId={target.authorAccountId} onClose={() => { setTarget(null); onSafetyChange?.(false); }} onBlocked={() => { setTarget(null); onSafetyChange?.(false); state.refresh(); }} />;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={typography.section}>Comments</Text>
    <Text style={typography.small}>Only the owner and accepted app recipients can join. Discussion can remain after viewing time is used, while audience access remains valid. Text is readable without holding.</Text>
    {state.data?.items.map(comment => <View key={comment.commentId} style={styles.card}>
      <Text style={typography.small}>{comment.authorAccountId === accountId ? 'You' : peerLabel(comment.authorUsername)} · {comment.status === 'moderation_pending' ? 'Waiting for safety review' : comment.status === 'rejected' ? 'Not approved' : comment.status === 'removed' ? 'Removed' : 'Approved'}</Text>
      {comment.body ? <Text selectable style={styles.body}>{comment.body}</Text> : null}
      {(comment.authorAccountId === accountId || owner || comment.canRemove) && comment.status !== 'removed' ? <Action label={comment.authorAccountId === accountId ? 'Delete your comment' : 'Remove comment from your moment'} disabled={state.busy} onPress={() => { void state.mutate(signal => apiRequest(`/api/social/comments/${comment.commentId}`, { method: 'DELETE', signal, expectedAccountId: accountId })); }} /> : null}
      {comment.authorAccountId !== accountId && comment.status === 'approved' ? <Action label="Report comment" disabled={state.busy} onPress={() => { onSafetyChange?.(true); setTarget({ kind: 'comment', id: comment.commentId, authorAccountId: comment.authorAccountId }); }} /> : null}
    </View>)}
    {state.data?.items.length === 0 ? <Text style={typography.body}>No comments yet.</Text> : null}
    <Pagination cursor={state.data?.nextCursor} onPage={setCursor} />
    <Input label="Write a comment" value={text} onChange={setText} disabled={state.busy || !state.data} />
    <Action label="Submit comment for review" disabled={state.busy || !state.data || !text.trim()} onPress={() => { void send(); }} />
    <Action label="Refresh comments" disabled={state.busy} onPress={state.refresh} />
    <State {...state} />
  </View>;
}
const reportReasons = [['child_safety', 'Child safety'], ['sexual_content', 'Sexual content'], ['violence', 'Violence or threats'], ['harassment', 'Harassment or hate'], ['privacy', 'Privacy violation'], ['spam', 'Spam or scam'], ['other', 'Something else']] as const;
function SocialSafety({ accountId, target, peerAccountId, onClose, onBlocked }: { accountId: string; target: { kind: 'message' | 'comment' | 'account'; id: string }; peerAccountId?: string; onClose: () => void; onBlocked: () => void }) {
  const [reason, setReason] = useState<string>('');
  const [reportAccount, setReportAccount] = useState(target.kind === 'account');
  const [details, setDetails] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  // The epoch endpoint supplies an authorized lifetime without exposing target bodies.
  const state = useSocial<{ epoch: number | string }>('/api/social/epoch', accountId, () => { setDetails(''); setNotice(''); setConfirm(false); setReason(''); setReportAccount(target.kind === 'account'); });
  async function report() {
    if (!reason) return;
    const ok = await state.mutate(async signal => {
      const result = await apiRequest<{ reportId?: string; reported?: boolean }>('/api/safety/reports', { body: { ...(reportAccount && peerAccountId ? { accountId: peerAccountId } : { [`${target.kind}Id`]: target.id }), reason, details: details.trim() || undefined }, signal, expectedAccountId: accountId });
      if (!result?.reportId && result?.reported !== true) throw new Error('Unconfirmed report');
    });
    if (ok) { setDetails(''); setNotice('Report received by the private safety queue.'); }
  }
  async function block() {
    if (!peerAccountId) return;
    const ok = await state.mutate(async signal => {
      const result = await apiRequest<{ blocked: boolean }>('/api/safety/blocks', { body: { accountId: peerAccountId }, signal, expectedAccountId: accountId });
      if (result?.blocked !== true) throw new Error('Unconfirmed block');
    });
    if (ok) onBlocked();
  }
  return <View style={styles.section}><Text accessibilityRole="header" style={typography.section}>Report {reportAccount ? 'account' : target.kind}</Text>
    <Text style={typography.small}>Reports are private to authorized safety operators. Do not include private media or unnecessary personal details.</Text>
    {peerAccountId && target.kind !== 'account' ? <Action label={reportAccount ? `Report this ${target.kind} instead` : 'Report this author account instead'} onPress={() => { setReportAccount(value => !value); setReason(''); setNotice(''); }} /> : null}
    {reportReasons.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: reason === value }} onPress={() => setReason(value)} style={styles.action}><Text style={styles.actionText}>{reason === value ? '● ' : '○ '}{label}</Text></Pressable>)}
    <Input label="Optional report context" value={details} onChange={setDetails} max={1000} disabled={state.busy} />
    <Action label="Submit private report" disabled={state.busy || !reason} onPress={() => { void report(); }} />
    {peerAccountId ? <><Text style={typography.small}>Blocking stops identified account access. Delivered text and media cannot be recalled. Unblocking does not restore previous permissions.</Text>{confirm ? <Action label="Confirm account block" danger disabled={state.busy} onPress={() => { void block(); }} /> : <Action label="Block this account" danger disabled={state.busy} onPress={() => setConfirm(true)} />}</> : null}
    <Action label="Back to discussion" disabled={state.busy} onPress={onClose} />
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.body}>{notice}</Text> : null}<State {...state} />
  </View>;
}
const styles = StyleSheet.create({
  section: { marginVertical: tokens.space.lg, gap: tokens.space.md, borderTopWidth: 1, borderColor: colors.border, paddingTop: tokens.space.lg },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.sm },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: tokens.radius.md, padding: tokens.space.md, backgroundColor: colors.surface, gap: tokens.space.sm },
  input: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.border, borderRadius: tokens.radius.sm, color: colors.text, padding: tokens.space.md, minHeight: 50, textAlignVertical: 'top' },
  action: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: tokens.radius.pill, paddingHorizontal: tokens.space.md, paddingVertical: 13, justifyContent: 'center', backgroundColor: colors.surface },
  actionText: { color: colors.text, fontSize: tokens.type.body }, body: { color: colors.text, fontSize: tokens.type.body, lineHeight: 23 },
  disabled: { opacity: 0.5 }, danger: { backgroundColor: colors.dangerSurface }, dangerText: { color: colors.danger }, error: { color: colors.danger, lineHeight: 22 },
});
