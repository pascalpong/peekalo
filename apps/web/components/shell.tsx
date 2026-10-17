import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark, Icon } from "./icons";

export function Shell({ children, viewer = false }: { children: ReactNode; viewer?: boolean }) {
  return (
    <div className={`site-shell${viewer ? " viewer-shell" : ""}`}>
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Peekalo demo profile">
          <BrandMark />
          <span>peekalo<span className="brand-period">.</span></span>
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
        <span className="footer-note">Peekalo prototype <span aria-hidden="true">↗</span></span>
      </footer>
    </div>
  );
}
