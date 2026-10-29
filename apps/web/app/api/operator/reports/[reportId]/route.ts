import { operatorReport } from '../../../../../lib/server/safety';
import { options } from '../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function POST(request: Request, context: { params: Promise<{ reportId: string }> }) {
  return operatorReport((await context.params).reportId)(request);
}
