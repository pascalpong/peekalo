import { clearTimeout, setTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';

export class UploadAdmissionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

// Admission covers body buffering, parsing, processing AND Storage I/O. Each
// process has one slot; this is not a distributed rate limit or an account quota.
let inFlight = 0;
export function acquireUploadSlot(): () => void {
  if (inFlight >= 1) throw new UploadAdmissionError(429, 'processing_busy');
  inFlight++;
  let released = false;
  return () => {
    if (!released) { released = true; inFlight--; }
  };
}

/** Reads a real Request stream under both a byte cap and a wall-clock deadline.
 * Timeout/disconnect/oversize actively cancel the underlying stream. Never wait
 * for its cancellation callback, which an arbitrary body source can stall. */
export async function readUploadBody(request: Request, limit = 30 * 1024 * 1024 + 64 * 1024, timeoutMs = 30_000): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid upload read bounds');
  const refuse = (error: UploadAdmissionError): never => {
    void request.body?.cancel().catch(() => {});
    throw error;
  };
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) refuse(new UploadAdmissionError(400, 'invalid_request'));
  if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) > limit)) refuse(new UploadAdmissionError(413, 'file_too_large'));
  if (request.signal.aborted) refuse(new UploadAdmissionError(408, 'request_timeout'));
  if (!request.body) throw new UploadAdmissionError(400, 'invalid_request');
  const reader = request.body.getReader();
  let failure: UploadAdmissionError | undefined;
  const interrupt = (error: UploadAdmissionError) => {
    if (failure) return;
    failure = error;
    // Cancel first: ReadableStream cancellation settles pending read requests,
    // even if the underlying source's cancel callback never settles.
    void reader.cancel().catch(() => {});
  };
  const onAbort = () => { interrupt(new UploadAdmissionError(408, 'request_timeout')); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  const deadline = performance.now() + timeoutMs;
  // Fixed capacity bounds memory even for millions of tiny/empty chunks. A
  // shared timeout Promise raced per chunk would accumulate pending reactions.
  let size = 0;
  try {
    const bytes = Buffer.allocUnsafe(limit);
    // Cover an abort between the initial signal check and listener attachment.
    if (request.signal.aborted) onAbort();
    while (true) {
      const result = await reader.read();
      // Also bound an immediately resolving source that starves timer tasks.
      if (performance.now() >= deadline) onAbort();
      if (failure) throw failure;
      if (result.done) break;
      if (result.value.byteLength > limit - size) {
        // No rejected interruption promise here: this read has already settled.
        void reader.cancel().catch(() => {});
        throw new UploadAdmissionError(413, 'file_too_large');
      }
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof UploadAdmissionError ? error : new UploadAdmissionError(400, 'invalid_request');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
