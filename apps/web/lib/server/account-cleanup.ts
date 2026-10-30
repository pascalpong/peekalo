import { createHash } from 'node:crypto';
import { database, rpc } from './sharing';
import { privateMediaCache } from './private-media-cache';

type DeletionJob = { requestId: string; accountId: string; requestedAt: string; notBefore: string; providerPending: boolean; providerRevoked: boolean; revokedAppleSubjectHash: string | null; writersPending: boolean; complete: boolean };
type CleanupFailure = 'storage_failed' | 'auth_failed' | 'provider_revocation_required' | 'cleanup_failed';
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const component = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/;
const pageSize = 100;
const maxEntries = 10_000;

/** Service-only maintenance. Durable database state is authoritative; no client
 * request or account identifier is accepted by the runner. Repeated/concurrent
 * runs are safe: object removal and provider deletion are idempotent, and the
 * completion transaction checks its prerequisites again. Never logs provider
 * responses or identifiers. Scheduling and alerting are operational release gates.
 */
export function createAccountCleanup({ db = database(), call = rpc, cache = privateMediaCache, now = Date.now } = {}) {
  const storage = db.storage.from('peekalo-captures');
  async function pathsUnder(accountId: string) {
    const paths: string[] = []; let entries = 0;
    async function visit(prefix: string, depth: number) {
      if (depth > 4 || !prefix.startsWith(`${accountId}/`) && prefix !== accountId) throw new Error('unsafe_storage_path');
      for (let offset = 0; ; offset += pageSize) {
        const result = await storage.list(prefix, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
        if (result.error || !Array.isArray(result.data) || result.data.length > pageSize) throw new Error('storage_failed');
        for (const item of result.data) {
          if (++entries > maxEntries || typeof item.name !== 'string' || !component.test(item.name) || item.name === '.' || item.name === '..') throw new Error('unsafe_storage_path');
          const path = `${prefix}/${item.name}`;
          if (item.id === null) await visit(path, depth + 1);
          else if (typeof item.id === 'string' && item.id.length) paths.push(path);
          else throw new Error('storage_failed');
        }
        if (result.data.length < pageSize) break;
      }
    }
    await visit(accountId, 0);
    return paths;
  }
  async function progress(requestId: string, stage: string, failure: string | null = null) {
    const accepted = await call<boolean>('peekalo_deletion_progress', { p_request: requestId, p_stage: stage, p_error: failure });
    if (accepted !== true) throw new Error('progress_not_recorded');
  }
  return async function runAccountCleanup(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_cleanup_limit');
    const jobs = await call<DeletionJob[]>('peekalo_deletion_jobs', { p_limit: limit });
    if (!Array.isArray(jobs) || jobs.length > limit) throw new Error('invalid_deletion_jobs');
    const summary = { examined: jobs.length, completed: 0, pending: 0 };
    for (const job of jobs) {
      // Validate before touching any remote object; malformed queue records can
      // never widen a prefix or cause another owner's Auth account to be removed.
      if (!job || !identifier.test(job.requestId) || !identifier.test(job.accountId) ||
          typeof job.providerPending !== 'boolean' || typeof job.providerRevoked !== 'boolean' || (job.revokedAppleSubjectHash !== null && (typeof job.revokedAppleSubjectHash !== 'string' || !/^[0-9a-f]{64}$/.test(job.revokedAppleSubjectHash))) || typeof job.writersPending !== 'boolean' || typeof job.complete !== 'boolean' || !Number.isFinite(Date.parse(job.requestedAt)) ||
          !Number.isFinite(Date.parse(job.notBefore)) || Date.parse(job.notBefore) < Date.parse(job.requestedAt) + 600_000 ||
          Date.parse(job.notBefore) > now()) { summary.pending++; continue; }
      let failure: CleanupFailure = 'storage_failed';
      try {
        // Collect the complete paginated inventory before removal. Deleting
        // while traversing offset pages would skip objects as offsets shift.
        const paths = await pathsUnder(job.accountId);
        for (let offset = 0; offset < paths.length; offset += pageSize) {
          const batch = paths.slice(offset, offset + pageSize);
          for (const path of batch) cache.remove(path);
          const removed = await storage.remove(batch);
          if (removed.error) throw new Error('storage_failed');
        }
        // A remove reply alone is insufficient; fail closed on a partial/unknown
        // delete or an object appearing during the sweep. Retry re-lists the root.
        if ((await pathsUnder(job.accountId)).length) throw new Error('storage_failed');
        await progress(job.requestId, 'storage_verified');
        // An ambiguous upload write may still reach Storage after this sweep.
        // Keep the durable writer barrier until a verified reconciliation; age
        // alone cannot establish that those bytes will never arrive.
        if (job.writersPending) { failure = 'cleanup_failed'; throw new Error('writer_reconciliation_required'); }
        if (job.complete) { summary.completed++; continue; }
        if (job.providerPending) {
          failure = 'provider_revocation_required';
          throw new Error('provider_revocation_required');
        }
        failure = 'auth_failed';
        const current = await db.auth.admin.getUserById(job.accountId);
        const absent = current.error?.code === 'user_not_found' && current.error?.status === 404;
        if (!absent) {
          if (current.error || current.data.user?.id !== job.accountId || !Array.isArray(current.data.user.identities)) throw new Error('auth_failed');
          // Provider linkage can change after the initial request. Recheck the
          // authoritative Auth user immediately before its destructive removal.
          const apple = current.data.user.identities.filter(identity => identity.provider === 'apple');
          const subject = apple[0]?.identity_data?.sub;
          if (apple.length && (apple.length !== 1 || typeof subject !== 'string' || !subject || !job.providerRevoked ||
              createHash('sha256').update(subject).digest('hex') !== job.revokedAppleSubjectHash)) {
            await progress(job.requestId, 'provider_required', typeof subject === 'string' && subject ? createHash('sha256').update(subject).digest('hex') : null);
            failure = 'provider_revocation_required';
            throw new Error('provider_revocation_required');
          }
          const removed = await db.auth.admin.deleteUser(job.accountId);
          if (removed.error) {
            // Covers a lost successful delete reply. Only explicit provider
            // absence suffices; network/5xx/other errors remain pending.
            const reconciled = await db.auth.admin.getUserById(job.accountId);
            if (!reconciled.error || reconciled.error.code !== 'user_not_found' || reconciled.error.status !== 404) throw new Error('auth_failed');
          }
        }
        await progress(job.requestId, 'auth_deleted');
        failure = 'cleanup_failed';
        if (await call<boolean>('peekalo_complete_deletion', { p_request: job.requestId }) !== true) throw new Error('cleanup_failed');
        summary.completed++;
      } catch {
        summary.pending++;
        // A failure recording progress must not erase prior work or falsely
        // complete. Next scheduled run starts from a fresh Storage inventory.
        try { await progress(job.requestId, 'failed', failure); } catch { /* Durable unfinished job remains queued. */ }
      }
    }
    // Expiry is a separate bounded transaction. Its receipt predicate requires
    // a recent empty sweep and excludes pending requests; the SQL remains the
    // authority even when this batch included a retryable failure.
    await call('peekalo_expire_private_records', {});
    return summary;
  };
}
