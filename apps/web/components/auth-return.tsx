'use client';

import { useEffect, useRef, useState } from 'react';
import { nativeEmailReturn } from '../lib/auth-return';

export function AuthReturn({ kind }: { kind: 'confirmation' | 'recovery' }) {
  const [destination, setDestination] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const captured = useRef<{ kind: typeof kind; destination: string | null } | null>(null);
  useEffect(() => {
    // Read only in browser memory. Never exchange here, render the code, or
    // preserve callback values in browser history/referrers.
    if (captured.current?.kind !== kind) {
      captured.current = { kind, destination: nativeEmailReturn(window.location.href, kind) };
      window.history.replaceState(null, '', window.location.pathname);
    }
    setDestination(captured.current.destination);
    setChecked(true);
  }, [kind]);
  return <main id="main" className="auth-return">
    <p className="eyebrow">PEEKALO ACCOUNT</p>
    <h1>{kind === 'recovery' ? 'A fresh start.' : 'Confirm your email.'}</h1>
    <p>Open Peekalo on the device where you requested this email to {kind === 'recovery' ? 'choose a new password' : 'finish confirming your email'}. Your email link does not sign in this browser.</p>
    {destination && <button className="auth-return-action" onClick={() => { window.location.assign(destination); }}>Open Peekalo</button>}
    {checked && !destination && <p role="alert">This link is expired or unavailable. Request a new email from Sign in in Peekalo.</p>}
    <p>If Peekalo does not open, install the app and request a fresh email from that device. Use the newest email; links work once.</p>
  </main>;
}
