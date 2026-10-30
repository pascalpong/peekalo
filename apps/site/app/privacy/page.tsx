import { PrivacyContent } from '@peekalo/web-ui/policy';
import { PolicyShell } from '../../components/policy-shell';
export const metadata = { title: 'Privacy notice' };
export const dynamic = 'force-dynamic';
export default function PrivacyPage() {
  return <PolicyShell title="Care for your information."><PrivacyContent /></PolicyShell>;
}
