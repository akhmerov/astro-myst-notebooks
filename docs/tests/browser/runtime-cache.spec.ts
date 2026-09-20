import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const serverRequests = async () => (await readFile(new URL('../../.astro/browser-requests.jsonl', import.meta.url), 'utf8'))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string);

test('execution assets wait for activation and Python downloads are cached across visits', async ({ page }) => {
  let start = (await serverRequests()).length;
  const executionModules: string[] = [];
  page.on('request', request => {
    if (/\/(runtime|xeus-server|live-mime)-[^/]+\.js$/.test(new URL(request.url()).pathname)) executionModules.push(request.url());
  });
  await page.goto('presentation/');
  const controls = page.locator('[data-thebe-controls]');
  await expect(controls.getByRole('button', { name: 'Enable interactivity', exact: true })).toBeEnabled();
  expect((await serverRequests()).slice(start).filter(url => url.includes('/thebe/'))).toEqual([]);
  expect(executionModules).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await controls.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  expect(executionModules.some(url => url.includes('/runtime-'))).toBe(true);
  const largeDownloads = [...new Set((await serverRequests()).slice(start).filter(url => /\.(wasm|tar\.gz)$/.test(url)))];
  expect(largeDownloads.some(url => url.endsWith('/xpython.wasm'))).toBe(true);
  expect(largeDownloads.some(url => url.endsWith('.tar.gz'))).toBe(true);
  await expect.poll(async () => page.evaluate(async urls => {
    const names = (await caches.keys()).filter(name => name.startsWith('astro-myst-notebooks:'));
    const cached = (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat();
    return urls.every(url => cached.includes(url));
  }, largeDownloads)).toBe(true);
  start = (await serverRequests()).length;
  executionModules.length = 0;
  await page.goto('notebook/');
  await expect(controls.getByRole('button', { name: 'Enable interactivity', exact: true })).toBeEnabled();
  expect((await serverRequests()).slice(start).filter(url => url.includes('/thebe/'))).toEqual([]);
  expect(executionModules).toEqual([]);
  await controls.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  expect((await serverRequests()).slice(start).filter(url => /\.(wasm|tar\.gz)$/.test(url))).toEqual([]);
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  start = (await serverRequests()).length;
  await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  expect((await serverRequests()).slice(start).filter(url => /\.(wasm|tar\.gz)$/.test(url))).toEqual([]);
});
