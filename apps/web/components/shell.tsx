import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import { BrandLogo } from "./brand-logo";
import { siteOrigin } from "../lib/site-origin";

export async function Shell({ children, viewer = false }: { children: ReactNode; viewer?: boolean }) {
  // Resolve the cross-app website origin from deployment-time server configuration.
  await connection();
  const about = siteOrigin();
  return (
    <div className={`site-shell${viewer ? " viewer-shell" : ""}`}>
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Peekalo home">
          <BrandLogo />
        </Link>
        <div className="header-right">
          <span className="demo-pill"><span />Early preview</span>
          <Link className="header-link" href={viewer ? "/u/demo" : "/s/demo"}>
            {viewer ? "Demo profile" : "Try the viewer"}<Icon name="arrow" />
          </Link>
        </div>
      </header>
      {children}
      <footer className="site-footer">
        <span>A little glimpse. A little closer.</span>
        <span className="footer-note">Peekalo web app{about && <a href={about}>About Peekalo <span aria-hidden="true">↗</span></a>}</span>
      </footer>
    </div>
  );
}
