import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import source from '../src/shared/model-source.json' with { type: 'json' };

const catalogFile = new URL('../src/shared/catalog.json', import.meta.url);
const previous = await readFile(catalogFile, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const known = new Map(previous.flatMap(pack => pack.assets.map(asset => [asset.file, asset])));
const response = await get('db/models.json');
const { models } = await response.json();
const released = Object.values(models).flatMap(choices => {
  const model = choices.find(item => item.releaseStatus === 'Release Desktop') ??
    choices.find(item => item.releaseStatus === 'Release');
  return model ? [model] : [];
});
if (!released.length) throw new Error('Mozilla registry returned no released models');

const catalog = [];
let index = 0;
async function loadModels() {
  while (index < released.length) {
    const model = released[index++];
    const from = languageCode(model.sourceLanguage);
    const to = languageCode(model.targetLanguage);
    const id = from + ':' + to;
    const files = model.files;
    const vocab = files.vocab ? [files.vocab] : [files.srcVocab, files.trgVocab];
    const assets = await Promise.all([files.model, files.lexicalShortlist, ...vocab].map(describe));
    const revision = createHash('sha256').update(assets.map(asset => asset.unpacked).join('')).digest('hex').slice(0, 20);
    catalog.push({ id, from, to, revision, assets });
  }
}
await Promise.all(Array.from({ length: 4 }, loadModels));
catalog.sort((left, right) => left.id.localeCompare(right.id, 'en'));
if (new Set(catalog.map(pack => pack.id)).size !== catalog.length) throw new Error('Duplicate model route');
await writeFile(catalogFile, '[\n' + catalog.map(pack => '  ' + JSON.stringify(pack)).join(',\n') + '\n]\n');
console.log('Pinned ' + catalog.length + ' released model packs');

function languageCode(code) {
  if (code === 'zh') return 'zh-Hans';
  if (code === 'zh_hant') return 'zh-Hant';
  if (!/^[a-z]{2,3}$/u.test(code)) throw new Error('Unrecognized language code ' + code);
  return code;
}

async function describe({ path: file, uncompressedSize, uncompressedHash }) {
  if (!/^models\/[\w.-]+\/[\w.-]+\/exported\/[\w.-]+\.gz$/u.test(file)) {
    throw new Error('Unsupported model path ' + file);
  }
  const old = known.get(file);
  if (old && (!uncompressedHash || old.unpacked === uncompressedHash)) return old;
  if (Number.isSafeInteger(uncompressedSize) && uncompressedSize > 0 && /^[0-9a-f]{64}$/u.test(uncompressedHash)) {
    const head = await get(file, 'HEAD');
    const size = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Unknown asset size for ' + file);
    return { file, size, bytes: uncompressedSize, unpacked: uncompressedHash };
  }

  const response = await get(file);
  const compressed = Buffer.from(await response.arrayBuffer());
  const unpacked = gunzipSync(compressed);
  return {
    file, size: compressed.length, bytes: unpacked.length,
    unpacked: createHash('sha256').update(unpacked).digest('hex'),
  };
}

async function get(file, method = 'GET') {
  const response = await fetch(source + file, { method, signal: AbortSignal.timeout(45_000), redirect: 'error' });
  if (!response.ok) throw new Error('Mozilla model source returned HTTP ' + response.status + ' for ' + file);
  return response;
}
