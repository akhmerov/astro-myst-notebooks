import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.MYST_THEME_PORT ?? 51542);
const prefix = (process.env.BASE_URL ?? '/').replace(/\/$/, '');
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 180000,
  use: { baseURL: `${origin}${prefix}/`, screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } },
  webServer: {
    command: 'node serve.mjs', cwd: fileURLToPath(new URL('./', import.meta.url)),
    url: `${origin}${prefix}/`, reuseExistingServer: false,
  },
});
