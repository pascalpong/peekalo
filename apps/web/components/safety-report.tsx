'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

const reasons = [
  ['child_safety', 'Child safety or exploitation'],
  ['sexual_content', 'Sexual content'],
  ['violence', 'Violence or threats'],
  ['harassment', 'Harassment or abuse'],
  ['spam', 'Spam or fraud'],
  ['other', 'Another safety concern'],
] as const;

/** Link capabilities stay in memory and request bodies, never rendered or added to URLs. */
export function SafetyReport({ username, link = false, onOpen, onClose }: {
  username?: string; link?: boolean; onOpen?: () => void; onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const target = useRef<{ token: string } | { username: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      generation.current++;
      pending.current?.abort(); pending.current = null; target.current = null;
      setOpen(false); setBusy(false); setDetails(''); setStatus('');
      closeCallback.current?.();
    };
    window.addEventListener('hashchange', changed);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current?.abort(); pending.current = null; target.current = null;
      window.removeEventListener('hashchange', changed);
    };
  }, []);

  const close = () => {
    if (busy) return;
    target.current = null;
    setOpen(false);
    setDetails('');
    setStatus('');
    onClose?.();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || pending.current || !target.current || !reasons.some(([value]) => value === reason)) return;
    const turn = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setStatus('Sending your report…');
    try {
      const response = await fetch('/api/safety/reports', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...target.current, reason, details: details.trim() }),
      });
      if (!mounted.current || generation.current !== turn) return;
      if (!response.ok) {
        setStatus(response.status === 429 ? 'Too many reports were submitted recently. Please try again later or use Support.' : 'Your report could not be submitted. Please try again or use Support.');
        return;
      }
      target.current = null;
      setDetails('');
      setStatus('Report received. Thank you for helping keep Peekalo safe.');
    } catch { if (mounted.current && generation.current === turn) setStatus('Your report could not be submitted. Check your connection and try again.'); }
    finally { if (mounted.current && generation.current === turn) { pending.current = null; setBusy(false); } }
  };

  return <section className="safety-report" aria-label={username ? 'Report account' : 'Report moment'}>
    {!open ? <button className="safety-button" type="button" onClick={() => {
      onOpen?.();
      const token = link ? window.location.hash.slice(1) : '';
      target.current = link && /^[A-Za-z0-9_-]{43}$/.test(token) ? { token } : username ? { username } : null;
      setReason('');
      setOpen(true);
      setStatus(target.current ? '' : 'This moment cannot be identified. Please use Support.');
    }}>{username ? 'Report this account' : 'Report this moment'}</button> : <form onSubmit={submit} className="safety-form">
      <h2>{username ? `Report @${username}` : 'Report this moment'}</h2>
      <p>You can report without revealing. Please do not attach, save or send copies of suspected child sexual abuse material.</p>
      <label>Reason<select required value={reason} disabled={busy || !target.current} onChange={event => setReason(event.target.value)}><option value="" disabled>Select a reason</option>{reasons.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>Additional context (optional)<textarea maxLength={1000} rows={4} value={details} disabled={busy || !target.current} onChange={event => setDetails(event.target.value)} placeholder="Describe the concern. Do not include passwords, share links or unnecessary personal details." /></label>
      <div className="safety-actions"><button className="safety-button safety-primary" type="submit" disabled={busy || !target.current || !reason}>Submit report</button><button className="safety-button" type="button" disabled={busy} onClick={close}>Close</button></div>
      <p role="status" aria-live="polite">{status}</p>
      <p><a href="/support">Support</a> · <a href="/safety">Safety standards</a></p>
    </form>}
  </section>;
}
