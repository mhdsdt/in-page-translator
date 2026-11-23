import { chromium, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { catalog, packKey } from '../src/shared/catalog';
import { catalogLanguage } from '../src/shared/languages';
import { installFake, prepare, withFakePacks } from './fake-translator';

test('restores an active page when the pack database is unavailable', async () => {
  await withFakePacks(async ({ page, serve, openPopup, openExtensionPage }) => {
    await page.goto(serve('/', '<html lang="fr"><h1>Texte original</h1></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect(page.locator('h1')).toHaveText('«Texte original»');
    await popup.close();

    const fixture = await openExtensionPage('MPL-2.0.txt');
    await fixture.evaluate(async () => {
      await chrome.offscreen.closeDocument();
      await new Promise<void>((resolve, reject) => {
        const upgrade = indexedDB.open('translation-models', 2);
        upgrade.onsuccess = () => { upgrade.result.close(); resolve(); };
        upgrade.onerror = () => reject(upgrade.error);
      });
    });
    await fixture.close();
    await page.bringToFront();
    const reopened = await openPopup();
    await expect.poll(reopened.status).toMatch(/^Translated to English/);
    await reopened.click();
    await expect(page.locator('h1')).toHaveText('Texte original');
  });
});

test('rechecks installed packs when a tab has an old missing-pack error', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><h1>Texte original</h1></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { firstSetup: 'missing-packs' });
    await popup.click();
    const status = () => popup.evaluate<{ error?: string }>(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    })()`);
    await expect.poll(async () => (await status()).error).toBe('missing-packs');
    await popup.close();

    const reopened = await openPopup();
    await expect.poll(reopened.status).toBe('Page is in its original language.');
    expect(await reopened.evaluate('document.querySelector("#action").textContent')).toContain('Translate page');
    await reopened.click();
    await expect(page.locator('h1')).toHaveText('«Texte original»');
  });
});

test('routes detected Filipino and Serbo-Croatian and keeps catalog targets', async () => {
  expect(catalogLanguage('sr-Latn', ['hbs'])).toBe('hbs');
  expect(catalogLanguage('hbs', ['hbs', 'sr'])).toBe('hbs');
  expect(catalogLanguage('hbs', ['sr'])).toBe('sr');
  expect(catalogLanguage('no', ['nb', 'no'])).toBe('no');
  expect(catalogLanguage('zh-TW', ['zh-Hans', 'zh-Hant'])).toBe('zh-Hant');

  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fil-PH"><h1>Kumusta</h1></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect(page.locator('h1')).toHaveText('«Kumusta»');
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await popup.click();
    await expect(page.locator('h1')).toHaveText('Kumusta');
    await popup.close();

    await page.goto(serve('/english', '<html lang="en"><h1>Good morning</h1></html>'));
    const english = await openPopup();
    await expect.poll(english.status).toBe('Choose a different language in To.');
    await english.choose('target', 'tl');
    await installFake(english);
    await english.click();
    await expect(page.locator('h1')).toHaveText('«Good morning»');
    await expect.poll(english.status).toMatch(/^Translated/);
    await english.click();
    await expect.poll(english.status).toBe('Page is in its original language.');
    await english.close();

    const reopened = await openPopup();
    await expect.poll(reopened.status).toBe('Page is in its original language.');
    expect(await reopened.evaluate('document.querySelector("#target").value')).toBe('tl');
  }, ['tl:en', 'en:tl']);
});

test('does not accept a pack install against a pending removal', async () => {
  const { outputFiles } = await build({
    stdin: { contents: "import { Packs } from './src/offline/packs'; globalThis.testPacks = () => new Packs();", resolveDir: process.cwd() },
    bundle: true, format: 'iife', write: false,
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://pack-review.test/', route => route.fulfill({ body: '<html></html>' }));
    await page.goto('https://pack-review.test/');
    await page.addScriptTag({ content: outputFiles[0]!.text });
    const status = await page.evaluate(async key => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('translation-models', 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('packs'); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction('packs', 'readwrite');
          transaction.objectStore('packs').put(null, key);
          transaction.oncomplete = () => { request.result.close(); resolve(); };
        };
      });

      const create = (globalThis as typeof globalThis & { testPacks: () => import('../src/offline/packs').Packs }).testPacks;
      const packs = create();
      await packs.status();
      const removal = packs.remove('fr:en');
      const install = packs.install({ from: 'fr', to: 'en' }).then(() => 'accepted', error => error.code);
      const [outcome] = await Promise.all([install, removal]);
      return { outcome, installed: (await packs.status()).installed };
    }, packKey(catalog.get('fr:en')!));
    expect(status).toEqual({ outcome: 'busy', installed: [] });
  } finally {
    await browser.close();
  }
});

test('downloads missing packs directly in popup, supports cancel, and auto-translates', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="de"><body><h1>Guten Morgen!</h1></body></html>'));
    const popup = await openPopup();
    await expect.poll(popup.status).toBe('Download language pack to translate this page.');
    expect(await popup.evaluate('document.querySelector("#action").textContent')).toContain('Download & translate');

    await installFake(popup);
    await popup.evaluate(`(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let state = { installed: ['fr:en', 'es:en'] };
      let timer;
      chrome.runtime.sendMessage = async message => {
        if (message.type === 'engine-open') return { ok: true };
        if (message.type === 'packs-state') return { ok: true, value: structuredClone(state) };
        if (message.type === 'packs-cancel') {
          clearTimeout(timer);
          state = { installed: ['fr:en', 'es:en'] };
          return { ok: true, value: undefined };
        }
        if (message.type === 'packs-install') {
          state = {
            installed: ['fr:en', 'es:en'],
            download: { pack: 'de:en', received: 5_000_000, total: 10_000_000, saving: false, step: 1, steps: 1 },
          };
          const auto = message.autoTranslate;
          timer = setTimeout(async () => {
            state = { installed: ['fr:en', 'es:en', 'de:en'] };
            if (auto) {
              await chrome.tabs.sendMessage(
                auto.tabId,
                { type: 'start', source: auto.source, target: auto.target },
                { documentId: auto.documentId },
              );
            }
          }, 450);
          return { ok: true, value: undefined };
        }
        return send(message);
      };
    })()`);

    await popup.click();
    await expect.poll(popup.status).toContain('Downloading German → English');
    expect(await popup.evaluate('document.querySelector("#action").textContent')).toContain('Cancel download');
    await popup.click();
    await expect.poll(popup.status).toBe('Download language pack to translate this page.');
    await expect(page.locator('h1')).toHaveText('Guten Morgen!');

    await popup.click();
    await expect.poll(popup.status).toContain('Downloading German → English');
    await expect(page.locator('h1')).toHaveText('«Guten Morgen!»');
    await expect.poll(popup.status).toMatch(/^Translated to English/);
  });
});

test('supports swapping languages in popup, updates tab badge, and pushes status updates', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><body><h1>Bonjour</h1></body></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);

    await expect.poll(() => popup.evaluate('document.querySelector("#swap").disabled')).toBe(false);
    await popup.evaluate('document.querySelector("#swap").click()');
    expect(await popup.evaluate('document.querySelector("#source").value')).toBe('en');
    expect(await popup.evaluate('document.querySelector("#target").value')).toBe('fr');

    await popup.evaluate('document.querySelector("#swap").click()');
    expect(await popup.evaluate('document.querySelector("#source").value')).toBe('fr');
    expect(await popup.evaluate('document.querySelector("#target").value')).toBe('en');

    await popup.click();
    await expect.poll(popup.status).toMatch(/^Translated to English/);

    const badgeText = () => popup.evaluate<string>(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.action.getBadgeText({ tabId: tab.id });
    })()`);
    await expect.poll(badgeText).toBe('EN');

    await popup.click();
    await expect.poll(popup.status).toBe('Page is in its original language.');
    await expect.poll(badgeText).toBe('');
  }, ['fr:en', 'en:fr']);
});
