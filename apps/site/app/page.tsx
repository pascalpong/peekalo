import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Icon } from '@peekalo/web-ui/icons';
import { BrandLogo } from '@peekalo/web-ui/brand';
import { MarketingDemo } from '../components/marketing-demo';
import { WaitlistForm } from '../components/waitlist-form';
import { HeroVideo } from '../components/hero-video';
import { getPublicConfig } from '../lib/public-config';
import styles from './marketing.module.css';

// Keep the form's runtime gate aligned with the API when collection changes.
export const dynamic = 'force-dynamic';

const title = 'Some things are just for you.';
const description = 'Capture a moment in Peekalo. Choose who sees it, then hold to reveal for up to ten seconds total.';

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title: `Peekalo · ${title}`, description, type: 'website' },
  robots: { index: false, follow: false },
};

export default function HomePage() {
  const { waitlistEnabled, appOrigin } = getPublicConfig();

  return <div className={styles.site}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Peekalo home"><BrandLogo /></Link>
      <nav aria-label="Main navigation" className={styles.nav}>
        <a href="#how-it-works" className={styles.navText}>How it works</a>
        {appOrigin && <a href={appOrigin} className={styles.navText}>Open web app</a>}
        <a href="#early-access" className={styles.navCta}>Get Peekalo</a>
      </nav>
    </header>

    <main id="main">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Moments, meant for fewer.</p>
          <h1 id="hero-title">Some things<br />are just for you.</h1>
          <p className={styles.heroDescription}>
            Capture a moment. Choose who sees it.<br />Hold to reveal.
          </p>
          <a className={styles.primary} href="#try-a-peek">Explore Peekalo <Icon name="arrow" /></a>
          <p className={styles.betaNote}>Invited beta · 18+</p>
        </div>
        <Image className={styles.heroArt} src="/marketing/veil-glass.webp" alt=""
          width={1254} height={1254} unoptimized loading="eager" fetchPriority="high" />
      </section>
      <div className={styles.manifestoStrip}>
        <span>Made in the moment.</span>
        <nav aria-label="How Peekalo works">
          <a href="#capture">Capture</a>
          <a href="#share">Share</a>
          <a href="#try-a-peek">Reveal</a>
        </nav>
      </div>

      <section className={styles.how} id="how-it-works" aria-labelledby="how-title">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>A quieter way to share</p>
          <h2 id="how-title">A little moment.<br />A little closer.</h2>
          <p>For the things you want to share with a few people.</p>
        </div>
        <ol className={styles.steps}>
          <li id="capture">
            <span aria-hidden="true">01</span>
            <h3>Capture it here.</h3>
            <p>Tap for a photo. Hold for a video up to ten seconds. Every moment starts in the app camera.</p>
          </li>
          <li id="share">
            <span aria-hidden="true">02</span>
            <h3>Choose who sees.</h3>
            <p>Send to chosen accounts on Peekalo, or create a single-use link that one viewer can claim.</p>
          </li>
          <li>
            <span aria-hidden="true">03</span>
            <h3>Hold for a glimpse.</h3>
            <p>Hidden by default. Hold to reveal, release to hide. Up to ten seconds total across holds.</p>
          </li>
        </ol>
      </section>

      <section className={styles.demoSection} id="try-a-peek" aria-labelledby="demo-title">
        <div className={styles.demoCopy}>
          <p className={styles.eyebrow}>Try a sample moment</p>
          <h2 id="demo-title">For your eyes.</h2>
          <p>Hold to reveal. Release to hide. Each hold uses some of the same ten seconds.</p>
          <p className={styles.demoHint}><Icon name="clock" /> Local demo with a generated image</p>
        </div>
        <MarketingDemo />
      </section>

      <section className={styles.faq} id="questions" aria-labelledby="faq-title">
        <div>
          <p className={styles.eyebrow}>A little more to know</p>
          <h2 id="faq-title">Good questions.</h2>
        </div>
        <div className={styles.questions}>
          <details><summary>What makes a Peekalo moment different?<span aria-hidden="true">+</span></summary><p>It starts with the in-app camera, stays hidden until the recipient holds to reveal, and has up to ten seconds of viewing time in total.</p></details>
          <details><summary>Does the other person need the app?<span aria-hidden="true">+</span></summary><p>For a single-use web link, no account or app is needed. The first viewer who deliberately reveals claims the link. Opening the preview does not claim it. Direct sharing in the app is for chosen accounts.</p></details>
          <details><summary>Can someone save what I share?<span aria-hidden="true">+</span></summary><p>Someone may capture or save revealed content, especially in a browser. Viewing limits and hiding on release cannot erase a copy someone has already received. Share with people you trust.</p></details>
          <details><summary>When can I try it?<span aria-hidden="true">+</span></summary><p>Peekalo is preparing an invited beta for adults in Thailand and Taiwan on iOS and Android. We haven’t announced a launch date yet.</p></details>
        </div>
      </section>

      <details className={styles.film}>
        <summary>Watch the brand film</summary>
        <div className={styles.filmFrame}>
          <HeroVideo src="/marketing/a-little-mystery.mp4" poster="/marketing/a-little-mystery-poster.webp" />
        </div>
      </details>

      <section className={styles.waitlist} id="early-access" aria-labelledby="waitlist-title">
        <p className={styles.eyebrow}>Invited beta · 18+</p>
        <h2 id="waitlist-title">A little closer, soon.</h2>
        <p>{waitlistEnabled ? 'Leave your email for early-access updates.' : 'Peekalo is being prepared for an invited beta.'}</p>
        <WaitlistForm enabled={waitlistEnabled} />
        <p className={styles.platforms}>Made for iOS and Android</p>
      </section>
    </main>

    <footer className={styles.footer}>
      <Link href="/" className={styles.brand} aria-label="Peekalo home"><BrandLogo /></Link>
      <p>A quieter way to share.</p>
      <nav aria-label="Footer">
        {appOrigin && <a href={appOrigin}>Open web app</a>}
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/support">Support</Link>
        <Link href="/delete-account">Delete account</Link>
        <span>© 2026 Peekalo</span>
      </nav>
    </footer>
  </div>;
}
