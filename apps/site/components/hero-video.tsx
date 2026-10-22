'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './hero-video.module.css';

type HeroVideoProps = {
  src: string;
  poster: string;
  className?: string;
};

type DataConnection = EventTarget & { saveData?: boolean };

/** Decorative public marketing footage, with a static first render and explicit motion control. */
export function HeroVideo({ src, poster, className }: HeroVideoProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const toggleRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: DataConnection }).connection;
    let manualChoice: 'play' | 'pause' | null = null;
    let inView = false;
    let disposed = false;
    let hasFailed = false;
    let wantsPlayback = false;
    let playPending = false;
    let attempt = 0;

    setReady(true);
    setFailed(false);
    setActive(false);
    setShowVideo(false);

    function reconcile() {
      if (disposed || !video) return;
      const automaticMotion = !motion.matches && !connection?.saveData;
      const motionAllowed = manualChoice === 'play' || (automaticMotion && manualChoice !== 'pause');
      wantsPlayback = motionAllowed && inView && !document.hidden && !hasFailed;
      setActive(wantsPlayback);

      if (!wantsPlayback) {
        ++attempt;
        playPending = false;
        video.pause();
        if (!motionAllowed && manualChoice !== 'pause') setShowVideo(false);
        return;
      }

      // No video URL is attached for reduced-motion or data-saver users until they opt in.
      if (!video.hasAttribute('src')) video.src = src;
      if (playPending || !video.paused) return;
      const currentAttempt = ++attempt;
      playPending = true;
      const playback = video.play();
      void playback?.then(() => {
        if (!disposed && currentAttempt === attempt) playPending = false;
      }).catch(() => {
        if (disposed || currentAttempt !== attempt) return;
        // Own pause requests invalidate their pending play attempt above.
        playPending = false;
        manualChoice = 'pause';
        wantsPlayback = false;
        setActive(false);
        setShowVideo(false);
      });
    }

    function onPlaying() {
      if (!wantsPlayback || disposed) {
        video?.pause();
        return;
      }
      setActive(true);
      setShowVideo(true);
    }

    function onPause() {
      if (disposed || !video?.paused) return;
      setActive(false);
      // Respect a browser/OS pause, including one unrelated to our visibility checks.
      if (wantsPlayback) {
        manualChoice = 'pause';
        wantsPlayback = false;
        playPending = false;
        ++attempt;
      }
    }

    function onError() {
      hasFailed = true;
      wantsPlayback = false;
      playPending = false;
      ++attempt;
      video?.pause();
      setFailed(true);
      setActive(false);
      setShowVideo(false);
    }

    toggleRef.current = () => {
      manualChoice = wantsPlayback ? 'pause' : 'play';
      reconcile();
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', reconcile);
    motion.addEventListener('change', reconcile);
    connection?.addEventListener('change', reconcile);

    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      reconcile();
    }, { threshold: 0 });
    observer.observe(container);

    return () => {
      disposed = true;
      ++attempt;
      toggleRef.current = null;
      observer.disconnect();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', reconcile);
      motion.removeEventListener('change', reconcile);
      connection?.removeEventListener('change', reconcile);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  const label = failed ? 'Background video unavailable' : active ? 'Pause background video' : 'Play background video';

  return (
    <div ref={containerRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <div className={styles.poster} style={{ backgroundImage: `url(${JSON.stringify(poster)})` }} aria-hidden="true" />
      <video
        ref={videoRef}
        className={[styles.video, showVideo ? styles.visible : ''].join(' ')}
        poster={poster}
        preload="none"
        muted
        loop
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        className={styles.control}
        type="button"
        onClick={() => toggleRef.current?.()}
        disabled={!ready || failed}
        aria-label={label}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
          {active ? <path d="M5 4h3v12H5zm7 0h3v12h-3z" /> : <path d="m6 3 11 7-11 7z" />}
        </svg>
        <span>{failed ? 'Still image' : active ? 'Pause motion' : 'Play motion'}</span>
      </button>
    </div>
  );
}
