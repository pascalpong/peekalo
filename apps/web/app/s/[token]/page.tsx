import type { Metadata } from "next";
import Link from "next/link";
import { REVEAL_BUDGET_MS } from "@peekalo/contracts";
import { Icon } from "../../../components/icons";
import { Shell } from "../../../components/shell";
import { SampleReveal } from "../../../components/sample-reveal";
import { ProtectedViewer } from "../../../components/protected-viewer";

export const metadata: Metadata = { title: "A shared moment" };

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (token === "view") {
    return (
      <Shell viewer>
        <main id="main" className="viewer-main">
          <div className="viewer-heading"><span className="sender">A moment shared with you.</span><span className="fixture-tag">Private link</span></div>
          <div className="viewer-layout">
            <ProtectedViewer />
            <section className="viewer-copy" aria-labelledby="viewer-title">
              <span className="eyebrow"><span className="tiny-star">✳</span> SMALL MOMENTS, SHARED</span>
              <h1 id="viewer-title">Just a little<br />glimpse<span>.</span></h1>
              <p className="viewer-lede">A moment, held for you.</p>
              <div className="viewing-rules">
                <p><Icon name="eye" /><span><strong>Hold to reveal.</strong><br />Release to hide the moment.</span></p>
                <p><Icon name="clock" /><span><strong>Up to {REVEAL_BUDGET_MS / 1000} seconds total.</strong><br />Across holds, for one viewer.</span></p>
                <p><Icon name="lock" /><span><strong>Only the first viewer.</strong><br />Revealing claims this link in this browser.</span></p>
              </div>
              <p className="capture-note">Browser viewers may save or capture revealed content.</p>
              <p className="sample-help">Keep using this browser to continue. Clearing its cookies loses access; it does not reopen the link for another viewer.</p>
            </section>
          </div>
        </main>
      </Shell>
    );
  }

  if (token !== "demo") {
    return (
      <Shell viewer>
        <main id="main" className="unavailable-main">
          <span className="unavailable-icon"><Icon name="link" /></span>
          <p className="eyebrow">LINK UNAVAILABLE</p>
          <h1>No moment here.</h1>
          <p>This link is incomplete, expired or unavailable. Ask the sender for a new link.</p>
          <Link href="/s/demo" className="primary-link">See the viewer demo<Icon name="arrow" /></Link>
        </main>
      </Shell>
    );
  }

  return (
    <Shell viewer>
      <main id="main" className="viewer-main">
        <div className="viewer-heading">
          <Link href="/u/demo" className="sender"><span className="avatar avatar-small" aria-hidden="true">m</span><span>A moment from <strong>Mika.</strong></span></Link>
          <span className="fixture-tag">Demo viewer</span>
        </div>
        <div className="viewer-layout">
          <SampleReveal />
          <section className="viewer-copy" aria-labelledby="viewer-title">
            <span className="eyebrow"><span className="tiny-star">✳</span> SMALL MOMENTS, SHARED</span>
            <h1 id="viewer-title">Here for<br />a little while<span>.</span></h1>
            <p className="viewer-lede">Some moments are made to be seen, then let go.</p>
            <div className="viewing-rules">
              <p><Icon name="eye" /><span><strong>Hold to reveal.</strong><br />Release to hide the moment.</span></p>
              <p><Icon name="clock" /><span><strong>Up to {REVEAL_BUDGET_MS / 1000} seconds total.</strong><br />Across holds, for one viewer.</span></p>
            </div>
            <details className="demo-details">
              <summary>About this demo<Icon name="arrow" /></summary>
              <p>Try holding the sample. Each hold uses the same ten-second local allowance. Releasing, leaving the image or switching away hides it.</p>
              <p>This is a public sample illustration, not a private post. Refreshing resets its allowance. This sample does not use real link claims or server authorization.</p>
            </details>
            <p className="demo-status"><span />Local demo · no real single-use link is claimed.</p>
            <p className="capture-note">Browser viewers may save or capture revealed content.</p>
          </section>
        </div>
      </main>
    </Shell>
  );
}
