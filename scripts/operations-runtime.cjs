'use strict';
// Shared by the source CLI and bundled CJS artifact. No dotenv loader is used.
function validateDeploymentEnvironment(env) {
  const origin = value => {
    const u = new globalThis.URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error();
    return u.origin;
  };
  if (!['development', 'staging', 'production'].includes(env.PEEKALO_DEPLOYMENT)) throw new Error();
  const actual = origin(env.SUPABASE_URL);
  if (origin(env.PEEKALO_EXPECTED_BACKEND_ORIGIN) !== actual) throw new Error();
  if (env.PEEKALO_DEPLOYMENT === 'development' && env.PEEKALO_PRODUCTION_BACKEND_ORIGIN && origin(env.PEEKALO_PRODUCTION_BACKEND_ORIGIN) === actual) throw new Error();
  if (env.PEEKALO_DEPLOYMENT !== 'development') {
    const production = origin(env.PEEKALO_PRODUCTION_BACKEND_ORIGIN);
    if ((env.PEEKALO_DEPLOYMENT === 'production') !== (production === actual)) throw new Error();
  }
  return { actual };
}
function validateOperationsEnvironment(env) {
  validateDeploymentEnvironment(env);
  const hook = value => {
    const u = new globalThis.URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
    return u.href;
  };
  return { heartbeat: hook(env.OPS_HEARTBEAT_URL), alert: hook(env.OPS_ALERT_URL) };
}
function createNotifier(hooks, send = globalThis.fetch) {
  return async event => {
    const url = event === 'success' ? hooks.heartbeat : hooks.alert;
    const reply = await send(url, {
      method: 'POST', redirect: 'error', signal: globalThis.AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'peekalo-maintenance', event }),
    });
    const ok = reply.ok;
    await reply.body?.cancel();
    if (!ok) throw new Error('notification_failed');
  };
}
module.exports = { validateDeploymentEnvironment, validateOperationsEnvironment, createNotifier };
