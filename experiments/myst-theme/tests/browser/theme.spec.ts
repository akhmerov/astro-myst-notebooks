import { test, expect } from '@playwright/test';

test('generated API signatures, prose, and references render in the theme', async ({ page }) => {
  await page.goto('api/');
  await expect(page.getByRole('heading', { name: 'Python API', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'theme_api.triangular', exact: true })).toBeVisible();
  await expect(page.locator('.sl-markdown-content')).toContainText('The last integer to include.');
  const link = page.locator('.sl-markdown-content a').filter({ hasText: /^theme_api.triangular$/ }).first();
  await link.click();
  await expect(page).toHaveURL(/#py-/);
  await expect(page.locator('.jupyter-cell')).toHaveCount(0);
});

test('MyST references and exact included-source selections survive Starlight rendering', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('h1')).toHaveText('MyST with Astro');
  await expect(page.locator('.jupyter-outputs')).toContainText('The triangular number is 21');
  const selection = await page.locator('[data-source-location]').filter({ hasText: /^An included sentence/ }).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return (window as any).mystSourceMap.resolve(range);
  });
  expect(selection.complete).toBe(true);
  expect(selection.ranges[0].origin).toMatchObject({ file: '_included.md', kind: 'exact', start: 0, end: 53 });
  await page.getByRole('link', { name: 'the equation', exact: true }).click();
  await expect(page.locator('#triangle .katex')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('A second page');
  await page.getByRole('link', { name: 'the notebook', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('MyST with Astro');
});

test('real browser Python activates without executing, reruns edits, and terminates a busy kernel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  const controls = page.locator('[data-thebe-controls]');
  const cell = page.locator('.jupyter-cell').first();
  await cell.getByText('Show code', { exact: true }).click();
  await expect(cell.getByRole('button', { name: 'Copy to clipboard' })).toBeVisible();
  await cell.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await expect(cell.locator('.jupyter-live-output')).toBeEmpty();
  await expect(cell.locator('.jupyter-outputs')).toContainText('The triangular number is 21');
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  await expect(cell.locator('.jupyter-live-output')).toContainText('The triangular number is 21');
  const editor = cell.locator('.CodeMirror');
  await editor.evaluate(element => (element as any).CodeMirror.setValue('n = 8\nprint(n * (n + 1) // 2)'));
  await cell.locator('.CodeMirror textarea').press('Shift+Enter');
  await expect(cell.locator('.jupyter-live-output')).toHaveText('36');
  await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(cell.locator('.jupyter-live-output')).toHaveText('36');
  await editor.evaluate(element => (element as any).CodeMirror.setValue('while True: pass'));
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'running');
  await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  expect(errors).toEqual([]);
});

test('notebook input reruns hidden setup cells in browser Python', async ({ page }) => {
  await page.goto('notebook/');
  const cells = page.locator('.jupyter-cell');
  await expect(cells.first()).toBeHidden();
  await expect(cells.nth(1).locator('.jupyter-outputs')).toHaveText('42');
  const controls = page.locator('[data-thebe-controls]');
  await controls.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  await expect(cells.nth(1).locator('.jupyter-live-output')).toHaveText('42');
  await expect(cells.first()).toBeHidden();
});
