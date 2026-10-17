import Link from "next/link";
import { Shell } from "../components/shell";

export default function NotFound() {
  return (
    <Shell>
      <main id="main" className="unavailable-main">
        <p className="eyebrow">A LITTLE LOST?</p>
        <h1>This page slipped away.</h1>
        <p>There&apos;s still a little glimpse waiting in our demo.</p>
        <Link className="primary-link" href="/">Back to Peekalo</Link>
      </main>
    </Shell>
  );
}
