import { AuthReturn } from '../../../components/auth-return';
import { Shell } from '../../../components/shell';
export const dynamic = 'force-dynamic';
export default function ResetPasswordPage() { return <Shell><AuthReturn kind="recovery" /></Shell>; }
