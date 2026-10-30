import { PrivacyContent } from '@peekalo/web-ui/policy';
import { Shell } from '../../components/shell';
import { PolicyLinks } from '../../components/policy-links';
export const metadata = { title: 'Privacy notice' };
export const dynamic = 'force-dynamic';
export default function PrivacyPage() {
  return <Shell><main id="main" className="safety-main"><p className="eyebrow">PEEKALO PRIVACY</p><h1>Care for your information.</h1><PrivacyContent /><PolicyLinks /></main></Shell>;
}
