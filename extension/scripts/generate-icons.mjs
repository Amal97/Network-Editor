import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'static', 'icons');
const icon = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#1468d4"/>
  <path d="M23 64h23l14-18 15 36 13-18h17" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

await mkdir(output, { recursive: true });
await Promise.all([16, 32, 48, 128].map((size) => sharp(icon).resize(size, size).png().toFile(resolve(output, `icon-${size}.png`))));
console.log(`Generated extension icons in ${output}`);
