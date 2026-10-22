import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../marketing.module.css';
export const metadata: Metadata = { title: 'Early-access privacy notice', robots: { index: false, follow: false } };
export default function PrivacyPage() {
  return <div className={styles.site}><main id="main" className={styles.privacy}><Link href="/">← Back to Peekalo</Link><p className={styles.eyebrow}>EARLY-ACCESS WEBSITE · UPDATED 20 OCTOBER 2026</p><h1>A little care for your information.</h1>
    <p>This notice covers Peekalo’s prelaunch website and early-access list. It is not a privacy policy for a released Peekalo app.</p>
    <h2>What signing up means</h2><p>If you submit the form and agree to updates, we store your email address, the date you signed up, and the version of the consent you accepted. We use this information to contact you about Peekalo early-access availability. Joining does not create an app account or guarantee an invitation or launch date.</p>
    <h2>Where your email goes</h2><p>The early-access list uses Peekalo’s Supabase database. Your email is not shown publicly. Access is restricted to the server and authorized operators. This website does not add advertising trackers or session replay. Hosting providers may process standard request information to operate the website.</p>
    <h2>Contact and removal</h2><p>We keep early-access signup details while organizing early access, unless you ask us to remove them sooner. A working private contact address and removal route must be connected before public signup collection opens. They are still being set up; this preview is not yet accepting public signups. Email updates will include an option to stop receiving them.</p>
    <h2>About the samples</h2><p>The homepage hero video is generated abstract brand artwork. The dog photo is an AI-generated sample of an everyday moment. These are public marketing assets. The hold-to-reveal interaction is a local demo, and reloading resets it. It does not establish server authorization, real single-use links or capture prevention.</p>
    <h2>About sharing</h2><p>A recipient may save or capture revealed media. A viewing allowance cannot erase content already delivered to someone’s device. Peekalo is still in development.</p>
  </main></div>;
}
