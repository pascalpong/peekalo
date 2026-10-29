import Link from 'next/link';
import { Shell } from '../../components/shell';
import { SafetyContact } from '../../components/safety-contact';

export const metadata = { title: 'Safety standards' };
export const dynamic = 'force-dynamic';
export default function SafetyPage() {
  return <Shell><main id="main" className="safety-main">
    <p className="eyebrow">PEEKALO COMMUNITY STANDARDS</p><h1>Share with care.</h1>
    <p>These standards apply to accounts, captured moments, profiles and every interaction on Peekalo, including comments and chat.</p>
    <section><h2>Child safety</h2><p>Child sexual abuse and exploitation (CSAE) is prohibited. This includes child sexual abuse material (CSAM), sexualization of children, grooming, solicitation, sexual extortion and facilitating or promoting exploitation. Never upload, request, share or link to this material.</p></section>
    <section><h2>Respect and consent</h2><p>Do not share sexual or intimate content without consent, sexual exploitation, threats, graphic violence, harassment, hateful abuse, fraud or spam. Do not impersonate people or expose someone&apos;s private information. Use only your own in-app captures and respect everyone shown in them.</p></section>
    <section><h2>Report a concern</h2><p>Use Report this moment in a shared viewer or Report this account on a profile. In the app, report from Inbox or a received moment. You do not need to reveal a moment to report it. Choose Child safety for suspected exploitation. Give only the context needed; do not save or send copies of suspected CSAM. <Link href="/support">Support and contact details</Link> provide another feedback route when configured.</p></section>
    <section><h2>Review and response</h2><p>During the invited beta, newly processed moments are held for manual review before sharing. Reports enter a restricted operator queue; child-safety concerns are prioritized for assessment. Operators can reject or take down moments and revoke future access. Suspected child exploitation requires prompt restriction and escalation through the designated child-safety process, including reporting confirmed CSAM to the relevant authority under applicable requirements. Response ownership, coverage and contacts must be verified before external beta opens.</p><p>Taking down a moment stops future authorized requests. It cannot erase bytes a viewer already received. Browser viewers can save or capture revealed content.</p></section>
    <section><h2>Blocking and anonymous links</h2><p>Signed-in accounts can block identified accounts in the app. Blocking prevents sharing and viewing between those accounts and revokes their existing direct grants. Anonymous browser identities cannot reliably be matched to a person or an account. A block cannot identify someone using an unrelated anonymous link or erase earlier copies; owners can revoke their links, and operators can take down a reported moment.</p></section>
    <SafetyContact />
    <p><Link href="/support">Support and appeals</Link></p>
  </main></Shell>;
}
