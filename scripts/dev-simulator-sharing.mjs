// Explicit loopback-only simulator test input. No hosted env files, uploads,
// fixture grants/acceptance/leases or blanket moment approval are performed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixtureOperator } from './safety-fixture-operator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.cache/run04/simulator-sharing');
const statePath = join(directory, 'fixtures.json');
const base = 'http://127.0.0.1:3101';
const local = parseEnv(await readFile(join(root, 'apps/web/.env.local-testing'), 'utf8'));
assert.equal(local.SUPABASE_URL, 'http://127.0.0.1:55321');
assert.equal(local.PUBLIC_APP_URL, base);
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const db = createClient(local.SUPABASE_URL, local.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const exec = promisify(execFile);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
async function save(state) { await writeFile(statePath, JSON.stringify(state), { mode: 0o600 }); await chmod(statePath, 0o600); }
async function load() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.backend, local.SUPABASE_URL);
  assert.match(state.prefix, /^sim_[a-f0-9]{8}$/);
  for (const role of ['sender', 'recipient']) {
    assert.equal(state[role].email, `${state.prefix}_${role}@example.invalid`);
    assert.equal(state[role].username, `${state.prefix}_${role === 'sender' ? 's' : 'r'}`);
    assert(state.users.includes(state[role].id));
  }
  return state;
}
async function login(actor) {
  const client = createClient(local.SUPABASE_URL, local.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email: actor.email, password: actor.password });
  assert(!result.error && result.data.session, 'Generated fixture login failed');
  client.auth.stopAutoRefresh();
  return result.data.session.access_token;
}
async function api(path, token, value, method = 'POST') {
  const response = await fetch(`${base}${path}`, { method, headers: { Origin: base, Authorization: `Bearer ${token}`, ...(value ? { 'Content-Type': 'application/json' } : {}) }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `Local fixture API returned ${response.status}`);
  return response.json();
}
const mode = process.argv[2] ?? 'start';
async function generateMedia() {
  const sharp = require('sharp');
  const svg = '<svg width="360" height="640" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="640" fill="#243744"/><circle cx="180" cy="280" r="115" fill="#f4d171"/><rect x="60" y="390" width="240" height="120" rx="32" fill="#708cdb"/><text x="180" y="80" font-size="24" text-anchor="middle" fill="white">SIMULATOR TEST PHOTO</text><text x="180" y="570" font-size="20" text-anchor="middle" fill="white">GENERATED · NO PRIVATE MEDIA</text></svg>';
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(join(directory, 'photo.jpg'));
  const label = '<svg width="360" height="84" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="84" fill="black"/><text x="180" y="34" font-size="23" text-anchor="middle" fill="white">SIMULATOR TEST VIDEO</text><text x="180" y="64" font-size="17" text-anchor="middle" fill="white">GENERATED · 6 SECONDS · TEST TONE</text></svg>';
  await sharp(Buffer.from(label)).png().toFile(join(directory, 'video-label.png'));
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-loop', '1', '-i', join(directory, 'video-label.png'), '-filter_complex', '[0:v][2:v]overlay=0:0[v]', '-map', '[v]', '-map', '1:a', '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(directory, 'video.mp4')]);
}
if (mode === 'prepare') {
  let existing;
  try { existing = await load(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) { console.log('Existing designated fixtures preserved.'); process.exit(0); }
  // Only this known local helper gets server credentials; Metro never does.
  process.env.SUPABASE_URL = local.SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = local.SUPABASE_ANON_KEY;
  const state = { backend: local.SUPABASE_URL, prefix: `sim_${randomUUID().replaceAll('-', '').slice(0, 8)}`, users: [] };
  state.operatorToken = await fixtureOperator(db, state.users, state.prefix);
  await save(state); // Keep a scoped ledger even if later preparation fails.
  for (const role of ['sender', 'recipient']) {
    const actor = { email: `${state.prefix}_${role}@example.invalid`, password: `${randomUUID()}aA1!`, username: `${state.prefix}_${role === 'sender' ? 's' : 'r'}` };
    const created = await db.auth.admin.createUser({ email: actor.email, password: actor.password, email_confirm: true });
    assert(!created.error && created.data.user);
    actor.id = created.data.user.id; state.users.push(actor.id); state[role] = actor; await save(state);
    const token = await login(actor);
    await api('/api/profile', token, { username: actor.username });
    await api('/api/operator/profile', state.operatorToken, { username: actor.username, action: 'approve', reason: 'Designated generated simulator fixture username; separate fixture reviewer' });
  }
  await generateMedia();
  console.log(`Prepared designated preconfirmed local fixture accounts. Sender @${state.sender.username}; recipient @${state.recipient.username}. No moments uploaded or approved. Native signup/email confirmation is separate evidence.`);
} else if (mode === 'generate') {
  await generateMedia();
  console.log('Generated labelled simulator photo and six-second video. No accounts, uploads, grants or budgets changed.');
} else if (mode === 'status' || mode === 'approve' || mode === 'review') {
  const state = await load();
  const token = await login(state.sender);
  const inventory = await api('/api/posts', token, undefined, 'GET');
  if (mode === 'status') {
    console.log(JSON.stringify({ sender: state.sender.username, recipient: state.recipient.username, ...inventory }, null, 2));
  } else {
    const id = process.argv[3];
    assert.match(id ?? '', /^[a-f0-9-]{36}$/);
    const item = inventory.items.find(item => item.postId === id);
    assert(item && item.status === 'moderation_pending', 'Only this run sender’s pending moment can be reviewed');
    if (mode === 'review') {
      const response = await fetch(`${base}/api/operator/media/${id}`, { headers: { Authorization: `Bearer ${state.operatorToken}` }, signal: AbortSignal.timeout(20_000) });
      assert(response.ok, 'Separate fixture reviewer media fetch denied');
      const target = join(directory, `review-${id}.${item.kind === 'photo' ? 'jpg' : 'mp4'}`);
      await writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      console.log(`Separate fixture reviewer downloaded designated generated media for inspection: ${target}`);
    } else {
      assert(process.env.PEEKALO_REVIEWED_GENERATED_FIXTURE === id, 'Inspect this exact generated fixture first, then supply its ID as PEEKALO_REVIEWED_GENERATED_FIXTURE');
      await api('/api/operator/decision', state.operatorToken, { postId: id, action: 'approve', reason: 'Inspected designated generated simulator test media; separate fixture reviewer' });
      console.log('The separate fixture reviewer approved only the specified inspected generated moment.');
    }
  }
} else if (mode === 'start') {
  const state = await load();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const role = request.url === '/account/sender' ? 'sender' : request.url === '/account/recipient' ? 'recipient' : null;
    if (role) { response.setHeader('Content-Type', 'application/json'); const { email, password, username } = state[role]; response.end(JSON.stringify({ email, password, username })); return; }
    const kind = request.url === '/photo' ? 'photo' : request.url === '/video' ? 'video' : null;
    if (!kind) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', kind === 'photo' ? 'image/jpeg' : 'video/mp4');
    response.end(await readFile(join(directory, kind === 'photo' ? 'photo.jpg' : 'video.mp4')));
  });
  server.listen(4184, '127.0.0.1');
  console.log(`Local simulator fixtures only. Sender @${state.sender.username}; recipient @${state.recipient.username}. Moment review remains manual. Server keys and reviewer credentials are never served.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
} else throw new Error('Choose prepare, generate, start, status, review or approve');
