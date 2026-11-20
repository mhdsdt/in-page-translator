import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogLanguage, isRtlLanguage, languageName, normalizeLanguage, pairName } from '../../src/shared/languages';

test('normalizeLanguage canonicalizes scripts, regional variants, and special catalog tags', () => {
  assert.equal(normalizeLanguage(undefined), undefined);
  assert.equal(normalizeLanguage(''), undefined);
  assert.equal(normalizeLanguage('not a valid tag !!!'), undefined);

  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('fr-CA'), 'fr');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-Hans');
  assert.equal(normalizeLanguage('zh-SG'), 'zh-Hans');
  assert.equal(normalizeLanguage('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLanguage('zh-HK'), 'zh-Hant');
  assert.equal(normalizeLanguage('fil-PH'), 'tl');
  assert.equal(normalizeLanguage('tl'), 'tl');
  assert.equal(normalizeLanguage('nn-NO'), 'nb');
  assert.equal(normalizeLanguage('no'), 'no');
  assert.equal(normalizeLanguage('hbs'), 'hbs');
});

test('catalogLanguage maps Serbian/Serbo-Croatian fallbacks and rejects unsupported languages', () => {
  assert.equal(catalogLanguage('sr-Latn', ['hbs']), 'hbs');
  assert.equal(catalogLanguage('sr', ['sr', 'hbs']), 'sr');
  assert.equal(catalogLanguage('hbs', ['sr']), 'sr');
  assert.equal(catalogLanguage('hbs', ['hbs', 'sr']), 'hbs');
  assert.equal(catalogLanguage('ja', ['en', 'fr']), undefined);
  assert.equal(catalogLanguage('de-AT', ['de', 'en']), 'de');
});

test('languageName and pairName produce readable English labels', () => {
  assert.equal(languageName('de'), 'German');
  assert.equal(pairName('de:en'), 'German → English');
  assert.equal(pairName('en:fr'), 'English → French');
});

test('isRtlLanguage identifies right-to-left catalog languages including regional tags', () => {
  assert.equal(isRtlLanguage('ar'), true);
  assert.equal(isRtlLanguage('ar-SA'), true);
  assert.equal(isRtlLanguage('fa'), true);
  assert.equal(isRtlLanguage('he'), true);
  assert.equal(isRtlLanguage('ur'), true);
  assert.equal(isRtlLanguage('ug'), true);
  assert.equal(isRtlLanguage('en'), false);
  assert.equal(isRtlLanguage('de'), false);
  assert.equal(isRtlLanguage(undefined), false);
});
