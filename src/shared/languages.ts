const RTL_LANGUAGES = new Set(['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

export function normalizeLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const tag = value.trim();
    const locale = new Intl.Locale(tag);
    // Intl.Locale canonicalizes tl/hbs/no to codes with different pack directions.
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

export function isRtlLanguage(code: string | undefined): boolean {
  const normalized = normalizeLanguage(code) ?? code?.split('-')[0]?.toLowerCase();
  return Boolean(normalized && RTL_LANGUAGES.has(normalized));
}

export function catalogLanguage(value: string | undefined, supported: readonly string[]): string | undefined {
  const code = normalizeLanguage(value);
  if (!code) return undefined;
  if (supported.includes(code)) return code;
  if (code === 'sr' && supported.includes('hbs')) return 'hbs';
  if (code === 'hbs' && supported.includes('sr')) return 'sr';
  return undefined;
}

let displayNames: Intl.DisplayNames | undefined;

export function languageName(code: string): string {
  displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
  return displayNames.of(code) ?? code;
}

export function pairName(id: string): string {
  return id.split(':').map(languageName).join(' \u2192 ');
}

export function fillLanguages(select: HTMLSelectElement, codes: string[], recent?: readonly string[]): void {
  const validCodes = new Set(codes);
  const recentCodes: string[] = [];
  if (recent) {
    for (const code of recent) {
      if (validCodes.has(code) && !recentCodes.includes(code)) recentCodes.push(code);
    }
  }

  if (recentCodes.length) {
    const recentSet = new Set(recentCodes);
    const recentGroup = document.createElement('optgroup');
    recentGroup.label = 'Recent';
    recentGroup.append(...recentCodes.map(code => new Option(languageName(code), code)));

    const restOptions = codes
      .filter(code => !recentSet.has(code))
      .map(code => new Option(languageName(code), code))
      .sort((a, b) => a.text.localeCompare(b.text, 'en'));
    const allGroup = document.createElement('optgroup');
    allGroup.label = 'All languages';
    allGroup.append(...restOptions);

    select.append(recentGroup, allGroup);
    return;
  }

  const options = codes.map(code => new Option(languageName(code), code));
  options.sort((a, b) => a.text.localeCompare(b.text, 'en'));
  select.append(...options);
}
