import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const exec = promisify(execFile);

// Local fixture setup only: a separate generated account, explicitly allowlisted
// by local database administration. The public API never grants operator access.
export async function fixtureOperator(db, users, namespace) {
  if (process.env.SUPABASE_URL !== 'http://127.0.0.1:55321') {
    assert(process.env.PEEKALO_TEST_OPERATOR_TOKEN, 'The moderated disposable remote test project requires an explicitly provisioned operator account access token');
    return process.env.PEEKALO_TEST_OPERATOR_TOKEN;
  }
  const email = `${namespace}_operator@example.invalid`, password = randomUUID() + 'aA1!';
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  assert(!created.error && created.data.user); const id = created.data.user.id;
  assert(/^[0-9a-f-]{36}$/.test(id)); users.push(id);
  await exec('docker', ['exec', 'supabase_db_peekalo-local-testing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `insert into public.peekalo_operators(account_id) values('${id}')`], { maxBuffer: 1024 * 1024 });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert(!signed.error && signed.data.session); const token = signed.data.session.access_token;
  client.auth.stopAutoRefresh(); // No persistent SDK state or refresh timer.
  return token;
}
