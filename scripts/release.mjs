import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const releases = resolve(root, 'releases');
const checkOnly = process.argv.includes('--check');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const packageJson = readJson('package.json');
const extensionPackage = readJson('extension/package.json');
const manifest = readJson('extension/manifest.json');

for (const [name, version] of [
  ['extension/package.json', extensionPackage.version],
  ['extension/manifest.json', manifest.version]
]) {
  if (version !== packageJson.version) {
    throw new Error(`${name} version ${version} does not match package.json version ${packageJson.version}`);
  }
}

function run(args) {
  const result = spawnSync(npm, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['test']);
run(['--prefix', 'extension', 'run', 'build']);
run(['--prefix', 'extension', 'run', 'typecheck']);
run(['--prefix', 'extension', 'test']);

if (checkOnly) {
  console.log(`Release checks passed for v${packageJson.version}`);
  process.exit(0);
}

rmSync(releases, { recursive: true, force: true });
mkdirSync(releases, { recursive: true });
run(['pack', '--pack-destination', 'releases']);
run(['--prefix', 'extension', 'run', 'archive']);

const artifacts = [
  `network-modifier-${packageJson.version}.tgz`,
  `network-modifier-v${packageJson.version}.zip`
];
const checksums = artifacts.map((file) => {
  const digest = createHash('sha256').update(readFileSync(resolve(releases, file))).digest('hex');
  return `${digest}  ${file}`;
});
writeFileSync(resolve(releases, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log(`Created release artifacts for v${packageJson.version} in ${releases}`);