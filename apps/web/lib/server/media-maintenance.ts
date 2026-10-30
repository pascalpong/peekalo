import { database, rpc } from './sharing';
import { privateMediaCache } from './private-media-cache';

type MediaJob = { ownerId: string; postId: string };
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attemptFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|mp4)$/;
const pageSize = 100;

/** Durable database fencing determines whether an exact object can be removed.
 * The sweep never deletes posts, retry keys, claims or budgets. It inventories
 * before removal and rechecks each candidate against the current publication /
 * active attempt; concurrent retries therefore keep their distinct path. Unknown
 * names/subdirectories remain pending for restricted operator inspection. */
export function createMediaMaintenance({ db = database(), call = rpc, cache = privateMediaCache } = {}) {
  const storage = db.storage.from('peekalo-captures');
  async function inventory(job: MediaJob) {
    const base = `${job.ownerId}/${job.postId}`;
    const paths: string[] = [];
    // Attempt-specific paths occupy exactly one level. Also recover historical
    // flat owner/post.jpg|mp4 paths, without touching any sibling post.
    for (const prefix of [base, job.ownerId]) {
      let count = 0;
      for (let offset = 0; ; offset += pageSize) {
        const result = await storage.list(prefix, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
        if (result.error || !Array.isArray(result.data) || result.data.length > pageSize) throw new Error('inventory_failed');
        for (const item of result.data) {
          if (++count > 10_000 || typeof item.name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(item.name) || item.name === '.' || item.name === '..') throw new Error('inventory_failed');
          if (prefix === base) {
            if (!attemptFile.test(item.name) || typeof item.id !== 'string' || !item.id) throw new Error('inventory_failed');
            paths.push(`${base}/${item.name}`);
          } else if (item.name === `${job.postId}.jpg` || item.name === `${job.postId}.mp4`) {
            if (typeof item.id !== 'string' || !item.id) throw new Error('inventory_failed');
            paths.push(`${job.ownerId}/${item.name}`);
          }
        }
        if (result.data.length < pageSize) break;
      }
    }
    return paths;
  }
  return async function runMediaMaintenance(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_cleanup_limit');
    const jobs = await call<MediaJob[]>('peekalo_media_cleanup_jobs', { p_limit: limit });
    if (!Array.isArray(jobs) || jobs.length > limit) throw new Error('invalid_media_jobs');
    const summary = { examined: jobs.length, completed: 0, pending: 0, removed: 0 };
    for (const job of jobs) {
      if (!job || !identifier.test(job.ownerId) || !identifier.test(job.postId)) { summary.pending++; continue; }
      const args = { p_owner: job.ownerId, p_post: job.postId };
      try {
        const paths = await inventory(job);
        for (const path of paths) {
          const allowed = await call<boolean>('peekalo_media_cleanup_path', { ...args, p_path: path });
          if (allowed !== true) continue;
          cache.remove(path);
          const result = await storage.remove([path]);
          if (result.error) throw new Error('removal_failed');
          summary.removed++;
        }
        // A successful provider reply is insufficient for partial removals.
        // Protected/current attempts can remain; removable leftovers cannot.
        for (const path of await inventory(job)) {
          if (await call<boolean>('peekalo_media_cleanup_path', { ...args, p_path: path }) === true) throw new Error('removal_unverified');
        }
        if (await call<boolean>('peekalo_media_cleanup_done', { ...args, p_ok: true }) !== true) throw new Error('progress_failed');
        summary.completed++;
      } catch {
        summary.pending++;
        try { await call('peekalo_media_cleanup_done', { ...args, p_ok: false }); } catch { /* Durable unchecked job is retried. */ }
      }
    }
    return summary;
  };
}
