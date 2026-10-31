import { messages } from '../../../../../../lib/server/social';
import { options } from '../../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  return messages(conversationId)(request);
}
export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  return messages(conversationId)(request);
}
