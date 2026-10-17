import { media } from '../../../../../lib/server/handlers';
import { options } from '../../../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ leaseId: string }> }) {
  const { leaseId } = await context.params;
  return media(leaseId)(request);
}
