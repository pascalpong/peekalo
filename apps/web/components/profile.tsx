import Link from "next/link";
import { MAX_VIDEO_DURATION_MS, REVEAL_BUDGET_MS } from "@peekalo/contracts";
import { BrandMark, Icon } from "./icons";
import { Shell } from "./shell";

const moments = [
  { number: "01", title: "The slow mornings", color: "peach" },
  { number: "02", title: "Somewhere outside", color: "green" },
  { number: "03", title: "After the rain", color: "blue" },
];

export function Profile() {
  return (
    <Shell>
      <main id="main" className="profile-main">
        <section className="profile-intro" aria-labelledby="profile-name">
          <div className="intro-copy">
            <span className="eyebrow"><span className="tiny-star">✳</span> A LITTLE WINDOW INTO</span>
            <div className="profile-identity">
              <div className="avatar" aria-hidden="true">m<span>✳</span></div>
              <div><h1 id="profile-name">Mika<span className="name-dot">.</span></h1><p className="handle">@mika.demo <span className="fixture-tag">Sample profile</span></p></div>
            </div>
            <p className="profile-bio">Collecting the small things.<br />Leaving a little to the imagination.</p>
          </div>
          <div className="intro-aside">
            <span className="scribble" aria-hidden="true">hello, curious you.</span>
            <div className="peek-stamp" aria-hidden="true"><BrandMark /><span>THERE&apos;S MORE<br />TO THE MOMENT</span></div>
          </div>
        </section>

        <section className="moments-section" aria-labelledby="moments-title">
          <div className="section-heading">
            <h2 id="moments-title">A little of lately <span>03</span></h2>
            <span className="hidden-label"><Icon name="eye" />Hidden for now</span>
          </div>
          <div className="moment-grid">
            {moments.map((moment) => (
              <Link className={`moment-card preview-${moment.color}`} href="/s/demo" key={moment.number} aria-label={`Open shared-viewer demo: ${moment.title}`}>
                <span className="moment-top"><span>DEMO PHOTO</span><span>{moment.number}</span></span>
                <span className="moment-center"><span className="peek-circle"><Icon name="eye" /></span><span>A little mystery.</span></span>
                <span className="moment-bottom"><span>{moment.title}</span><span className="card-arrow"><Icon name="arrow" /></span></span>
              </Link>
            ))}
          </div>
          <p className="fixture-caption">Illustrated sample moments. No personal photos are shown.</p>
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
