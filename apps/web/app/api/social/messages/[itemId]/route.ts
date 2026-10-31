import { removeSocial } from '../../../../../lib/server/social';
import { options } from '../../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = options;
export async function DELETE(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params;
  return removeSocial('message', itemId)(request);
}
