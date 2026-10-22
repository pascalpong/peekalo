import { publicOrigin } from '@peekalo/web-ui/origins';

/** A fixed public website origin; never infer cross-app links from request headers. */
export function siteOrigin(): string | null {
  const dev = process.env.NODE_ENV === 'development';
  const site = publicOrigin(process.env.PUBLIC_SITE_URL ?? (dev ? 'http://127.0.0.1:3100' : undefined));
  const app = publicOrigin(process.env.PUBLIC_APP_URL ?? (dev ? 'http://127.0.0.1:3101' : undefined));
  return site && site !== app ? site : null;
}
