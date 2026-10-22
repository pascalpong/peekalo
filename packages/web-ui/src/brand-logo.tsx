import { brandArtwork } from '@peekalo/design/brand';
import styles from './brand-logo.module.css';

/** Trusted, repository-owned outlined artwork shared with the native app. */
export function BrandLogo({ className = '' }: { className?: string }) {
  return <span className={`${styles.logo} ${className}`} aria-hidden="true"
    style={{ width: `calc(var(--brand-height, 32px) * ${brandArtwork.width / brandArtwork.height})` }}
    dangerouslySetInnerHTML={{ __html: brandArtwork.svg }} />;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`${styles.mark} ${className}`} aria-hidden="true"
    style={{ width: `calc(var(--brand-mark-height, 40px) * ${brandArtwork.markWidth / brandArtwork.markHeight})` }}
    dangerouslySetInnerHTML={{ __html: brandArtwork.markSvg }} />;
}
