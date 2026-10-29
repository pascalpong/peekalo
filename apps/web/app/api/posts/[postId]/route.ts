import { deletePost } from '../../../../lib/server/handlers';
import { options } from '../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function DELETE(request: Request, context: { params: Promise<{ postId: string }> }) {
  return deletePost((await context.params).postId)(request);
}
