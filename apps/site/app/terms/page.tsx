import { TermsContent } from '@peekalo/web-ui/policy';
import { PolicyShell } from '../../components/policy-shell';
export const metadata = { title: 'Terms' };
export const dynamic = 'force-dynamic';
export default function TermsPage() {
  return <PolicyShell title="Share with understanding."><TermsContent /></PolicyShell>;
}
