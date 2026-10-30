'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createDeletionClient, deletionCallback, deletionReceipt, deletionStatusUrl, type DeletionReceipt } from '../lib/deletion-auth';

type Connection = Awaited<ReturnType<typeof createDeletionClient>>;
type Verified = { token: string; email: string };

/** Destructive actions require a fresh isolated sign-in and a separate deliberate confirmation. */
export function AccountDeletion() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  const connection = useRef<Promise<Connection> | null>(null);
  const initialization = useRef<Promise<Verified | null> | null>(null);
  const verified = useRef<Verified | null>(null);
  const working = useRef(false);
  const pendingAuth = useRef<Promise<unknown> | null>(null);
  const turn = useRef(0);
  const alive = useRef(true);
  const redirecting = useRef(false);

  const clear = () => {
    turn.current++; verified.current = null;
    void connection.current?.then(value => { value.storage.clear(); }).catch(() => undefined);
    setPassword(''); setEmail(''); setIdentity(''); setConfirmation(false); working.current = false; setBusy(false);
  };
  useEffect(() => {
    let active = true; alive.current = true;
    if (!initialization.current) {
      const initialReceipt = deletionReceipt(window.location.href);
      if (initialReceipt) { setReceipt(initialReceipt); setSubmitted(true); setStatus('Deletion receipt loaded. Choose Check deletion status to request the latest result.'); }
      const callback = initialReceipt ? { present: false, code: null, flowId: null } : deletionCallback(window.location.href);
      // Remove all callback parameters before any network request or rendering.
      window.history.replaceState(null, '', window.location.pathname);
      connection.current = createDeletionClient(window.sessionStorage).catch(() => { throw new Error('connection'); });
      initialization.current = connection.current.then(async value => {
        if (!callback.present) return null;
        if (!callback.code || !value.storage.consumeStart()) { value.storage.clear(); throw new Error('callback'); }
        try {
          const result = await value.client.auth.exchangeCodeForSession(callback.code, callback.flowId ? { flowId: callback.flowId } : undefined);
          if (result.error || !result.data.session || (result.data as { redirectType?: string }).redirectType === 'recovery') throw new Error('callback');
          return { token: result.data.session.access_token, email: result.data.session.user.email || 'Verified account' };
        } finally { value.storage.clear(); }
      });
    }
    const initialTurn = turn.current;
    void initialization.current.then(value => {
      if (!active || !alive.current || initialTurn !== turn.current) return;
      verified.current = value; setIdentity(value?.email || ''); setReady(true);
      if (value) setStatus('Account verified. Review the deletion details, then confirm below.');
    }).catch(error => { if (active && alive.current && initialTurn === turn.current) {
      const unavailable = error instanceof Error && error.message === 'connection';
      setReady(!unavailable); setConnectionFailed(unavailable);
      setStatus(unavailable ? 'Account verification could not connect. Reconnect below to try again. No deletion request was submitted.' : 'Verification is unavailable or the sign-in link has expired. Start a fresh sign-in below.');
    } });
    const leave = () => { alive.current = false; turn.current++; verified.current = null; if (!redirecting.current) void connection.current?.then(value => value.storage.clear()).catch(() => undefined); };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      alive.current = true; redirecting.current = false; verified.current = null;
      const id = ++turn.current;
      working.current = false; setBusy(false); setReady(false); setConnectionFailed(false);
      setEmail(''); setPassword(''); setIdentity(''); setConfirmation(false);
      setStatus('Page restored. Verification was cleared; reconnecting before a fresh sign-in. A deletion request sent before leaving may already be pending.');
      const previous = connection.current;
      // Old Auth work may still finish after a BFCache restoration. Settle and
      // clear it before a new client can create another PKCE verifier.
      connection.current = Promise.allSettled([initialization.current, previous, pendingAuth.current]).then(async () => {
        try { (await previous)?.storage.clear(); } catch { /* A failed connection has no session to clear. */ }
        return createDeletionClient(window.sessionStorage);
      });
      void connection.current.then(() => {
        if (active && alive.current && id === turn.current) { setReady(true); setStatus('Page restored. Verify again before deleting an account, or check your saved deletion receipt.'); }
      }).catch(() => { if (active && alive.current && id === turn.current) { setConnectionFailed(true); setStatus('Account verification could not connect. Reconnect below to try again.'); } });
    };
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', restore);
    return () => { active = false; alive.current = false; window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restore); };
  }, []);

  const reconnect = async () => {
    if (working.current) return;
    working.current = true; setBusy(true); setReady(false); setConnectionFailed(false);
    const id = ++turn.current; verified.current = null;
    setEmail(''); setPassword(''); setIdentity(''); setConfirmation(false); setStatus('Reconnecting account verification…');
    try {
      const previous = connection.current;
      await Promise.allSettled([initialization.current, previous, pendingAuth.current]);
      try { (await previous)?.storage.clear(); } catch { /* Nothing to clear after a failed configuration request. */ }
      if (!alive.current || id !== turn.current) return;
      // This retries configuration only. The consumed callback is never replayed.
      connection.current = createDeletionClient(window.sessionStorage);
      await connection.current;
      if (alive.current && id === turn.current) { setReady(true); setStatus('Connected. Verify account control before confirming deletion.'); }
    } catch { if (alive.current && id === turn.current) { setConnectionFailed(true); setStatus('Account verification could not connect. Reconnect below to try again.'); } }
    finally { if (id === turn.current) { working.current = false; if (alive.current) setBusy(false); } }
  };
  const signIn = async (event: FormEvent) => {
    event.preventDefault(); if (!alive.current || !ready || working.current || !connection.current) return;
    working.current = true; setBusy(true); setStatus('Verifying account control…');
    const id = ++turn.current; verified.current = null;
    const address = email.trim(); const secret = password; setPassword('');
    try {
      const value = await connection.current;
      if (!alive.current || id !== turn.current) return;
      value.storage.clear();
      const request = value.client.auth.signInWithPassword({ email: address, password: secret });
      pendingAuth.current = request;
      const result = await request;
      value.storage.clear();
      if (!alive.current || id !== turn.current) return;
      if (result.error || !result.data.session) throw new Error('sign-in');
      verified.current = { token: result.data.session.access_token, email: result.data.session.user.email || address };
      setEmail(''); setIdentity(verified.current.email); setConfirmation(false);
      setStatus('Account verified. Review the deletion details, then confirm below.');
    } catch { if (alive.current && id === turn.current) setStatus('Sign-in failed. Check your details or try again later. No deletion request was submitted.'); }
    finally { if (id === turn.current) { working.current = false; if (alive.current) setBusy(false); } }
  };
  const google = async () => {
    if (!alive.current || !ready || working.current || !connection.current) return;
    working.current = true; setBusy(true); setPassword(''); setStatus('Opening Google to verify account control…');
    const id = ++turn.current;
    try {
      const value = await connection.current;
      if (!alive.current || id !== turn.current) return;
      value.storage.clear(); value.storage.start();
      const request = value.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/delete-account`, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } });
      pendingAuth.current = request;
      const result = await request;
      if (!alive.current || id !== turn.current) { value.storage.clear(); return; }
      if (result.error || !result.data.url) { value.storage.clear(); throw new Error('sign-in'); }
      // Leave the verifier for this navigation; no session has been established.
      redirecting.current = true;
      window.location.assign(result.data.url);
    } catch { if (alive.current && id === turn.current) setStatus('Google verification could not start. Its browser callback must be configured before use. No deletion request was submitted.'); }
    finally { if (id === turn.current) { working.current = false; if (alive.current) setBusy(false); } }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const account = verified.current;
    if (working.current || !account || !confirmation || submitted) return;
    working.current = true; setBusy(true); setStatus('Submitting deletion request…');
    const id = ++turn.current;
    try {
      const response = await fetch('/api/account/delete', { method: 'POST', headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }), cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
      const result = await response.json() as { status?: string; requestId?: string; receipt?: string };
      if (!alive.current || id !== turn.current) return;
      if (!response.ok || result.status !== 'pending' || typeof result.requestId !== 'string' || typeof result.receipt !== 'string') throw new Error('request');
      const proof = deletionReceipt(`${window.location.origin}${deletionStatusUrl({ requestId: result.requestId, receipt: result.receipt })}`);
      if (!proof) throw new Error('receipt');
      setReceipt(proof); clear(); setSubmitted(true);
      setStatus('Deletion request accepted. Future access is disabled. Private storage, account-data and authentication cleanup is pending; this is not confirmation of completed erasure.');
    } catch {
      if (alive.current && id === turn.current) {
        setStatus('Deletion could not be confirmed. It may have reached the server. Retry this request to recover its receipt; repeating it does not create a second deletion. Keep this page open until the result is confirmed.');
      }
    } finally { if (id === turn.current) { working.current = false; if (alive.current) setBusy(false); } }
  };
  const checkStatus = async () => {
    if (working.current || !receipt) return;
    working.current = true; setBusy(true); setStatus('Checking deletion status…');
    const id = ++turn.current;
    try {
      const response = await fetch('/api/account/deletion-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt), cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
      const value = await response.json() as { status?: string; needsAppleReauthentication?: boolean };
      if (!alive.current || id !== turn.current) return;
      if (!response.ok || !['pending', 'complete'].includes(value.status || '')) throw new Error('status');
      setStatus(value.status === 'complete' ? 'Account deletion cleanup is complete. Narrow retained records and any backup restrictions follow the privacy notice. This status receipt expires 30 days after completion.'
        : value.needsAppleReauthentication ? 'Deletion remains pending. Reconnect Sign in with Apple through the iOS deletion flow to complete provider-token revocation. Account access remains disabled.'
          : 'Deletion remains pending. Account access is disabled; unfinished cleanup steps remain queued for retry.');
    } catch { if (alive.current && id === turn.current) setStatus('Deletion status is unavailable or this receipt has expired. No completion result could be confirmed. Keep your receipt link and try again later.'); }
    finally { if (id === turn.current) { working.current = false; if (alive.current) setBusy(false); } }
  };
  return <section className="safety-panel" aria-labelledby="deletion-heading">
    <h2 id="deletion-heading">Request permanent deletion</h2>
    <p>Verify the account you want to delete. Signing in here only authorizes this deletion flow; it does not open your private moments in this browser.</p>
    {connectionFailed && <button className="safety-button" type="button" disabled={busy} onClick={() => { void reconnect(); }}>Reconnect verification</button>}
    {!submitted && !identity && <><form className="safety-form" onSubmit={signIn}>
      <label>Email<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={busy || !ready} /></label>
      <label>Password<input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={busy || !ready} /></label>
      <button className="safety-button safety-primary" type="submit" disabled={busy || !ready}>Verify with email and password</button>
    </form><button className="safety-button" type="button" onClick={() => { void google(); }} disabled={busy || !ready}>Verify with Google</button>
    <p>Use the same sign-in method as your account. Google browser sign-in needs the configured callback. Apple web sign-in and monitored support recovery are not configured; existing Apple accounts can initiate deletion in the iOS app. This remaining browser-access gap blocks release for that provider.</p></>}
    {!submitted && identity && <form className="safety-form" onSubmit={submit}>
      <p>Verified account: <strong>{identity}</strong></p>
      <label className="deletion-check"><input type="checkbox" checked={confirmation} onChange={event => setConfirmation(event.target.checked)} disabled={busy} />I want to permanently delete this account and its associated moments. I understand access stops when accepted and cleanup can remain pending.</label>
      <button className="safety-button safety-primary" type="submit" disabled={busy || !confirmation}>Delete this account permanently</button>
      <button className="safety-button" type="button" disabled={busy} onClick={() => { clear(); setStatus('Verification cleared. No new deletion request was submitted.'); }}>Cancel verification</button>
    </form>}
    {receipt && <><p><a href={deletionStatusUrl(receipt)} referrerPolicy="no-referrer">Save this private deletion-status link</a>. Keep it private: anyone with this receipt can check this request’s status. It contains no media access and is not a sign-in link.</p><button className="safety-button" type="button" disabled={busy} onClick={() => { void checkStatus(); }}>Check deletion status</button></>}
    <p role="status" aria-live="polite">{status || (!ready ? 'Connecting secure account verification…' : '')}</p>
  </section>;
}
