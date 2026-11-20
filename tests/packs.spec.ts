import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { withExtension } from './browser';

test('installs verified Mozilla packs directly in popup, reuses them offline, pivots, and removes a pack', async () => {
  test.setTimeout(180_000);
  await withExtension(async ({ page, serve, openPopup }) => {
    await page.goto(serve('/', `<!doctype html><html lang="de"><body>
      <h1>Guten Morgen!</h1><p>Wo ist der Bahnhof?</p>
      <div style="height:1600px"></div><p id="unseen">Vielen Dank!</p>
    </body></html>`));

    // Download directly from the popup and verify automatic translation on completion.
    const original = await openPopup();
    await expect.poll(original.status).toBe('Download language pack to translate this page.');
    await original.choose('source', 'de');
    expect(await original.evaluate('document.querySelector("#action").textContent')).toContain('Download & translate');
    await original.click();
    await expect.poll(original.status, { timeout: 60_000, intervals: [250, 500, 1_000] })
      .toMatch(/^Translated to English/);
    await expect(page.locator('h1')).toHaveText(/good morning/i);
    await expect(page.locator('p').first()).toHaveText(/where(?: is|'s) the (train |railway )?station/i);
    await expect(page.locator('#unseen')).toHaveText('Vielen Dank!');
    await page.locator('#unseen').evaluate(node => node.scrollIntoView());
    await expect(page.locator('#unseen')).toHaveText(/thank you/i);
    await original.click();
    await expect(page.locator('h1')).toHaveText('Guten Morgen!');

    // Open the language pack manager via the header button and verify offline reload from disk.
    const managerPage = page.context().waitForEvent('page');
    await original.evaluate('document.querySelector("#language-packs").click()');
    const manager = await managerPage;
    await expect(manager).toHaveTitle(/Language packs/);
    await expect(manager.getByRole('button', { name: 'Remove German → English' })).toBeVisible();

    // Closing the inference context proves the pack is read back from disk offline.
    await manager.evaluate(() => chrome.offscreen.closeDocument());
    await page.context().setOffline(true);
    await manager.getByRole('button', { name: 'Back to page' }).click();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
    await page.evaluate(() => window.scrollTo(0, 0));
    const popup = await openPopup();
    await expect.poll(popup.status).toBe('Page is in its original language.');
    const start = performance.now();
    await popup.click();
    await page.waitForFunction(() => /good morning/i.test(document.querySelector('h1')?.textContent ?? ''),
      undefined, { timeout: 2_500 });
    console.log('First German heading from installed pack in ' + Math.round(performance.now() - start) + ' ms.');
    await expect.poll(popup.status).toMatch(/^Translated to English/);
    await popup.click();
    await expect(page.locator('h1')).toHaveText('Guten Morgen!');
    await popup.close();
    await page.context().setOffline(false);

    // Install pivot second pack via the manager and translate German -> French via English.
    await manager.bringToFront();
    await manager.locator('#from').selectOption('de');
    await manager.locator('#to').selectOption('fr');
    await expect(manager.locator('#route-summary')).toContainText('through English');
    await expect(manager.locator('#route li[data-installed=true]')).toContainText('German → English');
    await expect(manager.locator('#route li[data-installed=false]')).toContainText('English → French');
    await expect(manager.locator('#requirements')).toContainText('1 pack to download');
    await installSelected(manager);
    await expect(manager.getByRole('button', { name: 'Remove English → French' })).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.bringToFront();
    const french = await openPopup();
    await expect.poll(french.status).toBe('Page is in its original language.');
    await french.choose('target', 'fr');
    expect(await french.evaluate('document.getElementById("target").value')).toBe('fr');
    await french.click();
    await expect(page.locator('h1')).toHaveText(/bonjour/i);
    await expect.poll(french.status).toMatch(/^Translated to French/);
    await french.click();
    await expect(page.locator('h1')).toHaveText('Guten Morgen!');
    await french.close();

    // Remove pack and confirm popup offers Download & translate again.
    await manager.bringToFront();
    await manager.getByRole('button', { name: 'Remove German → English' }).click();
    await expect(manager.locator('#requirements')).toContainText('1 pack to download');
    await expect(manager.locator('#route li[data-installed=false]')).toContainText('German → English');
    await expect(manager.getByRole('button', { name: 'Remove German → English' })).toHaveCount(0);
    await manager.close();

    await page.bringToFront();
    const afterRemoval = await openPopup();
    await expect.poll(afterRemoval.status).toBe('Download language pack to translate this page.');
  }, process.env.PACKS_BROWSER_BIN, ['--disable-component-update']);
});

async function installSelected(manager: Page): Promise<void> {
  await manager.getByRole('button', { name: 'Download packs' }).click();
  await expect.poll(async () => {
    const failure = await manager.locator('#message').textContent();
    return failure || await manager.locator('#requirements').textContent();
  }, { timeout: 55_000, intervals: [250, 500, 1_000] }).toMatch(/^Ready offline|^Couldn’t/);
  expect(await manager.locator('#message').textContent()).toBe('');
  await expect(manager.locator('#requirements')).toContainText('Ready offline');
}
