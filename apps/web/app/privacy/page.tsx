import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Shell } from '../../components/shell';
import { siteOrigin } from '../../lib/site-origin';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Privacy notice' };

export default function PrivacyPage() {
  const origin = siteOrigin();
  if (origin) redirect(`${origin}/privacy`);
  return <Shell><main id="main" className="unavailable-main"><p className="eyebrow">PRIVACY NOTICE</p><h1>Notice unavailable.</h1><p>The Peekalo website privacy notice is not connected to this web app yet.</p><Link href="/" className="primary-link">Back to Peekalo</Link></main></Shell>;
}
