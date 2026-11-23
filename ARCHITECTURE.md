# Architecture

In-Page Translator is a zero-framework Manifest V3 extension designed around four invariants:

1. **Minimal privileges**: `activeTab` only—never `<all_urls>` or broad host permissions. The only host permission is Mozilla’s pinned model bucket in [src/shared/model-source.json](src/shared/model-source.json).
2. **On-device privacy**: Page text never leaves the browser. The page layer cannot issue network requests.
3. **Lossless restoration**: Every DOM mutation is tracked in [src/page/patches.ts](src/page/patches.ts) and cleanly undone when **Show original** is triggered or a node leaves an eligible region.
4. **Small, zero-dependency bundles**: Plain TypeScript bundled with `esbuild`, verified against bundle size budgets on every check.

## Module layers & boundaries

Layer rules are enforced statically via TypeScript AST analysis in [scripts/verify.mjs](scripts/verify.mjs), and TypeScript compilation isolates browser extension code ([tsconfig.json](tsconfig.json), `chrome` types only) from Node test suites ([tsconfig.tests.json](tsconfig.tests.json)):

| Layer | Owns | Allowed imports | Restrictions |
| --- | --- | --- | --- |
| `src/shared/` | Types, model catalog & routing, language/RTL helpers, text chunking & CSS unquoting, inline-HTML AST parser/validator, generic `LruCache` (`cache.ts`), char-budgeted & length-bucketed batching (`batch.ts`), badge derivation, shared UI formatting, thin RPC helper | `shared` | Pure modules (except `offline.ts`) may not touch `chrome.*` |
| `src/page/` | Isolated content script: TreeWalker DOM scanning (`scanner.ts`), surface observer/frame/shadow/slot tracking (`roots.ts`), viewport-prioritized lookahead & `<select>`/overflow visibility (`viewport.ts`), late shadow-root discovery (`shadow-discovery.ts`), sentence-level inline-HTML unit reconciliation (`inline.ts`), patch & ref-counted RTL `dir` ledger (`patches.ts`), length-bucketed micro-batched IPC & LRU cache (`engine.ts`), pipelined non-blocking session orchestration (`session.ts`), push state notifications (`index.ts`) | `page`, `shared` | No `fetch`, `XMLHttpRequest`, or `WebSocket`; no `innerHTML`/`eval` |
| `src/offline/` | Background service worker (`background.ts`, action badge + shortcut command), offscreen LRU cache & bucketed coordinator (`document.ts`), verified pack downloader (`packs.ts`, `download-worker.ts`), IndexedDB storage (`store.ts`), work-stealing multi-worker Bergamot pool (`translator.ts`, `bergamot.ts`) | `offline`, `shared` | Strictly validates message `sender` |
| `src/popup/` | Toolbar popup controller (`index.ts`) with push updates, swap, and recent targets, plus pure view-model (`view.ts`) | `popup`, `shared` | Thin UI layer over `PageState` and `PackStatus` |
| `src/packs/` | Language pack manager tab (`index.ts`) and pure view-model (`view.ts`) | `packs`, `shared` | Thin UI layer over `PackStatus` |

## Verification tiers

- `npm run typecheck` — Strict TypeScript checking (`tsc --noEmit` on `src/` with `chrome`-only types, plus `tsc -p tsconfig.tests.json --noEmit` for `tests/` and Playwright config).
- `npm run verify` — Static AST boundary & security checks, manifest/version/privacy invariants, catalog schema verification, and `dist/` bundle size budgets.
- `npm run test:unit` — Fast (<200 ms) native Node unit and property tests covering language routing, catalog invariants, text splitting, batch packing, formatting, patch ledger RTL ref-counting, and both popup/packs state machines.
- `npm test` — Real Chromium Playwright suite across focused domain spec files (`extension`, `dom-coverage`, `inline-html`, `popup-and-packs`, `resilience`) loading the unpacked `dist/` extension over CDP with mocked inference.
- `npm run test:packs` — End-to-end test downloading real verified Mozilla packs, translating offline, pivoting through English, and removing packs.
- `npm run bench` — Repeatable headless Chromium cold/warm latency benchmark using real cached Mozilla/Bergamot `de:en` WASM packs.
