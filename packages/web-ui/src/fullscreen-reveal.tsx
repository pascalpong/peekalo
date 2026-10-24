"use client";

import { useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './fullscreen-reveal.module.css';
import { BrandLogo } from './brand-logo';

/** Presentation only: the original control keeps focus and pointer capture.
 * Callers may retain authorized media while covered between lease renewals.
 * visible must be true only while their current allowance permits clear output.
 * Release/interruption unmounts the portal and removes that media.
 * This deliberately avoids a dialog focus change, which would end the hold.
 */
export function FullscreenReveal({ children, seconds, onDismiss, visible = true }: {
  children: ReactNode;
  seconds: string;
  visible?: boolean;
  onDismiss: () => void;
}) {
  useLayoutEffect(() => {
    // Preserve the page's content width when hiding its scrollbar, so the
    // initiating card neither moves nor changes its captured pointer hit area.
    const root = document.documentElement;
    const viewportWidth = window.innerWidth;
    const orientation = window.screen?.orientation?.type;
    const overflow = root.style.overflow;
    const padding = root.style.paddingRight;
    const gutter = window.innerWidth - root.clientWidth;
    if (gutter > 0) root.style.paddingRight = `${parseFloat(getComputedStyle(root).paddingRight) + gutter}px`;
    root.style.overflow = 'hidden';
    const preventScroll = (event: Event) => event.preventDefault();
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) onDismiss();
    };
    const resize = () => {
      // Android Chrome can emit resize as scroll locking/browser controls
      // settle, even with unchanged dimensions. Keep that deliberate hold;
      // width/orientation changes still interrupt it, as do the caller's
      // release, cancellation, blur and visibility handlers.
      if (window.innerWidth !== viewportWidth || window.screen?.orientation?.type !== orientation) onDismiss();
    };
    window.addEventListener('wheel', preventScroll, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', onDismiss);
    return () => {
      root.style.overflow = overflow;
      root.style.paddingRight = padding;
      window.removeEventListener('wheel', preventScroll);
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', onDismiss);
    };
  }, [onDismiss]);

  // Only mounted after deliberate client interaction; never evaluated in SSR.
  return createPortal(<div className={styles.overlay} aria-hidden="true" style={{ visibility: visible ? "visible" : "hidden", pointerEvents: visible ? "auto" : "none" }}
    onContextMenu={event => event.preventDefault()}
    onPointerDown={event => { event.preventDefault(); onDismiss(); }}>
    <div className={styles.media}>{children}</div>
    <div className={styles.top}><BrandLogo className={styles.brand} /><span className={styles.time}>{seconds}s left</span></div>
    <div className={styles.bottom}><span className={styles.dot} />Release to hide</div>
  </div>, document.body);
}
