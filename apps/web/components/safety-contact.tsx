'use client';

import { useEffect, useState } from 'react';

type Config = { contactConfigured: boolean; supportEmail?: string; childSafetyEmail?: string; agePolicy?: string };
export function SafetyContact() {
  const [config, setConfig] = useState<Config | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch('/api/safety/config', { cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json() as Config;
      if (active) setConfig(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; controller.abort(); };
  }, []);
  const email = (value: unknown) => typeof value === 'string' && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(value) ? value : null;
  const support = email(config?.supportEmail);
  const childSafety = email(config?.childSafetyEmail);
  return <section className="safety-panel" aria-labelledby="contact-title">
    <h2 id="contact-title">Contact and audience</h2>
    {!config && !failed && <p role="status">Checking contact availability…</p>}
    {failed && <p role="status">Contact availability could not be checked. Please try again later. External beta remains closed until contacts are verified.</p>}
    {config && <>
      {config.contactConfigured && support && childSafety ? <>
        <p>Support and appeals: <a href={`mailto:${encodeURIComponent(support)}`}>{support}</a></p>
        <p>Child-safety concerns and designated contact: <a href={`mailto:${encodeURIComponent(childSafety)}`}>{childSafety}</a></p>
      </> : <p>Support and the designated child-safety contact have not been configured and verified. External beta is closed until these contacts and the operating response process are ready. Do not send private material to an unverified address.</p>}
      <p>{config.agePolicy || 'The launch age policy and countries have not been confirmed. This preview is not open registration for an external beta.'}</p>
    </>}
  </section>;
}
