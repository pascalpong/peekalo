import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ApiError } from './sharing';

const execute = promisify(execFile);
type VideoStage = 'probe' | 'validation' | 'transcode' | 'output';
type FailureCategory = 'timeout' | 'spawn_unavailable' | 'buffer_limit' | 'nonzero_exit' | 'terminated' | 'invalid_metadata' | 'output_limit' | 'io_failure';
function reportVideoFailure(stage: VideoStage, category: FailureCategory, started: number, error?: unknown) {
  const failure = error as { code?: unknown; signal?: unknown } | undefined;
  // execFile errors include argv, private paths and arbitrary source metadata in
  // message/stderr. Construct this record from a closed field/value allowlist.
  console.warn({ event: 'media_processing_failed', stage, category,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    ...(typeof failure?.code === 'number' && Number.isSafeInteger(failure.code) ? { exitCode: failure.code } : {}),
    ...(typeof failure?.signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(failure.signal) ? { signal: failure.signal } : {}),
  });
}
function executionCategory(error: unknown, started: number, timeoutMs: number): FailureCategory {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown } | undefined;
  // A signal alone can mean an external termination. These execFile calls use
  // only their local deadline to kill a child. FFmpeg may handle SIGTERM and
  // exit 255 instead, leaving signal null despite execFile's killed marker.
  if (failure?.killed === true && (failure.signal == null || failure.signal === 'SIGTERM') && performance.now() - started >= timeoutMs - 100) return 'timeout';
  if (failure?.code === 'ENOENT' || failure?.code === 'EACCES') return 'spawn_unavailable';
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'buffer_limit';
  return typeof failure?.code === 'number' ? 'nonzero_exit' : 'terminated';
}
let processing = 0;
export async function normalizeCapture(bytes: Buffer, kind: 'photo' | 'video') {
  if (processing >= 2) throw new ApiError(429, 'processing_busy');
  processing++;
  try {
    if (kind === 'photo') {
      try {
        const image = sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning', animated: false });
        const meta = await image.metadata();
        if (!['jpeg', 'png', 'webp', 'heif'].includes(meta.format ?? '') || !meta.width || !meta.height || (meta.pages ?? 1) > 1) throw new Error();
        // autoOrient and resize emit a new JPEG, excluding source metadata by default.
        const output = await image.autoOrient().resize(1080, 1920, { fit: 'cover', position: 'centre' }).jpeg({ quality: 86 }).toBuffer();
        return { bytes: output, extension: 'jpg', contentType: 'image/jpeg' };
      } catch { throw new ApiError(422, 'invalid_photo'); }
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'peekalo-process-'));
    try {
      const input = path.join(dir, 'capture'); const output = path.join(dir, 'normalized.mp4');
      await writeFile(input, bytes, { mode: 0o600 });
      const probeStarted = performance.now();
      let probe: { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
      let probeText: string;
      try {
        const result = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input], { timeout: 15_000, maxBuffer: 16_384 });
        probeText = result.stdout;
      } catch (error) { reportVideoFailure('probe', executionCategory(error, probeStarted, 15_000), probeStarted, error); throw new ApiError(422, 'invalid_video'); }
      try {
        probe = JSON.parse(probeText);
        if (!probe || !Array.isArray(probe.streams)) throw new Error();
      } catch { reportVideoFailure('validation', 'invalid_metadata', probeStarted); throw new ApiError(422, 'invalid_video'); }
      const stream = probe.streams?.find(item => item?.codec_type === 'video');
      const width = stream?.width; const height = stream?.height;
      const duration = Number(probe.format?.duration);
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096 || width * height > 17_000_000 || !Number.isFinite(duration) || duration <= 0 || duration > 10.15) {
        reportVideoFailure('validation', 'invalid_metadata', probeStarted); throw new ApiError(422, 'invalid_video');
      }
      const transcodeStarted = performance.now();
      try {
        await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-fs', '30000000', output], { timeout: 60_000, maxBuffer: 16_384 });
      } catch (error) {
        const category = executionCategory(error, transcodeStarted, 60_000);
        reportVideoFailure('transcode', category, transcodeStarted, error);
        throw new ApiError(422, category === 'timeout' ? 'video_processing_timeout' : 'video_processing_failed');
      }
      const outputStarted = performance.now();
      let normalized: Buffer;
      try { normalized = await readFile(output); }
      catch { reportVideoFailure('output', 'io_failure', outputStarted); throw new ApiError(422, 'video_processing_failed'); }
      if (!normalized.length || normalized.length >= 30_000_000) {
        reportVideoFailure('output', 'output_limit', outputStarted); throw new ApiError(422, 'video_processing_failed');
      }
      return { bytes: normalized, extension: 'mp4', contentType: 'video/mp4' };
    } finally { await rm(dir, { recursive: true, force: true }); }
  } finally { processing--; }
}
