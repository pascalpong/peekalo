import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '../components/icons';
import { Shell } from '../components/shell';
import { siteOrigin } from '../lib/site-origin';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Web app', description: 'Open shared Peekalo moments in your browser, or explore the clearly labelled local viewer and profile demos.' };

export default function HomePage() {
  const about = siteOrigin();
  return <Shell>
    <main id="main" className="product-home">
      <section className="product-intro" aria-labelledby="product-title">
        <p className="eyebrow"><span className="tiny-star">✳</span> PEEKALO WEB</p>
        <h1 id="product-title">A moment<br />shared with you<span>.</span></h1>
        <p>Have a Peekalo link? Open it directly from your sender’s message to view their moment here.</p>
        <p className="product-hint"><Icon name="eye" />Hidden by default. Hold to reveal.</p>
      </section>
      <section className="product-demos" aria-labelledby="demos-title">
        <div className="section-heading"><h2 id="demos-title">Explore the demos</h2><span className="fixture-tag">Public samples</span></div>
        <div className="product-demo-grid">
          <Link href="/s/demo" className="product-demo-card"><span className="product-demo-icon"><Icon name="eye" /></span><span className="fixture-tag">Local demo</span><h3>Try the viewer</h3><p>Hold a sample to reveal it. Each hold uses the same ten-second local allowance.</p><span className="text-link">Open sample viewer<Icon name="arrow" /></span></Link>
          <Link href="/u/demo" className="product-demo-card"><span className="product-demo-icon"><Icon name="spark" /></span><span className="fixture-tag">Sample profile</span><h3>A little of lately</h3><p>See how a profile presents hidden moments using illustrated public samples.</p><span className="text-link">Open sample profile<Icon name="arrow" /></span></Link>
        </div>
        <p className="fixture-caption">These demos contain no private posts. Reloading resets the local viewing allowance; demos do not claim real single-use links.</p>
      </section>
      <section className="product-native" aria-labelledby="native-title"><div><p className="eyebrow">CAPTURE IN THE APP</p><h2 id="native-title">Made in the moment.</h2><p>Photo and video capture happens in the Peekalo iOS and Android app. This web app is for profiles and shared viewing.</p></div>{about && <a href={about} className="header-link">About Peekalo<Icon name="arrow" /></a>}</section>
    </main>
  </Shell>;
}
