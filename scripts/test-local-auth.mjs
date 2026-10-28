// Real signup/email-confirmation checks against only the isolated local stack.
// Uses a generated .invalid identity; never sends email or touches hosted accounts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const api = 'http://127.0.0.1:55321';
const product = 'http://127.0.0.1:3101';
const mail = 'http://127.0.0.1:55324';
assert(process.env.SUPABASE_URL === api, 'This test requires the isolated local configuration');
assert(process.env.PUBLIC_APP_URL === product, 'This test requires the local product origin');
const options = { auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false } };
const client = createClient(api, process.env.SUPABASE_ANON_KEY, options);
const admin = createClient(api, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const email = `signup_${suffix}@example.invalid`;
const password = `${randomUUID()}aA1!`;
const verifierStore = new Map();
const confirmationOptions = { auth: { flowType: 'pkce', storageKey: 'confirmation-local-test', persistSession: true, autoRefreshToken: false,
  storage: { getItem: key => verifierStore.get(key) ?? null, setItem: (key, value) => { verifierStore.set(key, value); }, removeItem: key => { verifierStore.delete(key); } } } };
const signupClient = createClient(api, process.env.SUPABASE_ANON_KEY, confirmationOptions);
let userId, otherId, passed = 0;
const check = (condition, label) => { assert(condition, label); passed++; };
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, 'Local endpoint unavailable');
  return response.json();
}
try {
  const config = await json(`${product}/api/shares/config`);
  check(config.ready && config.supabaseUrl === api, 'Native bootstrap points only at local Supabase');
  const settings = await (await fetch(`${api}/auth/v1/settings`, { headers: { apikey: process.env.SUPABASE_ANON_KEY } })).json();
  check(settings.mailer_autoconfirm === false && settings.external?.google === false, 'Confirmation stays enabled and local Google stays disabled');
  const signup = await signupClient.auth.signUp({ email, password, options: { emailRedirectTo: 'peekalo://confirm-email' } });
  userId = signup.data.user?.id;
  check(!signup.error && userId && !signup.data.session, 'Signup creates an unconfirmed account without granting a session');
  const denied = await client.auth.signInWithPassword({ email, password });
  check(denied.error?.code === 'email_not_confirmed' && !denied.data.session, 'Unconfirmed account cannot sign in');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const firstEmails = new Set((await json(`${mail}/api/v1/messages`)).messages.map(item => item.ID));
  const resend = await signupClient.auth.resend({ type: 'signup', email, options: { emailRedirectTo: 'peekalo://confirm-email' } });
  check(!resend.error && !resend.data.session, 'Resend confirmation uses a fresh PKCE verifier without signing in');
  let message;
  for (let attempt = 0; attempt < 20 && !message; attempt++) {
    const list = await json(`${mail}/api/v1/messages`);
    const entry = list.messages.find(item => !firstEmails.has(item.ID) && item.To?.some(recipient => recipient.Address === email));
    if (entry) message = await json(`${mail}/api/v1/message/${encodeURIComponent(entry.ID)}`);
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  check(Boolean(message), 'Confirmation email reaches the local inbox');
  const match = message.Text.match(/https?:\/\/[^\s<>]+\/auth\/v1\/verify\?[^\s<>]+/);
  assert(match, 'Local confirmation link missing');
  const confirmation = new URL(match[0].replaceAll('&amp;', '&'));
  assert(confirmation.origin === api && confirmation.pathname === '/auth/v1/verify', 'Confirmation must stay on the isolated local API');
  const verified = await fetch(confirmation, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  check(verified.status === 303 || verified.status === 302, 'Confirmation link completes without following its secret-bearing redirect');
  const destination = new URL(verified.headers.get('location'));
  check(destination.protocol === 'peekalo:' && destination.host === 'confirm-email' && !destination.hash && Boolean(destination.searchParams.get('code')), 'Confirmation redirect uses native PKCE without bearer tokens');
  const coldConfirmation = createClient(api, process.env.SUPABASE_ANON_KEY, confirmationOptions);
  const exchanged = await coldConfirmation.auth.exchangeCodeForSession(destination.searchParams.get('code'), { flowId: destination.searchParams.get('sb_flow_id') });
  check(!exchanged.error && exchanged.data.user?.id === userId && Boolean(exchanged.data.user.email_confirmed_at), 'Fresh client restores verifier and confirms the generated account');
  check(!(await client.auth.getSession()).data.session, 'Isolated email confirmation leaves ordinary client signed out');
  const confirmationReplay = await coldConfirmation.auth.exchangeCodeForSession(destination.searchParams.get('code'), { flowId: destination.searchParams.get('sb_flow_id') });
  check(Boolean(confirmationReplay.error) && !confirmationReplay.data.session, 'Consumed confirmation code cannot be replayed');
  verifierStore.clear();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  check(!signedIn.error && signedIn.data.user?.id === userId && Boolean(signedIn.data.session), 'Confirmed account can sign in with its password');
  const username = `local_${suffix}`;
  const token = signedIn.data.session.access_token;
  const saved = await fetch(`${product}/api/profile`, { method: 'POST', headers: { Origin: product, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
  check(saved.ok, 'Confirmed account can choose a username through the product API');
  const profile = await fetch(`${product}/api/profile`, { headers: { Authorization: `Bearer ${token}` } });
  check(profile.ok && (await profile.json()).username === username, 'Chosen username persists');
  const other = await admin.auth.admin.createUser({ email: `username_${suffix}@example.invalid`, password, email_confirm: true });
  otherId = other.data.user?.id;
  assert(otherId && !other.error, 'Disposable username contender created');
  const contender = createClient(api, process.env.SUPABASE_ANON_KEY, options);
  const otherLogin = await contender.auth.signInWithPassword({ email: `username_${suffix}@example.invalid`, password });
  assert(otherLogin.data.session && !otherLogin.error, 'Disposable username contender signed in');
  const writeProfile = name => fetch(`${product}/api/profile`, { method: 'POST', headers: { Origin: product, Authorization: `Bearer ${otherLogin.data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name }) });
  const conflict = await writeProfile(username);
  check(conflict.status === 409 && (await conflict.json()).error === 'username_taken', 'A different account cannot take an existing username');
  const invalidName = await writeProfile('Invalid name!');
  check(invalidName.status === 400 && (await invalidName.json()).error === 'invalid_username', 'Invalid username is denied authoritatively');
  const available = await writeProfile(`other_${suffix}`);
  check(available.ok, 'Contender can retry with an available username');
  await contender.auth.signOut();
  const unchanged = await fetch(`${product}/api/profile`, { headers: { Authorization: `Bearer ${token}` } });
  check((await unchanged.json()).username === username, 'Conflict and retry leave the original account username intact');
  const signedOut = await client.auth.signOut();
  check(!signedOut.error, 'Account can sign out');

  // Exercise the real mail/PKCE/password path. Never print the recovery URL,
  // code, verifier or passwords, and never modify an existing phone account.
  const recovery = createClient(api, process.env.SUPABASE_ANON_KEY, options);
  const events = [];
  const subscription = recovery.auth.onAuthStateChange(event => { events.push(event); });
  try {
    const before = new Set((await json(`${mail}/api/v1/messages`)).messages.map(item => item.ID));
    const requested = await recovery.auth.resetPasswordForEmail(email, { redirectTo: 'peekalo://reset-password' });
    check(!requested.error, 'Password recovery request succeeds');
    let recoveryMessage;
    for (let attempt = 0; attempt < 30 && !recoveryMessage; attempt++) {
      const list = await json(`${mail}/api/v1/messages`);
      const entry = list.messages.find(item => !before.has(item.ID) && item.To?.some(recipient => recipient.Address === email));
      if (entry) recoveryMessage = await json(`${mail}/api/v1/message/${encodeURIComponent(entry.ID)}`);
      else await new Promise(resolve => setTimeout(resolve, 250));
    }
    check(Boolean(recoveryMessage), 'Recovery email reaches only the local inbox');
    const recoveryMatch = recoveryMessage.Text.match(/https?:\/\/[^\s<>]+\/auth\/v1\/verify\?[^\s<>]+/);
    assert(recoveryMatch, 'Local recovery link missing');
    const recoveryLink = new URL(recoveryMatch[0].replaceAll('&amp;', '&'));
    assert(recoveryLink.origin === api && recoveryLink.pathname === '/auth/v1/verify' && recoveryLink.searchParams.get('type') === 'recovery', 'Recovery must stay on the isolated local API');
    const redirected = await fetch(recoveryLink, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const destination = new URL(redirected.headers.get('location'));
    check((redirected.status === 302 || redirected.status === 303) && destination.protocol === 'peekalo:' && destination.host === 'reset-password' && !destination.pathname && !destination.hash && Boolean(destination.searchParams.get('code')), 'Recovery redirects to the native screen with a PKCE code, without bearer tokens');
    const exchanged = await recovery.auth.exchangeCodeForSession(destination.searchParams.get('code'), { flowId: destination.searchParams.get('sb_flow_id') });
    check(!exchanged.error && exchanged.data.user?.id === userId && events.includes('PASSWORD_RECOVERY'), 'The requesting client exchanges its PKCE code as password recovery');
    check(!(await client.auth.getSession()).data.session, 'Recovery leaves the ordinary signed-out client untouched');
    const replacement = `${randomUUID()}bB2!`;
    const updated = await recovery.auth.updateUser({ password: replacement });
    check(!updated.error && updated.data.user?.id === userId, 'Recovery session changes its own password');
    const fresh = createClient(api, process.env.SUPABASE_ANON_KEY, options);
    const oldLogin = await fresh.auth.signInWithPassword({ email, password });
    check(oldLogin.error?.code === 'invalid_credentials' && !oldLogin.data.session, 'The previous password no longer signs in');
    const newLogin = await fresh.auth.signInWithPassword({ email, password: replacement });
    check(!newLogin.error && newLogin.data.user?.id === userId, 'The replacement password signs in');
    const replay = await recovery.auth.exchangeCodeForSession(destination.searchParams.get('code'), { flowId: destination.searchParams.get('sb_flow_id') });
    check(Boolean(replay.error) && !replay.data.session, 'A consumed recovery code cannot be replayed');
    await fresh.auth.signOut();
  } finally { subscription.data.subscription.unsubscribe(); }
} finally {
  for (const id of [userId, otherId].filter(Boolean)) {
    const removed = await admin.auth.admin.deleteUser(id);
    assert(!removed.error, 'Generated local signup account cleanup failed');
  }
}
console.log(`${passed} isolated local account assertions passed; generated accounts removed.`);
