import { notFound } from 'next/navigation';
import { ApiError, rpc } from '../../../lib/server/sharing';
import { PublicProfile, type PublicProfileData } from '../../../components/public-profile';
import { Shell } from '../../../components/shell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Peekalo profile', robots: { index: false, follow: false } };

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  if (!/^[a-z0-9_]{3,24}$/.test(username)) notFound();
  let profile: PublicProfileData;
  try { profile = await rpc<PublicProfileData>('peekalo_public_profile', { p_username: username }); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return <Shell><main id="main" className="profile-main"><h1>Profile unavailable</h1><p className="profile-bio">We couldn&apos;t load this profile. Please try again later.</p></main></Shell>;
  }
  return <PublicProfile profile={profile} />;
}
