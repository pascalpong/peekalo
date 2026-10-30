import { PolicyShell } from '../../components/policy-shell';
import { getPublicConfig } from '../../lib/public-config';
export const metadata = { title: 'Delete account' };
export const dynamic = 'force-dynamic';
export default function DeletionPage() {
  const { appOrigin } = getPublicConfig();
  return <PolicyShell title="Delete your Peekalo account."><p>Delete your account and its associated moments through the secure product deletion route. Verify account control and confirm the permanent request. Email/password and configured Google sign-in work in the browser without reinstalling the app.</p>{appOrigin ? <p><a href={`${appOrigin}/delete-account`}>Continue to secure account deletion →</a></p> : <p role="status">The secure product deletion destination has not been connected to this website. No deletion request has been submitted. External beta remains closed.</p>}<p>Once the server accepts the request, it disables future account and owned-moment access. Cleanup of private objects, account records and authentication may finish later and remains pending on failure. Deletion cannot erase copies someone already received. Narrow retained safety and anti-replay records are explained in <a href="/privacy#retention">Privacy and retention</a>.</p><p>In the app, find Delete account in Profile. Apple browser sign-in and verified support recovery remain setup dependencies; no working route for those is claimed in this preview.</p></PolicyShell>;
}
