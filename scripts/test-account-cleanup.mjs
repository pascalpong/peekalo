import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/account-cleanup.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', request = '33333333-3333-4333-8333-333333333333';
const stamp = Date.parse('2026-10-29T10:00:00Z');
const job = { accountId: owner, requestId: request, requestedAt: new Date(stamp - 700_000).toISOString(), notBefore: new Date(stamp - 100_000).toISOString(), providerPending: false, providerRevoked: false, revokedAppleSubjectHash: null, writersPending: false, complete: false };
function fixture({ paths = [`${owner}/post/image.jpg`], jobs = [job], listFailure, removeFailure, authFailure, getFailure, progressFailure, completion = true, afterRemove, identities = [] } = {}) {
  const files = new Set([...paths, `${other}/unrelated.jpg`]), events = [];
  const storage = {
    async list(prefix, options) {
      events.push(['list', prefix, options.offset]);
      if (listFailure?.(prefix, events)) return { data: null, error: { message: 'synthetic private error' } };
      const names = new Map();
      for (const file of files) {
        if (!file.startsWith(`${prefix}/`)) continue;
        const tail = file.slice(prefix.length + 1), name = tail.split('/')[0];
        names.set(name, { name, id: tail.includes('/') ? null : 'synthetic-object-id' });
      }
      return { data: [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(options.offset, options.offset + options.limit), error: null };
    },
    async remove(paths) {
      events.push(['remove', ...paths]);
      if (removeFailure?.(paths)) return { data: null, error: { message: 'synthetic private removal error' } };
      for (const path of paths) files.delete(path);
      afterRemove?.(files);
      return { data: paths.map(name => ({ name })), error: null };
    },
  };
  const db = { storage: { from(bucket) { assert.equal(bucket, 'peekalo-captures'); return storage; } }, auth: { admin: {
    async deleteUser(id) { events.push(['auth-delete', id]); return { error: authFailure?.() ?? null }; },
    async getUserById(id) { events.push(['auth-get', id]); return { error: getFailure?.() ?? null, data: { user: { id, identities } } }; },
  } } };
  const call = async (name, args) => {
    events.push([name, args]);
    if (name === 'peekalo_deletion_jobs') return jobs;
    if (name === 'peekalo_deletion_progress') return !progressFailure?.(args);
    if (name === 'peekalo_expire_private_records') return { reports: 0, audits: 0, receipts: 0 };
    assert.equal(name, 'peekalo_complete_deletion'); return completion;
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (name === 'node:crypto') return crypto;
    if (name === './sharing') return { database: () => db, rpc: call };
    assert.equal(name, './private-media-cache'); return { privateMediaCache: { remove: path => events.push(['cache-remove', path]) } };
  }, module, module.exports);
  return { files, events, run: module.exports.createAccountCleanup({ now: () => stamp }), storage };
}
function stages(f) { return f.events.filter(item => item[0] === 'peekalo_deletion_progress').map(item => [item[1].p_stage, item[1].p_error]); }
function authTouched(f) { return f.events.some(item => item[0].startsWith('auth-')); }

test('complete sweep removes nested/legacy/orphan objects only under queued owner; independent verification precedes Auth', async () => {
  const f = fixture({ paths: [`${owner}/legacy.jpg`, `${owner}/post/attempt.jpg`, `${owner}/orphan/old.mp4`] });
  assert.deepEqual(await f.run(), { examined: 1, completed: 1, pending: 0 });
  assert.deepEqual([...f.files], [`${other}/unrelated.jpg`]);
  assert.deepEqual(stages(f), [['storage_verified', null], ['auth_deleted', null]]);
  const authIndex = f.events.findIndex(item => item[0] === 'auth-get');
  assert(f.events.slice(0, authIndex).some(item => item[0] === 'remove'));
  assert.equal(f.events[authIndex - 2][0], 'list');
  assert.equal(f.events[authIndex - 1][0], 'peekalo_deletion_progress');
  assert.equal(f.events.at(-2)[0], 'peekalo_complete_deletion');
  assert.equal(f.events.at(-1)[0], 'peekalo_expire_private_records');
});

test('pagination collects before deleting, so shifted offsets cannot skip more than one page', async () => {
  const paths = Array.from({ length: 230 }, (_, index) => `${owner}/post/${String(index).padStart(3, '0')}.jpg`);
  const f = fixture({ paths });
  assert.equal((await f.run()).completed, 1);
  assert.deepEqual([...f.files], [`${other}/unrelated.jpg`]);
  assert.deepEqual(f.events.filter(item => item[0] === 'remove').map(item => item.length - 1), [100, 100, 30]);
  const before = f.events.slice(0, f.events.findIndex(item => item[0] === 'remove'));
  assert(before.some(item => item[0] === 'list' && item[2] === 200));
});

test('Storage list/removal failures remain pending and never reach Auth; retry starts with a fresh inventory', async () => {
  for (const kind of ['list', 'remove']) {
    let outage = true;
    const f = fixture({ listFailure: () => kind === 'list' && outage, removeFailure: () => kind === 'remove' && outage });
    assert.deepEqual(await f.run(), { examined: 1, completed: 0, pending: 1 });
    assert(!authTouched(f)); assert.deepEqual(stages(f).at(-1), ['failed', 'storage_failed']);
    outage = false;
    assert.equal((await f.run()).completed, 1);
    assert(![...f.files].some(path => path.startsWith(`${owner}/`)));
  }
});

test('apparently successful partial removal cannot produce a complete deletion', async () => {
  let repeat = true;
  const f = fixture({ afterRemove: files => { if (repeat) files.add(`${owner}/late/arrived.jpg`); } });
  assert.equal((await f.run()).pending, 1); assert(!authTouched(f));
  repeat = false;
  assert.equal((await f.run()).completed, 1);
});

test('unknown Auth failure remains pending; only explicit 404 user_not_found can reconcile a lost successful delete', async () => {
  let lookups = 0;
  const f = fixture({ authFailure: () => ({ status: 503, code: 'unexpected_failure' }), getFailure: () => {
    lookups++;
    return lookups === 1 ? null : lookups === 2 ? ({ status: 503, code: 'unexpected_failure' }) : ({ status: 404, code: 'user_not_found' });
  } });
  assert.equal((await f.run()).pending, 1);
  assert(!f.events.some(item => item[0] === 'peekalo_complete_deletion'));
  assert.deepEqual(stages(f).at(-1), ['failed', 'auth_failed']);
  assert.equal(f.events.filter(item => item[0] === 'auth-delete').length, 1);
  assert.equal((await f.run()).completed, 1);
  assert.equal(f.events.filter(item => item[0] === 'auth-delete').length, 1);
  assert.deepEqual(stages(f).at(-1), ['auth_deleted', null]);
});

test('nonabsence Auth errors and a mismatched not-found status cannot complete', async () => {
  for (const error of [{ status: 404, code: 'unexpected_failure' }, { status: 503, code: 'user_not_found' }, null]) {
    const f = fixture({ authFailure: () => ({ status: 500 }), getFailure: () => error });
    assert.equal((await f.run()).pending, 1);
    assert(!f.events.some(item => item[0] === 'peekalo_complete_deletion'));
  }
});

test('Apple provider revocation remains an explicit pending dependency after objects are removed', async () => {
  const f = fixture({ jobs: [{ ...job, providerPending: true }] });
  assert.equal((await f.run()).pending, 1); assert(!authTouched(f));
  assert.deepEqual(stages(f), [['storage_verified', null], ['failed', 'provider_revocation_required']]);
});

test('invalid, future and insufficiently delayed records never touch Storage or Auth', async () => {
  const invalid = [null, { ...job, accountId: '../other-owner' }, { ...job, accountId: owner.toUpperCase() }, { ...job, requestId: '' }, { ...job, providerPending: 'false' }, { ...job, requestedAt: 'invalid' }, { ...job, notBefore: new Date(stamp + 1).toISOString() }, { ...job, requestedAt: new Date(stamp - 100_001).toISOString() }];
  // UUID used here contains no letters, use an explicitly uppercase alphabetic ID.
  invalid[2] = { ...job, accountId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' };
  for (const bad of invalid) {
    const f = fixture({ jobs: [bad] });
    assert.equal((await f.run()).pending, 1); assert(!authTouched(f));
    assert(!f.events.some(item => ['list', 'remove'].includes(item[0])));
  }
});

test('unsafe Storage names fail closed without widening a removal prefix', async () => {
  for (const name of ['..', '../secret', 'folder\\secret', '', '.hidden']) {
    const f = fixture();
    f.storage.list = async () => ({ data: [{ name, id: 'object' }], error: null });
    assert.equal((await f.run()).pending, 1); assert(!authTouched(f));
    assert(!f.events.some(item => item[0] === 'remove'));
  }
});

test('failure to durably record Storage/Auth progress or finish leaves a retryable job', async () => {
  for (const failStage of ['storage_verified', 'auth_deleted', 'complete']) {
    const f = fixture({ progressFailure: args => args.p_stage === failStage, completion: failStage !== 'complete' });
    assert.equal((await f.run()).pending, 1);
    if (failStage === 'storage_verified') assert(!authTouched(f));
    if (failStage === 'auth_deleted') assert(!f.events.some(item => item[0] === 'peekalo_complete_deletion'));
  }
});

test('concurrent sweeps only target the same owner, are repeatable, and never delete unrelated bytes', async () => {
  const f = fixture();
  const results = await Promise.all([f.run(), f.run()]);
  assert(results.every(result => result.completed === 1));
  assert.deepEqual([...f.files], [`${other}/unrelated.jpg`]);
  assert(f.events.filter(item => item[0] === 'auth-delete').every(item => item[1] === owner));
});

test('invalid limits and oversized malformed queue responses stop before remote side effects', async () => {
  const f = fixture();
  for (const limit of [0, 101, 1.5, NaN]) await assert.rejects(() => f.run(limit));
  const malformed = fixture({ jobs: [job, job] });
  await assert.rejects(() => malformed.run(1));
  assert(!authTouched(malformed));
});


test('uncertain in-flight writers keep cleanup pending even after an empty Storage sweep', async () => {
  const f = fixture({ jobs: [{ ...job, writersPending: true }] });
  assert.equal((await f.run()).pending, 1); assert(!authTouched(f));
  assert.deepEqual(stages(f), [['storage_verified', null], ['failed', 'cleanup_failed']]);
  assert(!f.events.some(item => item[0] === 'peekalo_complete_deletion'));
});

test('completed receipts are independently reswept without recreating Auth or completion state', async () => {
  const f = fixture({ jobs: [{ ...job, complete: true }] });
  assert.equal((await f.run()).completed, 1); assert(!authTouched(f));
  assert.deepEqual(stages(f), [['storage_verified', null]]);
  assert(![...f.files].some(path => path.startsWith(`${owner}/`)));
  assert(!f.events.some(item => item[0] === 'peekalo_complete_deletion'));
});


test('Apple identity linked after initial request becomes a durable provider requirement before Auth removal', async () => {
  const f = fixture({ identities: [{ provider: 'apple' }] });
  assert.equal((await f.run()).pending, 1);
  assert(!f.events.some(item => item[0] === 'auth-delete'));
  assert.deepEqual(stages(f), [['storage_verified', null], ['provider_required', null], ['failed', 'provider_revocation_required']]);
  const subject = 'fixture-apple-subject', hash = crypto.createHash('sha256').update(subject).digest('hex');
  const revoked = fixture({ jobs: [{ ...job, providerRevoked: true, revokedAppleSubjectHash: hash }], identities: [{ provider: 'apple', identity_data: { sub: subject } }] });
  assert.equal((await revoked.run()).completed, 1);
  for (const identities of [[{ provider: 'apple' }], [{ provider: 'apple', identity_data: { sub: 'different-subject' } }], [{ provider: 'apple', identity_data: { sub: subject } }, { provider: 'apple', identity_data: { sub: subject } }]]) {
    const mismatched = fixture({ jobs: [{ ...job, providerRevoked: true, revokedAppleSubjectHash: hash }], identities });
    assert.equal((await mismatched.run()).pending, 1);
    assert(!mismatched.events.some(item => item[0] === 'auth-delete'));
    assert.deepEqual(stages(mismatched).at(-1), ['failed', 'provider_revocation_required']);
  }
});
