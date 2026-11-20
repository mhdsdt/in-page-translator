# Architecture

In-Page Translator is a zero-framework Manifest V3 extension designed around four invariants:

1. **Minimal privileges**: `activeTab` only—never `<all_urls>` or broad host permissions. The only host permission is Mozilla’s pinned model bucket in [src/shared/model-source.json](src/shared/model-source.json).
2. **On-device privacy**: Page text never leaves the browser. The page layer cannot issue network requests.
3. **Lossless restoration**: Every DOM mutation is tracked in [src/page/patches.ts](src/page/patches.ts) and cleanly undone when **Show original** is triggered or a node leaves an eligible region.
4. **Small, zero-dependency bundles**: Plain TypeScript bundled with `esbuild`, verified against bundle size budgets on every check.

## Module layers & boundaries

Layer rules are enforced statically via TypeScript AST analysis in [scripts/verify.mjs](scripts/verify.mjs):

| Layer | Owns | Allowed imports | Restrictions |
| --- | --- | --- | --- |
| `src/shared/` | Types, model catalog & routing, language/RTL helpers, text chunking & CSS unquoting, char-budgeted batching, badge derivation, shared UI formatting, thin RPC helper | `shared` | Pure modules (except `offline.ts`) may not touch `chrome.*` |
| `src/page/` | Isolated content script: TreeWalker DOM scanning (`scanner.ts`), viewport lookahead & `<select>`/overflow visibility (`viewport.ts`), late shadow-root discovery (`shadow-discovery.ts`), patch & RTL `dir` ledger (`patches.ts`), microtask-batched IPC & LRU cache (`engine.ts`), session orchestration (`session.ts`), push state notifications (`index.ts`) | `page`, `shared` | No `fetch`, `XMLHttpRequest`, or `WebSocket`; no `innerHTML`/`eval` |
| `src/offline/` | Background service worker (`background.ts`, action badge + shortcut command), offscreen coordinator (`document.ts`), verified pack downloader (`packs.ts`, `download-worker.ts`), IndexedDB storage (`store.ts`), adaptive 2-worker Bergamot pool (`translator.ts`, `bergamot.ts`) | `offline`, `shared` | Strictly validates message `sender` |
| `src/popup/` | Toolbar popup controller (`index.ts`) with push updates, swap, and recent targets, plus pure view-model (`view.ts`) | `popup`, `shared` | Thin UI layer over `PageState` and `PackStatus` |
| `src/packs/` | Language pack manager tab (`index.ts`) | `packs`, `shared` | Thin UI layer over `PackStatus` |

## Verification tiers

- `npm run typecheck` — Strict TypeScript checking (`noUncheckedIndexedAccess`, `noUnusedLocals`, `verbatimModuleSyntax`).
- `npm run verify` — Static AST boundary & security checks, manifest/version/privacy invariants, catalog schema verification, and `dist/` bundle size budgets.
- `npm run test:unit` — Fast (<200 ms) native Node unit and property tests covering language routing, catalog invariants, text splitting, batch packing, formatting, and the popup state machine.
- `npm test` — Real Chromium Playwright suite loading the unpacked `dist/` extension over CDP with mocked inference.
- `npm run test:packs` — End-to-end test downloading real verified Mozilla packs, translating offline, pivoting through English, and removing packs.
