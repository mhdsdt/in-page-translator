import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'regression', testMatch: ['extension.spec.ts', 'review-regressions.spec.ts'] },
    { name: 'packs', testMatch: 'packs.spec.ts' },
  ],
});
