import { expect, test } from '@playwright/test';
import { installFake, prepare, withFakePacks } from './fake-translator';

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
