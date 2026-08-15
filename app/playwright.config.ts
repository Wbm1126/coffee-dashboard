import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5194',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'narrow-768', use: { viewport: { width: 768, height: 900 } } },
    { name: 'minimum-320-reduced', use: { viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' } },
  ],
});
