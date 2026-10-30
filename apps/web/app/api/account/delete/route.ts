import { deleteAccount } from '../../../../lib/server/account-privacy';
import { options } from '../../../../lib/server/sharing';
export const runtime = 'nodejs';
export const POST = deleteAccount;
export const OPTIONS = options;
