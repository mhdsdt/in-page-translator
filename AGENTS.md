# In-Page Translator

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the module layer map and core invariants.

## Product Constraints & Non-Goals
- **Strict `activeTab`-only permissions**: never add `<all_urls>`, `tabs`, or broad host permissions, and do not add cross-navigation auto-translation persistence. The only `host_permissions` entry is Mozilla’s pinned model bucket in `src/shared/model-source.json`.
- **Zero runtime dependencies & zero frameworks**: keep `package.json` `dependencies` empty and stay within the `dist/` bundle budgets in `scripts/verify.mjs`.
- **Manual releases only**: `.github/workflows/release.yml` runs strictly on `workflow_dispatch` (never auto-release on push). Version bumps must update `package.json`, `package-lock.json` (root and `packages[""]`), and `static/manifest.json` together.

## Code Style
- **Minimal comments**: write self-explanatory code through clear naming and small functions. Do not add comments that describe what code does, narrate steps, or label sections. Only write a comment in genuinely rare cases where a non-obvious *why* (such as a browser or spec quirk) cannot be inferred from the code itself.
- **Pure view-models**: keep popup and packs state derivation pure in `src/popup/view.ts` and `src/packs/view.ts`, with unit tests in `tests/unit/`.

## Verification
- Fast loop: `npm run typecheck && npm run test:unit`
- Full local gate (required before finishing code changes): `npm run check`
- Inference, model pack, or performance changes: also run `npm run test:packs` (live Mozilla/Bergamot WASM) and `npm run bench` (real Chromium cold/warm TTFT and TTVC)
- Never relax AST rules, manifest checks, or bundle budgets in `scripts/verify.mjs` without explicit user approval.

## Repo Gotchas
- **Split TypeScript configs**: `tsconfig.json` checks `src/` with `chrome`-only types (no Node globals); `tsconfig.tests.json` checks `tests/` and Playwright configs with `chrome` + `node`.
- **Node unit tests for DOM modules**: `tests/unit/` runs in plain Node (`node --test`), not jsdom. Stub minimal DOM primitives when unit-testing `src/page/` modules (see `tests/unit/patches.test.ts`).
- **Playwright popup focus on Linux CI**: clicking inside the page auto-dismisses open Chrome toolbar popups on Linux headless/Aura. Always call `await popup.close()` before clicking page elements, then reopen the popup if needed.
- **GitHub Actions**: keep workflows on `ubuntu-latest` and Node 24 native action majors (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`) so CI emits zero deprecation annotations.
