import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const unitDir = join(root, 'tests', 'unit');
const files = (await readdir(unitDir))
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join(unitDir, name));

if (!files.length) {
  console.error('No unit tests found in tests/unit');
  process.exit(1);
}

const outdir = await mkdtemp(join(tmpdir(), 'in-page-unit-'));
try {
  await build({
    absWorkingDir: root,
    entryPoints: files,
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
  });
  const built = (await readdir(outdir))
    .filter(name => name.endsWith('.mjs'))
    .sort()
    .map(name => join(outdir, name));
  const result = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
