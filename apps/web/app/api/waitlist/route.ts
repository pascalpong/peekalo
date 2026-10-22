import { waitlistPost } from '../../../lib/server/waitlist';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return waitlistPost(request);
}
