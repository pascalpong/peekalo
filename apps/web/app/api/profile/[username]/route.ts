import { publicProfile } from '../../../../lib/server/handlers';
import { options } from '../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ username: string }> }) {
  return publicProfile((await context.params).username)(request);
}
