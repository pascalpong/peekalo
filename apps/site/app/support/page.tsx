import { PolicyShell } from '../../components/policy-shell';
import { getPublicConfig } from '../../lib/public-config';
export const metadata = { title: 'Support' };
export const dynamic = 'force-dynamic';
export default function SupportPage() {
  const { appOrigin } = getPublicConfig();
  return <PolicyShell title="Peekalo support."><p>The monitored support and child-safety contacts and responsible operator are not confirmed. External beta and public signup collection remain closed until these routes and response coverage are verified.</p><p>Existing users can report a moment or account without revealing media. Do not include passwords, authentication codes, raw private links or copies of suspected child sexual abuse material in a request. Peekalo is not an emergency response service.</p>{appOrigin ? <p><a href={`${appOrigin}/support`}>Open product support and configured contact details</a> · <a href={`${appOrigin}/safety`}>Safety standards</a></p> : <p>The product support destination is not connected to this website yet. No fabricated contact address is provided.</p>}<p>For account removal, use <a href="/delete-account">Delete account</a>. The external route verifies control of an existing account and does not require reinstalling the app for email/password or configured Google sign-in.</p></PolicyShell>;
}
