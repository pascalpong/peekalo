export type Video = Readonly<{ uri: string }>;

export type VideoSnapshot = Readonly<{
  status: "idle" | "preparing" | "recording" | "stopping" | "review";
  video: Video | null;
  error: string | null;
}>;

type VideoSessionOptions = {
  prepare: () => Promise<boolean>;
  record: () => Promise<Video | null | undefined>;
  stop: () => void;
  deleteVideo: (uri: string) => void | Promise<void>;
  onRestore: () => void;
};

type Operation = {
  epoch: number;
  held: boolean;
  canceled: boolean;
  started: boolean;
  stopRequested: boolean;
};

const recordError = "Could not record a video. Please try again.";
const prepareError = "Could not start recording. Check camera and microphone access.";
const cleanupError = "Could not clear the temporary video. Please try again.";

function localUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("file:///") && value.length > 8;
}

// Native record() must also enforce maxDuration: 10. This controller owns gesture
// intent and draft lifetime; it does not infer duration from wall-clock time.
export function createVideoSession(options: VideoSessionOptions) {
  let epoch = 0;
  let active: Operation | null = null;
  let snapshot: VideoSnapshot = Object.freeze({ status: "idle", video: null, error: null });
  const listeners = new Set<() => void>();

  function publish(status: VideoSnapshot["status"], video: Video | null, error: string | null) {
    if (snapshot.status === status && snapshot.video === video && snapshot.error === error) return;
    snapshot = Object.freeze({ status, video, error });
    listeners.forEach((listener) => listener());
  }

  function finishPendingState() {
    if (snapshot.status === "preparing" || snapshot.status === "recording" || snapshot.status === "stopping") {
      publish("idle", null, null);
    }
  }

  async function cleanup(uri: string, cleanupEpoch: number) {
    try {
      await options.deleteVideo(uri);
    } catch {
      if (epoch === cleanupEpoch && snapshot.status === "idle") publish("idle", null, cleanupError);
    }
  }

  function requestStop(operation: Operation) {
    if (!operation.started || operation.stopRequested) return;
    operation.stopRequested = true;
    try {
      options.stop();
    } catch {
      // Keep the native-operation lock until record() settles, even if stop fails.
      if (!operation.canceled) publish("stopping", null, recordError);
    }
  }

  function release() {
    if (!active || !active.held) return;
    active.held = false;
    if (!active.canceled) publish("stopping", null, null);
    requestStop(active);
  }

  function discard() {
    const video = snapshot.video;
    const discardEpoch = ++epoch;
    if (active) {
      active.held = false;
      active.canceled = true;
      requestStop(active);
    }
    publish("idle", null, null);
    if (video) void cleanup(video.uri, discardEpoch);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async start() {
      // This lock survives interruption until native work settles. An interrupted
      // record must never overlap another native recording on the same camera.
      if (active || snapshot.status !== "idle") return;
      const operation: Operation = { epoch: ++epoch, held: true, canceled: false, started: false, stopRequested: false };
      let stopTimer: ReturnType<typeof setTimeout> | null = null;
      active = operation;
      publish("preparing", null, null);
      try {
        if (operation.canceled || !operation.held) return;
        const prepared = await options.prepare();
        if (operation.canceled || !operation.held) return;
        if (!prepared) {
          publish("idle", null, prepareError);
          return;
        }
        publish("recording", null, null);
        // Subscribers can release or interrupt synchronously on a state change.
        if (operation.canceled || !operation.held) return;
        operation.started = true;
        stopTimer = setTimeout(() => { if (active === operation) release(); }, 10_000);
        const result = await options.record();
        operation.started = false;
        operation.held = false;
        const valid = !!result && localUri(result.uri);
        if (operation.canceled || epoch !== operation.epoch) {
          if (valid) await cleanup(result.uri, operation.epoch);
          return;
        }
        if (!valid) {
          publish("idle", null, recordError);
          return;
        }
        publish("review", Object.freeze({ uri: result.uri }), null);
      } catch {
        if (!operation.canceled && epoch === operation.epoch) publish("idle", null, recordError);
      } finally {
        if (stopTimer !== null) clearTimeout(stopTimer);
        // Restore the photo camera for failed, canceled and completed recordings.
        // prepare() must settle false if its readiness wait is interrupted.
        finishPendingState();
        try {
          options.onRestore();
        } catch {
          if (snapshot.status === "idle" && epoch === operation.epoch) publish("idle", null, recordError);
        }
        active = null;
      }
    },
    release,
    discard,
    interrupt: discard,
  };
}
