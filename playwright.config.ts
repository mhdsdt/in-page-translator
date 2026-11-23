import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 2,
  reporter: 'list',
  projects: [
    {
      name: 'regression',
      testMatch: [
        'extension.spec.ts',
        'dom-coverage.spec.ts',
        'inline-html.spec.ts',
        'popup-and-packs.spec.ts',
        'resilience.spec.ts',
      ],
    },
    { name: 'packs', testMatch: 'packs.spec.ts' },
  ],
});
