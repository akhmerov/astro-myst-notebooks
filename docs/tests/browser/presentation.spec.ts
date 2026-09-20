import { test, expect } from '@playwright/test';

test('page and cell overrides survive activation, reruns, disclosures, and restart', async ({ page }) => {
  await page.goto('presentation/');
  const cells = page.locator('.jupyter-cell');
  const first = cells.nth(0);
  const streams = cells.nth(1);
  const whole = cells.nth(2);
  const removedInput = cells.nth(3);
  const removedOutput = cells.nth(4);
  const setup = cells.nth(5);
  const result = cells.nth(6);
  await expect(first.locator('.jupyter-input-area')).not.toHaveAttribute('open');
  await expect(first.locator('.jupyter-output-area')).not.toHaveAttribute('open');
  await expect(first.locator('.jupyter-outputs')).toHaveText('Visible result: 42');
  await expect(streams.locator('.jupyter-outputs')).toContainText('Kept stdout');
  await expect(streams.locator('.jupyter-outputs')).toContainText('Kept stderr');
  await expect(streams.locator('.jupyter-outputs')).not.toContainText('discarded');
  await expect(whole.locator('.jupyter-cell-area')).not.toHaveAttribute('open');
  await expect(removedInput.locator('.jupyter-input-area')).toBeHidden();
  await expect(removedOutput.locator('.jupyter-output-area')).toBeHidden();
  await expect(setup).toBeHidden();
  await first.locator('.jupyter-output-area > summary').click();
  await expect(first.locator('.jupyter-outputs')).toBeVisible();
  const frame = await streams.locator('.jupyter-output').first().evaluate(element => {
    const css = getComputedStyle(element);
    return [css.borderTopWidth, css.borderLeftWidth, css.paddingTop, css.paddingLeft];
  });
  expect(frame).toEqual(['0px', '0px', '0px', '0px']);

  const controls = page.locator('[data-thebe-controls]');
  await controls.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await expect(first.locator('.CodeMirror')).toBeHidden();
  await expect(first.locator('.jupyter-output-area')).toHaveAttribute('open');
  await expect(removedInput.locator('.CodeMirror')).toBeHidden();
  await expect(whole.locator('.CodeMirror')).toBeHidden();
  await first.locator('.jupyter-input-area > summary').click();
  await whole.locator('.jupyter-cell-area > summary').click();
  await expect(first.locator('.CodeMirror')).toBeVisible();
  await expect(whole.locator('.CodeMirror')).toBeVisible();

  for (let run = 0; run < 2; run++) {
    await controls.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
    await expect(first.locator('.jupyter-live-output')).toHaveText('Visible result: 42');
    await expect(streams.locator('.jupyter-live-output')).toContainText('Kept stdout');
    await expect(streams.locator('.jupyter-live-output')).toContainText('Kept stderr');
    await expect(streams.locator('.jupyter-live-output')).toContainText('updated result');
    await expect(streams.locator('.jupyter-live-output')).not.toContainText('discarded');
    await expect(streams.locator('.jupyter-live-output')).not.toContainText('old result');
    await expect(removedOutput.locator('.jupyter-live-output')).toHaveText('');
    await expect(result.locator('.jupyter-live-output')).toContainText('Hidden setup ran: 42');
    await expect(removedInput.locator('.CodeMirror')).toBeHidden();
    await expect(setup).toBeHidden();
    if (run === 0) {
      await controls.getByRole('button', { name: 'Restart Python', exact: true }).click();
      await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
      await expect(first.locator('.jupyter-input-area')).toHaveAttribute('open');
      await expect(whole.locator('.jupyter-cell-area')).toHaveAttribute('open');
    }
  }
  // Hiding stderr must not swallow unexpected exceptions or allow later cells to run.
  await first.locator('.CodeMirror').evaluate(element => {
    (element as HTMLElement & { CodeMirror: { setValue(code: string): void } }).CodeMirror.setValue('raise ValueError("visible exception")');
  });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toContainText('A cell failed');
  await expect(first.locator('.jupyter-live-output')).toContainText('visible exception');
});
