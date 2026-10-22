import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@peekalo/web-ui/icons';
import { BrandLogo } from '@peekalo/web-ui/brand';
import { MarketingDemo } from '../components/marketing-demo';
import { WaitlistForm } from '../components/waitlist-form';
import { HeroVideo } from '../components/hero-video';
import { getPublicConfig } from '../lib/public-config';
import styles from './marketing.module.css';

// Keep the form's runtime gate aligned with the API when an operator opens or
// pauses collection; never freeze an enabled form into static build output.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Peekalo — A little moment. Just for you.',
  description: 'A camera-first way to share the little things. Capture a photo or short video, send it to someone, and hold to reveal. Join Peekalo early access.',
  openGraph: { title: 'Peekalo — A little moment. Just for you.', description: 'The little things feel bigger when they’re just for you. Join early access.', type: 'website' },
  robots: { index: false, follow: false },
};

export default function HomePage() {
  const { waitlistEnabled, appOrigin } = getPublicConfig();
  return <div className={styles.site}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Peekalo home"><BrandLogo /></Link>
      <nav aria-label="Main navigation" className={styles.nav}>
        <a href="#how-it-works" className={styles.navText}>How it works</a>
        <a href="#questions" className={styles.navText}>A few questions</a>
        <a href="#early-access" className={styles.navText}>Get early access</a>
        {appOrigin && <a href={appOrigin} className={styles.navCta}>Open web app <Icon name="arrow" /></a>}
      </nav>
    </header>
    <main id="main">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span className={styles.statusDot} /> SOME THINGS ARE BETTER LEFT BETWEEN US</p>
          <h1 id="hero-title">A little<br />mystery.<br /><span className={styles.you}>Just for you.</span></h1>
          <p className={styles.heroDescription}>Real moments. Chosen people.<br />Hidden until they hold to reveal.</p>
          <div className={styles.heroActions}><a className={styles.primary} href="#early-access">Get early access <Icon name="arrow" /></a><a className={styles.demoLink} href="#try-a-peek"><span className={styles.play}>↗</span> Take a peek</a></div>
        </div>
        <HeroVideo src="/marketing/a-little-mystery.mp4" poster="/marketing/a-little-mystery-poster.webp" />
        <div className={styles.heroShade} aria-hidden="true" />
        <div className={styles.heroBottom}><p><span className={styles.statusDot} /> IN THE MAKING FOR iOS & ANDROID</p><a href="#how-it-works">SCROLL TO DISCOVER <span>↓</span></a><span className={styles.heroFilmLabel}>A LITTLE GLIMPSE / 001</span></div>
      </section>
      <div className={styles.manifestoStrip}><span>Less performing.</span><Icon name="spark" /><span>More “you had to be there.”</span><Icon name="spark" /><span>That’s Peekalo.</span></div>
      <section className={styles.demoSection} id="try-a-peek" aria-labelledby="demo-title">
        <div className={styles.demoCopy}><p className={styles.eyebrow}>CURIOSITY LOOKS GOOD ON YOU</p><h2 id="demo-title">Some moments<br />are worth<br /><span>holding onto.</span></h2><p>A glance from your day. A little inside joke.<br />Something that only makes sense to them.</p><p>Hold to reveal. Let go to hide.<br />Up to ten seconds total. A little closer.</p><span className={styles.demoHint}><Icon name="eye" /> Go on. Try a little peek.</span></div>
        <div className={styles.demoVisual}><div className={styles.demoHalo} aria-hidden="true" /><MarketingDemo /><span className={styles.visualCaption}>ILLUSTRATIVE SAMPLE · LOCAL DEMO</span></div>
      </section>
      <section className={styles.how} id="how-it-works" aria-labelledby="how-title">
        <div className={styles.sectionHeading}><p className={styles.eyebrow}>THE RITUAL</p><h2 id="how-title">Catch it. Send it.<br /><span>Keep them curious.</span></h2><p>No perfect shot needed. Just something<br />that made you think of someone.</p></div>
        <div className={styles.steps}>
          <article className={styles.step}><div className={styles.stepGraphic}><span className={styles.viewfinder}><span>✳</span><i /></span><span className={styles.stepNumber}>01</span></div><h3>Catch a little moment.</h3><p>Open the camera. Tap for a photo or hold for a video up to ten seconds. Fresh from your day.</p></article>
          <article className={styles.step}><div className={`${styles.stepGraphic} ${styles.sendGraphic}`}><span className={styles.miniMessage}><Icon name="eye" /> a little something for you <span>↗</span></span><span className={styles.stepNumber}>02</span></div><h3>Pick your person.</h3><p>Choose who gets a peek in the app, or send a single-use link that one viewer can claim.</p></article>
          <article className={styles.step}><div className={`${styles.stepGraphic} ${styles.holdGraphic}`}><span className={styles.holdIllustration}><Icon name="eye" /><span>Hold to reveal</span><i>10s</i></span><span className={styles.stepNumber}>03</span></div><h3>Hold. Peek. Smile.</h3><p>Hold to reveal. Release to hide. Up to ten seconds total, even across a few little peeks.</p></article>
        </div>
      </section>
      <section className={styles.feeling} aria-labelledby="feeling-title"><span className={styles.feelingStar} aria-hidden="true">✳</span><p className={styles.eyebrow}>FOR THE “THIS MADE ME THINK OF YOU” MOMENTS</p><h2 id="feeling-title">Not every moment<br />needs <em>an audience.</em></h2><p>Some just need your favourite person.</p><a href="#early-access">Find your little corner <Icon name="arrow" /></a></section>
      <section className={styles.faq} id="questions" aria-labelledby="faq-title"><div><p className={styles.eyebrow}>A LITTLE MORE TO KNOW</p><h2 id="faq-title">Good questions.</h2></div><div className={styles.questions}>
        <details><summary>What makes a Peekalo moment different?<span>+</span></summary><p>It starts with the in-app camera, stays hidden until the recipient holds to reveal, and has up to ten seconds of viewing time in total. It’s a small way to share something from right now.</p></details>
        <details><summary>Does the other person need the app?<span>+</span></summary><p>For a single-use web link, no account or app is needed. Only the first viewer who deliberately reveals can claim that link. Direct sharing in the app is for chosen accounts.</p></details>
        <details><summary>Can someone save what I share?<span>+</span></summary><p>Someone may capture or save revealed content, especially in a browser. Viewing limits and hiding on release cannot erase a copy someone has already received. Share with people you trust.</p></details>
        <details><summary>When can I try it?<span>+</span></summary><p>Peekalo is being built for iOS and Android. Join early access for availability updates. We haven’t announced a launch date yet.</p></details>
      </div></section>
      <section className={styles.waitlist} id="early-access" aria-labelledby="waitlist-title"><span className={styles.waitlistDoodle} aria-hidden="true">♡</span><p className={styles.eyebrow}><span className={styles.statusDot} /> A LITTLE SOMETHING IS COMING</p><h2 id="waitlist-title">Be in on<br />the little things.</h2><p>{waitlistEnabled ? 'Leave your email. We’ll let you know when it’s time to peek.' : 'Your people. Your little moments. Early access is on its way.'}</p><WaitlistForm enabled={waitlistEnabled} /><span className={styles.platforms}>MADE FOR iOS & ANDROID · COMING SOON</span></section>
    </main>
    <footer className={styles.footer}><Link href="/" className={styles.brand} aria-label="Peekalo home"><BrandLogo /></Link><p>A little glimpse. A little closer.</p><div>{appOrigin && <a href={appOrigin}>Open web app ↗</a>}<Link href="/privacy">Privacy & contact</Link><span>© 2026 Peekalo</span></div></footer>
  </div>;
}
