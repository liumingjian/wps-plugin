import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './roadflow-extension',
  testMatch: 'editor.browser.test.mjs',
  fullyParallel: true,
  forbidOnly: true,
  reporter: 'line',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 }
  }
});
