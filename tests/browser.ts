import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

interface Target { targetId: string; url: string }
interface Response { id?: number; result?: unknown; error?: { message: string } }

export async function withExtension(
  run: (browser: ExtensionBrowser) => Promise<void>,
  executablePath = chromium.executablePath(),
  args: string[] = [],
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'in-page-tests-'));
  const pages = new Map<string, string>();
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(pages.get(request.url ?? '') ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bind = server.address();
  if (!bind || typeof bind === 'string') throw new Error('Fixture server did not start');

  // The browser-level protocol can install the real unpacked build and invoke its toolbar
  // action with activeTab, without adding test permissions to the manifest.
  const process = spawn(executablePath, [
    '--headless', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--user-data-dir=' + profile, ...args, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exited = once(process, 'exit').then(() => {});
  void exited.catch(() => {});
  const pending = new Map<number, (message: Response) => void>();
  let sequence = 0;
  let buffer = '';
  let browser: Browser | undefined;
  let stderr = '';
  const socket = new Promise<string>((accept, reject) => {
    process.once('error', reject);
    process.once('exit', () => reject(new Error('Chrome exited before startup\n' + stderr)));
    process.stderr!.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-16_384);
      const endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
      if (endpoint) accept(endpoint);
    });
  });
  const output = process.stdio[4] as Readable;
  const input = process.stdio[3] as Writable;
  output.setEncoding('utf8').on('data', (data: string) => {
    buffer += data;
    const frames = buffer.split('\x00');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const response = JSON.parse(frame) as Response;
      if (response.id !== undefined) {
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      }
    }
  });
  process.once('exit', () => {
    for (const reply of pending.values()) reply({ error: { message: 'Chrome exited' } });
    pending.clear();
  });

  function send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    const id = ++sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(method + ': ' + message.error.message));
        else accept(message.result as T);
      });
      input.write(JSON.stringify({ id, method, params, sessionId }) + '\x00');
    });
  }

  try {
    browser = await chromium.connectOverCDP(await socket);
    const context = browser.contexts()[0]!;
    const page = context.pages()[0]!;
    const { id } = await send<{ id: string }>('Extensions.loadUnpacked', { path: resolve('dist') });
    const origin = 'http://127.0.0.1:' + bind.port;
    await run({
      page,
      async openExtensionPage(file) {
        const extensionPage = await context.newPage();
        await extensionPage.goto('chrome-extension://' + id + '/' + file);
        return extensionPage;
      },
      serve(path, html) {
        pages.set(path, html);
        return origin + path;
      },
      async openPopup() {
        const { targetInfos } = await send<{ targetInfos: Target[] }>('Target.getTargets', {
          filter: [{ type: 'tab' }],
        });
        const tab = targetInfos.find(entry => entry.url === page.url());
        if (!tab) throw new Error('Fixture tab not found');
        await send('Extensions.triggerAction', { id, targetId: tab.targetId });
        const popupUrl = 'chrome-extension://' + id + '/popup.html';
        let popup: Target | undefined;
        await expect.poll(async () => {
          const targets = await send<{ targetInfos: Target[] }>('Target.getTargets');
          popup = targets.targetInfos.find(entry => entry.url === popupUrl);
          return Boolean(popup);
        }).toBe(true);
        const targetId = popup!.targetId;
        const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
          targetId, flatten: true,
        });

        async function evaluate<T>(expression: string): Promise<T> {
          const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
            'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId,
          );
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
          return result.result.value;
        }

        return {
          evaluate,
          async choose(field, code) {
            await evaluate(`(() => {
              const select = document.getElementById(${JSON.stringify(field)});
              select.value = ${JSON.stringify(code)};
              select.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
          },
          async click() {
            const coordinates = await evaluate<{ x: number; y: number }>(`(() => {
              const button = document.querySelector('#action');
              if (button.disabled) throw new Error('Disabled action');
              const box = button.getBoundingClientRect();
              return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            })()`);
            for (const type of ['mousePressed', 'mouseReleased']) {
              await send('Input.dispatchMouseEvent', {
                ...coordinates, type, button: 'left', clickCount: 1,
              }, sessionId);
            }
          },
          async close() {
            await send('Target.closeTarget', { targetId });
          },
          status: () => evaluate<string>('document.querySelector("#status")?.textContent'),
        };
      },
    });
  } finally {
    await browser?.close();
    if (process.exitCode === null && process.signalCode === null) process.kill();
    await exited.catch(() => {});
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export interface ExtensionBrowser {
  page: Page;
  serve(path: string, html: string): string;
  openExtensionPage(file: string): Promise<Page>;
  openPopup(): Promise<Popup>;
}

export interface Popup {
  evaluate<T = unknown>(expression: string): Promise<T>;
  choose(field: 'source' | 'target', code: string): Promise<void>;
  click(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<string>;
}
