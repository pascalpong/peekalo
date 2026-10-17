import { configuration } from '../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Runtime tools are checked before container startup. Readiness also requires the
// deployed ledger and private bucket; it never claims a link or fetches media.
export async function GET() {
  let ready = false;
  try {
    const c = configuration();
    const headers = { apikey: c.service, Authorization: `Bearer ${c.service}` };
    const signal = AbortSignal.timeout(4000);
    const [ledger, storage] = await Promise.all([
      fetch(`${c.url}/rest/v1/peekalo_link_requests?select=post_id&limit=0`, { headers, cache: 'no-store', signal }),
      fetch(`${c.url}/storage/v1/bucket/peekalo-captures`, { headers, cache: 'no-store', signal }),
    ]);
    if (ledger.ok && storage.ok) {
      const bucket = await storage.json();
      ready = bucket.public === false && bucket.file_size_limit === 30 * 1024 * 1024;
    }
  } catch { /* Health responses deliberately omit configuration and upstream errors. */ }
  return Response.json({ ready }, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
