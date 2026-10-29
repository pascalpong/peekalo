import { Icon } from './icons';
import { Shell } from './shell';
import { SafetyReport } from './safety-report';

export type PublicProfileData = { username: string; items: { kind: 'photo' | 'video'; createdAt: string }[] };

/** Opaque placeholders: this component never receives a clear-media URL. */
export function PublicProfile({ profile }: { profile: PublicProfileData }) {
  return <Shell><main id="main" className="profile-main">
    <section className="profile-intro" aria-labelledby="profile-name">
      <div className="intro-copy">
        <span className="eyebrow">A LITTLE WINDOW INTO</span>
        <div className="profile-identity"><div className="avatar" aria-hidden="true">{profile.username[0]}</div><div><h1 id="profile-name">@{profile.username}</h1><p className="handle">Peekalo profile</p></div></div>
        <p className="profile-bio">A little mystery. Shared only by invitation.</p>
      </div>
    </section>
    <section className="moments-section" aria-labelledby="moments-title">
      <div className="section-heading"><h2 id="moments-title">Moments <span>{profile.items.length}</span></h2><span className="hidden-label"><Icon name="eye" />Hidden by default</span></div>
      {profile.items.length ? <div className="moment-grid">{profile.items.map((moment, index) => <article className="moment-card public-moment" key={`${moment.createdAt}-${index}`}>
        <span className="moment-top"><span>{moment.kind === 'video' ? 'VIDEO' : 'PHOTO'}</span><span>{String(index + 1).padStart(2, '0')}</span></span>
        <span className="moment-center"><span className="peek-circle"><Icon name="eye" /></span><span>Hidden by default.</span></span>
        <span className="moment-bottom"><span>Invitation required</span></span>
      </article>)}</div> : <p className="profile-bio">No active moments yet.</p>}
      <p className="fixture-caption">These opaque cards contain no photo or video. Ask the owner to send you a moment on Peekalo or share a single-use link.</p>
    </section>
    <SafetyReport username={profile.username} />
  </main></Shell>;
}
