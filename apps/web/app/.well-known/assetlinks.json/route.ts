import { appAssociationResponse } from '../../../lib/server/app-associations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return appAssociationResponse('android');
}
