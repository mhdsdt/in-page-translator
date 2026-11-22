import { createServer } from 'node:http';
import { chromium, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { catalog, packKey } from '../src/shared/catalog';
import { catalogLanguage } from '../src/shared/languages';
import { installFake, htmlCalls, prepare, translationCalls, withFakePacks } from './fake-translator';

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

test('translates select options with explicit values, CSS pseudo-element data-* attributes, button inputs, tooltips, and details', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="de"><head><style>
      #IFeedbackButton::after { content: attr(data-after); }
    </style></head><body>
      <form id="controls">
        <select id="sort-box-select" name="sort" aria-label="Sortieren nach:">
          <optgroup label="Sortierung">
            <option value="RELEVANCE_DESC" selected="">Beliebteste zuerst</option>
            <option value="DISCOUNT_DESC">Größte Ersparnis zuerst</option>
          </optgroup>
        </select>
        <input id="btn-submit" type="submit" value="Suchen">
        <input id="btn-cancel" type="button" value="Abbrechen">
        <input id="btn-named" type="submit" name="op" value="Behalten">
      </form>
      <button id="IFeedbackButton" type="button" aria-label="Feedback / Meldung" data-after="Feedback / Meldung" data-testid="Untouched id"><span></span></button>
      <button id="tip-btn" type="button" data-tooltip="Filter öffnen" aria-placeholder="Begriff">OK</button>
      <details id="more"><summary>Mehr</summary><p id="details-body">Versteckter Text</p></details>
    </body></html>`), { waitUntil: 'load' });

    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();

    await expect(page.locator('#sort-box-select option[value="RELEVANCE_DESC"]')).toHaveText('«Beliebteste zuerst»');
    await expect(page.locator('#sort-box-select option[value="DISCOUNT_DESC"]')).toHaveText('«Größte Ersparnis zuerst»');
    await expect(page.locator('#sort-box-select optgroup')).toHaveAttribute('label', '«Sortierung»');
    await expect(page.locator('#sort-box-select')).toHaveAttribute('aria-label', '«Sortieren nach:»');
    expect(await page.evaluate(() => new FormData(document.querySelector<HTMLFormElement>('#controls')!).get('sort'))).toBe('RELEVANCE_DESC');

    await expect(page.locator('#IFeedbackButton')).toHaveAttribute('aria-label', '«Feedback / Meldung»');
    await expect(page.locator('#IFeedbackButton')).toHaveAttribute('data-after', '«Feedback / Meldung»');
    await expect(page.locator('#IFeedbackButton')).toHaveAttribute('data-testid', 'Untouched id');

    await expect(page.locator('#btn-submit')).toHaveAttribute('value', '«Suchen»');
    await expect(page.locator('#btn-cancel')).toHaveAttribute('value', '«Abbrechen»');
    await expect(page.locator('#btn-named')).toHaveAttribute('value', 'Behalten');
    await expect(page.locator('#tip-btn')).toHaveAttribute('data-tooltip', '«Filter öffnen»');
    await expect(page.locator('#tip-btn')).toHaveAttribute('aria-placeholder', '«Begriff»');
    await expect(page.locator('#more summary')).toHaveText('«Mehr»');
    await expect(page.locator('#details-body')).toHaveText('Versteckter Text');

    await page.locator('#more').evaluate(node => node.setAttribute('open', ''));
    await expect(page.locator('#details-body')).toHaveText('«Versteckter Text»');

    await popup.click();
    await expect(page.locator('#sort-box-select option[value="RELEVANCE_DESC"]')).toHaveText('Beliebteste zuerst');
    await expect(page.locator('#IFeedbackButton')).toHaveAttribute('aria-label', 'Feedback / Meldung');
    await expect(page.locator('#IFeedbackButton')).toHaveAttribute('data-after', 'Feedback / Meldung');
    await expect(page.locator('#btn-submit')).toHaveAttribute('value', 'Suchen');
  }, ['de:en']);
});

test('applies dir="auto" for RTL targets and restores original dir on Show original', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="en"><body>
      <p id="plain">Hello world</p>
      <p id="explicit" dir="ltr">Explicit left to right</p>
    </body></html>`));
    const popup = await openPopup();
    await expect.poll(popup.status).toBe('Choose a different language in To.');
    await popup.choose('target', 'ar');
    await installFake(popup);
    await popup.click();

    await expect(page.locator('#plain')).toHaveText('«Hello world»');
    await expect(page.locator('#plain')).toHaveAttribute('dir', 'auto');
    await expect(page.locator('#explicit')).toHaveText('«Explicit left to right»');
    await expect(page.locator('#explicit')).toHaveAttribute('dir', 'auto');

    await popup.click();
    await expect(page.locator('#plain')).toHaveText('Hello world');
    await expect(page.locator('#plain')).not.toHaveAttribute('dir', 'auto');
    await expect(page.locator('#explicit')).toHaveText('Explicit left to right');
    await expect(page.locator('#explicit')).toHaveAttribute('dir', 'ltr');
  }, ['en:ar']);
});

test('supports swapping languages in popup, updates tab badge, and pushes status updates', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><body><h1>Bonjour</h1></body></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);

    // Swap French -> English into English -> French.
    await expect.poll(() => popup.evaluate('document.querySelector("#swap").disabled')).toBe(false);
    await popup.evaluate('document.querySelector("#swap").click()');
    expect(await popup.evaluate('document.querySelector("#source").value')).toBe('en');
    expect(await popup.evaluate('document.querySelector("#target").value')).toBe('fr');

    // Swap back to French -> English and translate.
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

test('translates inline HTML sentences as whole units, preserves live DOM & handlers, handles reordering, and restores losslessly', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="de"><body>
      <p id="inline">Lesen Sie die <a id="guide" href="#guide">offizielle <em>Anleitung</em></a> und nutzen Sie <code id="cmd">npm test</code>.</p>
      <div id="price">ab <strong>59,00 €</strong></div>
      <div id="flex-cards" style="display:flex; flex-direction:column">
        <span>Erste Karte</span><span>Zweite Karte</span>
      </div>
      <script>
        const link = document.getElementById('guide');
        window.__origLink = link;
        link.onclick = (e) => { e.preventDefault(); link.dataset.clicks = String(Number(link.dataset.clicks || 0) + 1); };
      </script>
    </body></html>`));

    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();

    await expect(page.locator('#inline')).toHaveText('«Lesen Sie die» «offizielle» «Anleitung» «und nutzen Sie» npm test.');
    await expect(page.locator('#cmd')).toHaveText('npm test');
    await expect(page.locator('#price')).toHaveText('«ab» 59,00 €');
    await expect(page.locator('#flex-cards span').first()).toHaveText('«Erste Karte»');
    await expect(page.locator('#flex-cards span').last()).toHaveText('«Zweite Karte»');

    // Verify whole sentence sent in one HTML translation call and flex spans were NOT bundled as one sentence.
    const html = await htmlCalls(popup);
    expect(html.some(s => s.includes('<span id="0">') && s.includes('<code id="2" translate="no">npm test</code>'))).toBe(true);
    expect(html.some(s => s.includes('Erste Karte') && s.includes('Zweite Karte'))).toBe(false);

    // Close popup before clicking the page (page focus dismisses toolbar popups on Linux).
    await popup.close();

    // Live element identity and click handler stay intact.
    expect(await page.evaluate(() => document.getElementById('guide') === (window as unknown as { __origLink: Element }).__origLink)).toBe(true);
    await page.locator('#guide').click();
    await expect(page.locator('#guide')).toHaveAttribute('data-clicks', '1');

    // Reopen popup and restore exact original DOM & text.
    const reopened = await openPopup();
    await expect.poll(reopened.status).toMatch(/^Translated to English/);
    await reopened.click();
    await expect(page.locator('#inline')).toHaveText('Lesen Sie die offizielle Anleitung und nutzen Sie npm test.');
    await expect(page.locator('#price')).toHaveText('ab 59,00 €');

    // Now test reordered inline tags returned by NMT.
    await prepare(reopened);
    await installFake(reopened, { htmlMode: 'reorder' });
    await reopened.click();
    await expect(page.locator('#inline')).toHaveText('npm test :: «offizielle» «Anleitung»');
    expect(await page.evaluate(() => document.getElementById('guide') === (window as unknown as { __origLink: Element }).__origLink)).toBe(true);
    await expect.poll(reopened.status).toMatch(/^Translated to English/);
    await reopened.click();
    await expect(page.locator('#inline')).toHaveText('Lesen Sie die offizielle Anleitung und nutzen Sie npm test.');
  }, ['de:en']);
});

test('falls back safely to plain text translation when inline HTML output drops a tag', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="de"><body>
      <p id="sentence">Bitte <a id="link" href="/next">hier klicken</a> zum Starten.</p>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { htmlMode: 'drop-tag' });
    await popup.click();

    await expect(page.locator('#link')).toBeVisible();
    await expect(page.locator('#link')).toHaveAttribute('href', '/next');
    await expect(page.locator('#link')).toHaveText('«hier klicken»');
    await expect(page.locator('#sentence')).toHaveText('«Bitte» «hier klicken» «zum Starten.»');

    await popup.click();
    await expect(page.locator('#sentence')).toHaveText('Bitte hier klicken zum Starten.');
  }, ['de:en']);
});

test('translates same-origin shadow-nested iframes while surfacing a muted notice for visible third-party iframes', async () => {
  const widgetServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="de"><body><p>Drittanbieter</p></body></html>');
  });
  await new Promise<void>(resolve => widgetServer.listen(0, '127.0.0.1', resolve));
  const address = widgetServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  const crossOriginBase = `http://127.0.0.1:${address.port}`;

  try {
    await withFakePacks(async ({ page, serve, openPopup }) => {
      await page.goto(serve('/', `<!doctype html><html lang="de"><body>
        <h1>Willkommen</h1>
        <iframe id="hidden-auth" src="${crossOriginBase}/auth" style="width:0;height:0;border:0"></iframe>
        <div id="shadow-host"></div>
        <script>
          const outer = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
          const sameFrame = document.createElement('iframe');
          sameFrame.id = 'same-frame';
          sameFrame.style.cssText = 'width:400px;height:200px;border:0';
          sameFrame.srcdoc = '<!doctype html><html><body><div id="inner-host"></div></body></html>';
          sameFrame.addEventListener('load', () => {
            const doc = sameFrame.contentDocument;
            const inner = doc.getElementById('inner-host').attachShadow({ mode: 'open' });
            inner.innerHTML = '<h2 id="greeting">Hallo!</h2>';
          });
          outer.appendChild(sameFrame);

          let widget;
          window.openCrossOriginWidget = () => {
            widget = document.createElement('iframe');
            widget.id = 'widget-frame';
            widget.style.cssText = 'width:320px;height:240px;border:0';
            widget.src = ${JSON.stringify(crossOriginBase + '/widget')};
            outer.appendChild(widget);
          };
          window.closeCrossOriginWidget = () => {
            widget?.remove();
            widget = undefined;
          };
        </script>
      </body></html>`));

      const popup = await openPopup();
      await prepare(popup);
      await installFake(popup);
      await popup.click();

      await expect(page.locator('h1')).toHaveText('«Willkommen»');
      await expect.poll(() => page.evaluate(() => {
        const frame = document.getElementById('shadow-host')?.shadowRoot?.getElementById('same-frame') as HTMLIFrameElement | null;
        return frame?.contentDocument?.getElementById('inner-host')?.shadowRoot?.getElementById('greeting')?.textContent ?? '';
      })).toBe('«Hallo!»');

      const readinessState = () => popup.evaluate<{ hidden: boolean; text: string; tone: string }>(
        '(() => { const el = document.querySelector("#readiness"); return { hidden: el.hidden, text: el.textContent || "", tone: el.dataset.tone || "" }; })()',
      );
      await expect.poll(popup.status).toMatch(/^Translated to English/);
      await expect.poll(() => readinessState().then(r => r.hidden)).toBe(true);

      await page.evaluate(() => (window as unknown as { openCrossOriginWidget(): void }).openCrossOriginWidget());
      await expect.poll(readinessState).toEqual({
        hidden: false,
        text: '1 third-party frame skipped (this site only)',
        tone: 'muted',
      });
      await expect.poll(popup.status).toMatch(/^Translated to English/);

      await page.evaluate(() => (window as unknown as { closeCrossOriginWidget(): void }).closeCrossOriginWidget());
      await expect.poll(() => readinessState().then(r => r.hidden)).toBe(true);

      await popup.click();
      await expect(page.locator('h1')).toHaveText('Willkommen');
      await expect.poll(() => page.evaluate(() => {
        const frame = document.getElementById('shadow-host')?.shadowRoot?.getElementById('same-frame') as HTMLIFrameElement | null;
        return frame?.contentDocument?.getElementById('inner-host')?.shadowRoot?.getElementById('greeting')?.textContent ?? '';
      })).toBe('Hallo!');
    }, ['de:en']);
  } finally {
    await new Promise<void>(resolve => widgetServer.close(() => resolve()));
  }
});
