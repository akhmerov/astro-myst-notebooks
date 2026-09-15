import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.DOCS_PORT ?? 51300);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DOCS_PORT');
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  use: {
    baseURL: `${origin}${base}/`,
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // The public API keeps the server owned by Playwright even when Astro's
    // CLI detects an agent environment and automatically backgrounds itself.
    command: 'node docs/tests/preview.mjs',
    env: { DOCS_PORT: String(port) },
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    url: `${origin}${base}/`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
