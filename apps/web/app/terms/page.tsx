import { TermsContent } from '@peekalo/web-ui/policy';
import { Shell } from '../../components/shell';
import { PolicyLinks } from '../../components/policy-links';
export const metadata = { title: 'Terms' };
export const dynamic = 'force-dynamic';
export default function TermsPage() {
  return <Shell><main id="main" className="safety-main"><p className="eyebrow">PEEKALO TERMS</p><h1>Share with understanding.</h1><TermsContent /><PolicyLinks /></main></Shell>;
}
