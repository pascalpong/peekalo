import Link from 'next/link';
import { BrandLogo } from '@peekalo/web-ui/brand';
import styles from '../app/marketing.module.css';

export function ProductUnavailable() {
  return <div className={styles.site}><main id="main" className={styles.privacy}>
    <BrandLogo />
    <p className={styles.eyebrow}>A LITTLE PATIENCE</p>
    <h1>Shared viewing is on its way.</h1>
    <p>The Peekalo web app is not available from this website yet. If someone sent you a moment, ask them for a new link once sharing is available.</p>
    <p><Link href="/">Back to Peekalo</Link></p>
  </main></div>;
}
