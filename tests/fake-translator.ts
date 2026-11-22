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
  slow?: { minLength: number; delay: number };
  firstSetup?: 'engine-unavailable' | 'missing-packs';
  busy?: Record<string, number>;
  disconnectOnce?: string;
  htmlMode?: 'wrap' | 'reorder' | 'drop-tag';
}

export async function installFake(
  popup: Popup,
  { delay = 0, slow, firstSetup, busy = {}, disconnectOnce, htmlMode = 'wrap' }: FakeOptions = {},
): Promise<void> {
  await popup.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [
        ${delay},
        ${JSON.stringify(slow ?? null)},
        ${JSON.stringify(firstSetup ?? null)},
        ${JSON.stringify(busy)},
        ${JSON.stringify(disconnectOnce ?? null)},
        ${JSON.stringify(htmlMode)},
      ],
      func: (delay, slow, firstSetup, busy, disconnectOnce, htmlMode) => {
        globalThis.translationCalls = [];
        globalThis.htmlCalls = [];
        globalThis.engineOpens = 0;
        let attempts = 0;
        let disconnected = false;
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);

        const wrapText = (text) => {
          if (!/\\p{L}/u.test(text)) return text;
          const lead = text.length - text.trimStart().length;
          const trail = text.length - text.trimEnd().length;
          return text.slice(0, lead) + '«' + text.trim() + '»' + text.slice(text.length - trail);
        };

        const translateHtml = (html) => {
          globalThis.htmlCalls.push(html);
          let out = '';
          let inCode = 0;
          const parts = html.split(/(<[^>]+>)/gu);
          for (const part of parts) {
            if (!part) continue;
            if (part.startsWith('<')) {
              if (/^<code\\b/iu.test(part)) inCode++;
              else if (/^<\\/code\\b/iu.test(part)) inCode = Math.max(0, inCode - 1);
              out += part;
            } else {
              out += inCode > 0 ? part : wrapText(part);
            }
          }
          if (htmlMode === 'drop-tag') {
            return out.replace(/<span\\b[^>]*id="0"[^>]*>/iu, '').replace('</span>', '');
          }
          if (htmlMode === 'reorder') {
            const slots = out.match(/<(span|code)\\b[^>]*>.*?<\\/\\1>/gu);
            if (slots && slots.length >= 2) {
              return slots[1] + ' :: ' + slots[0];
            }
          }
          return out;
        };

        const translateOne = (text, html) => {
          globalThis.translationCalls.push(text);
          if (busy[text] > 0) {
            busy[text]--;
            return { ok: false, error: 'busy' };
          }
          if (text === 'FAIL') return { ok: false, error: 'engine-unavailable' };
          return { ok: true, value: html ? translateHtml(text) : '«' + text + '»' };
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
            const extra = slow && message.text.length >= slow.minLength ? slow.delay : 0;
            const wait = delay + extra;
            if (wait) await new Promise(resolve => setTimeout(resolve, wait));
            return translateOne(message.text, Boolean(message.html));
          }
          if (message.type === 'engine-translate-batch') {
            const items = Array.isArray(message.items)
              ? message.items
              : (message.texts || []).map(text => ({ text, html: false }));
            if (disconnectOnce && !disconnected && items.some(item => item.text === disconnectOnce)) {
              disconnected = true;
              return undefined;
            }
            const extra = slow && items.some(item => item.text.length >= slow.minLength) ? slow.delay : 0;
            const wait = delay + extra;
            if (wait) await new Promise(resolve => setTimeout(resolve, wait));
            return { ok: true, value: items.map(item => translateOne(item.text, Boolean(item.html))) };
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

export async function htmlCalls(popup: Popup): Promise<string[]> {
  return await popup.evaluate<string[]>(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.htmlCalls,
    });
    return injection.result;
  })()`);
}

export async function prepare(popup: Popup): Promise<void> {
  await expect.poll(popup.status).toBe('Page is in its original language.');
  await popup.choose('target', 'en');
}
