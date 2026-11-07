import { brandArtwork } from '@peekalo/design/brand';
import logo from '@peekalo/design/brand/logo@3x.png';
import mark from '@peekalo/design/brand/mark@3x.png';
import styles from './brand-logo.module.css';

export function BrandLogo({ className = '' }: { className?: string }) {
  return <span className={`${styles.logo} ${className}`} aria-hidden="true"
    style={{
      width: `calc(var(--brand-height, 32px) * ${brandArtwork.width / brandArtwork.height})`,
      backgroundImage: `url("${logo.src}")`,
    }} />;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`${styles.mark} ${className}`} aria-hidden="true"
    style={{
      width: `calc(var(--brand-mark-height, 40px) * ${brandArtwork.markWidth / brandArtwork.markHeight})`,
      backgroundImage: `url("${mark.src}")`,
    }} />;
}
