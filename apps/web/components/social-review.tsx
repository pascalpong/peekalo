'use client';

import { useEffect, useRef, useState } from 'react';

type Item = { kind: 'message' | 'comment'; itemId: string; authorAccountId: string; status: string; createdAt: string };
type Cursor = { createdAt: string; id: string };
type Review = { body?: string | null; postId?: string | null; authorAccountId?: string; status: string };

/** Private text is fetched only after a deliberate, audited operator inspection. */
export function SocialReview({ request, target }: { request: (path: string, init?: RequestInit) => Promise<Response>; target?: { kind: 'message' | 'comment'; itemId: string } | null }) {
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [content, setContent] = useState<Review | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const bodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimer = () => { if (bodyTimer.current !== null) clearTimeout(bodyTimer.current); bodyTimer.current = null; };
  const hide = () => { cancelTimer(); epoch.current++; setContent(null); setSelected(null); setReason(''); setBusy(false); };
  useEffect(() => {
    const clear = () => { hide(); setItems([]); setCursor(null); };
    const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
    window.addEventListener('blur', clear); window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', visibility);
    return () => { cancelTimer(); epoch.current++; window.removeEventListener('blur', clear); window.removeEventListener('pagehide', clear); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const load = async (next = false) => {
    hide(); setBusy(true); const turn = epoch.current;
    const query = next && cursor ? `?before=${encodeURIComponent(cursor.createdAt)}&beforeId=${encodeURIComponent(cursor.id)}` : '';
    try {
      const result = await request(`/api/operator/social${query}`);
      if (turn !== epoch.current) return;
      if (!result.ok) throw new Error();
      const data = await result.json() as { items: Item[]; nextCursor: Cursor | null };
      if (turn !== epoch.current) return;
      if (!Array.isArray(data.items) || data.items.length > 50) throw new Error();
      setItems(data.items); setCursor(data.nextCursor); setStatus('Text queue loaded. Select an item for audited private review.');
    } catch { if (turn === epoch.current) { setItems([]); setCursor(null); setStatus('Queue unavailable. Check operator access and retry.'); } }
    finally { if (turn === epoch.current) setBusy(false); }
  };
  const inspect = async (item: Item) => {
    hide(); setBusy(true); const turn = epoch.current;
    try {
      const before = await request('/api/operator/social/epoch');
      if (turn !== epoch.current) return;
      if (!before.ok) throw new Error();
      const beforeEpoch = await before.json() as { epoch: number };
      const result = await request(`/api/operator/social/${item.kind}/${encodeURIComponent(item.itemId)}`);
      if (turn !== epoch.current) return;
      if (!result.ok) throw new Error();
      const data = await result.json() as Review;
      if (turn !== epoch.current) return;
      const after = await request('/api/operator/social/epoch');
      if (turn !== epoch.current) return;
      if (!after.ok) throw new Error();
      const afterEpoch = await after.json() as { epoch: number };
      if (turn !== epoch.current) return;
      if (!Number.isSafeInteger(beforeEpoch.epoch) || beforeEpoch.epoch !== afterEpoch.epoch) throw new Error();
      setSelected(item); setContent(data); setStatus('Private text loaded briefly for this assessment. Do not copy it into the reason.');
      bodyTimer.current = setTimeout(() => {
        bodyTimer.current = null; epoch.current++; setContent(null); setBusy(false);
        setStatus('Private text hidden after 15 seconds. Reopen it to verify current access. Your assessment draft remains.');
      }, 15_000);
    } catch { if (turn === epoch.current) setStatus('Private review unavailable or access denied.'); }
    finally { if (turn === epoch.current) setBusy(false); }
  };
  useEffect(() => {
    if (target) void inspect({ ...target, authorAccountId: '', status: '', createdAt: '' });
  }, [target]);
  const decide = async (action: 'approve' | 'reject' | 'takedown') => {
    if (!selected || busy || !reason.trim()) return;
    const item = selected, note = reason; hide(); setBusy(true); const turn = epoch.current;
    try {
      const result = await request(`/api/operator/social/${item.kind}/${encodeURIComponent(item.itemId)}`, { method: 'POST', body: JSON.stringify({ action, reason: note }) });
      if (turn !== epoch.current) return;
      if (!result.ok) throw new Error();
      setItems(previous => previous.filter(row => row.itemId !== item.itemId)); setStatus('Text decision saved. Delivered text cannot be recalled.');
    } catch { if (turn === epoch.current) setStatus('Decision not confirmed. Reload and inspect before retrying.'); }
    finally { if (turn === epoch.current) setBusy(false); }
  };
  return <section className="safety-panel"><h2>Private text review</h2><p>Messages and comments require independent approval before peers can read them. Owners cannot approve their own text. Queue entries contain no bodies; deliberate inspection is audited.</p>
    <button className="safety-button" disabled={busy} onClick={() => void load()}>Load text queue</button>
    <p role="status">{status}</p>
    <div className="operator-list">{items.map(item => <article key={`${item.kind}:${item.itemId}`}><h3>{item.kind} · {item.status.replaceAll('_', ' ')}</h3><p className="operator-id">{item.itemId}</p><p>{item.createdAt}</p><button className="safety-button" disabled={busy} onClick={() => void inspect(item)}>Review text privately</button></article>)}</div>
    {cursor && <button className="safety-button" disabled={busy} onClick={() => void load(true)}>Load older text</button>}
    {selected && <article><h3>Private {selected.kind} assessment</h3><p className="operator-id">{selected.itemId}</p>{content ? <p className="operator-details">{content.body ?? 'Moment reference. This review does not grant access to its media.'}</p> : <button className="safety-button" disabled={busy} onClick={() => void inspect(selected)}>Reopen private text</button>}<label className="safety-form">Assessment reason<textarea maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Record the policy assessment without quoting private content." /></label><div className="safety-actions">{(['approve', 'reject', 'takedown'] as const).map(action => <button key={action} className="safety-button" disabled={busy || !reason.trim()} onClick={() => void decide(action)}>{action === 'takedown' ? 'Take down' : action === 'approve' ? 'Approve' : 'Reject'}</button>)}<button className="safety-button" onClick={hide}>Close private text</button></div></article>}
  </section>;
}
