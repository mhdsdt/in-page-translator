import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const icons = new URL('../static/icons/', import.meta.url);
const svg = await readFile(new URL('mark.svg', icons), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: new URL(`${size}.png`, icons).pathname, omitBackground: true });
  }
} finally {
  await browser.close();
}
