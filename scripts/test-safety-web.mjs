import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const { Response, EventTarget, Event, Headers, AbortController, Blob } = globalThis;

const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sources = Object.fromEntries(await Promise.all(['safety-report', 'operator-console', 'social-review'].map(async name => [name, ts.transpileModule(await readFile(new URL(`../apps/web/components/${name}.tsx`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText])));
function walk(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const child of node) { const result = walk(child, predicate); if (result) return result; } return undefined; }
  return predicate(node) ? node : walk(node.props?.children, predicate);
}
function harness(t, name, props = {}, fetcher = async () => Response.json({ received: true })) {
  const requests = [], cells = [], effects = [], cleanups = [], created = [], revoked = [], timers = new Set();
  const window = Object.assign(new EventTarget(), { location: { hash: `#${'A'.repeat(43)}` } });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let cursor = 0, tree, component, mounted = true;
  const render = () => { cursor = 0; tree = component(props); };
  const same = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], value => { assert(mounted, 'No state update after unmount'); cells[index] = typeof value === 'function' ? value(cells[index]) : value; render(); }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useEffect(callback, dependencies) { const index = cursor++; if (!cells[index] || !same(cells[index], dependencies)) { cells[index] = dependencies; effects.push(callback); } },
  };
  const exported = {};
  vm.runInNewContext(sources[name], {
    exports: exported, window, document, Headers, AbortController,
    setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(callback) { timers.delete(callback); },
    URL: { createObjectURL(blob) { const url = `blob:fixture-${created.length + 1}`; created.push({ blob, url }); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    fetch: (url, init) => { const entry = { url, ...init }; requests.push(entry); return fetcher(entry); },
    require(path) {
      if (path === './social-review') return { SocialReview: 'SocialReview' };
      if (path === 'react') return react;
      if (path === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      throw new Error(`Unexpected import ${path}`);
    },
  });
  component = name === 'safety-report' ? exported.SafetyReport : name === 'social-review' ? exported.SocialReview : exported.OperatorConsole;
  if (name === 'social-review') props.request = (url, init) => { const entry = { url, ...init }; requests.push(entry); return fetcher(entry); };
  render();
  for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  const find = predicate => walk(tree, predicate);
  const button = text => find(node => node.type === 'button' && node.props.children === text);
  const unmount = () => { if (!mounted) return; mounted = false; for (const cleanup of cleanups.splice(0)) cleanup(); tree = undefined; };
  t.after(unmount);
  return {
    requests, created, revoked, find, button, unmount, expire() { for (const callback of [...timers]) callback(); timers.clear(); },
    tree: () => tree, text: () => JSON.stringify(tree),
    click(text) { const result = button(text); assert(result, `Missing button ${text}`); result.props.onClick(); },
    async submit() { const form = find(node => node.type === 'form'); assert(form); await form.props.onSubmit({ preventDefault() {} }); await flush(); },
    change(type, value) { const input = find(node => node.type === type); assert(input); input.props.onChange({ target: { value } }); },
    hash(value) { window.location.hash = `#${value}`; window.dispatchEvent(new Event('hashchange')); },
    blur() { window.dispatchEvent(new Event('blur')); },
    hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    leave() { window.dispatchEvent(new Event('pagehide')); },
  };
}

const postId = '11111111-1111-4111-8111-111111111111';
const accountToken = 'non-sensitive-fixture-account-token';
const queue = { posts: [{ postId, username: 'fixture_sender', kind: 'photo', status: 'moderation_pending', createdAt: '2026-10-29T00:00:00Z' }], profiles: [], reports: [] };
async function connect(h) { h.change('input', accountToken); await h.submit(); }

test('link report uses a body capability without revealing, claiming or putting it in the DOM/URL', async t => {
  let opened = 0;
  const h = harness(t, 'safety-report', { link: true, onOpen() { opened++; } });
  assert.equal(h.requests.length, 0);
  h.click('Report this moment'); h.change('select', 'child_safety'); h.change('textarea', '  Non-sensitive test concern  ');
  assert.equal(opened, 1);
  assert(!h.text().includes('A'.repeat(43)));
  await h.submit();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, '/api/safety/reports');
  assert.equal(request.cache, 'no-store'); assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(request.body), { token: 'A'.repeat(43), reason: 'child_safety', details: 'Non-sensitive test concern' });
  assert(!h.text().includes('Non-sensitive test concern'));
  assert.match(h.text(), /Report received/);
  await h.submit(); assert.equal(h.requests.length, 1, 'Success clears the target and cannot resubmit it');
});

test('account report snapshots only the identified username; malformed link cannot submit', async t => {
  const h = harness(t, 'safety-report', { username: 'fixture_account' });
  h.click('Report this account'); h.change('select', 'child_safety'); await h.submit();
  assert.deepEqual(JSON.parse(h.requests[0].body), { username: 'fixture_account', reason: 'child_safety', details: '' });
  const invalid = harness(t, 'safety-report', { link: true });
  invalid.hash('invalid'); invalid.click('Report this moment'); await invalid.submit();
  assert.equal(invalid.requests.length, 0);
  assert.equal(invalid.button('Submit report').props.disabled, true);
});

test('hash navigation aborts and fences a pending report and clears its old target/context', async t => {
  const pending = deferred(); let closed = 0;
  const h = harness(t, 'safety-report', { link: true, onClose() { closed++; } }, () => pending.promise);
  h.click('Report this moment'); h.change('select', 'child_safety'); h.change('textarea', 'Old report context');
  const submission = h.submit(); await flush();
  assert.equal(h.requests.length, 1);
  h.hash('B'.repeat(43));
  assert(h.requests[0].signal.aborted); assert.equal(closed, 1);
  assert(!h.find(node => node.type === 'form'));
  pending.resolve(Response.json({ received: true })); await submission;
  assert(!h.text().includes('Report received')); assert(!h.text().includes('Old report context'));
  h.click('Report this moment'); h.change('select', 'child_safety'); await h.submit();
  assert.equal(JSON.parse(h.requests[1].body).token, 'B'.repeat(43));
});

test('report unmount aborts pending work without late state updates', async t => {
  const pending = deferred();
  const h = harness(t, 'safety-report', { link: true }, () => pending.promise);
  h.click('Report this moment'); h.change('select', 'child_safety'); const submission = h.submit(); await flush();
  h.unmount(); assert(h.requests[0].signal.aborted);
  pending.resolve(Response.json({ received: true })); await submission;
});

test('operator queue requires deliberate account credentials; no clear media request or token rendering', async t => {
  const h = harness(t, 'operator-console', {}, async () => Response.json(queue));
  assert.equal(h.requests.length, 0); await connect(h);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/operator/queue');
  assert.equal(h.requests[0].headers.get('Authorization'), `Bearer ${accountToken}`);
  assert.equal(h.requests[0].credentials, 'omit'); assert.equal(h.requests[0].cache, 'no-store');
  assert(!h.text().includes(accountToken)); assert.equal(h.created.length, 0); assert(!h.find(node => node.type === 'img'));
  h.click('Clear operator session'); assert(!h.text().includes('fixture_sender'));
});

test('operator rejection never loads media and clears the token before another account attempt', async t => {
  let number = 0;
  const h = harness(t, 'operator-console', {}, async () => ++number === 1 ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(queue));
  await connect(h); assert.match(h.text(), /Access denied/); assert.equal(h.created.length, 0);
  assert.equal(h.find(node => node.type === 'input').props.value, '');
  await h.submit(); assert.equal(h.requests.length, 1, 'A failed credential cannot be silently retried from a cleared field');
});

for (const action of ['close', 'blur', 'hide', 'leave', 'unmount']) test(`operator ${action} releases a loaded private blob`, async t => {
  const h = harness(t, 'operator-console', {}, async request => request.url.endsWith('/queue') ? Response.json(queue) : { ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg' }), blob: async () => new Blob(['public-fixture-pixels']) });
  await connect(h); h.click('Review privately'); await flush();
  assert.equal(h.created.length, 1); assert(h.find(node => node.type === 'img'));
  const request = h.requests[1]; assert.equal(request.url, `/api/operator/media/${postId}`);
  assert.equal(request.headers.get('Authorization'), `Bearer ${accountToken}`);
  assert(!request.url.includes(accountToken));
  if (action === 'close') h.click('Close clear media'); else h[action]();
  assert.deepEqual(h.revoked, ['blob:fixture-1']); assert(!h.find(node => node.type === 'img'));
  if (action === 'leave') assert(!h.text().includes('fixture_sender'), 'Page restoration must not retain the private queue');
});

test('operator blur stops video/audio synchronously before releasing its object URL', async t => {
  const videoQueue = { ...queue, posts: [{ ...queue.posts[0], kind: 'video' }] };
  const h = harness(t, 'operator-console', {}, async request => request.url.endsWith('/queue') ? Response.json(videoQueue) : { ok: true, headers: new Headers({ 'Content-Type': 'video/mp4' }), blob: async () => new Blob(['public-fixture-video']) });
  await connect(h); h.click('Review privately'); await flush();
  const calls = [];
  h.find(node => node.type === 'video').props.ref.current = { pause() { calls.push('pause'); }, removeAttribute(name) { calls.push(`remove:${name}`); }, load() { calls.push('load'); } };
  h.blur(); assert.deepEqual(calls, ['pause', 'remove:src', 'load']); assert.equal(h.revoked.length, 1);
});

for (const action of ['disconnect', 'unmount', 'blur']) test(`a late operator media body cannot render after ${action}`, async t => {
  const pending = deferred();
  const h = harness(t, 'operator-console', {}, async request => request.url.endsWith('/queue') ? Response.json(queue) : { ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg' }), blob: () => pending.promise });
  await connect(h); h.click('Review privately'); await flush();
  if (action === 'disconnect') h.click('Clear operator session'); else h[action]();
  assert(h.requests[1].signal.aborted);
  pending.resolve(new Blob(['public-fixture-pixels'])); await flush();
  assert.equal(h.created.length, 0); assert(!h.find(node => node.type === 'img'));
});

for (const action of ['leave', 'unmount']) test(`late operator queue result cannot restore access after ${action}`, async t => {
  const pending = deferred();
  const h = harness(t, 'operator-console', {}, () => pending.promise);
  h.change('input', accountToken); const connection = h.submit(); await flush();
  h[action](); pending.resolve(Response.json(queue)); await connection;
  assert(!h.text()?.includes('fixture_sender'));
});


test('reports require deliberate reason selection instead of automatically classifying a child-safety concern', async t => {
  const h = harness(t, 'safety-report', { link: true });
  h.click('Report this moment');
  assert.equal(h.button('Submit report').props.disabled, true);
  await h.submit(); assert.equal(h.requests.length, 0);
  h.change('select', 'harassment'); await h.submit();
  assert.equal(JSON.parse(h.requests[0].body).reason, 'harassment');
});

test('private operator text inspection clears on blur and fences a late body response', async t => {
  const item = { kind: 'message', itemId: postId, authorAccountId: postId, status: 'moderation_pending', createdAt: '2026-10-30T00:00:00Z' };
  const pending = deferred();
  const h = harness(t, 'social-review', {}, entry => entry.url === '/api/operator/social/epoch' ? Promise.resolve(Response.json({epoch:1})) : entry.url === '/api/operator/social' ? Promise.resolve(Response.json({ items: [item], nextCursor: null })) : pending.promise);
  h.click('Load text queue'); await flush();
  h.click('Review text privately'); await flush();
  h.blur(); pending.resolve(Response.json({ body: 'Private generated message', status: 'moderation_pending' })); await flush();
  assert(!h.text().includes('Private generated message'));
  assert(!h.text().includes('Private message assessment'));
});
test('operator text decisions close bodies before IO and carry only explicit assessment', async t => {
  const item = { kind: 'comment', itemId: postId, authorAccountId: postId, status: 'moderation_pending', createdAt: '2026-10-30T00:00:00Z' };
  const h = harness(t, 'social-review', {}, async entry => entry.url === '/api/operator/social/epoch' ? Response.json({epoch:1}) : entry.url === '/api/operator/social' ? Response.json({ items: [item], nextCursor: null }) : entry.method === 'POST' ? Response.json({ status: 'approved' }) : Response.json({ body: 'Private generated comment', status: 'moderation_pending' }));
  h.click('Load text queue'); await flush(); h.click('Review text privately'); await flush();
  assert(h.text().includes('Private generated comment'));
  h.change('textarea', 'Independent generated review'); h.click('Approve');
  assert(!h.text().includes('Private generated comment')); await flush();
  assert.deepEqual(JSON.parse(h.requests.at(-1).body), { action: 'approve', reason: 'Independent generated review' });
  assert(!h.requests.at(-1).body.includes('Private generated comment'));
});

test('private operator text expires while foreground and late safety epoch changes deny rendering', async t => {
  const item = { kind: 'comment', itemId: postId, status: 'moderation_pending', createdAt: '2026-10-30T00:00:00Z' };
  let epoch = 1;
  const h = harness(t, 'social-review', {}, async entry => entry.url === '/api/operator/social/epoch' ? Response.json({epoch}) : entry.url === '/api/operator/social' ? Response.json({items:[item],nextCursor:null}) : Response.json({body:'Generated private review text',status:'moderation_pending'}));
  h.click('Load text queue'); await flush(); h.click('Review text privately'); await flush();
  h.change('textarea', 'Assessment draft'); assert(h.text().includes('Generated private review text'));
  h.expire(); assert(!h.text().includes('Generated private review text')); assert(h.text().includes('Assessment draft'));
  let calls=0;
  const stale = harness(t, 'social-review', {}, async entry => entry.url === '/api/operator/social/epoch' ? Response.json({epoch:++calls}) : entry.url === '/api/operator/social' ? Response.json({items:[item],nextCursor:null}) : Response.json({body:'Stale generated text',status:'approved'}));
  stale.click('Load text queue'); await flush(); stale.click('Review text privately'); await flush(); assert(!stale.text().includes('Stale generated text'));
});

test('operator membership revocation after private read denies the final delivery fence', async t => {
  const item = { kind: 'message', itemId: postId, status: 'approved', createdAt: '2026-10-31T00:00:00Z' }; let checks=0;
  const h = harness(t, 'social-review', {}, async entry => {
    if (entry.url === '/api/operator/social/epoch') return ++checks===1 ? Response.json({epoch:1}) : Response.json({error:'operator_required'},{status:403});
    if (entry.url === '/api/operator/social') return Response.json({items:[item],nextCursor:null});
    return Response.json({body:'Generated body after operator revocation',status:'approved'});
  });
  h.click('Load text queue'); await flush(); h.click('Review text privately'); await flush();
  assert.equal(checks,2); assert(!h.text().includes('Generated body after operator revocation'));
});
