"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FullscreenReveal } from "./fullscreen-reveal";
import { Icon } from "./icons";
import styles from "./protected-viewer.module.css";

type Phase = "loading" | "ready" | "requesting" | "revealing" | "hidden" | "exhausted" | "unavailable" | "busy" | "error";
type ViewerState = { phase: Phase; kind: "photo" | "video"; remainingMs: number; mediaUrl: string | null };
type Lease = { leaseId: string; mediaUrl: string; grantedMs: number; remainingMs: number; expiresAt: string | number };
type Controls = { start: (input: string, oneSecond?: boolean) => void; stop: () => void; retry: () => void };
const initial: ViewerState = { phase: "loading", kind: "photo", remainingMs: 10_000, mediaUrl: null };

function statusMessage(phase: Phase) {
  switch (phase) {
    case "loading": return "Checking this moment…";
    case "requesting": return "Preparing your glimpse…";
    case "revealing": return "Revealed · release to hide";
    case "exhausted": return "Your viewing time is used up.";
    case "unavailable": return "This moment is unavailable or has already been claimed.";
    case "busy": return "Another viewing session is active. Try again in a moment.";
    case "error": return "The moment couldn’t load. Check your connection and try again.";
    default: return "Hidden · ready when you are";
  }
}

/** No clear media is requested until the server grants a deliberate reveal. */
export function ProtectedViewer() {
  const [state, setState] = useState<ViewerState>(initial);
  const controls = useRef<Controls | null>(null);
  const input = useRef<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const videoPosition = useRef(0);

  useEffect(() => {
    let mounted = true;
    let generation = 0;
    let token = "";
    const sessionId = crypto.randomUUID();
    let holding = false;
    let once = false;
    let deadline = 0;
    let renewalWaitStarted: number | null = null;
    let unreserved = 10_000;
    let current = initial;
    let controller: AbortController | null = null;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const publish = (patch: Partial<ViewerState>) => {
      current = { ...current, ...patch };
      if (mounted) setState(current);
    };
    const clearTimers = () => {
      clearTimeout(renewal);
      clearTimeout(expiry);
      clearInterval(ticker);
    };
    const stop = (phase?: Phase) => {
      const remainingMs = unreserved + Math.max(0, deadline - performance.now());
      generation++;
      holding = false;
      input.current = null;
      controller?.abort();
      controller = null;
      clearTimers();
      renewalWaitStarted = null;
      // Stop audio synchronously, before React removes the media element.
      if (video.current) {
        videoPosition.current = video.current.currentTime;
        video.current.pause();
        video.current.removeAttribute("src");
        video.current.load();
      }
      // Unspent prepaid time is not refunded after release/interruption.
      const stoppedPhase = phase ?? (unreserved <= 0 ? "exhausted" : "hidden");
      publish({ phase: stoppedPhase, mediaUrl: null, remainingMs: phase === "exhausted" ? 0 : Math.min(remainingMs, unreserved) });
      deadline = 0;
    };
    const post = (url: string, body: object, signal: AbortSignal) => fetch(url, {
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const load = async () => {
      stop("loading");
      unreserved = 10_000;
      token = window.location.hash.slice(1);
      publish({ remainingMs: 10_000 });
      if (!token || token.length > 2_048) { publish({ phase: "unavailable" }); return; }
      const turn = generation;
      const pending = new AbortController();
      controller = pending;
      try {
        const response = await post("/api/view/preview", { token }, pending.signal);
        const result: { kind?: string; available?: boolean } = await response.json();
        if (!mounted || turn !== generation) return;
        controller = null;
        if (!response.ok || !result.available || (result.kind !== "photo" && result.kind !== "video")) {
          publish({ phase: "unavailable" }); return;
        }
        publish({ phase: "ready", kind: result.kind });
      } catch {
        if (mounted && turn === generation) { controller = null; publish({ phase: "error" }); }
      }
    };
    const requestLease = async (turn: number) => {
      if (!holding || !mounted || generation !== turn || controller) return;
      clearTimeout(renewal);
      const sentAt = performance.now();
      const previousDeadline = deadline;
      const pending = new AbortController();
      controller = pending;
      try {
        const response = await post("/api/view/lease", { token, sessionId, requestId: crypto.randomUUID() }, pending.signal);
        const result = await response.json() as Partial<Lease> & { code?: string; error?: string };
        if (!holding || !mounted || generation !== turn) return;
        controller = null;
        if (!response.ok) {
          const code = (result.error ?? result.code)?.toLowerCase() ?? "";
          if (response.status === 409 && code === "renew_later") {
            // Release hides immediately but does not cancel the server's prepaid
            // slice. A new hold must wait for renewal without treating that
            // still-active slice as a lost claim or revealing without a grant.
            const now = performance.now();
            renewalWaitStarted ??= now;
            if (now - renewalWaitStarted >= 3_000) { stop("error"); return; }
            renewal = setTimeout(() => { void requestLease(turn); }, 100);
            return;
          }
          stop(code.includes("exhaust") ? "exhausted" : code.includes("busy") ? "busy" : response.status === 410 || response.status === 409 || response.status === 404 || response.status === 403 ? "unavailable" : "error");
          return;
        }
        const mediaUrl = typeof result.mediaUrl === "string" ? new URL(result.mediaUrl, window.location.origin) : null;
        const mediaPath = mediaUrl?.origin === window.location.origin && /^\/api\/view\/media\/[^/?#]+$/.test(mediaUrl.pathname) && !mediaUrl.search && !mediaUrl.hash ? mediaUrl.pathname : null;
        const serverExpires = typeof result.expiresAt === "number" ? result.expiresAt : Date.parse(result.expiresAt ?? "");
        if (typeof result.leaseId !== "string" || !mediaPath || typeof result.grantedMs !== "number" || !Number.isFinite(result.grantedMs) || result.grantedMs <= 0 || result.grantedMs > 2_000 || typeof result.remainingMs !== "number" || !Number.isFinite(result.remainingMs) || result.remainingMs < 0 || result.remainingMs > 10_000 || !Number.isFinite(serverExpires)) {
          stop("error"); return;
        }
        unreserved = result.remainingMs;
        renewalWaitStarted = null;
        const now = performance.now();
        const conservativeDeadline = Math.max(sentAt, previousDeadline) + result.grantedMs;
        deadline = Math.min(conservativeDeadline, now + Math.max(0, serverExpires - Date.now()));
        if (deadline <= now) { stop(); return; }
        publish({ phase: "revealing", mediaUrl: current.mediaUrl ?? mediaPath, remainingMs: unreserved + deadline - now });
        clearTimers();
        const expire = () => {
          if (once || unreserved <= 0) { stop(); return; }
          // Hide immediately at expiry, but keep the deliberate hold while a slow renewal finishes.
          if (video.current) {
            videoPosition.current = video.current.currentTime;
            video.current.pause();
          }
          clearInterval(ticker);
          publish({ phase: "requesting", mediaUrl: null, remainingMs: unreserved });
          if (!controller && holding) void requestLease(turn);
        };
        ticker = setInterval(() => {
          const left = deadline - performance.now();
          if (left <= 0) { expire(); return; }
          publish({ remainingMs: unreserved + left });
        }, 50);
        expiry = setTimeout(expire, Math.max(0, Math.min(once ? 1000 : Infinity, deadline - performance.now())));
        if (!once && unreserved > 0) {
          renewal = setTimeout(() => { void requestLease(turn); }, Math.max(0, deadline - performance.now() - 600));
        }
      } catch {
        if (mounted && holding && generation === turn) stop("error");
      }
    };
    controls.current = {
      start: (source, oneSecond = false) => {
        if (holding || !token || document.visibilityState !== "visible" || !document.hasFocus() || !["ready", "hidden", "busy"].includes(current.phase)) return;
        generation++;
        const turn = generation;
        input.current = source;
        holding = true;
        once = oneSecond;
        publish({ phase: "requesting" });
        void requestLease(turn);
      },
      stop: () => { if (holding) stop(); },
      retry: () => { void load(); },
    };
    const suspend = () => { if (holding) stop(); };
    const visibility = () => { if (document.visibilityState !== "visible") suspend(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") suspend(); };
    const hashChanged = () => { void load(); };
    window.addEventListener("blur", suspend);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("hashchange", hashChanged);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      mounted = false;
      stop();
      token = "";
      controls.current = null;
      window.removeEventListener("blur", suspend);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("hashchange", hashChanged);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const revealed = state.phase === "revealing" && state.mediaUrl !== null;
  const disabled = ["loading", "exhausted", "unavailable", "error"].includes(state.phase);
  const seconds = (Math.ceil(state.remainingMs / 100) / 10).toFixed(1);
  const stop = useCallback(() => { controls.current?.stop(); }, []);

  return <section className={styles.viewer} aria-label="Private shared moment">
    <div className={styles.meta}><span>ONE MOMENT · ONE VIEWER</span><span className={styles.time} aria-label={`${seconds} seconds remaining`}>{seconds}s left</span></div>
    <button className={styles.surface} type="button" disabled={disabled} aria-label={revealed ? "Moment revealed. Release to hide." : "Hold to reveal this moment"} aria-describedby="protected-instructions" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        controls.current?.start(`pointer:${event.pointerId}`);
      }}
      onPointerMove={event => {
        if (input.current !== `pointer:${event.pointerId}`) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientY < rect.top || event.clientX > rect.right || event.clientY > rect.bottom) stop();
      }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
      onKeyDown={event => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!event.repeat) controls.current?.start(`key:${event.key}`);
      }} onKeyUp={event => {
        if (event.key === " " || event.key === "Enter") event.preventDefault();
        if (input.current === `key:${event.key}`) stop();
      }}>
      <span className={styles.cover} aria-hidden="true"><span className={styles.eye}><Icon name={state.phase === "exhausted" || state.phase === "unavailable" ? "lock" : "eye"} /></span><strong>{state.phase === "exhausted" ? "A moment, remembered." : state.phase === "unavailable" ? "This moment is unavailable." : state.phase === "requesting" ? "Just a moment…" : "Hold to reveal"}</strong><span>Release to hide · Up to 10 seconds total</span></span>
    </button>
    {revealed && <FullscreenReveal seconds={seconds} onDismiss={stop}>
      {state.kind === "photo" && (
        // eslint-disable-next-line @next/next/no-img-element -- Private media uses the cookie-authorized gateway only during an active lease; never Next image caching.
        <img src={state.mediaUrl!} alt="Shared photo" className={styles.media} draggable={false} referrerPolicy="no-referrer" onError={() => { stop(); setState(previous => ({ ...previous, phase: "error", mediaUrl: null })); }} />
      )}
      {state.kind === "video" && <video ref={video} src={state.mediaUrl!} className={styles.media} autoPlay playsInline preload="none" controls={false} onLoadedMetadata={event => { event.currentTarget.currentTime = videoPosition.current; }} onTimeUpdate={event => { videoPosition.current = event.currentTarget.currentTime; }} disablePictureInPicture controlsList="nodownload noplaybackrate noremoteplayback" onError={() => { stop(); setState(previous => ({ ...previous, phase: "error", mediaUrl: null })); }} />}
    </FullscreenReveal>}
    <p className={styles.status} role="status" aria-live="polite">{statusMessage(state.phase)}</p>
    <p id="protected-instructions" className={styles.help}>Hold the image, Space or Enter to view full screen. Release, move outside the card or press Escape to hide.</p>
    <button type="button" className={styles.accessible} disabled={disabled} aria-busy={state.phase === "requesting"} onClick={() => controls.current?.start("accessible", true)} onBlur={stop}>Reveal for 1 second<Icon name="eye" /></button>
    <p className={styles.help}>Uses the same total allowance. Interrupted prepaid time is used.</p>
    {state.phase === "error" && <button type="button" className={styles.retry} onClick={() => controls.current?.retry()}>Try again</button>}
  </section>;
}
