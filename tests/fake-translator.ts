import { expect } from '@playwright/test';
import { catalog, packKey } from '../src/shared/catalog';
import { withExtension } from './browser';
import type { ExtensionBrowser, Popup } from './browser';

export async function withFakePacks(run: (browser: ExtensionBrowser) => Promise<void>,
  pairs = ['fr:en', 'es:en'],
): Promise<void> {
  await withExtension(async browser => {
    const fixture = await browser.openExtensionPage('MPL-2.0.txt');
    const keys = pairs.map(pair => packKey(catalog.get(pair)!));
    await fixture.evaluate(keys => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('translation-models', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('packs'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('packs', 'readwrite');
        const store = transaction.objectStore('packs');
        // These keys make the popup offer Translate. The page worker is mocked below.
        for (const key of keys) store.put(null, key);
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    }), keys);
    await fixture.close();
    await browser.page.bringToFront();
    await run(browser);
  });
}

interface FakeOptions {
  delay?: number;
  firstSetup?: 'engine-unavailable' | 'missing-packs';
  busy?: Record<string, number>;
  disconnectOnce?: string;
}

export async function installFake(
  popup: Popup,
  { delay = 0, firstSetup, busy = {}, disconnectOnce }: FakeOptions = {},
): Promise<void> {
  await popup.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [${delay}, ${JSON.stringify(firstSetup ?? null)}, ${JSON.stringify(busy)}, ${JSON.stringify(disconnectOnce ?? null)}],
      func: (delay, firstSetup, busy, disconnectOnce) => {
        globalThis.translationCalls = [];
        globalThis.engineOpens = 0;
        let attempts = 0;
        let disconnected = false;
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        const translateOne = (text) => {
          globalThis.translationCalls.push(text);
          if (busy[text] > 0) {
            busy[text]--;
            return { ok: false, error: 'busy' };
          }
          return text === 'FAIL'
            ? { ok: false, error: 'engine-unavailable' }
            : { ok: true, value: '«' + text + '»' };
        };
        chrome.runtime.sendMessage = async message => {
          if (message.type === 'engine-open') {
            globalThis.engineOpens++;
            return { ok: true };
          }
          if (message.type === 'engine-prepare') {
            attempts++;
            return attempts === 1 && firstSetup ? { ok: false, error: firstSetup } : { ok: true };
          }
          if (message.type === 'engine-translate') {
            if (disconnectOnce && !disconnected && message.text === disconnectOnce) {
              disconnected = true;
              return undefined;
            }
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            return translateOne(message.text);
          }
          if (message.type === 'engine-translate-batch') {
            if (disconnectOnce && !disconnected && message.texts.includes(disconnectOnce)) {
              disconnected = true;
              return undefined;
            }
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            return { ok: true, value: message.texts.map(translateOne) };
          }
          return send(message);
        };
      },
    });
  })()`);
}

export async function translationCalls(popup: Popup): Promise<string[]> {
  return await popup.evaluate<string[]>(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.translationCalls,
    });
    return injection.result;
  })()`);
}

export async function prepare(popup: Popup): Promise<void> {
  await expect.poll(popup.status).toBe('Page is in its original language.');
  await popup.choose('target', 'en');
}
