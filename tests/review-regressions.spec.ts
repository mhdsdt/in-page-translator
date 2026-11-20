import { chromium, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { catalog, packKey } from '../src/shared/catalog';
import { catalogLanguage } from '../src/shared/languages';
import { installFake, prepare, translationCalls, withFakePacks } from './fake-translator';

test('repairs translated nodes moved into form values and protects in-flight writes', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="fr"><body><form>
      <p id="first">Premier</p><p id="second">Deuxième</p><p id="pending">En cours</p>
      <textarea name="notes"></textarea>
      <select name="choice"><option></option></select><select name="pending"><option></option></select>
    </form></body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { delay: 700 });
    await popup.click();
    await expect.poll(() => translationCalls(popup)).toContain('En cours');
    await page.evaluate(() => {
      document.querySelector('[name=pending] option')!.append(document.querySelector('#pending')!.firstChild!);
    });
    await expect(page.locator('#first')).toHaveText('«Premier»');
    await expect(page.locator('#second')).toHaveText('«Deuxième»');
    await page.evaluate(() => {
      document.querySelector('textarea')!.append(document.querySelector('#first')!.firstChild!);
      document.querySelector('[name=choice] option')!.append(document.querySelector('#second')!.firstChild!);
    });
    const values = () => page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form')!)));
    await expect.poll(values).toEqual({ notes: 'Premier', choice: 'Deuxième', pending: 'En cours' });
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    expect(await values()).toEqual({ notes: 'Premier', choice: 'Deuxième', pending: 'En cours' });
  });
});

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

test('honors viewport styling, shadow roots, and nested author opt-ins and opt-outs', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    serve('/f', '<p>Dans le cadre</p>');
    await page.goto(serve('/', `<!doctype html><html lang="fr"><meta charset="utf-8"><style>
      #focus-text { opacity: 0; }
      #focus:focus + #focus-text { opacity: 1; }
      #boxless { display: contents; visibility: hidden; }
      @keyframes reveal { to { opacity: 1; } }
      #animated { opacity: 0; animation: reveal 10ms 2s forwards; }
    </style><body>
      <h1>Visible</h1>
      <button id="focus">Montrer</button><p id="focus-text">Par le focus</p>
      <div><span id="boxless">Dans le conteneur</span></div>
      <iframe src="/f" style="opacity:0;height:44px"></iframe>
      <p id="animated">Après animation</p>
      <div id="late" style="display:contents"></div>
      <section translate="no"><p id="optout">Original</p><p id="optin" translate="yes">Exception</p></section>
      <div id="host"><span id="slotted">Dans la projection</span></div>
      <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML =
        '<section id="wrapper" translate="no"><slot></slot></section>';</script>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect(page.locator('h1')).toHaveText('«Visible»');
    await expect(page.locator('#optin')).toHaveText('«Exception»');
    const initialCalls = await translationCalls(popup);
    for (const hidden of ['Dans le cadre', 'Dans le conteneur', 'Par le focus', 'Dans la projection', 'Original']) {
      expect(initialCalls).not.toContain(hidden);
    }
    // No DOM changes should be necessary to notice a CSS-only animation.
    await expect(page.locator('#animated')).toHaveText('«Après animation»');
    await page.locator('#focus').evaluate(node => (node as HTMLButtonElement).focus());
    await expect(page.locator('#focus-text')).toHaveText('«Par le focus»');

    await page.locator('#late').evaluate(node => {
      node.attachShadow({ mode: 'open' }).innerHTML = '<p>Ajout tardif</p>';
    });
    await expect(page.locator('#late p')).toHaveText('«Ajout tardif»');

    await page.locator('#boxless').evaluate(node => { (node as HTMLElement).style.visibility = 'visible'; });
    await page.locator('iframe').evaluate(node => { node.style.opacity = '1'; });
    await expect(page.locator('#boxless')).toHaveText('«Dans le conteneur»');
    await expect(page.frameLocator('iframe').locator('p')).toHaveText('«Dans le cadre»');

    const wrapper = page.locator('#host #wrapper');
    await wrapper.evaluate(node => node.setAttribute('translate', 'yes'));
    await expect(page.locator('#slotted')).toHaveText('«Dans la projection»');
    await wrapper.evaluate(node => node.setAttribute('translate', 'no'));
    await expect(page.locator('#slotted')).toHaveText('Dans la projection');
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

test('retries busy replies and revisits text when a burst outlasts the retry budget', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="fr"><body>
      <h1>Réessai bref</h1><p>Réessai plus tard</p>
      <div style="height:2400px"></div><p id="last">Fin de la page</p>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { busy: { 'Réessai bref': 1, 'Réessai plus tard': 4 } });
    await popup.click();
    await expect(page.locator('h1')).toHaveText('«Réessai bref»');
    await expect.poll(popup.status).toContain('Some text couldn’t be translated.');
    await expect(page.locator('p').first()).toHaveText('Réessai plus tard');
    await page.locator('#last').evaluate(node => node.scrollIntoView());
    await expect(page.locator('#last')).toHaveText('«Fin de la page»');
    await page.locator('h1').evaluate(node => node.scrollIntoView());
    await expect(page.locator('p').first()).toHaveText('«Réessai plus tard»');
    await expect.poll(popup.status).toBe('Translated to English. Scroll to translate more.');
  });
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

test('recovers automatically when offscreen document closes mid-session and user scrolls', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="fr"><body>
      <h1>Haut de page</h1>
      <div style="height:2400px"></div>
      <p id="bottom">Bas de page</p>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { disconnectOnce: 'Bas de page' });
    await popup.click();
    await expect(page.locator('h1')).toHaveText('«Haut de page»');
    await expect.poll(popup.status).toMatch(/^Translated to English/);

    await page.locator('#bottom').evaluate(node => node.scrollIntoView());
    await expect(page.locator('#bottom')).toHaveText('«Bas de page»');
    const opens = await popup.evaluate<number>(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.engineOpens,
      });
      return injection.result;
    })()`);
    expect(opens).toBeGreaterThanOrEqual(2);
  });
});

test('translates visible text overflowing zero-height and unclipped boxes while keeping scrollers clipped', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="fr"><body>
      <div id="zero" style="height:0; overflow:visible">Texte sans hauteur</div>
      <div style="height:40px"></div>
      <div id="overflow" style="height:18px; overflow:visible">
        <div style="height:24px"></div>Texte qui déborde
      </div>
      <div style="height:40px"></div>
      <div id="scroller" style="height:40px; overflow:auto">
        <p>Première ligne</p>
        <div style="height:240px"></div>Texte caché dans le défilement
      </div>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect(page.locator('#zero')).toHaveText('«Texte sans hauteur»');
    await expect(page.locator('#overflow')).toContainText('«Texte qui déborde»');
    await expect(page.locator('#scroller p')).toHaveText('«Première ligne»');
    await expect(page.locator('#scroller')).not.toContainText('«Texte caché dans le défilement»');

    await page.locator('#scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#scroller')).toContainText('«Texte caché dans le défilement»');
  });
});

test('does not permanently skip a node whose eligibility flickers mid-flight', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><body><p id="flicker">Texte mouvant</p></body></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { delay: 300 });
    await popup.click();
    await expect.poll(() => translationCalls(popup)).toContain('Texte mouvant');

    await page.locator('#flicker').evaluate(node => node.setAttribute('hidden', ''));
    await page.waitForTimeout(450);
    await expect(page.locator('#flicker')).toHaveText('Texte mouvant');

    await page.locator('#flicker').evaluate(node => node.removeAttribute('hidden'));
    await expect(page.locator('#flicker')).toHaveText('«Texte mouvant»');
  });
});

test('downloads missing packs directly in popup, supports cancel, and auto-translates', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="de"><body><h1>Guten Morgen!</h1></body></html>'));
    const popup = await openPopup();
    await expect.poll(popup.status).toBe('Download language pack to translate this page.');
    expect(await popup.evaluate('document.querySelector("#action").textContent')).toContain('Download & translate');

    await installFake(popup);
    // Mock pack download lifecycle in popup while letting real background auto-translate work.
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

    // Start download, then cancel it before completion.
    await popup.click();
    await expect.poll(popup.status).toContain('Downloading German → English');
    expect(await popup.evaluate('document.querySelector("#action").textContent')).toContain('Cancel download');
    await popup.click();
    await expect.poll(popup.status).toBe('Download language pack to translate this page.');
    await expect(page.locator('h1')).toHaveText('Guten Morgen!');

    // Download again and let it finish -> page translates automatically.
    await popup.click();
    await expect.poll(popup.status).toContain('Downloading German → English');
    await expect(page.locator('h1')).toHaveText('«Guten Morgen!»');
    await expect.poll(popup.status).toMatch(/^Translated to English/);
  });
});
