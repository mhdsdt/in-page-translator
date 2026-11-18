export function normalizeLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const tag = value.trim();
    const locale = new Intl.Locale(tag);
    // Intl canonicalizes some catalog IDs to codes with different pack directions.
    const original = tag.split('-')[0]?.toLowerCase();
    if (original === 'tl' || original === 'hbs' || original === 'no') return original;
    switch (locale.language) {
      case 'zh': return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
      case 'fil': return 'tl';
      case 'nn': return 'nb';
      default: return locale.language;
    }
  } catch {
    return undefined;
  }
}

export function catalogLanguage(value: string | undefined, supported: readonly string[]): string | undefined {
  const code = normalizeLanguage(value);
  if (!code) return undefined;
  if (supported.includes(code)) return code;
  if (code === 'sr' && supported.includes('hbs')) return 'hbs';
  if (code === 'hbs' && supported.includes('sr')) return 'sr';
  return undefined;
}

const names = new Intl.DisplayNames(['en'], { type: 'language' });

export function languageName(code: string): string {
  return names.of(code) ?? code;
}

export function pairName(id: string): string {
  return id.split(':').map(languageName).join(' \u2192 ');
}

export function fillLanguages(select: HTMLSelectElement, codes: string[]): void {
  const options = codes.map(code => new Option(languageName(code), code));
  options.sort((a, b) => a.text.localeCompare(b.text, 'en'));
  select.append(...options);
}
