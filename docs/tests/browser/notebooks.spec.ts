import { test, expect } from '@playwright/test';
import type {} from '../../../dist/notebooks/source-selection.js';

test('mounted files and directories are readable in browser Python and restored on restart', async ({ page }) => {
  await page.goto('browser/');
  const cell = page.locator('.jupyter-cell').first();
  await expect(cell.locator('.jupyter-outputs')).toContainText('Measured total: 42');
  await cell.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  const controls = page.locator('[data-notebook-toolbar] [data-thebe-controls]');
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  await expect(cell.locator('.jupyter-live-output')).toContainText('Measurements bundled with the documentation.');
  await expect(cell.locator('.jupyter-live-output')).toContainText('Measured total: 42');
  const source = await cell.getAttribute('data-source');
  await cell.locator('.CodeMirror').evaluate((element, code) => {
    (element as HTMLElement & { CodeMirror: { setValue(value: string): void } }).CodeMirror.setValue(code!);
  }, "from pathlib import Path\nPath('/data/description.txt').write_text('edited')\nprint(Path('/data/description.txt').read_text())");
  await cell.locator('.CodeMirror textarea').press('Shift+Enter');
  await expect(cell.locator('.jupyter-live-output')).toContainText('edited');
  await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await cell.locator('.CodeMirror').evaluate((element, code) => {
    (element as HTMLElement & { CodeMirror: { setValue(value: string): void } }).CodeMirror.setValue(code!);
  }, source);
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  await expect(cell.locator('.jupyter-live-output')).toContainText('Measurements bundled with the documentation.');
  await expect(cell.locator('.jupyter-live-output')).toContainText('Measured total: 42');
});

test('rendered output, Plotly, navigation, and included source selections', async ({ page }) => {
  await page.goto('walkthrough/');
  await expect(page.getByRole('heading', { name: 'Executable walkthrough', exact: true })).toBeVisible();
  await expect(page.locator('.jupyter-outputs').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await expect(page.locator('[data-plotly][data-rendered]')).toHaveCount(1);
  const firstCell = page.locator('.jupyter-cell').first();
  const wand = firstCell.getByRole('button', { name: 'Enable interactivity', exact: true });
  const copy = firstCell.getByRole('button', { name: 'Copy to clipboard' });
  await expect(wand).toBeEnabled();
  const wandBox = (await wand.boundingBox())!;
  const copyBox = (await copy.boundingBox())!;
  expect(wandBox.x + wandBox.width).toBeLessThanOrEqual(copyBox.x);
  expect(Math.abs(wandBox.y - copyBox.y)).toBeLessThan(2);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await firstCell.getAttribute('data-source'));
  const mapped = await page.locator('[data-source-location]').filter({ hasText: /^included file$/ }).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return window.mystSourceMap.resolve(range);
  });
  expect(mapped.complete).toBe(true);
  expect(mapped.ranges[0]?.origin?.file).toBe('docs/src/content/docs/_partials/_provenance.md');
  await page.getByRole('link', { name: 'authoring guide', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Author MyST', exact: true })).toBeVisible();
});

test('the authored notebook runs in real browser Python and resets with edits preserved', async ({ page }) => {
  await page.goto('walkthrough/');
  const notebook = page.locator('jupyter-notebook');
  const controls = page.locator('[data-notebook-toolbar] [data-thebe-controls]');
  await expect(controls.getByRole('button', { name: 'Run all', exact: true })).toBeHidden();
  const wands = notebook.getByRole('button', { name: 'Enable interactivity', exact: true });
  await expect(wands).toHaveCount(4);
  await wands.nth(1).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await expect(notebook.locator('.jupyter-live-output')).toHaveText(['', '', '', '', '']);
  await expect(notebook.locator('.jupyter-outputs').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await expect(notebook.locator('.jupyter-cell').nth(2).locator('.CodeMirror textarea')).toBeFocused();
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  await expect(notebook.locator('.jupyter-live-output').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await notebook.locator('.CodeMirror').first().evaluate(element => {
    (element as HTMLElement & { CodeMirror: { setValue(value: string): void } }).CodeMirror
      .setValue('n = 4\nvalues = list(range(1, n + 1))\nprint(f"Terms: {values}")');
  });
  await notebook.locator('.CodeMirror textarea').first().press('Shift+Enter');
  await expect(notebook.locator('.jupyter-live-output').filter({ hasText: 'Terms: [1, 2, 3, 4]' })).toBeVisible();
  // A cell action must not silently rerun the rest of the notebook.
  await expect(notebook.locator('.jupyter-live-output').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await page.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(page.locator('[data-thebe-controls]')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await page.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('All cells completed.', { timeout: 150000 });
  await expect(notebook.locator('.jupyter-live-output').filter({ hasText: 'Sum: 10' })).toBeVisible();
  await expect(notebook.locator('.jupyter-live-output [data-plotly][data-rendered]')).toHaveCount(1);
  await notebook.locator('.CodeMirror').first().evaluate(element => {
    (element as HTMLElement & { CodeMirror: { setValue(value: string): void } }).CodeMirror.setValue('while True: pass');
  });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'running');
  await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  // Moving the toolbar into the heading must not leave controls behind on removal.
  await notebook.evaluate(element => element.remove());
  await expect(page.locator('[data-notebook-toolbar]')).toBeEmpty();
});

test('source selections are ready at page load and activation waits for its controls', async ({ page }) => {
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/notebooks/element.js', async route => { await loaded; await route.continue(); });
  try {
    await page.goto('walkthrough/');
    expect(await page.evaluate(() => typeof window.mystSourceMap?.resolve)).toBe('function');
    const activate = page.getByRole('button', { name: 'Enable interactivity', exact: true }).first();
    await expect(activate).toBeDisabled();
    release();
    await expect(activate).toBeEnabled();
  } finally { release(); }
});

test('a failed start retries interactivity and navigation clears the title controls', async ({ page }) => {
  await page.route('**/thebe/index.js', route => route.abort());
  await page.goto('walkthrough/');
  const controls = page.locator('[data-notebook-toolbar] [data-thebe-controls]');
  await page.locator('.jupyter-cell').first().getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.cell-interactivity-status')).toContainText('Could not download');
  await expect(page.locator('.jupyter-outputs').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await page.unroute('**/thebe/index.js');
  await page.locator('.jupyter-cell').first().getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 150000 });
  await expect(page.locator('.jupyter-live-output').filter({ hasText: 'Sum: 36' })).toBeVisible();
  await page.getByRole('link', { name: 'authoring guide', exact: true }).click();
  await expect(page.locator('[data-notebook-toolbar]')).toBeEmpty();
  await page.goBack();
  await expect(controls.getByRole('button', { name: 'Enable interactivity', exact: true })).toBeEnabled();
  await expect(controls).toHaveCount(1);
});

test('layout constructs behave in the browser: tabs switch and Mermaid draws with the theme', async ({ page }) => {
  await page.goto('authoring/');
  const tabs = page.locator('[data-tab-set]').first();
  const pixiPanel = tabs.locator('[role="tabpanel"]').first();
  const npmPanel = tabs.locator('[role="tabpanel"]').nth(1);
  await expect(pixiPanel).toBeVisible();
  await expect(npmPanel).toBeHidden();
  await tabs.getByRole('tab', { name: 'npm' }).click();
  await expect(npmPanel).toBeVisible();
  await expect(pixiPanel).toBeHidden();
  await expect(tabs.getByRole('tab', { name: 'npm' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'npm' }).press('ArrowLeft');
  await expect(pixiPanel).toBeVisible();
  const diagram = page.locator('pre.mermaid[data-processed]');
  await expect(diagram.locator('svg')).toHaveCount(1, { timeout: 30000 });
  await expect(diagram).toContainText('Jupyter kernel');
  const before = await diagram.locator('svg').getAttribute('id');
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; });
  await expect.poll(async () => diagram.locator('svg').getAttribute('id'), { timeout: 30000 }).not.toBe(before);
  await expect(page.getByRole('link', { name: /Executable walkthrough/ }).and(page.locator('a.card'))).toHaveAttribute('href', /walkthrough\/$/);
});
