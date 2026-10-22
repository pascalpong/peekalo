// The SVG geometry is the master. Native bitmap densities and launcher/favicon
// assets are exports of that geometry, never independently drawn logos.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tokens } from '../packages/design/src/index.ts';
import { createBrandArtwork } from '../packages/design/src/brand-geometry.ts';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const sharp = requireWeb('sharp');
const root = new URL('../', import.meta.url);
const brand = createBrandArtwork(tokens.color);
const check = process.argv.includes('--check');
const outputs = new Map();
for (const [name, svg, width, height] of [
  ['logo', brand.svg, brand.width, brand.height],
  ['mark', brand.markSvg, brand.markWidth, brand.markHeight],
]) {
  outputs.set(`packages/design/assets/brand/${name}.svg`, Buffer.from(`${svg}\n`));
  for (const density of [1, 2, 3]) {
    const suffix = density === 1 ? '' : `@${density}x`;
    outputs.set(`packages/design/assets/brand/${name}${suffix}.png`, await sharp(Buffer.from(svg))
      .resize(width * density, height * density).png().toBuffer());
  }
}
outputs.set('packages/design/assets/brand/icon.svg', Buffer.from(`${brand.iconSvg}\n`));
outputs.set('apps/web/app/icon.svg', Buffer.from(`${brand.iconSvg}\n`));
outputs.set('apps/site/app/icon.svg', Buffer.from(`${brand.iconSvg}\n`));
outputs.set('apps/mobile/assets/icon.png', await sharp(Buffer.from(brand.iconSvg)).png().toBuffer());
for (const [name, expected] of outputs) {
  const path = new URL(name, root);
  if (check) {
    const actual = await readFile(path).catch(() => null);
    if (!actual?.equals(expected)) throw new Error(`Brand export differs: ${name}. Run pnpm brand:generate.`);
  } else {
    await mkdir(fileURLToPath(new URL('./', path)), { recursive: true });
    await writeFile(path, expected);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} ${outputs.size} canonical Peekalo brand assets.`);
