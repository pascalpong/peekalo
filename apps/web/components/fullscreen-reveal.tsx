"use client";

import { useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './fullscreen-reveal.module.css';

/** Presentation only: the original control keeps focus and pointer capture.
 * Mount only while the caller's local allowance or server lease permits reveal.
 * This deliberately avoids a dialog focus change, which would end the hold.
 */
export function FullscreenReveal({ children, seconds, onDismiss }: {
  children: ReactNode;
  seconds: string;
  onDismiss: () => void;
}) {
  useLayoutEffect(() => {
    // Preserve the page's content width when hiding its scrollbar, so the
    // initiating card neither moves nor changes its captured pointer hit area.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    const padding = root.style.paddingRight;
    const gutter = window.innerWidth - root.clientWidth;
    if (gutter > 0) root.style.paddingRight = `${parseFloat(getComputedStyle(root).paddingRight) + gutter}px`;
    root.style.overflow = 'hidden';
    const preventScroll = (event: Event) => event.preventDefault();
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) onDismiss();
    };
    window.addEventListener('wheel', preventScroll, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onDismiss);
    return () => {
      root.style.overflow = overflow;
      root.style.paddingRight = padding;
      window.removeEventListener('wheel', preventScroll);
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onDismiss]);

  // Only mounted after deliberate client interaction; never evaluated in SSR.
  return createPortal(<div className={styles.overlay} aria-hidden="true"
    onContextMenu={event => event.preventDefault()}
    onPointerDown={event => { event.preventDefault(); onDismiss(); }}>
    <div className={styles.media}>{children}</div>
    <div className={styles.top}><span className={styles.brand}>peekalo</span><span className={styles.time}>{seconds}s left</span></div>
    <div className={styles.bottom}><span className={styles.dot} />Release to hide</div>
  </div>, document.body);
}
