import { brandArtwork } from '@peekalo/design/brand';
import { Image } from 'react-native';

// The same outlined artwork is used on web. Metro selects the bundled density.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logo = require('@peekalo/design/brand/logo.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mark = require('@peekalo/design/brand/mark.png');

export function BrandLogo({ height = 28 }: { height?: number }) {
  return <Image source={logo} resizeMode="contain" accessible accessibilityRole="image"
    accessibilityLabel="Peekalo" style={{ height, width: height * brandArtwork.width / brandArtwork.height }} />;
}

/** Decorative mark for avatars and sample illustrations. */
export function BrandMark({ height = 22 }: { height?: number }) {
  return <Image source={mark} resizeMode="contain" accessible={false}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ height, width: height * brandArtwork.markWidth / brandArtwork.markHeight }} />;
}
