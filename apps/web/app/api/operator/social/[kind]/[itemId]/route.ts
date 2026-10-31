import { operatorSocialItem } from '../../../../../../lib/server/social';
import { options } from '../../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ kind: string; itemId: string }> }) {
  const { kind, itemId } = await context.params;
  return operatorSocialItem(kind, itemId)(request);
}
export async function POST(request: Request, context: { params: Promise<{ kind: string; itemId: string }> }) {
  const { kind, itemId } = await context.params;
  return operatorSocialItem(kind, itemId)(request);
}
