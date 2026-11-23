import { expect, test } from '@playwright/test';
import { withExtension } from './browser';
import { installFake, prepare, translationCalls, withFakePacks } from './fake-translator';

test('translates the page in place, observes new text and restores the latest originals', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    serve('/frame', '<p id="nested">Cadre incorporé</p>');
    serve('/next-frame', '<p id="nested">Autre document</p>');
    serve('/editor', '<p>Texte éditable</p><script>document.designMode = "on";</script>');
    await page.goto(serve('/', `<!doctype html><html lang="fr"><head><title>Le journal</title></head>
      <body>
        <h1>Le petit journal</h1>
        <p id="paragraph">Bonjour <strong>tout le monde</strong> !</p>
        <button id="button" aria-label="Ajouter au panier">Ajouter</button>
        <input id="query" placeholder="Chercher" value="Texte saisi">
        <textarea id="notes" placeholder="Écrire ici">Texte du brouillon</textarea>
        <select id="valued"><option selected value="fr">Français</option></select>
        <select id="valueless"><option selected>Français natif</option></select>
        <p translate="no">Laisser intact</p>
        <p contenteditable>Mon brouillon</p>
        <code>document.querySelector</code>
        <p><a href="https://example.test/">https://example.test/</a></p>
        <div id="widget"></div><iframe id="article" src="/frame"></iframe><iframe id="editor" src="/editor"></iframe>
        <script>
          const originalButton = document.querySelector('#button');
          originalButton.onclick = () => originalButton.dataset.clicked = 'yes';
          document.querySelector('#widget').attachShadow({mode:'open'}).innerHTML = '<p>Dans le widget</p>';
        </script>
      </body></html>`));

    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await expect(page).toHaveTitle('Le journal');
    await expect(page.locator('h1')).toHaveText('«Le petit journal»');
    await expect(page.locator('#paragraph strong')).toHaveText('«tout le monde»');
    await expect(page.locator('#paragraph')).toHaveText('«Bonjour» «tout le monde» !');
    await expect(page.locator('#button')).toHaveAttribute('aria-label', '«Ajouter au panier»');
    await expect(page.locator('#query')).toHaveAttribute('placeholder', '«Chercher»');
    await expect(page.locator('#query')).toHaveValue('Texte saisi');
    await expect(page.locator('#notes')).toHaveAttribute('placeholder', '«Écrire ici»');
    await expect(page.locator('#notes')).toHaveValue('Texte du brouillon');
    await expect(page.locator('#valued option')).toHaveText('«Français»');
    await expect(page.locator('#valued')).toHaveValue('fr');
    await expect(page.locator('#valueless option')).toHaveText('Français natif');
    await expect(page.locator('[translate=no]')).toHaveText('Laisser intact');
    await expect(page.locator('[contenteditable]')).toHaveText('Mon brouillon');
    await expect(page.locator('code')).toHaveText('document.querySelector');
    await expect(page.locator('a')).toHaveText('https://example.test/');
    await expect(page.locator('#widget p')).toHaveText('«Dans le widget»');
    await expect(page.frameLocator('#article').locator('#nested')).toHaveText('«Cadre incorporé»');

    await expect(page.frameLocator('#editor').locator('p')).toHaveText('Texte éditable');
    await page.locator('#article').evaluate(frame => frame.setAttribute('src', '/next-frame'));
    await expect(page.frameLocator('#article').locator('#nested')).toHaveText('«Autre document»');

    await page.locator('#button').dispatchEvent('click');
    await expect(page.locator('#button')).toHaveAttribute('data-clicked', 'yes');
    await popup.close();
    await page.evaluate(() => {
      document.querySelector('h1')!.firstChild!.nodeValue = 'Dernière édition';
      document.querySelector('#button')!.setAttribute('aria-label', 'Voir le panier');
      document.querySelector('h1')!.insertAdjacentHTML('afterend', '<p id="live">Nouvelles locales</p>');
    });
    await expect(page.locator('h1')).toHaveText('«Dernière édition»');
    await expect(page.locator('#button')).toHaveAttribute('aria-label', '«Voir le panier»');
    await expect(page.locator('#live')).toHaveText('«Nouvelles locales»');

    await page.locator('#widget').evaluate(node => node.setAttribute('translate', 'no'));
    await expect(page.locator('#widget p')).toHaveText('Dans le widget');
    await page.locator('#widget').evaluate(node => node.removeAttribute('translate'));
    await expect(page.locator('#widget p')).toHaveText('«Dans le widget»');

    const detached = await page.locator('#live').elementHandle();
    await detached.evaluate(node => node.remove());
    await expect.poll(() => detached.textContent()).toBe('Nouvelles locales');

    const reopened = await openPopup();
    await expect.poll(reopened.status).toMatch(/^Translated to English/);
    await reopened.click();
    await expect.poll(reopened.status).toBe('Page is in its original language.');
    await expect(page.locator('h1')).toHaveText('Dernière édition');
    await expect(page.locator('#button')).toHaveAttribute('aria-label', 'Voir le panier');
    await detached.evaluate(node => document.body.append(node));
    await expect(page.locator('#live')).toHaveText('Nouvelles locales');
    await expect(page.locator('#valued option')).toHaveText('Français');
    await expect(page.locator('#valueless option')).toHaveText('Français natif');
    await expect(page.frameLocator('#article').locator('#nested')).toHaveText('Autre document');
    await expect(page).toHaveTitle('Le journal');
  });
});

test('cancels in-flight requests and never overwrites a newer page edit', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><body><h1>Premier</h1><p>Deuxième</p></body>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { delay: 350 });
    await popup.click();
    await expect.poll(() => translationCalls(popup)).toContain('Premier');
    await page.locator('h1').evaluate(node => { node.firstChild!.nodeValue = 'Révisé'; });
    await popup.click();
    await expect.poll(popup.status).toBe('Page is in its original language.');
    await expect(page.locator('h1')).toHaveText('Révisé');
    await expect(page.locator('p')).toHaveText('Deuxième');

    await popup.click();
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await expect(page.locator('h1')).toHaveText('«Révisé»');
    await expect(page.locator('p')).toHaveText('«Deuxième»');
  });
});

test('re-detects an undeclared language after reopening and restoring', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="fr"><body><p>Une phrase en français.</p></body>'));
    const first = await openPopup();
    await prepare(first);
    await installFake(first);
    await first.click();
    await expect.poll(first.status).toMatch(/^Translated/);
    await first.close();

    await page.evaluate(() => document.documentElement.removeAttribute('lang'));
    const reopened = await openPopup();
    await expect.poll(reopened.status).toMatch(/^Translated/);
    await reopened.evaluate(`chrome.tabs.detectLanguage = () => new Promise(
      resolve => setTimeout(() => resolve('fr'), 300))`);
    await reopened.click();
    await expect.poll(reopened.status).toBe('Page is in its original language.');
    await expect.poll(() => reopened.evaluate('document.querySelector("#source").options[0].text'))
      .toBe('Auto · French');
    await reopened.click();
    await expect.poll(reopened.status).toMatch(/^Translated/);
  });
});

test('reuses translations on a large page and continues after a failed request', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    const rows = Array.from({ length: 3_000 }, (_, index) => '<p>' +
      (index % 2 ? 'Réserver maintenant' : 'Lire la suite') + '</p>').join('');
    await page.goto(serve('/', '<html lang="fr"><main><p>FAIL</p>' + rows + '</main></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect.poll(popup.status, { timeout: 15_000 }).toContain('Some text couldn’t be translated.');
    const last = page.locator('main p').last();
    await expect(last).toHaveText('Réserver maintenant');
    await last.evaluate(node => node.scrollIntoView());
    await expect(last).toHaveText('«Réserver maintenant»');
    const calls = await translationCalls(popup);
    expect(calls.sort()).toEqual(['FAIL', 'Lire la suite', 'Réserver maintenant']);
    await popup.click();
    await expect.poll(popup.status).toBe('Page is in its original language.');
    await expect(page.locator('main p').last()).toHaveText('Réserver maintenant');
  });
});

test('shows an actionable status for restricted pages', async () => {
  await withExtension(async ({ page, openPopup }) => {
    await page.goto('chrome://version/');
    const popup = await openPopup();
    await expect.poll(popup.status).toContain('Chrome restricts translation');
    expect(await popup.evaluate('document.querySelector("#action").disabled')).toBe(true);
  });
});

test('can retry when local model initialization fails', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', '<html lang="es"><h1>Buenos días!</h1></html>'));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { firstSetup: 'engine-unavailable' });
    await popup.click();
    await expect.poll(popup.status).toContain('The local translator couldn’t start');
    await popup.click();
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await expect(page.locator('h1')).toHaveText('«Buenos días!»');
  });
});

test('only translates text that enters the viewport, including inside nested scrollers', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    serve('/hidden-frame', '<p>Texte dans le cadre</p>');
    await page.goto(serve('/', `<!doctype html><html lang="fr"><body>
      <h1>Premier titre</h1>
      <div id="scroller" style="height:90px; overflow:auto">
        <p>Première ligne</p><div style="height:280px"></div>
        Texte au fond du panneau
      </div>
      <p id="hidden" style="visibility:hidden">Texte masqué</p>
      <div style="height:2400px"></div>
      <p id="skipped">Section sautée</p>
      <div style="height:2400px"></div>
      <p id="bottom">Dernière ligne</p>
      <div style="height:1400px"></div>
      <iframe src="/hidden-frame"></iframe>
    </body></html>`));
    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup);
    await popup.click();
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await expect(page.locator('h1')).toHaveText('«Premier titre»');
    await expect(page.locator('#bottom')).toHaveText('Dernière ligne');
    expect((await translationCalls(popup)).sort()).toEqual(['Premier titre', 'Première ligne'].sort());
    await expect(page.frameLocator('iframe').locator('p')).toHaveText('Texte dans le cadre');

    await page.locator('#scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#scroller')).toContainText('«Texte au fond du panneau»');
    await page.locator('#hidden').evaluate(node => { node.style.visibility = 'visible'; });
    await expect(page.locator('#hidden')).toHaveText('«Texte masqué»');
    await page.locator('#bottom').evaluate(node => node.scrollIntoView());
    await expect(page.locator('#bottom')).toHaveText('«Dernière ligne»');
    await page.locator('iframe').evaluate(node => node.scrollIntoView());
    await expect(page.frameLocator('iframe').locator('p')).toHaveText('«Texte dans le cadre»');
    await expect(page.locator('#skipped')).toHaveText('Section sautée');
    await expect(page.locator('h1')).toHaveText('«Premier titre»');
    expect(await translationCalls(popup)).not.toContain('Section sautée');

    await page.locator('h1').evaluate(node => { node.textContent = 'Titre révisé'; });
    await expect(page.locator('h1')).toHaveText('Titre révisé');
    expect(await translationCalls(popup)).not.toContain('Titre révisé');
    await page.locator('h1').evaluate(node => node.scrollIntoView());
    await expect(page.locator('h1')).toHaveText('«Titre révisé»');

    await popup.click();
    await expect(page.locator('h1')).toHaveText('Titre révisé');
    await expect(page.locator('#bottom')).toHaveText('Dernière ligne');
  });
});
