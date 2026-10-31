import { conversations } from '../../../../lib/server/social';
import { options } from '../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export const GET = conversations;
export const POST = conversations;
