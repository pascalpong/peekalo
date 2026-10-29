import * as Linking from 'expo-linking';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiRequest, resolveApiUrl, SharingError } from '../lib/sharing-client';
import { colors, tokens, typography } from './ui';

const reasons = [
  ['child_safety', 'Child safety'], ['sexual_content', 'Sexual content'], ['violence', 'Violence or threats'],
  ['harassment', 'Harassment or hate'], ['privacy', 'Privacy violation'], ['spam', 'Spam or scam'], ['other', 'Something else'],
] as const;
type Reason = typeof reasons[number][0];
export type SafetyTarget = { postId: string; username?: string | null; accountId?: string };
type Config = { standardsUrl: string | null; supportUrl: string | null; contactConfigured: boolean; agePolicyConfigured: boolean; manualApproval: boolean };
type Block = { accountId?: string; username: string | null; createdAt: string };

function Action({ label, disabled, onPress, danger = false }: { label: string; disabled?: boolean; onPress: () => void; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[styles.action, danger && styles.danger, disabled && styles.disabled]}>
    <Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text>
  </Pressable>;
}

/** Parent unmounts the clear viewer before mounting this panel. No media is fetched. */
export function SafetyPanel({ target, accountId, onClose, onBlocked }: { target: SafetyTarget; accountId: string; onClose: () => void; onBlocked: () => void }) {
  const label = target.username ? `@${target.username}` : 'Account awaiting review';
  const targetAccount = target.accountId ? { accountId: target.accountId } : { username: target.username };
  const [scope, setScope] = useState<'post' | 'account'>('post');
  const [reason, setReason] = useState<Reason>('child_safety');
  const [details, setDetails] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); lifetime.current = null; };
  }, []);

  async function submit(block: boolean) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    const current = () => lifetime.current === controller && !controller.signal.aborted;
    try {
      if (block) {
        const result = await apiRequest<{ blocked: boolean }>('/api/safety/blocks', { body: targetAccount, signal: controller.signal, expectedAccountId: accountId });
        if (!current()) return;
        if (result.blocked !== true) throw new Error('Unconfirmed block');
        onBlocked();
      } else {
        const result = await apiRequest<{ reportId?: string; reported?: boolean }>('/api/safety/reports', {
          body: { ...(scope === 'post' ? { postId: target.postId } : targetAccount), reason, details: details.trim() || undefined },
          signal: controller.signal, expectedAccountId: accountId,
        });
        if (!current()) return;
        if (!result.reportId && result.reported !== true) throw new Error('Unconfirmed report');
        setDetails(''); setNotice('Report received by Peekalo’s safety queue. You can also block this account below.');
      }
    } catch (failure) {
      if (current()) setError(failure instanceof SharingError ? failure.message : 'This action was not confirmed. Please try again.');
    } finally { if (current()) { operation.current = false; setBusy(false); } }
  }

  return <View style={styles.section}>
    <Text accessibilityRole="header" style={typography.section}>Safety · {label}</Text>
    <Text style={typography.body}>Reports are private to the safety team. Do not attach, copy or describe private images in detail; a moment report identifies it securely.</Text>
    <Action label="Back to inbox" disabled={busy} onPress={onClose} />
    <Action label={scope === 'post' ? 'Reporting this moment' : 'Report this moment'} disabled={busy} onPress={() => { setScope('post'); setNotice(''); }} />
    <Action label={scope === 'account' ? 'Reporting this account' : 'Report this account'} disabled={busy} onPress={() => { setScope('account'); setNotice(''); }} />
    <Text style={typography.body}>Choose the reason</Text>
    {reasons.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: reason === value, disabled: busy }} disabled={busy} onPress={() => setReason(value)} style={[styles.reason, reason === value && styles.chosen]}>
      <Text style={styles.actionText}>{reason === value ? '● ' : '○ '}{label}</Text>
    </Pressable>)}
    <TextInput accessibilityLabel="Optional report details" style={styles.input} value={details} onChangeText={setDetails} editable={!busy} multiline maxLength={1000} placeholder="Optional context, without private media or contact details" placeholderTextColor={colors.muted} />
    <Action label="Submit report" disabled={busy} onPress={() => { void submit(false); }} />
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.body}>{notice}</Text> : null}
    <Text style={typography.section}>Block {label}</Text>
    <Text style={typography.body}>Blocks stop sharing and viewing between these identified accounts and revoke existing recipient access. Unblocking does not restore it. An anonymous link visitor cannot reliably be matched to an account; revoke your external links to stop future access through them. Delivered media cannot be recalled.</Text>
    {confirm ? <><Action label={`Confirm block ${label}`} disabled={busy} danger onPress={() => { void submit(true); }} /><Action label="Cancel block" disabled={busy} onPress={() => setConfirm(false)} /></>
      : <Action label={`Block ${label}`} disabled={busy} danger onPress={() => setConfirm(true)} />}
    {busy ? <ActivityIndicator color={colors.text} accessibilityLabel="Sending safety action" /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

/** The account key in Profile makes auth changes discard private block state. */
export function SafetySettings({ accountId }: { accountId: string | null }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const configRequest = new AbortController();
    const timeout = setTimeout(() => configRequest.abort(), 30_000);
    void (async () => {
      try {
        const response = await fetch(resolveApiUrl('/api/safety/config'), { cache: 'no-store', signal: configRequest.signal });
        if (!response.ok) throw new Error('Unavailable');
        const result = await response.json() as Config;
        if (!controller.signal.aborted) setConfig(result);
      } catch { if (!controller.signal.aborted) setError('Cannot load safety information. Reopen Profile to try again.'); }
      finally { clearTimeout(timeout); }
    })();
    return () => { controller.abort(); configRequest.abort(); clearTimeout(timeout); lifetime.current = null; };
  }, []);
  async function manage(target?: Block) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || operation.current || !accountId) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    const current = () => lifetime.current === controller && !controller.signal.aborted;
    try {
      if (target) {
        const result = await apiRequest<{ blocked: boolean }>('/api/safety/blocks', { method: 'DELETE', body: target.accountId ? { accountId: target.accountId } : { username: target.username }, signal: controller.signal, expectedAccountId: accountId });
        if (!current()) return;
        if (result.blocked !== false) throw new Error('Unconfirmed unblock');
        setBlocks(previous => previous.filter(item => target.accountId ? item.accountId !== target.accountId : item.username !== target.username));
        setNotice(`${target.username ? `@${target.username}` : 'Account'} unblocked. Previous grants and links remain revoked.`);
      } else {
        const result = await apiRequest<{ items: Block[] }>('/api/safety/blocks', { signal: controller.signal, expectedAccountId: accountId });
        if (current()) { setBlocks(result.items); setExpanded(true); }
      }
    } catch (failure) { if (current()) setError(failure instanceof SharingError ? failure.message : 'This action was not confirmed. Please try again.'); }
    finally { if (current()) { operation.current = false; setBusy(false); } }
  }
  async function open(raw: string | null) {
    if (!raw) return;
    const controller = lifetime.current;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.origin !== new URL(resolveApiUrl('/')).origin) throw new Error('Invalid URL');
      await Linking.openURL(url.toString());
    } catch { if (controller && !controller.signal.aborted) setError('This safety page could not be opened. Please try again.'); }
  }
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={typography.section}>Safety and support</Text>
    <Text style={typography.body}>Every moment waits for manual approval before sharing. Report a moment or account from Inbox. Child sexual abuse and exploitation, grooming, threats and harassment are prohibited.</Text>
    {config?.standardsUrl ? <Action label="Safety and child-safety standards" onPress={() => { void open(config.standardsUrl); }} /> : null}
    {config?.supportUrl ? <Action label="Support and safety feedback" onPress={() => { void open(config.supportUrl); }} /> : null}
    {config && !config.contactConfigured ? <Text style={typography.small}>A working public support contact is still pending. External beta release is not ready.</Text> : null}
    {config && !config.agePolicyConfigured ? <Text style={typography.small}>The operator’s final audience and age policy is still pending.</Text> : null}
    {accountId ? <Action label={expanded ? 'Refresh blocked accounts' : 'Manage blocked accounts'} disabled={busy} onPress={() => { void manage(); }} /> : null}
    {expanded && <>
      <Text style={typography.small}>Blocks apply to identified accounts. Anonymous link viewers cannot reliably be matched to blocked accounts. Unblocking never restores revoked access.</Text>
      {blocks.length === 0 ? <Text style={typography.body}>You have no blocked accounts.</Text> : blocks.map(item => <View key={item.accountId ?? item.username} style={styles.block}>
        <Text style={typography.body}>{item.username ? `@${item.username}` : 'Account awaiting review'}</Text><Action label={item.username ? `Unblock @${item.username}` : 'Unblock account'} disabled={busy} onPress={() => { void manage(item); }} />
      </View>)}
    </>}
    {busy ? <ActivityIndicator color={colors.text} accessibilityLabel="Updating blocked accounts" /> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.body}>{notice}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 14, borderTopWidth: 1, borderColor: colors.border, marginTop: 22, paddingTop: 24 },
  action: { minHeight: 48, padding: 15, borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.text, fontSize: 14, fontWeight: '600' }, disabled: { opacity: 0.55 },
  danger: { borderColor: colors.danger, backgroundColor: colors.dangerSurface }, dangerText: { color: colors.danger },
  error: { color: colors.danger, lineHeight: 21 }, input: { minHeight: 95, borderRadius: tokens.radius.sm, backgroundColor: colors.elevated, color: colors.text, padding: 16, fontSize: 15, textAlignVertical: 'top' },
  reason: { minHeight: 48, padding: 14, borderRadius: tokens.radius.sm, borderWidth: 1, borderColor: colors.border }, chosen: { borderColor: colors.accent },
  block: { gap: 10, paddingVertical: 10 },
});
