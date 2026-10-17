export type Photo = Readonly<{
  uri: string;
  width: number;
  height: number;
}>;

export type PhotoSnapshot = Readonly<{
  status: "idle" | "capturing" | "review";
  photo: Photo | null;
  error: string | null;
}>;

const captureError = "Could not take a photo. Please try again.";
const cleanupError = "Could not clear the temporary photo. Please try again.";

function validDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function localUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("file:///") && value.length > 8;
}

export function createPhotoSession(deletePhoto: (photo: Photo) => void | Promise<void>) {
  let epoch = 0;
  let snapshot: PhotoSnapshot = Object.freeze({ status: "idle", photo: null, error: null });
  const listeners = new Set<() => void>();

  function publish(status: PhotoSnapshot["status"], photo: Photo | null, error: string | null) {
    if (snapshot.status === status && snapshot.photo === photo && snapshot.error === error) return;
    snapshot = Object.freeze({ status, photo, error });
    listeners.forEach((listener) => listener());
  }

  async function cleanup(photo: Photo, cleanupEpoch: number) {
    try {
      await deletePhoto(photo);
    } catch {
      // An old cleanup must never replace a newer capture or review state.
      if (epoch === cleanupEpoch && snapshot.status === "idle") {
        publish("idle", null, cleanupError);
      }
    }
  }

  function discard() {
    const photo = snapshot.photo;
    const discardEpoch = ++epoch;
    publish("idle", null, null);
    if (photo) void cleanup(photo, discardEpoch);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async capture(takePhoto: () => Promise<Photo | null | undefined>) {
      // Set the lock before calling native code, including callbacks that throw synchronously.
      if (snapshot.status !== "idle") return;
      const captureEpoch = ++epoch;
      publish("capturing", null, null);
      let result: Photo | null | undefined;
      try {
        result = await takePhoto();
      } catch {
        if (epoch === captureEpoch) publish("idle", null, captureError);
        return;
      }

      if (!result) {
        if (epoch === captureEpoch) publish("idle", null, captureError);
        return;
      }
      const hasLocalFile = localUri(result.uri);
      const valid = hasLocalFile && validDimension(result.width) && validDimension(result.height);
      if (epoch !== captureEpoch || !valid) {
        if (epoch === captureEpoch) publish("idle", null, captureError);
        if (hasLocalFile) {
          // Even a malformed native result can own a cache file that needs removing.
          await cleanup({ uri: result.uri, width: 1, height: 1 }, captureEpoch);
        }
        return;
      }

      publish("review", Object.freeze({ uri: result.uri, width: result.width, height: result.height }), null);
    },
    discard,
    interrupt: discard,
  };
}
