import Link from 'next/link';
import { Shell } from '../../components/shell';
import { PolicyLinks } from '../../components/policy-links';
import { SafetyContact } from '../../components/safety-contact';

export const metadata = { title: 'Support' };
export const dynamic = 'force-dynamic';
export default function SupportPage() {
  return <Shell><main id="main" className="safety-main">
    <p className="eyebrow">HELP AND FEEDBACK</p><h1>Peekalo support.</h1>
    <p>Report a moment from its shared viewer or report an account from its profile. Reports are available without revealing the media. In the app, use the report and block controls in Inbox and on received moments; manage blocked accounts from Profile.</p>
    <p>For a report, access problem or appeal, describe the issue with the minimum information needed. Do not include passwords, authentication codes, private share links or copies of suspected child sexual abuse material. Do not post private media publicly to request help.</p>
    <p>Reports go to a restricted review queue. If someone is in immediate danger, contact local emergency services. Peekalo&apos;s report queue is not an emergency response service.</p>
    <SafetyContact />
    <p>For moderation appeals, use the configured support contact with your account username and the decision or report reference, if available. Do not resend the original media.</p>
    <p><Link href="/delete-account">Delete your account and associated data</Link> from the secure browser route, or use Delete account in Profile. The privacy notice explains cleanup and narrow retention.</p><PolicyLinks />
  </main></Shell>;
}
