import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Peekalo — A little glimpse", template: "%s · Peekalo" },
  description: "A little glimpse into someone's world. Peekalo's profile and shared-viewer prototype.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f7f7f2" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
