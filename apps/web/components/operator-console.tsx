'use client';

import { SocialReview } from './social-review';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type PendingPost = { postId: string; username: string; kind: 'photo' | 'video'; status: string; createdAt: string };
type SafetyReport = { reportId: string; targetKind?: string; targetId?: string; postId?: string | null; username?: string | null; reason: string; details?: string | null; createdAt: string; state: string };
type Queue = { posts: PendingPost[]; reports: SafetyReport[]; profiles?: { username: string; reviewState: string; createdAt?: string }[] };
type Audit = { id: string; operatorId: string; event: string; targetId: string | null; note: string | null; createdAt: string };
type Media = { postId: string; url: string; kind: 'photo' | 'video' };

/** Authorized account tokens and private review bytes live only in this mounted page. */
export function OperatorConsole() {
  const [credential, setCredential] = useState('');
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<Media | null>(null);
  const [selected, setSelected] = useState('');
  const [socialTarget, setSocialTarget] = useState<{ kind: 'message' | 'comment'; itemId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountReason, setAccountReason] = useState('');
  const [audit, setAudit] = useState<Audit[] | null>(null);
  const token = useRef('');
  const mediaUrl = useRef<string | null>(null);
  const mediaRequest = useRef<AbortController | null>(null);
  const reviewVideo = useRef<HTMLVideoElement | null>(null);
  const mediaTurn = useRef(0);
  const sessionTurn = useRef(0);

  const releaseMedia = () => {
    if (reviewVideo.current) {
      reviewVideo.current.pause();
      reviewVideo.current.removeAttribute('src');
      reviewVideo.current.load();
      reviewVideo.current = null;
    }
    mediaTurn.current++;
    mediaRequest.current?.abort();
    mediaRequest.current = null;
    if (mediaUrl.current) URL.revokeObjectURL(mediaUrl.current);
    mediaUrl.current = null;
  };
  const hideMedia = () => { releaseMedia(); setMedia(null); };
  const disconnect = () => {
    sessionTurn.current++;
    token.current = '';
    hideMedia();
    setCredential('');
    setConnected(false);
    setBusy(false);
    setQueue(null);
    setSelected('');
    setReason('');
    setAccountName('');
    setAccountReason('');
    setAudit(null); setSocialTarget(null);
    setStatus('Operator session cleared.');
  };
  useEffect(() => {
    const hide = () => { if (document.visibilityState !== 'visible') hideMedia(); };
    const leave = () => { disconnect(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', hideMedia);
    window.addEventListener('pagehide', leave);
    return () => {
      token.current = '';
      sessionTurn.current++;
      releaseMedia();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', hideMedia);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token.current}`);
    if (init?.body) headers.set('Content-Type', 'application/json');
    return fetch(path, { ...init, headers, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  };
  const load = async () => {
    const turn = sessionTurn.current;
    const response = await request('/api/operator/queue');
    if (turn !== sessionTurn.current) return false;
    if (!response.ok) {
      hideMedia();
      setSelected('');
      setReason('');
      setQueue(null);
      setAudit(null);
      setConnected(false);
      token.current = '';
      setStatus(response.status === 401 || response.status === 403 ? 'Access denied. Use an active account explicitly authorized as a safety operator.' : 'The queue could not load. Try again.');
      return false;
    }
    const result = await response.json() as Queue;
    if (turn !== sessionTurn.current) return false;
    if (!Array.isArray(result.posts) || !Array.isArray(result.reports)) throw new Error('invalid_queue');
    setQueue(result);
    setConnected(true);
    return true;
  };
  const refresh = async () => {
    if (busy) return;
    hideMedia();
    setBusy(true);
    setStatus('Loading restricted queue…');
    const turn = sessionTurn.current;
    try { if (await load()) setStatus('Queue loaded. Every queue, media and decision request is audited.'); }
    catch { if (turn === sessionTurn.current) setStatus('The queue could not load. Check your connection and retry.'); }
    finally { if (turn === sessionTurn.current) setBusy(false); }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !credential.trim()) return;
    token.current = credential.trim();
    setCredential('');
    await refresh();
  };
  const inspect = async (postId: string) => {
    if (busy) return;
    hideMedia();
    setSelected(postId);
    setReason('');
    const turn = mediaTurn.current;
    const controller = new AbortController();
    mediaRequest.current = controller;
    setStatus('Requesting private media for manual review…');
    try {
      const response = await request(`/api/operator/media/${encodeURIComponent(postId)}`, { signal: controller.signal });
      if (turn !== mediaTurn.current) return;
      if (!response.ok) { setStatus('Review media is unavailable or operator access was denied.'); return; }
      const type = response.headers.get('content-type')?.split(';')[0];
      if (type !== 'image/jpeg' && type !== 'video/mp4') throw new Error('invalid_media');
      const bytes = await response.blob();
      if (turn !== mediaTurn.current) return;
      const url = URL.createObjectURL(bytes);
      mediaUrl.current = url;
      setMedia({ postId, url, kind: type === 'video/mp4' ? 'video' : 'photo' });
      setStatus('Private review media loaded. Close it when your assessment is complete.');
    } catch { if (turn === mediaTurn.current) setStatus('Review media could not load. Try again.'); }
    finally { if (turn === mediaTurn.current) mediaRequest.current = null; }
  };
  const decide = async (action: 'approve' | 'reject' | 'takedown') => {
    if (busy || !selected || !reason.trim()) return;
    setBusy(true);
    const turn = sessionTurn.current;
    hideMedia();
    try {
      const response = await request('/api/operator/decision', { method: 'POST', body: JSON.stringify({ postId: selected, action, reason: reason.trim() }) });
      if (turn !== sessionTurn.current) return;
      if (!response.ok) { setStatus('The decision was not saved. Refresh before retrying; the moment may have changed.'); return; }
      setSelected('');
      setReason('');
      if (await load()) setStatus('Decision saved. Future access follows the updated moderation state.');
    } catch { if (turn === sessionTurn.current) setStatus('The decision response was lost. Refresh the queue before retrying.'); }
    finally { if (turn === sessionTurn.current) setBusy(false); }
  };
  const resolve = async (reportId: string, state: 'resolved' | 'dismissed', note: string) => {
    if (busy || !note.trim()) return;
    setBusy(true);
    const turn = sessionTurn.current;
    try {
      const response = await request(`/api/operator/reports/${encodeURIComponent(reportId)}`, { method: 'POST', body: JSON.stringify({ state, note: note.trim() }) });
      if (turn !== sessionTurn.current) return;
      if (!response.ok) { setStatus('Report resolution was not saved. Refresh and retry.'); return; }
      if (await load()) setStatus('Report response recorded. Closing a report does not itself take down a moment.');
    } catch { if (turn === sessionTurn.current) setStatus('The response was lost. Refresh before retrying.'); }
    finally { if (turn === sessionTurn.current) setBusy(false); }
  };

  const accountAction = async (path: 'account' | 'profile', username: string, action: string, note: string) => {
    if (busy || !/^[a-z0-9_]{3,24}$/.test(username) || !note.trim()) return;
    setBusy(true);
    const turn = sessionTurn.current;
    hideMedia();
    try {
      const response = await request(`/api/operator/${path}`, { method: 'POST', body: JSON.stringify({ username, action, reason: note.trim() }) });
      if (turn !== sessionTurn.current) return;
      if (!response.ok) { setStatus('The account decision was not saved. Refresh and verify its current state before retrying.'); return; }
      setAccountName(''); setAccountReason('');
      if (await load()) setStatus('Account decision recorded. Existing viewing budgets have not been reset.');
    } catch { if (turn === sessionTurn.current) setStatus('The decision response was lost. Refresh before retrying.'); }
    finally { if (turn === sessionTurn.current) setBusy(false); }
  };
  const loadAudit = async () => {
    if (busy) return;
    setBusy(true);
    const turn = sessionTurn.current;
    try {
      const response = await request('/api/operator/audit');
      if (turn !== sessionTurn.current) return;
      if (!response.ok) { setAudit(null); setStatus('Audit access was denied or the log is unavailable.'); return; }
      const result = await response.json() as { items: Audit[] };
      if (turn !== sessionTurn.current) return;
      if (!Array.isArray(result.items)) throw new Error('invalid_audit');
      setAudit(result.items);
      setStatus('Restricted audit log loaded.');
    } catch { if (turn === sessionTurn.current) setStatus('The audit log could not load.'); }
    finally { if (turn === sessionTurn.current) setBusy(false); }
  };

  return <>
    <section className="safety-panel"><h2>Restricted operator access</h2><p>Only active, explicitly authorized safety-operator accounts can load this queue or review media. Use a short-lived account access token from your approved operator sign-in. Never enter a service-role key, password or refresh token. This page keeps the access token in memory until you clear the session or leave.</p>
      {!connected ? <form className="safety-form" onSubmit={connect}><label>Operator account access token<input type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="off" spellCheck={false} maxLength={8192} required disabled={busy} /></label><button className="safety-button safety-primary" disabled={busy} type="submit">Open review queue</button></form> : <div className="safety-actions"><button className="safety-button" type="button" disabled={busy} onClick={() => void refresh()}>Refresh queue</button><button className="safety-button" type="button" onClick={disconnect}>Clear operator session</button></div>}
      <p role="status" aria-live="polite">{status}</p>
    </section>
    {queue && <>
      <SocialReview key={sessionTurn.current} request={request} target={socialTarget} />
      <section className="safety-panel"><h2>Pending profile names</h2><p>New or changed usernames require manual approval before publication. Reject names that violate the standards. This decision does not approve the account&apos;s moments.</p><div className="operator-list">{(queue.profiles ?? []).map(profile => <ProfileItem key={profile.username} username={profile.username} busy={busy} decide={accountAction} />)}</div>{!queue.profiles?.length && <p>No profile names awaiting review.</p>}</section>
      <section className="safety-panel"><h2>Awaiting pre-publication review</h2><p>Review each moment against the <a href="/safety" target="_blank" rel="noreferrer">safety standards</a> before approval. No automatic filtering provider is connected. An approval permits sharing; it does not create a recipient grant or reset viewing budgets.</p>
        {!queue.posts.length && <p>No moments in this queue.</p>}
        <div className="operator-list">{queue.posts.map(post => <article key={post.postId}><h3>@{post.username} · {post.kind === 'video' ? 'Video' : 'Photo'} · {post.status.replaceAll('_', ' ')}</h3><p><time dateTime={post.createdAt}>{post.createdAt}</time></p><p className="operator-id">{post.postId}</p><button className="safety-button" type="button" disabled={busy} onClick={() => void inspect(post.postId)}>Review privately</button></article>)}</div>
      </section>
      {selected && <section className="safety-panel"><h2>Moment assessment</h2><p className="operator-id">{selected}</p>
        {media?.postId === selected && <div className="operator-media">{media.kind === 'photo' ? (
          // eslint-disable-next-line @next/next/no-img-element -- Authorized private blob, deliberately excluded from image optimization and caches.
          <img src={media.url} alt="Private moment for authorized moderation review" />
        ) : <video ref={reviewVideo} src={media.url} controls playsInline preload="metadata" controlsList="nodownload noremoteplayback" disablePictureInPicture />}</div>}
        <button className="safety-button" type="button" onClick={hideMedia}>Close clear media</button>
        <label className="safety-form">Decision reason<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={3} disabled={busy} placeholder="Record the policy assessment. Do not copy sensitive content into the audit." /></label>
        <div className="safety-actions"><button className="safety-button safety-primary" disabled={busy || !reason.trim()} type="button" onClick={() => void decide('approve')}>Approve pending moment</button><button className="safety-button" disabled={busy || !reason.trim()} type="button" onClick={() => void decide('reject')}>Reject pending moment</button><button className="safety-button" disabled={busy || !reason.trim()} type="button" onClick={() => void decide('takedown')}>Take down moment</button></div>
        <p>A takedown stops future authorized access and revokes its links and grants. It cannot recall delivered bytes. Follow the designated child-safety escalation process separately when needed.</p>
      </section>}
      <section className="safety-panel"><h2>Reports and feedback</h2><p>Assess child-safety reports first. Taking down a moment and recording the report response are separate actions. Account-level enforcement and any legally required escalation must be handled through the restricted operating process.</p>
        {!queue.reports.length && <p>No open reports in this queue.</p>}
        <div className="operator-list">{queue.reports.map(report => <ReportItem key={report.reportId} report={report} busy={busy} inspect={inspect} resolve={resolve} inspectSocial={setSocialTarget} />)}</div>
      </section>
      <section className="safety-panel"><h2>Account enforcement</h2><p>Use the reported account&apos;s current username. Suspension restricts account activity and future media access. Restoration does not undo revoked sharing grants or reset allowances.</p><div className="safety-form"><label>Account username<input value={accountName} onChange={event => setAccountName(event.target.value.toLowerCase().replace(/^@/, ''))} maxLength={24} disabled={busy} autoComplete="off" /></label><label>Enforcement or restoration reason<textarea value={accountReason} onChange={event => setAccountReason(event.target.value)} maxLength={1000} rows={3} disabled={busy} /></label></div><div className="safety-actions"><button type="button" className="safety-button" disabled={busy || !/^[a-z0-9_]{3,24}$/.test(accountName) || !accountReason.trim()} onClick={() => void accountAction('account', accountName, 'suspend', accountReason)}>Suspend account</button><button type="button" className="safety-button" disabled={busy || !/^[a-z0-9_]{3,24}$/.test(accountName) || !accountReason.trim()} onClick={() => void accountAction('account', accountName, 'restore', accountReason)}>Restore account</button></div></section>
      <section className="safety-panel"><h2>Restricted audit</h2><p>Review access and decisions are recorded with the operator identity. Keep sensitive media and unnecessary personal information out of audit notes.</p><button type="button" className="safety-button" disabled={busy} onClick={() => void loadAudit()}>Load audit log</button>{audit && <div className="operator-list">{audit.map(item => <article key={item.id}><h3>{item.event}</h3><p className="operator-id">Operator {item.operatorId} · target {item.targetId ?? 'queue'}</p><p>{item.createdAt}</p>{item.note && <p className="operator-details">{item.note}</p>}</article>)}</div>}</section>
    </>}
  </>;
}

function ReportItem({ report, busy, inspect, resolve, inspectSocial }: { report: SafetyReport; busy: boolean; inspect: (postId: string) => Promise<void>; resolve: (id: string, state: 'resolved' | 'dismissed', note: string) => Promise<void>; inspectSocial: (target: { kind: 'message' | 'comment'; itemId: string }) => void }) {
  const [note, setNote] = useState('');
  return <article><h3>{report.reason.replaceAll('_', ' ')} · {report.state}</h3><p className="operator-id">Report {report.reportId}</p>{report.username && <p>Account: @{report.username}</p>}<p><time dateTime={report.createdAt}>{report.createdAt}</time></p>{report.details && <p className="operator-details">{report.details}</p>}{report.postId && <button className="safety-button" type="button" disabled={busy} onClick={() => void inspect(report.postId!)}>Review reported moment</button>}{(report.targetKind === 'message' || report.targetKind === 'comment') && report.targetId && <button className="safety-button" type="button" disabled={busy} onClick={() => inspectSocial({ kind: report.targetKind as 'message' | 'comment', itemId: report.targetId! })}>Review reported text privately</button>}<label className="safety-form">Response and escalation note<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={3} disabled={busy} placeholder="Record action and minimal escalation reference. Do not include copies of media." /></label><div className="safety-actions"><button className="safety-button" type="button" disabled={busy || !note.trim()} onClick={() => void resolve(report.reportId, 'resolved', note)}>Record response and resolve</button><button className="safety-button" type="button" disabled={busy || !note.trim()} onClick={() => void resolve(report.reportId, 'dismissed', note)}>Dismiss with reason</button></div></article>;
}

function ProfileItem({ username, busy, decide }: { username: string; busy: boolean; decide: (path: 'account' | 'profile', username: string, action: string, note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  return <article><h3>@{username}</h3><label className="safety-form">Profile assessment<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={2} disabled={busy} /></label><div className="safety-actions"><button type="button" className="safety-button" disabled={busy || !note.trim()} onClick={() => void decide('profile', username, 'approve', note)}>Approve profile name</button><button type="button" className="safety-button" disabled={busy || !note.trim()} onClick={() => void decide('profile', username, 'reject', note)}>Reject profile name</button></div></article>;
}
