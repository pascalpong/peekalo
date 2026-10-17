import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from './sharing';

const execute = promisify(execFile);
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
      let probe: { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
      try {
        const result = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input], { timeout: 15_000, maxBuffer: 16_384 });
        probe = JSON.parse(result.stdout);
      } catch { throw new ApiError(422, 'invalid_video'); }
      const stream = probe.streams?.find(item => item.codec_type === 'video');
      const duration = Number(probe.format?.duration);
      if (!stream?.width || !stream.height || stream.width > 4096 || stream.height > 4096 || stream.width * stream.height > 17_000_000 || !Number.isFinite(duration) || duration <= 0 || duration > 10.15) throw new ApiError(422, 'invalid_video');
      try {
        await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1', '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-fs', '30000000', output], { timeout: 60_000, maxBuffer: 16_384 });
        const normalized = await readFile(output);
        if (!normalized.length || normalized.length >= 30_000_000) throw new Error();
        return { bytes: normalized, extension: 'mp4', contentType: 'video/mp4' };
      } catch { throw new ApiError(422, 'video_processing_failed'); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  } finally { processing--; }
}
