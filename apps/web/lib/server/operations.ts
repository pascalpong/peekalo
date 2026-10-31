import { createAccountCleanup } from './account-cleanup';
import { createMediaMaintenance } from './media-maintenance';
import { rpc } from './sharing';

type Call = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) => Promise<T>;
type Counts = { examined: number; completed: number; pending: number };
type Signal = 'success' | 'failure';
// Only fixed event names and aggregate counts leave this process. Hook URLs are
// credentials; neither provider responses nor exception text are ever logged.
export function createOperations({ call = rpc as Call, accounts = () => createAccountCleanup()(), media = () => createMediaMaintenance()(), notify = async (event: Signal) => { void event; throw new Error('monitor_unconfigured'); } } = {}) {
  return async function run(mode: 'maintenance' | 'monitor' = 'maintenance') {
    let pending = 0;
    try {
      if (mode === 'maintenance') {
        const result = await media();
        const deletion: Counts = await accounts();
        pending = result.pending + deletion.pending;
        await call('peekalo_abuse_expire', {});
        await call('peekalo_maintenance_heartbeat', { p_ok: pending === 0, p_pending: pending });
        if (pending) throw new Error('maintenance_pending');
      } else {
        const status = await call<Record<string, unknown>>('peekalo_operations_status', {});
        // Missing/malformed state, first run and scheduler loss are failures.
        const age = status.lastSuccessSeconds;
        if (typeof age !== 'number' || !Number.isFinite(age) || age < 0 || age > 1800 ||
            status.lastRunOk !== true) throw new Error('maintenance_stale');
        for (const field of ['oldestDeletionSeconds', 'writerPending', 'staleUploads', 'cleanupBacklog']) {
          if (typeof status[field] !== 'number' || !Number.isFinite(status[field]) || Number(status[field]) < 0) throw new Error('invalid_operations_state');
        }
        if (Number(status.oldestDeletionSeconds) > 3600 || Number(status.writerPending) > 0 ||
            Number(status.cleanupBacklog) > 100 || Number(status.staleUploads) > 0) throw new Error('recovery_attention_required');
        const social = await call<{ pendingReview: number; oldestPendingSeconds: number; restrictions: number }>('peekalo_social_operations', {});
        // A one-day engineering review-age alarm is a baseline for the selected
        // operator to validate; it is not a promised moderation response time.
        for (const field of ['pendingReview', 'oldestPendingSeconds', 'restrictions'] as const) {
          if (!Number.isSafeInteger(social[field]) || social[field] < 0) throw new Error('invalid_social_operations');
        }
        if (social.oldestPendingSeconds > 86400 || social.restrictions > 9000) throw new Error('social_attention_required');
        const abuse = await call<{ deniedLastHour: number }>('peekalo_abuse_status', {});
        if (!Number.isFinite(abuse.deniedLastHour) || abuse.deniedLastHour < 0 || abuse.deniedLastHour >= 100) throw new Error('abuse_attention_required');
      }
      await notify('success');
      return { ok: true };
    } catch {
      if (mode === 'maintenance') {
        try { await call('peekalo_maintenance_heartbeat', { p_ok: false, p_pending: pending }); } catch { /* Independent watchdog detects a missing heartbeat. */ }
      }
      try { await notify('failure'); } catch { /* CLI remains nonzero if alert transport also fails. */ }
      throw new Error('operations_incomplete');
    }
  };
}
