import { ZipArchive } from 'archiver';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const workspaceReleases = resolve(root, '..', 'releases');
const releases = process.env.NETMOD_RELEASE_DIR || workspaceReleases;
const destination = resolve(releases, `network-modifier-v${manifest.version}.zip`);

await mkdir(releases, { recursive: true });
await new Promise((resolveArchive, reject) => {
  const output = createWriteStream(destination);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  output.on('close', resolveArchive);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);
  archive.directory(resolve(root, 'dist'), false);
  archive.finalize();
});
console.log(`Created ${destination}`);
