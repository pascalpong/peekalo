import { inbox } from '../../../lib/server/handlers';
import { options } from '../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export const GET = inbox;
