"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FullscreenReveal } from "./fullscreen-reveal";
import { BrandMark, Icon } from "./icons";
import { SafetyReport } from "./safety-report";
import styles from "./protected-viewer.module.css";

type Phase = "loading" | "ready" | "requesting" | "revealing" | "hidden" | "exhausted" | "unavailable" | "claimed" | "expired" | "busy" | "pending" | "blocked" | "restricted" | "error";
type ViewerState = { phase: Phase; kind: "photo" | "video"; remainingMs: number | null; mediaUrl: string | null; mediaTurn: number | null; mediaReady: boolean };
type Lease = { leaseId: string; mediaUrl: string; grantedMs: number; remainingMs: number; expiresAt: string | number };
type Controls = { start: (input: string, oneSecond?: boolean) => void; stop: () => void; retry: () => void; ready: (turn: number) => void; failed: (turn: number) => void };
const initial: ViewerState = { phase: "loading", kind: "photo", remainingMs: null, mediaUrl: null, mediaTurn: null, mediaReady: false };

function statusMessage(phase: Phase) {
  switch (phase) {
    case "loading": return "Checking this moment…";
    case "requesting": return "Preparing your glimpse…";
    case "revealing": return "Revealed · release to hide";
    case "exhausted": return "Your viewing time is used up.";
    case "unavailable": return "This moment is no longer available. Ask the sender for help.";
    case "claimed": return "This single-use link has already been claimed in another browser. Ask the sender for a new link.";
    case "expired": return "This link has expired. Ask the sender for a new link.";
    case "pending": return "This moment is awaiting safety review. Sharing is unavailable until it is approved.";
    case "blocked": return "This moment is unavailable between these accounts. Manage account blocks in the app.";
    case "restricted": return "Viewing is unavailable for this account. See Support for help.";
    case "busy": return "Another viewing session is active. Try again in a moment.";
    case "error": return "The moment couldn’t load. Check your connection and try again.";
    default: return "Hidden · ready when you are";
  }
}

/** No clear media is requested until the server grants a deliberate reveal. */
export function ProtectedViewer() {
  const [state, setState] = useState<ViewerState>(initial);
  const [reportOpen, setReportOpen] = useState(false);
  const reportActive = useRef(false);
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
    let loadingGrants = 0;
    let deadline = 0;
    let renewalWaitStarted: number | null = null;
    let unreserved = 0;
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
      publish({ phase: stoppedPhase, mediaUrl: null, mediaTurn: null, mediaReady: false, remainingMs: phase === "exhausted" ? 0 : Math.min(remainingMs, unreserved) });
      deadline = 0;
    };
    const post = (url: string, body: object, signal: AbortSignal) => fetch(url, {
      method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const load = async () => {
      stop("loading");
      unreserved = 0;
      token = window.location.hash.slice(1);
      publish({ remainingMs: null });
      if (!token || token.length > 2_048) { publish({ phase: "unavailable" }); return; }
      const turn = generation;
      const pending = new AbortController();
      controller = pending;
      try {
        const response = await post("/api/view/status", { token }, pending.signal);
        const result: { kind?: string; state?: string; remainingMs?: number; error?: string } = await response.json();
        if (!mounted || turn !== generation) return;
        controller = null;
        if (!response.ok) { publish({ phase: result.error === "moderation_pending" ? "pending" : result.error === "blocked" ? "blocked" : result.error === "suspended" ? "restricted" : result.error === "already_claimed" ? "claimed" : result.error === "expired" ? "expired" : [403, 404, 410].includes(response.status) ? "unavailable" : "error" }); return; }
        if (!(["available", "exhausted"].includes(result.state ?? "")) || (result.kind !== "photo" && result.kind !== "video")) {
          publish({ phase: "error" }); return;
        }
        if (!Number.isInteger(result.remainingMs) || result.remainingMs! < 0 || result.remainingMs! > 10_000 || (result.state === "exhausted") !== (result.remainingMs === 0)) { publish({ phase: "error" }); return; }
        unreserved = result.remainingMs!;
        publish({ phase: unreserved === 0 ? "exhausted" : "ready", kind: result.kind, remainingMs: unreserved });
      } catch {
        if (mounted && turn === generation) { controller = null; publish({ phase: "error" }); }
      }
    };
    const requestLease = async (turn: number) => {
      if (!holding || !mounted || generation !== turn || controller) return;
      clearTimeout(renewal);
      // Loading must not silently spend the entire allowance. Two prepaid
      // slices are the maximum until this hold has decoded usable media.
      if (!current.mediaReady && loadingGrants >= 2) return;
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
          stop(code === "moderation_pending" ? "pending" : code === "blocked" ? "blocked" : code === "suspended" ? "restricted" : code.includes("exhaust") ? "exhausted" : code.includes("busy") ? "busy" : response.status === 410 || response.status === 409 || response.status === 404 || response.status === 403 ? "unavailable" : "error");
          return;
        }
        const mediaUrl = typeof result.mediaUrl === "string" ? new URL(result.mediaUrl, window.location.origin) : null;
        const mediaPath = mediaUrl?.origin === window.location.origin && /^\/api\/view\/media\/[^/?#]+$/.test(mediaUrl.pathname) && !mediaUrl.search && !mediaUrl.hash ? mediaUrl.pathname : null;
        const serverExpires = typeof result.expiresAt === "number" ? result.expiresAt : Date.parse(result.expiresAt ?? "");
        if (typeof result.leaseId !== "string" || !mediaPath || typeof result.grantedMs !== "number" || !Number.isFinite(result.grantedMs) || result.grantedMs <= 0 || result.grantedMs > 2_000 || typeof result.remainingMs !== "number" || !Number.isFinite(result.remainingMs) || result.remainingMs < 0 || result.remainingMs > 10_000 || !Number.isFinite(serverExpires)) {
          stop("error"); return;
        }
        unreserved = result.remainingMs;
        if (!current.mediaReady) loadingGrants++;
        renewalWaitStarted = null;
        const now = performance.now();
        const conservativeDeadline = Math.max(sentAt, previousDeadline) + result.grantedMs;
        deadline = Math.min(conservativeDeadline, now + Math.max(0, serverExpires - Date.now()));
        if (deadline <= now) { stop(); return; }
        publish({ phase: current.mediaReady ? "revealing" : "requesting", mediaUrl: current.mediaUrl ?? mediaPath, mediaTurn: turn, remainingMs: unreserved + deadline - now });
        if (current.mediaReady && video.current) void video.current.play().catch(() => { if (holding && generation === turn && deadline > performance.now() && current.phase === "revealing") stop("error"); });
        clearTimers();
        const expire = () => {
          if (!current.mediaReady && loadingGrants >= 2) { stop("error"); return; }
          if (once || unreserved <= 0) { stop(); return; }
          // Hide immediately at expiry, but keep the deliberate hold while a slow renewal finishes.
          if (video.current) {
            videoPosition.current = video.current.currentTime;
            video.current.pause();
          }
          clearInterval(ticker);
          // Keep the authorized fetch/element stable across renewal gaps;
          // presentation is covered until a current lease permits output.
          publish({ phase: "requesting", remainingMs: unreserved });
          if (!controller && holding) void requestLease(turn);
        };
        ticker = setInterval(() => {
          const left = deadline - performance.now();
          if (left <= 0) { expire(); return; }
          publish({ remainingMs: unreserved + left });
        }, 50);
        expiry = setTimeout(expire, Math.max(0, Math.min(once ? 1000 : Infinity, deadline - performance.now())));
        if (!once && unreserved > 0 && (current.mediaReady || loadingGrants < 2)) {
          renewal = setTimeout(() => { void requestLease(turn); }, Math.max(0, deadline - performance.now() - 600));
        }
      } catch {
        if (mounted && holding && generation === turn) stop("error");
      }
    };
    controls.current = {
      start: (source, oneSecond = false) => {
        if (reportActive.current || holding || !token || document.visibilityState !== "visible" || !document.hasFocus() || !["ready", "hidden", "busy"].includes(current.phase)) return;
        generation++;
        const turn = generation;
        input.current = source;
        holding = true;
        once = oneSecond;
        loadingGrants = 0;
        publish({ phase: "requesting" });
        void requestLease(turn);
      },
      stop: () => { if (holding) stop(); },
      retry: () => { void load(); },
      ready: turn => {
        if (!mounted || !holding || generation !== turn || current.mediaTurn !== turn || current.mediaReady) return;
        publish({ mediaReady: true, phase: deadline > performance.now() ? "revealing" : "requesting" });
        if (deadline > performance.now() && video.current) void video.current.play().catch(() => { if (holding && generation === turn && deadline > performance.now() && current.phase === "revealing") stop("error"); });
        // The second loading slice deliberately had no renewal scheduled.
        // Readiness can now resume ordinary renewal without changing its expiry.
        if (!once && unreserved > 0) {
          clearTimeout(renewal);
          renewal = setTimeout(() => { void requestLease(turn); }, Math.max(0, deadline - performance.now() - 600));
        }
      },
      failed: turn => { if (mounted && holding && generation === turn && current.mediaTurn === turn) stop("error"); },
    };
    const suspend = () => { if (holding) stop(); };
    const visibility = () => { if (document.visibilityState !== "visible") suspend(); else if (!holding) void load(); };
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

  const revealed = state.phase === "revealing" && state.mediaReady && state.mediaUrl !== null;
  const disabled = reportOpen || ["loading", "exhausted", "unavailable", "claimed", "expired", "pending", "blocked", "restricted", "error"].includes(state.phase);
  const seconds = state.remainingMs === null ? null : (Math.ceil(state.remainingMs / 100) / 10).toFixed(1);
  const stop = useCallback(() => { controls.current?.stop(); }, []);
  const unavailable = ["unavailable", "claimed", "expired", "pending", "blocked", "restricted"].includes(state.phase);
  const prompt = state.phase === "loading" || state.phase === "requesting" ? "Just a moment…"
    : state.phase === "exhausted" ? "Your viewing time is used up."
    : state.phase === "pending" ? "Awaiting safety review."
    : state.phase === "claimed" ? "This link is already claimed."
    : state.phase === "expired" ? "This link has expired."
    : unavailable ? "This moment is unavailable."
    : state.phase === "error" ? "This moment couldn’t load."
    : "Hold to reveal";

  return <section className={styles.viewer} aria-label="Private shared moment">
    <button className={styles.surface} type="button" disabled={disabled} aria-label={revealed ? "Moment revealed. Release to hide." : "Hold to reveal this moment"} aria-describedby="protected-time protected-instructions" onContextMenu={event => event.preventDefault()}
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
      <span className={styles.meta} aria-hidden="true"><span>Shared moment</span><span>{unavailable ? "Unavailable" : "Hidden"}</span></span>
      <span className={styles.cover} aria-hidden="true">
        <span className={styles.mark}>{unavailable || state.phase === "exhausted" ? <Icon name="lock" /> : <BrandMark />}</span>
        <strong>{prompt}</strong>
        {!disabled && state.phase !== "requesting" && <span>Release to hide.</span>}
      </span>
      <span className={styles.budget}>
        <span id="protected-time" className={styles.time} aria-label={seconds === null ? "Checking viewing time" : `${seconds} seconds remaining`}>{seconds === null ? "—" : `${seconds}s left`}</span>
        <span className={styles.allowance}>Up to 10 seconds total</span>
      </span>
    </button>
    {state.mediaUrl !== null && <FullscreenReveal seconds={seconds ?? "0.0"} onDismiss={stop} visible={revealed}>
      {state.kind === "photo" && (
        // eslint-disable-next-line @next/next/no-img-element -- Private media uses the cookie-authorized gateway only during an active lease; never Next image caching.
        <img src={state.mediaUrl!} alt="Shared photo" className={styles.media} draggable={false} referrerPolicy="no-referrer" onLoad={async event => {
          const image = event.currentTarget;
          const turn = state.mediaTurn!;
          try { await image.decode(); controls.current?.ready(turn); }
          catch { controls.current?.failed(turn); }
        }} onError={() => controls.current?.failed(state.mediaTurn!)} />
      )}
      {state.kind === "video" && <video ref={video} src={state.mediaUrl!} className={styles.media} autoPlay={false} playsInline preload="auto" controls={false} onLoadedMetadata={event => { if (video.current === event.currentTarget) event.currentTarget.currentTime = videoPosition.current; }} onLoadedData={() => controls.current?.ready(state.mediaTurn!)} onTimeUpdate={event => { if (video.current === event.currentTarget) videoPosition.current = event.currentTarget.currentTime; }} disablePictureInPicture controlsList="nodownload noplaybackrate noremoteplayback" onError={() => controls.current?.failed(state.mediaTurn!)} />}
    </FullscreenReveal>}
    <p className={styles.status} role="status" aria-live="polite">{statusMessage(state.phase)}</p>
    <p id="protected-instructions" className={styles.help}>Hold the card, Space or Enter to view full screen. Release, move outside the card or press Escape to hide.</p>
    <button type="button" className={styles.accessible} disabled={disabled} aria-busy={state.phase === "requesting"} onClick={() => controls.current?.start("accessible", true)} onBlur={stop}>Reveal for 1 second<Icon name="eye" /></button>
    <p className={styles.help}>Uses the same total allowance. Interrupted prepaid time is used.</p>
    <SafetyReport link onOpen={() => { reportActive.current = true; controls.current?.stop(); setReportOpen(true); }} onClose={() => { reportActive.current = false; setReportOpen(false); }} />
    {state.phase === "error" && <button type="button" className={styles.retry} onClick={() => controls.current?.retry()}>Try again</button>}
  </section>;
}
