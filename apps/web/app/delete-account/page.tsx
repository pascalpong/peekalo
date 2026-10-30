import Link from 'next/link';
import { Shell } from '../../components/shell';
import { AccountDeletion } from '../../components/account-deletion';
import { PolicyLinks } from '../../components/policy-links';
export const metadata = { title: 'Delete account', referrer: 'no-referrer' as const };
export const dynamic = 'force-dynamic';
export default function DeletionPage() {
  return <Shell><main id="main" className="safety-main"><p className="eyebrow">PEEKALO ACCOUNT DELETION</p><h1>Leave on your terms.</h1>
    <p>Request deletion of your Peekalo account and its associated data here, even if the app is uninstalled. You must verify account control and deliberately confirm the request. You can also use Delete account in Profile in the app.</p>
    <AccountDeletion />
    <section><h2>What happens after acceptance</h2><p>The server disables future account and owned-moment access promptly, then queues private objects, profile and authentication for cleanup. An accepted pending request does not mean Storage or Auth deletion has finished. Failed steps remain pending for retry.</p><p>Cleanup operations, completion notifications and hosted backup/restore checks still need operational verification before release. No guaranteed completion deadline or backup-erasure period is claimed in this development preview.</p></section>
    <section><h2>What may remain</h2><p>Private status receipts expire 30 days after cleanup completes. Minimal restricted account-ID and request-time records remain until the backup inventory and a fresh empty-storage check make removal safe. Unfinished requests remain available for retry and status. The cleanup policy expires report, operator-note and audit records after 90 days; associated text and account identifiers are scrubbed during deletion. Its schedule remains an operational release gate. Random nonaccount identifiers preserve spent allowances and already-claimed links only for the lifetime of the related moment. This prevents deletion from resetting another person’s viewing budget or reopening a consumed link.</p><p>Deleting your account cannot erase copies already received, delete unrelated owners’ media or guarantee forensic erasure of device caches. <Link href="/privacy#retention">Read the privacy and retention details</Link>.</p></section>
    <PolicyLinks />
  </main></Shell>;
}
