import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

const ALLOWED_LAYERS = {
  shared: new Set(['shared']),
  page: new Set(['page', 'shared']),
  offline: new Set(['offline', 'shared']),
  popup: new Set(['popup', 'shared']),
  packs: new Set(['packs', 'shared']),
};

const FORBIDDEN_PERMISSIONS = new Set([
  '<all_urls>', 'tabs', 'webRequest', 'webRequestBlocking', 'cookies', 'history', 'bookmarks', 'management',
]);

const BUNDLE_BUDGETS = {
  'page.js': 42 * 1024,
  'popup.js': 110 * 1024,
  'packs.js': 110 * 1024,
  'offline.js': 110 * 1024,
  'background.js': 5 * 1024,
  'download.js': 5 * 1024,
  'theme.css': 10 * 1024,
  'popup.css': 10 * 1024,
  'packs.css': 12 * 1024,
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

async function verifySourceModules(errors) {
  const sourceFiles = (await walk(srcDir)).filter(file => file.endsWith('.ts'));
  for (const file of sourceFiles) {
    const rel = relative(srcDir, file).replaceAll('\\', '/');
    const layer = rel.split('/')[0];
    const allowed = ALLOWED_LAYERS[layer];
    if (!allowed) {
      errors.push(`Unknown source layer "${layer}" for src/${rel}`);
      continue;
    }

    const content = await readFile(file, 'utf8');
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.ESNext, true);

    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          const targetRel = relative(srcDir, target).replaceAll('\\', '/');
          const targetLayer = targetRel.split('/')[0];
          if (!allowed.has(targetLayer)) {
            errors.push(`Layer boundary violation: src/${rel} (${layer}) cannot import "${spec}" (${targetLayer})`);
          }
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
        errors.push(`Forbidden eval() call in src/${rel}`);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
        errors.push(`Forbidden new Function() in src/${rel}`);
      }
      if (ts.isPropertyAccessExpression(node) && (node.name.text === 'innerHTML' || node.name.text === 'outerHTML')) {
        errors.push(`Forbidden ${node.name.text} usage in src/${rel}`);
      }

      if (layer === 'page') {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
          errors.push(`Network call fetch() forbidden in page layer: src/${rel}`);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === 'XMLHttpRequest' || node.expression.text === 'WebSocket')) {
          errors.push(`Network API ${node.expression.text} forbidden in page layer: src/${rel}`);
        }
      }

      if (layer === 'shared' && rel !== 'shared/offline.ts') {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'chrome') {
          errors.push(`chrome.* access forbidden in pure shared module: src/${rel}`);
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return sourceFiles.length;
}

async function verifyManifestAndDist(errors) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const pkgLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const staticManifest = JSON.parse(await readFile(join(root, 'static', 'manifest.json'), 'utf8'));
  const distManifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
  const modelSource = JSON.parse(await readFile(join(root, 'src', 'shared', 'model-source.json'), 'utf8'));

  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    errors.push(`Runtime dependencies are forbidden in package.json: ${Object.keys(pkg.dependencies).join(', ')}`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(pkg.version)) {
    errors.push(`package.json version "${pkg.version}" is not valid X.Y.Z semver`);
  }
  if (pkgLock.version !== pkg.version || pkgLock.packages?.['']?.version !== pkg.version) {
    errors.push(`Version drift: package-lock.json (${pkgLock.version} / ${pkgLock.packages?.['']?.version}) !== package.json (${pkg.version})`);
  }
  if (staticManifest.version !== pkg.version) {
    errors.push(`Version drift: static/manifest.json (${staticManifest.version}) !== package.json (${pkg.version})`);
  }
  if (distManifest.version !== pkg.version) {
    errors.push(`Version drift: dist/manifest.json (${distManifest.version}) !== package.json (${pkg.version})`);
  }

  for (const permission of distManifest.permissions ?? []) {
    if (FORBIDDEN_PERMISSIONS.has(permission)) {
      errors.push(`Forbidden broad permission "${permission}" in manifest.json`);
    }
  }
  const expectedHost = modelSource + '*';
  if (JSON.stringify(distManifest.host_permissions) !== JSON.stringify([expectedHost])) {
    errors.push(`Unexpected host_permissions: ${JSON.stringify(distManifest.host_permissions)} (expected [${expectedHost}])`);
  }

  const referencedFiles = [
    distManifest.background?.service_worker,
    distManifest.action?.default_popup,
    distManifest.options_ui?.page,
    ...Object.values(distManifest.icons ?? {}),
    ...Object.values(distManifest.action?.default_icon ?? {}),
    'offline.html',
    'offline.js',
    'download.js',
    'page.js',
    'packs.js',
    'popup.js',
    'LICENSE',
    'MPL-2.0.txt',
    'THIRD-PARTY-NOTICES.md',
    'bergamot/translator-worker.js',
    'bergamot/bergamot-translator-worker.js',
    'bergamot/bergamot-translator-worker.wasm',
  ].filter(Boolean);

  for (const relPath of new Set(referencedFiles)) {
    try {
      await stat(join(distDir, relPath));
    } catch {
      errors.push(`Missing required dist asset: ${relPath}`);
    }
  }

  for (const file of await walk(distDir)) {
    const rel = relative(distDir, file);
    if (rel.endsWith('.DS_Store') || rel.endsWith('.map')) {
      errors.push(`Unexpected stray file in dist/: ${rel}`);
    }
  }
}

async function verifyCatalog(errors) {
  const catalog = JSON.parse(await readFile(join(root, 'src', 'shared', 'catalog.json'), 'utf8'));
  const seenIds = new Set();
  for (const pack of catalog) {
    if (seenIds.has(pack.id)) errors.push(`Duplicate catalog pack id: ${pack.id}`);
    seenIds.add(pack.id);
    if (pack.id !== `${pack.from}:${pack.to}`) errors.push(`Mismatched catalog pack id: ${pack.id}`);
    if (!/^[0-9a-f]{20}$/u.test(pack.revision)) errors.push(`Invalid revision for ${pack.id}: ${pack.revision}`);
    if (!Array.isArray(pack.assets) || pack.assets.length < 3) errors.push(`Incomplete assets for ${pack.id}`);
    for (const asset of pack.assets) {
      if (!/^models\/[\w.-]+\/[\w.-]+\/exported\/[\w.-]+\.gz$/u.test(asset.file)) {
        errors.push(`Invalid asset path in ${pack.id}: ${asset.file}`);
      }
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !Number.isSafeInteger(asset.bytes) || asset.bytes < asset.size) {
        errors.push(`Invalid asset sizes in ${pack.id}: ${asset.file}`);
      }
      if (!/^[0-9a-f]{64}$/u.test(asset.unpacked)) {
        errors.push(`Invalid SHA-256 digest in ${pack.id}: ${asset.file}`);
      }
    }
  }
  return catalog.length;
}

async function verifyBundleBudgets(errors) {
  const sizeReport = [];
  for (const [file, budget] of Object.entries(BUNDLE_BUDGETS)) {
    const info = await stat(join(distDir, file));
    const kb = (info.size / 1024).toFixed(1);
    const maxKb = (budget / 1024).toFixed(1);
    sizeReport.push(`  ${file.padEnd(16)} ${kb.padStart(6)} KiB / ${maxKb.padStart(5)} KiB`);
    if (info.size > budget) {
      errors.push(`Bundle size budget exceeded for dist/${file}: ${kb} KiB > ${maxKb} KiB`);
    }
  }
  return sizeReport;
}

const errors = [];
const sourceCount = await verifySourceModules(errors);
await verifyManifestAndDist(errors);
const packCount = await verifyCatalog(errors);
const sizeReport = await verifyBundleBudgets(errors);

if (errors.length) {
  console.error('Verification failed:\n' + errors.map(err => '  - ' + err).join('\n'));
  process.exit(1);
}

console.log(`Verified ${sourceCount} source modules, ${packCount} catalog packs, manifest invariants, and bundle budgets:`);
console.log(sizeReport.join('\n'));
