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
          <div className="viewer-layout">
            <section className="viewer-copy" aria-labelledby="viewer-title">
              <span className="eyebrow">PRIVATE LINK</span>
              <h1 id="viewer-title">Just for your eyes.</h1>
              <p className="viewer-lede">Hold to reveal. Release to hide.</p>
              <p className="viewer-claim">The first reveal claims this single-use link.</p>
            </section>
            <div className="viewer-stage"><ProtectedViewer /></div>
            <section className="viewer-conditions" aria-label="Viewing rules">
              <div className="viewing-rules">
                <p><strong>Up to {REVEAL_BUDGET_MS / 1000} seconds total.</strong>Your remaining time continues across holds.</p>
                <p><strong>One link. One viewer.</strong>Opening a preview does not claim the link. The first reveal binds it to the viewer’s browser.</p>
              </div>
              <p className="capture-note">Browser viewers may save or capture revealed content.</p>
              <p className="capture-note">Keep using this browser to continue. Clearing its cookies loses access; it does not reopen the link for another viewer.</p>
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
        <div className="viewer-layout">
          <section className="viewer-copy" aria-labelledby="viewer-title">
            <Link href="/u/demo" className="eyebrow viewer-sender">A moment from @mika.demo</Link>
            <h1 id="viewer-title">Just for your eyes.</h1>
            <p className="viewer-lede">Hold to reveal. Release to hide.</p>
            <p className="viewer-claim">Local demo · Public illustration</p>
          </section>
          <div className="viewer-stage"><SampleReveal /></div>
          <section className="viewer-conditions" aria-label="About the sample viewer">
            <div className="viewing-rules">
              <p><strong>Up to {REVEAL_BUDGET_MS / 1000} seconds total.</strong>Your remaining time continues across holds.</p>
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
