import type { ReactNode } from 'react';
import Link from 'next/link';
import { BrandLogo } from '@peekalo/web-ui/brand';
import styles from '../app/marketing.module.css';
export function PolicyShell({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.site}><main id="main" className={styles.privacy}><Link href="/" aria-label="Peekalo home"><BrandLogo /></Link><p className={styles.eyebrow}>PEEKALO · ACCOUNT RESOURCES</p><h1>{title}</h1>{children}<nav className={styles.policyLinks} aria-label="Account resources"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/support">Support</Link><Link href="/delete-account">Delete account</Link></nav></main></div>;
}
