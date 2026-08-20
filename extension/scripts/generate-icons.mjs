import sharp from 'sharp';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workspace = resolve(root, '..');
const output = resolve(root, 'static', 'icons');
const source = resolve(workspace, 'assets', 'network-modifier.svg');
const icon = await readFile(source);

await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(source, resolve(output, 'icon.svg')),
  copyFile(source, resolve(workspace, 'public', 'icon.svg')),
  ...[16, 32, 48, 128].map((size) => sharp(icon).resize(size, size).png().toFile(resolve(output, `icon-${size}.png`)))
]);
console.log('Generated consistent proxy and extension icons');
