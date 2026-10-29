import { operatorMedia } from '../../../../../lib/server/safety';
import { options } from '../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ postId: string }> }) {
  return operatorMedia((await context.params).postId)(request);
}
