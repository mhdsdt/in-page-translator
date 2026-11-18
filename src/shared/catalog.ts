import records from './catalog.json' with { type: 'json' };

export type Pack = typeof records[number];
export type PackAsset = Pack['assets'][number];
export const catalog = new Map(records.map(pack => [pack.id, pack]));

export const inputs = [...new Set(records.map(pack => pack.from))];
export const outputs = [...new Set(records.map(pack => pack.to))];

export function routeFor(from: string, to: string): Pack[] {
  if (from === to) return [];
  const direct = catalog.get(from + ':' + to);
  if (direct) return [direct];
  const first = catalog.get(from + ':en');
  const second = catalog.get('en:' + to);
  return first && second ? [first, second] : [];
}

export function packKey(pack: Pack): string {
  return pack.id + '@' + pack.revision;
}

export function packBytes(pack: Pack, field: 'size' | 'bytes'): number {
  return pack.assets.reduce((total, asset) => total + asset[field], 0);
}
