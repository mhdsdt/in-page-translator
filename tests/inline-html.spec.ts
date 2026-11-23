import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { htmlCalls, installFake, prepare, withFakePacks } from './fake-translator';

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

    const html = await htmlCalls(popup);
    expect(html.some(s => s.includes('<span id="0">') && s.includes('<code id="2" translate="no">npm test</code>'))).toBe(true);
    expect(html.some(s => s.includes('Erste Karte') && s.includes('Zweite Karte'))).toBe(false);

    await popup.close();

    expect(await page.evaluate(() => document.getElementById('guide') === (window as unknown as { __origLink: Element }).__origLink)).toBe(true);
    await page.locator('#guide').click();
    await expect(page.locator('#guide')).toHaveAttribute('data-clicks', '1');

    const reopened = await openPopup();
    await expect.poll(reopened.status).toMatch(/^Translated to English/);
    await reopened.click();
    await expect(page.locator('#inline')).toHaveText('Lesen Sie die offizielle Anleitung und nutzen Sie npm test.');
    await expect(page.locator('#price')).toHaveText('ab 59,00 €');

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

test('streams short visible labels before slow long paragraphs settle and restores cleanly mid-flight', async () => {
  const longSentences = Array.from({ length: 8 }, (_, index) =>
    `<p class="slow-copy">Dies ist ein ausführlicher deutscher Beispielsatz Nummer ${index + 1} mit genügend Text für einen separaten Batch.</p>`,
  ).join('');
  await withFakePacks(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="de"><body>
      <h1 id="heading">Kurz</h1>
      <button id="cta">Kaufen</button>
      ${longSentences}
    </body></html>`));

    const popup = await openPopup();
    await prepare(popup);
    await installFake(popup, { slow: { minLength: 80, delay: 900 } });
    await popup.click();

    await expect(page.locator('#heading')).toHaveText('«Kurz»');
    await expect(page.locator('#cta')).toHaveText('«Kaufen»');
    await expect(page.locator('.slow-copy').first()).toContainText('Dies ist ein ausführlicher deutscher Beispielsatz');
    await expect.poll(popup.status).toMatch(/^Translating/);

    await popup.click();
    await expect(page.locator('#heading')).toHaveText('Kurz');
    await expect(page.locator('#cta')).toHaveText('Kaufen');
    await page.waitForTimeout(1_000);
    await expect(page.locator('.slow-copy').first()).toContainText('Dies ist ein ausführlicher deutscher Beispielsatz');
  }, ['de:en']);
});
