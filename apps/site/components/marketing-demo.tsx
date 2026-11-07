'use client';
import { createLocalRevealSession } from '@peekalo/reveal';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { FullscreenReveal } from '@peekalo/web-ui/reveal';
import { Icon } from '@peekalo/web-ui/icons';
import { BrandMark } from '@peekalo/web-ui/brand';
import styles from '../app/marketing.module.css';

// Public generated sample. Runtime-local interaction does not prove real claims,
// protected delivery, cross-device allowances or native capture protection.
const session = createLocalRevealSession({ budgetMs: 10000, now: () => performance.now(), schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } });
const initial = session.getSnapshot();
export function MarketingDemo() {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, () => initial);
  const input = useRef<string | null>(null);
  const stop = useCallback(() => { input.current = null; session.stop(); }, []);
  const revealing = snapshot.status === 'revealing'; const exhausted = snapshot.status === 'exhausted';
  const seconds = (Math.ceil(snapshot.remainingMs / 100) / 10).toFixed(1);
  useEffect(() => {
    const suspend = () => { stop(); session.setEnabled(false); };
    const resume = () => session.setEnabled(document.visibilityState === 'visible' && document.hasFocus());
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
    resume(); window.addEventListener('blur', suspend); window.addEventListener('focus', resume); window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume); document.addEventListener('visibilitychange', visibility);
    return () => { suspend(); window.removeEventListener('blur', suspend); window.removeEventListener('focus', resume); window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', visibility); };
  }, [stop]);
  return <div className={styles.demoCard}>
    <button type="button" className={styles.peekSurface} disabled={exhausted} aria-label={exhausted ? 'Demo viewing time used up' : 'Hold to reveal sample photo'} aria-describedby="marketing-demo-help" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => { if (!event.isPrimary || event.button !== 0 || input.current !== null) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); if (session.start()) input.current = `pointer:${event.pointerId}`; }}
      onPointerMove={event => { if (input.current !== `pointer:${event.pointerId}`) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) stop(); }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
      onKeyDown={event => { if (event.key === 'Escape') stop(); if (event.key !== ' ' && event.key !== 'Enter') return; event.preventDefault(); if (!event.repeat && input.current === null && session.start()) input.current = `key:${event.key}`; }}
      onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') event.preventDefault(); if (input.current === `key:${event.key}`) stop(); }}>
      <span className={styles.peekTop}><span>Sample moment</span><span><Icon name="clock" />{seconds}s</span></span>
      <span className={styles.peekCenter}><BrandMark /><strong>{exhausted ? 'Viewing time used up' : 'Hold to reveal'}</strong><span>{exhausted ? 'Reload to restart this demo' : 'Release to hide'}</span></span>
      <span className={styles.peekBottom}><Icon name="lock" />Up to ten seconds total</span>
    </button>
    <button type="button" className={styles.accessiblePeek} disabled={exhausted} onClick={() => session.start(1000)} onBlur={stop}>Reveal for 1 second <Icon name="eye" /></button>
    <p id="marketing-demo-help" className={styles.demoHelp}>Hold here or use Space / Enter. Release to hide.<br />Local demo · reload resets the allowance.</p>
    <span className={styles.srOnly} role="status">{exhausted ? 'Demo viewing time used up.' : revealing ? 'Sample revealed. Release to hide.' : 'Sample hidden.'}</span>
    {revealing && <FullscreenReveal seconds={seconds} onDismiss={stop}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Public generated sample image. */}
      <img src="/marketing/veil-moment.webp" alt="Generated sample of a ceramic cup in soft window light" draggable={false} onError={stop} />
    </FullscreenReveal>}
  </div>;
}
