import { redirect } from 'next/navigation';
import { getPublicConfig } from '../../../lib/public-config';
import { ProductUnavailable } from '../../../components/product-unavailable';

export const dynamic = 'force-dynamic';
export default async function Profile({ params }: { params: Promise<{ username: string }> }) {
  const { appOrigin } = getPublicConfig();
  if (!appOrigin) return <ProductUnavailable />;
  const { username } = await params;
  redirect(`${appOrigin}/u/${encodeURIComponent(username)}`);
}
