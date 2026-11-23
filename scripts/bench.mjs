import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { env, platform } from 'node:process';
import { gunzipSync } from 'node:zlib';

const root = resolve(new URL('..', import.meta.url).pathname);
const pairId = process.argv[2] ?? 'de:en';

const NAV_LABELS = [
  'Startseite',
  'Einstellungen',
  'Warenkorb',
  'Bestellungen',
  'Merkliste',
  'Mein Konto',
  'Hilfe & Support',
  'Kontaktformular',
  'Produktsuche',
  'Sonderangebote',
  'Neuigkeiten',
  'Abmelden',
];

function buildPageHtml(variant) {
  const nav = NAV_LABELS.map((label, index) =>
    `<a class="bench-item bench-short" data-kind="short" data-id="nav-${index}" href="#n${index}">${label}</a>`,
  ).join('');

  const cards = Array.from({ length: 24 }, (_, index) => {
    const id = variant === 1 ? index + 1 : index + 101;
    const text = `Produktbeschreibung Nummer ${id}: Hochwertige Verarbeitung aus nachhaltigen Materialien für den täglichen Einsatz.`;
    return `<article class="card"><p class="bench-item" data-kind="medium" data-id="med-${id}">${text}</p></article>`;
  }).join('');

  const paragraphs = Array.from({ length: 24 }, (_, index) => {
    const id = variant === 1 ? index + 1 : index + 101;
    const text = `Ausführlicher Testbericht Abschnitt ${id}: Unsere unabhängigen Redakteure prüfen jedes einzelne Bauteil über mehrere Wochen im Alltag, vergleichen Stromverbrauch sowie Verarbeitungsqualität bei hoher Belastung und dokumentieren sämtliche Messergebnisse verständlich für unsere Leser.`;
    return `<p class="bench-item" data-kind="long" data-id="long-${id}">${text}</p>`;
  }).join('');

  const inlineItems = variant === 1
    ? Array.from({ length: 12 }, (_, index) => {
        const id = index + 1;
        return `<p class="bench-item" data-kind="inline" data-id="inline-${id}">Lesen Sie Abschnitt ${id} in unserer <a href="#g${id}">offiziellen <em>Anleitung</em></a> vor dem Start.</p>`;
      }).join('')
    : '';

  return `<!doctype html><html lang="${pairId.split(':')[0]}"><head><meta charset="utf-8"><style>
    body{font-family:sans-serif;margin:16px}
    nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
    .card p,p{margin:4px 0;font-size:12px;line-height:1.25}
  </style></head><body><nav>${nav}</nav><section class="grid">${cards}</section><section>${paragraphs}${inlineItems}</section></body></html>`;
}

async function ensurePackBuffers(pack, modelSource) {
  const dir = join(tmpdir(), 'in-page-translator-bench', `${pack.id}@${pack.revision}`);
  await mkdir(dir, { recursive: true });
  const loaded = [];
  for (const asset of pack.assets) {
    const filename = asset.file.split('/').pop().replace(/\.gz$/u, '');
    const filePath = join(dir, filename);
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      const url = modelSource + asset.file;
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`);
      data = gunzipSync(Buffer.from(await response.arrayBuffer()));
      await writeFile(filePath, data);
    }
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== asset.unpacked) {
      throw new Error(`Digest mismatch for cached asset ${filePath}`);
    }
    loaded.push(data.toString('base64'));
  }
  return { model: loaded[0], shortlist: loaded[1], vocabs: loaded.slice(2) };
}

async function runBenchmark() {
  const catalog = JSON.parse(await readFile(join(root, 'src', 'shared', 'catalog.json'), 'utf8'));
  const modelSource = JSON.parse(await readFile(join(root, 'src', 'shared', 'model-source.json'), 'utf8'));
  const pack = catalog.find(entry => entry.id === pairId);
  if (!pack) throw new Error(`Unknown pack id "${pairId}"`);
  const serialized = await ensurePackBuffers(pack, modelSource);

  const page1Html = buildPageHtml(1);
  const page2Html = buildPageHtml(2);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/page2' ? page2Html : page1Html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bind = server.address();
  if (!bind || typeof bind === 'string') throw new Error('Benchmark HTTP server failed to bind');
  const baseUrl = `http://127.0.0.1:${bind.port}`;

  const profile = await mkdtemp(join(tmpdir(), 'in-page-bench-profile-'));
  const ciLinuxArgs = platform === 'linux' && env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const proc = spawn(chromium.executablePath(), [
    '--headless', '--no-first-run', '--no-default-browser-check',
    ...ciLinuxArgs,
    '--remote-debugging-pipe', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--window-size=1440,1800',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exited = once(proc, 'exit').then(() => {});
  void exited.catch(() => {});

  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  const stderrPromise = new Promise((resolveReady, rejectReady) => {
    let stderr = '';
    proc.once('error', rejectReady);
    proc.once('exit', () => rejectReady(new Error('Chrome exited before startup\n' + stderr)));
    proc.stderr.setEncoding('utf8').on('data', chunk => {
      stderr = (stderr + chunk).slice(-16_384);
      if (/DevTools listening on ws:\/\//u.test(stderr)) resolveReady();
    });
  });

  const output = proc.stdio[4];
  const input = proc.stdio[3];
  output.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    const frames = buffer.split('\x00');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const response = JSON.parse(frame);
      if (response.id !== undefined) {
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      }
    }
  });

  function send(method, params, sessionId) {
    const id = ++sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 60_000);
      pending.set(id, message => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else accept(message.result);
      });
      input.write(JSON.stringify({ id, method, params, sessionId }) + '\x00');
    });
  }

  async function evaluate(sessionId, expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result?.value;
  }

  async function waitForTarget(predicate) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { targetInfos } = await send('Target.getTargets');
      const match = targetInfos.find(predicate);
      if (match) return match;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('Timed out waiting for target');
  }

  async function measurePage(extId, tabTargetId, pageSessionId, url) {
    await send('Page.navigate', { url }, pageSessionId);
    await pollUntil(() => evaluate(
      pageSessionId,
      `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`,
    ));

    const openStart = performance.now();
    await send('Extensions.triggerAction', { id: extId, targetId: tabTargetId });
    const popupTarget = await waitForTarget(t => t.url === `chrome-extension://${extId}/popup.html`);
    const { sessionId: popupSessionId } = await send('Target.attachToTarget', {
      targetId: popupTarget.targetId,
      flatten: true,
    });

    await pollUntil(async () => {
      const state = await evaluate(popupSessionId, `(() => {
        const status = document.querySelector('#status')?.textContent || '';
        const action = document.querySelector('#action');
        return { status, disabled: action ? action.disabled : true };
      })()`);
      return state.status === 'Page is in its original language.' && !state.disabled;
    });
    await evaluate(popupSessionId, `(() => {
      const select = document.getElementById('target');
      if (select.value !== ${JSON.stringify(pack.to)}) {
        select.value = ${JSON.stringify(pack.to)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    const openMs = performance.now() - openStart;

    await evaluate(pageSessionId, `(() => {
      const items = [...document.querySelectorAll('.bench-item')].map(el => ({
        el,
        kind: el.dataset.kind,
        orig: el.textContent,
      }));
      const shorts = items.filter(item => item.kind === 'short');
      window.__bench = { items: items.length, first: null, short: null, all: null };
      const check = () => {
        const now = performance.now();
        let changed = 0;
        for (const item of items) {
          if (item.el.textContent !== item.orig) changed++;
        }
        if (changed > 0 && window.__bench.first === null) window.__bench.first = now;
        if (window.__bench.short === null && shorts.every(item => item.el.textContent !== item.orig)) {
          window.__bench.short = now;
        }
        if (window.__bench.all === null && changed === items.length) {
          window.__bench.all = now;
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      window.__benchStart = performance.now();
    })()`);

    const clickStart = performance.now();
    const box = await evaluate(popupSessionId, `(() => {
      const r = document.querySelector('#action').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { ...box, type, button: 'left', clickCount: 1 }, popupSessionId);
    }

    const domMetrics = await pollUntil(async () => {
      const m = await evaluate(pageSessionId, `window.__bench.all !== null
        ? {
            items: window.__bench.items,
            ttftMs: window.__bench.first - window.__benchStart,
            shortMs: window.__bench.short - window.__benchStart,
            ttvcMs: window.__bench.all - window.__benchStart,
          }
        : null`);
      return m;
    }, 60_000);

    await pollUntil(async () => {
      const status = await evaluate(popupSessionId, 'document.querySelector("#status")?.textContent || ""');
      return /^Translated to /u.test(status);
    }, 30_000);
    const statusMs = performance.now() - clickStart;

    await send('Target.closeTarget', { targetId: popupTarget.targetId });
    return { openMs, ...domMetrics, statusMs };
  }

  async function waitForLoaded(sessionId) {
    await pollUntil(() => evaluate(sessionId, 'document.readyState === "complete"'));
  }

  async function pollUntil(fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Timed out polling benchmark condition');
  }

  try {
    await stderrPromise;
    const { id: extId } = await send('Extensions.loadUnpacked', { path: resolve(root, 'dist') });

    const { targetId: seedTargetId } = await send('Target.createTarget', {
      url: `chrome-extension://${extId}/MPL-2.0.txt`,
    });
    const { sessionId: seedSessionId } = await send('Target.attachToTarget', {
      targetId: seedTargetId,
      flatten: true,
    });
    await waitForLoaded(seedSessionId);
    await evaluate(seedSessionId, `((key, data) => new Promise((accept, reject) => {
      const decode = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
      const buffers = {
        model: decode(data.model),
        shortlist: decode(data.shortlist),
        vocabs: data.vocabs.map(decode),
      };
      const req = indexedDB.open('translation-models', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('packs'); };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('packs', 'readwrite');
        tx.objectStore('packs').put(buffers, key);
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => { db.close(); accept(true); };
      };
    }))(${JSON.stringify(`${pack.id}@${pack.revision}`)}, ${JSON.stringify(serialized)})`);
    await send('Target.closeTarget', { targetId: seedTargetId });

    const { targetInfos } = await send('Target.getTargets', { filter: [{ type: 'page' }] });
    const pageTarget = targetInfos[0];
    if (!pageTarget) throw new Error('No initial browser page');
    const { sessionId: pageSessionId } = await send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    await send('Page.enable', {}, pageSessionId);

    const { targetInfos: tabTargets } = await send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tabTarget = tabTargets[0];
    if (!tabTarget) throw new Error('No initial browser tab');

    const cold = await measurePage(extId, tabTarget.targetId, pageSessionId, `${baseUrl}/`);
    const warm = await measurePage(extId, tabTarget.targetId, pageSessionId, `${baseUrl}/page2`);

    const fmt = n => `${Math.round(n)} ms`;
    console.log(`Benchmark (${pairId}, real Bergamot WASM in headless Chromium):`);
    console.log(`  Page 1 (cold, ${cold.items} items): popup ${fmt(cold.openMs)} | TTFT ${fmt(cold.ttftMs)} | short nav ${fmt(cold.shortMs)} | TTVC ${fmt(cold.ttvcMs)} | status ${fmt(cold.statusMs)}`);
    console.log(`  Page 2 (warm, ${warm.items} items): popup ${fmt(warm.openMs)} | TTFT ${fmt(warm.ttftMs)} | short nav ${fmt(warm.shortMs)} | TTVC ${fmt(warm.ttvcMs)} | status ${fmt(warm.statusMs)}`);
  } finally {
    try { await send('Browser.close'); } catch {}
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited.catch(() => {});
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

await runBenchmark();
