import { Shell } from '../../components/shell';
import { OperatorConsole } from '../../components/operator-console';

export const metadata = { title: 'Restricted safety review', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default function OperatorPage() {
  return <Shell><main id="main" className="safety-main"><p className="eyebrow">RESTRICTED SAFETY OPERATIONS</p><h1>Review queue.</h1><OperatorConsole /></main></Shell>;
}
