import { expect, test } from '@playwright/test';
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

test('applies dir="auto" for RTL targets, ref-counts shared containers, and restores original dir on Show original', async () => {
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="en"><body>
      <p id="plain">Hello world</p>
      <p id="explicit" dir="ltr">Explicit left to right</p>
      <div id="shared" dir="ltr"><span id="part-a">First part</span> <span id="part-b">Second part</span></div>
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
    await expect(page.locator('#part-a')).toHaveText('«First part»');
    await expect(page.locator('#part-b')).toHaveText('«Second part»');
    await expect(page.locator('#shared')).toHaveAttribute('dir', 'auto');

    await page.locator('#part-a').evaluate(node => node.setAttribute('translate', 'no'));
    await expect(page.locator('#part-a')).toHaveText('First part');
    await expect(page.locator('#part-b')).toHaveText('«Second part»');
    await expect(page.locator('#shared')).toHaveAttribute('dir', 'auto');

    await page.locator('#part-b').evaluate(node => node.setAttribute('translate', 'no'));
    await expect(page.locator('#part-b')).toHaveText('Second part');
    await expect(page.locator('#shared')).toHaveAttribute('dir', 'ltr');

    await popup.click();
    await expect(page.locator('#plain')).toHaveText('Hello world');
    await expect(page.locator('#plain')).not.toHaveAttribute('dir', 'auto');
    await expect(page.locator('#explicit')).toHaveText('Explicit left to right');
    await expect(page.locator('#explicit')).toHaveAttribute('dir', 'ltr');
  }, ['en:ar']);
});
