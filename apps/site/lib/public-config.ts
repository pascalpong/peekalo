import { publicOrigin } from '@peekalo/web-ui/origins';

/** Public navigation destinations are runtime configuration, never request headers. */
export function getPublicConfig() {
  const development = process.env.NODE_ENV === 'development';
  const siteOrigin = publicOrigin(process.env.PUBLIC_SITE_URL ?? (development ? 'http://127.0.0.1:3100' : undefined));
  const configuredApp = publicOrigin(process.env.PUBLIC_APP_URL ?? (development ? 'http://127.0.0.1:3101' : undefined));
  // A compatibility redirect must not point back to the marketing origin.
  const appOrigin = configuredApp && configuredApp !== siteOrigin ? configuredApp : null;
  return {
    siteOrigin,
    appOrigin,
    waitlistEnabled: process.env.WAITLIST_ENABLED === 'true' && !!siteOrigin && !!appOrigin,
  };
}
