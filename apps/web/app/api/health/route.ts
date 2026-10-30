import { configuration } from '../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Startup validates tools and the serving gate. Readiness verifies both current
// operations migrations and the private bucket without claiming or fetching media.
export async function GET() {
  let ready = false;
  try {
    const c = configuration();
    const headers = { apikey: c.service, Authorization: `Bearer ${c.service}` };
    const signal = AbortSignal.timeout(4000);
    const replies = await Promise.allSettled([
      fetch(`${c.url}/rest/v1/peekalo_link_requests?select=post_id&limit=0`, { headers, cache: 'no-store', signal }),
      fetch(`${c.url}/storage/v1/bucket/peekalo-captures`, { headers, cache: 'no-store', signal }),
      ...['peekalo_operations_status', 'peekalo_abuse_status'].map(name => fetch(`${c.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store', signal })),
    ]);
    try {
      if (replies.every(reply => reply.status === 'fulfilled' && reply.value.ok)) {
        const bucket = await (replies[1] as PromiseFulfilledResult<Response>).value.json();
        ready = bucket.public === false && bucket.file_size_limit === 30 * 1024 * 1024;
      }
    } finally {
      await Promise.allSettled(replies.map(reply => reply.status === 'fulfilled' ? reply.value.body?.cancel() : undefined));
    }
  } catch { /* Never expose configuration, identifiers or upstream errors. */ }
  return Response.json({ ready }, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
