import Link from "next/link";
import { MAX_VIDEO_DURATION_MS, REVEAL_BUDGET_MS } from "@peekalo/contracts";
import { BrandMark, Icon } from "./icons";
import { Shell } from "./shell";

const moments = [
  { number: "01", title: "The slow mornings" },
  { number: "02", title: "Somewhere outside" },
  { number: "03", title: "After the rain" },
];

export function Profile() {
  return (
    <Shell>
      <main id="main" className="profile-main">
        <section className="profile-intro" aria-labelledby="profile-name">
          <BrandMark />
          <span className="eyebrow">PUBLIC PROFILE · SAMPLE</span>
          <h1 id="profile-name">A little corner<br />of Mika.</h1>
          <p className="handle">@mika.demo</p>
          <div className="profile-access">
            <Icon name="lock" />
            <h2>Moments are shared personally.</h2>
            <p className="profile-bio">Real moments open through a personal invitation. Try the public sample to see how it works.</p>
          </div>
        </section>

        <section className="moments-section" aria-labelledby="moments-title">
          <div className="section-heading">
            <h2 id="moments-title">A little of lately <span>03</span></h2>
            <span className="hidden-label"><Icon name="eye" />Hidden by default</span>
          </div>
          <div className="moment-grid">
            {moments.map((moment) => (
              <Link className="moment-card" href="/s/demo" key={moment.number} aria-label={`Open shared-viewer demo: ${moment.title}`}>
                <span className="moment-top"><span>DEMO PHOTO</span><span>{moment.number}</span></span>
                <span className="moment-center"><BrandMark /><span>Hidden by default.</span></span>
                <span className="moment-bottom"><span>{moment.title}</span><span className="card-arrow"><Icon name="arrow" /></span></span>
              </Link>
            ))}
          </div>
          <p className="fixture-caption">Sample cards open the same public illustration.</p>
        </section>

        <section className="how-strip" aria-labelledby="how-title">
          <div className="how-title"><Icon name="spark" /><h2 id="how-title">A moment. Just for you.</h2></div>
          <p>Take a photo or a {MAX_VIDEO_DURATION_MS / 1000}-second video. Share it with someone. Hold to reveal for up to {REVEAL_BUDGET_MS / 1000} seconds total.</p>
          <Link className="text-link" href="/s/demo">Explore the demo<Icon name="arrow" /></Link>
        </section>
      </main>
    </Shell>
  );
}
