'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Icon } from '@peekalo/web-ui/icons';
import styles from '../app/marketing.module.css';

export function WaitlistForm({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || status === 'sending') return;
    const data = new FormData(event.currentTarget);
    setStatus('sending'); setMessage('');
    try {
      const response = await fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), consent: data.get('consent') === 'on', website: data.get('website') }), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        setStatus('error'); setMessage(response.status === 429 ? 'A few too many tries. Please try again in a minute.' : response.status === 400 ? 'Please enter a valid email and agree to early-access updates.' : 'Signups are temporarily unavailable. Please try again later.'); return;
      }
      setStatus('success'); setMessage('You’re on the list. A little closer, already.');
    } catch { setStatus('error'); setMessage('We couldn’t save your email. Check your connection and try again.'); }
  }
  return <form className={styles.form} onSubmit={submit} aria-label="Join Peekalo early access">
    {!enabled && <p className={styles.signupPending}>The early-access list opens soon. Stay curious. <Icon name="spark" /></p>}
    {enabled && status !== 'success' && <><label htmlFor="early-email" className={styles.srOnly}>Your email address</label>
      <div className={styles.emailRow}><input id="early-email" name="email" type="email" autoComplete="email" placeholder="Your email address" maxLength={254} required disabled={status === 'sending'} aria-describedby="signup-message" /><button type="submit" disabled={status === 'sending'}>{status === 'sending' ? 'Saving…' : 'Count me in'}<Icon name="arrow" /></button></div>
      <div className={styles.honeypot} aria-hidden="true"><label htmlFor="early-website">Website</label><input id="early-website" type="text" name="website" tabIndex={-1} autoComplete="off" /></div>
      <label className={styles.consent}><input type="checkbox" name="consent" required disabled={status === 'sending'} /><span>Email me about Peekalo early access. See our <Link href="/privacy">privacy notice</Link>.</span></label></>}
    {enabled && <p id="signup-message" className={status === 'error' ? styles.formError : styles.formMessage} role="status" aria-live="polite">{message || 'Just early-access updates. Your email won’t appear publicly.'}</p>}
  </form>;
}
