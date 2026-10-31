import { comments } from '../../../../../../lib/server/social';
import { options } from '../../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ postId: string }> }) {
  const { postId } = await context.params;
  return comments(postId)(request);
}
export async function POST(request: Request, context: { params: Promise<{ postId: string }> }) {
  const { postId } = await context.params;
  return comments(postId)(request);
}
