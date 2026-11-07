"use client";

import { REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { createLocalRevealSession } from '@peekalo/reveal';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FullscreenReveal } from './fullscreen-reveal';
import { BrandMark, Icon } from './icons';
import styles from './protected-viewer.module.css';

// This sample has no identity or storage. Route changes retain its allowance;
// a full page reload creates a new demo, not another real-link entitlement.
const session = createLocalRevealSession({
  budgetMs: REVEAL_BUDGET_MS,
  now: () => performance.now(),
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
});
const initial = session.getSnapshot();

export function SampleReveal() {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, () => initial);
  const input = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const revealed = snapshot.status === 'revealing';
  const exhausted = snapshot.status === 'exhausted';
  const seconds = (Math.ceil(snapshot.remainingMs / 100) / 10).toFixed(1);
  const stop = useCallback(() => { input.current = null; session.stop(); }, []);

  useEffect(() => {
    const suspend = () => { input.current = null; session.setEnabled(false); };
    const resume = () => session.setEnabled(document.visibilityState === 'visible' && document.hasFocus());
    const visibility = () => { if (document.visibilityState === 'hidden') suspend(); else resume(); };
    resume();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', suspend);
    window.addEventListener('focus', resume);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    return () => {
      suspend();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', suspend);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', resume);
    };
  }, []);

  const start = (duration?: number) => !failed && session.start(duration);
  return <div className={styles.viewer}>
    <button type="button" className={styles.surface} disabled={exhausted || failed}
      aria-label={revealed ? 'Sample revealed: a coffee cup, orange and a potted plant' : failed ? 'Sample unavailable' : exhausted ? 'Viewing time used up' : 'Hold to reveal sample'}
      aria-describedby="sample-time reveal-instructions" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (input.current !== null) { stop(); return; }
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (start()) input.current = `pointer:${event.pointerId}`;
      }}
      onPointerMove={event => {
        if (input.current !== `pointer:${event.pointerId}`) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientY < box.top || event.clientX > box.right || event.clientY > box.bottom) stop();
      }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
      onKeyDown={event => {
        if (event.key === 'Escape') { stop(); return; }
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (!event.repeat && input.current === null && start()) input.current = `key:${event.key}`;
      }}
      onKeyUp={event => {
        if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
        if (input.current === `key:${event.key}`) stop();
      }}>
      <span className={styles.meta} aria-hidden="true"><span>Sample illustration</span><span>Hidden</span></span>
      <span className={styles.cover} aria-hidden="true">
        <span className={styles.mark}>{exhausted ? <Icon name="lock" /> : <BrandMark />}</span>
        <strong>{failed ? 'Sample unavailable' : exhausted ? 'Your viewing time is used up.' : 'Hold to reveal'}</strong>
        <span>{failed ? 'Refresh to try again.' : exhausted ? 'Refresh to reset the demo.' : 'Release to hide.'}</span>
      </span>
      <span className={styles.budget}>
        <span id="sample-time" className={styles.time} aria-label={`${seconds} seconds remaining`}>{seconds}s left</span>
        <span className={styles.allowance}>Up to {REVEAL_BUDGET_MS / 1000} seconds total</span>
      </span>
    </button>
    {revealed && <FullscreenReveal seconds={seconds} onDismiss={stop}>
      {/* eslint-disable-next-line @next/next/no-img-element -- This tiny public fixture is deliberately loaded only during revelation. */}
      <img src="/demo/morning-clear.png" alt="" draggable={false}
        onError={() => { stop(); setFailed(true); }} />
    </FullscreenReveal>}
    <p className={styles.status} role="status">{revealed ? 'Revealed · release to hide' : failed ? 'Sample couldn’t load.' : exhausted ? 'Your viewing time is used up.' : 'Hidden · ready when you are'}</p>
    <p id="reveal-instructions" className={styles.help}>Hold the card, Space or Enter to view full screen. Release, move outside the card or press Escape to hide.</p>
    <button type="button" className={styles.accessible} disabled={exhausted || failed} onClick={() => start(1_000)} onBlur={stop}>Reveal for 1 second<Icon name="eye" /></button>
    <p className={styles.help}>This button uses the same allowance. Refreshing resets this local demo.</p>
  </div>;
}
