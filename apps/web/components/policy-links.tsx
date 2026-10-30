import Link from 'next/link';
export function PolicyLinks() {
  return <nav className="policy-links" aria-label="Account resources"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/support">Support</Link><Link href="/delete-account">Delete account</Link><Link href="/safety">Safety</Link></nav>;
}
