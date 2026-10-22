import type { Metadata, Viewport } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import localFont from 'next/font/local';
import { cssVariables, tokens } from '@peekalo/design';
import '@peekalo/web-ui/base.css';

const displayFont = localFont({
  src: '../../../packages/design/assets/display.ttf',
  variable: '--font-peekalo-display',
  weight: '700',
  display: 'swap',
});
export const metadata: Metadata = {
  title: { default: 'Peekalo — A little glimpse', template: '%s · Peekalo' },
  description: 'A little moment. Just for you. Peekalo is a camera-first way to share the little things.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: tokens.color.background };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={displayFont.variable} style={cssVariables as CSSProperties}>
    <body><a className="skip-link" href="#main">Skip to content</a>{children}</body>
  </html>;
}
