import { waitlistProxyPost } from '../../../lib/server/waitlist-proxy';

export const runtime = 'nodejs';
export async function POST(request: Request) { return waitlistProxyPost(request); }
