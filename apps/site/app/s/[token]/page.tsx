import { redirect } from 'next/navigation';
import { getPublicConfig } from '../../../lib/public-config';
import { ProductUnavailable } from '../../../components/product-unavailable';

export const dynamic = 'force-dynamic';
export default async function SharedMoment({ params }: { params: Promise<{ token: string }> }) {
  const { appOrigin } = getPublicConfig();
  if (!appOrigin) return <ProductUnavailable />;
  const { token } = await params;
  // No fragment is set: browsers inherit the original secret fragment on HTTP redirects.
  // This compatibility page never claims or loads a moment.
  redirect(`${appOrigin}/s/${encodeURIComponent(token)}`);
}
