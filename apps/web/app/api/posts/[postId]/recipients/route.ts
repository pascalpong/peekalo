import { recipient, revoke } from '../../../../../lib/server/handlers';
import { options } from '../../../../../lib/server/sharing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function POST(request: Request, context: { params: Promise<{ postId: string }> }) {
  const { postId } = await context.params;
  return recipient(postId)(request);
}

export async function DELETE(request: Request, context: { params: Promise<{ postId: string }> }) {
  const { postId } = await context.params;
  return revoke(postId, true)(request);
}
