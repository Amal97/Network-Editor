import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const options = {
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    bridge: resolve(root, 'src/bridge.ts'),
    page: resolve(root, 'src/page.ts'),
    devtools: resolve(root, 'src/devtools.ts'),
    panel: resolve(root, 'src/panel.ts'),
    popup: resolve(root, 'src/popup.ts')
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir,
  sourcemap: true
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync(resolve(root, 'manifest.json'), resolve(outdir, 'manifest.json'));
cpSync(resolve(root, 'static'), outdir, { recursive: true });

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log(`Watching ${root}`);
} else {
  await build(options);
  console.log(`Built extension in ${outdir}`);
}
