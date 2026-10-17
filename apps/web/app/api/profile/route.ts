import { getProfile } from '../../../lib/server/handlers';
import { options } from '../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export const GET = getProfile;
export { saveProfile as POST } from '../../../lib/server/handlers';
