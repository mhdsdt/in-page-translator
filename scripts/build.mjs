import { build } from 'esbuild';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await rm(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    page: 'src/page/index.ts',
    popup: 'src/popup/index.ts',
    background: 'src/offline/background.ts',
    offline: 'src/offline/document.ts',
    download: 'src/offline/download-worker.ts',
    packs: 'src/packs/index.ts',
  },
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome138',
  legalComments: 'none',
});
await cp(new URL('../static/', import.meta.url), dist, {
  recursive: true,
  filter: source => !source.endsWith('/.DS_Store'),
});

// Keep built manifest version derived from package.json as single source of truth.
const manifestUrl = new URL('manifest.json', dist);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.version = pkg.version;
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');

await cp(new URL('../LICENSE', import.meta.url), new URL('LICENSE', dist));
await cp(new URL('../node_modules/@mkljczk/bergamot-translator/worker/', import.meta.url),
  new URL('bergamot/', dist), { recursive: true });
