// Export the approved Veil masters at the display densities and icon sizes.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tokens } from '../packages/design/src/index.ts';
import { brandArtwork } from '../packages/design/src/brand.ts';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const sharp = requireWeb('sharp');
const root = new URL('../', import.meta.url);
const check = process.argv.includes('--check');
const source = name => new URL(`packages/design/assets/brand/source/${name}.png`, root);
const outputs = new Map();

for (const [name, width, height] of [
  ['logo', brandArtwork.width, brandArtwork.height],
  ['mark', brandArtwork.markWidth, brandArtwork.markHeight],
]) {
  const master = await readFile(source(name));
  for (const density of [1, 2, 3]) {
    const suffix = density === 1 ? '' : `@${density}x`;
    const png = await sharp(master)
      .resize(width * density, height * density, { fit: 'contain', background: '#00000000' })
      .png().toBuffer();
    outputs.set(`packages/design/assets/brand/${name}${suffix}.png`, png);
  }
}

const mark = await readFile(source('mark'));
async function icon(size, markHeight, background) {
  const symbol = await sharp(mark).resize({ height: markHeight }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: symbol, gravity: 'centre' }]).png().toBuffer();
}

const favicon = await icon(96, 74, tokens.color.background);
outputs.set('apps/web/app/icon.png', favicon);
outputs.set('apps/site/app/icon.png', favicon);
outputs.set('apps/mobile/assets/icon.png', await icon(1024, 690, tokens.color.background));
// Android masks the adaptive foreground. Keep its artwork inside the safe zone.
outputs.set('apps/mobile/assets/adaptive-icon.png', await icon(1024, 580, '#00000000'));

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
