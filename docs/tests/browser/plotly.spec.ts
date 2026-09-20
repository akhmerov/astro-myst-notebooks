import { test, expect, type Locator, type Page } from '@playwright/test';

// Inspect painted trace pixels, not just Plotly's DOM or a min-height container.
async function tracePixels(page: Page, plot: Locator) {
  const screenshot = await plot.screenshot();
  return page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 140 && pixels[i + 1] < 90 && pixels[i + 2] > 80) count++;
    }
    image.close();
    return count;
  }, [...screenshot]);
}

async function visibleFigures(page: Page, plots: Locator, webgl: boolean) {
  await expect(plots).toHaveCount(4);
  for (const [i, height] of [250, 520, 420, 360].entries()) {
    const plot = plots.nth(i);
    await expect(plot).toHaveAttribute('data-rendered', 'true');
    const box = await plot.locator('.main-svg').first().boundingBox();
    expect(box?.height).toBeCloseTo(height, 0);
    expect(box!.width).toBeGreaterThan(200);
    if (i === 1) expect(box!.width).toBe(360);
    if (i === 3 && !webgl) {
      await expect(plot).toContainText('WebGL is not supported');
      continue;
    }
    await expect.poll(() => tracePixels(page, plot)).toBeGreaterThan(50);
    if (i < 3) {
      const math = plot.locator('svg.ytitle-math');
      await expect(math).toHaveCount(1);
      expect((await math.boundingBox())!.height).toBeGreaterThan(10);
      expect(await math.locator('path, use').count()).toBeGreaterThan(0);
    } else {
      expect((await plot.locator('canvas').first().boundingBox())!.height).toBeGreaterThan(100);
    }
  }
}

test('Plotly paints figures, typesets local math, resizes, and renders live output', async ({ page, browserName }, info) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type()) && /MathJax|typesetting failed/.test(message.text())) errors.push(message.text());
  });
  page.on('request', request => requests.push(request.url()));
  await page.goto('walkthrough/');
  await expect(page.locator('[data-plotly]')).toHaveAttribute('data-rendered', 'true');
  expect(requests.filter(url => /mathjax|\/thebe\//i.test(url))).toEqual([]);

  await page.goto('plots/');
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'));
  // Chromium exercises painted 3D output. Headless Firefox may lack a GL
  // driver; in that environment verify Plotly's visible unsupported message.
  if (browserName === 'chromium') expect(webgl).toBe(true);
  if (!webgl) info.annotations.push({ type: 'WebGL unavailable', description: '3D fallback checked; SVG paint and live math still required.' });
  const plots = page.locator('.jupyter-outputs [data-plotly]');
  await visibleFigures(page, plots, webgl);
  expect(requests.filter(url => /mathjax-tex-svg\.js/.test(url))).toHaveLength(1);
  expect(requests.every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(requests.filter(url => /\/thebe\//.test(url))).toEqual([]);
  await expect(page.locator('.sl-markdown-content .katex')).toHaveCount(1);
  await expect(page.locator('.sl-markdown-content mjx-container')).toHaveCount(0);
  await info.attach('published-plot', { body: await plots.first().screenshot(), contentType: 'image/png' });

  const before = (await plots.first().boundingBox())!.width;
  await page.setViewportSize({ width: 500, height: 900 });
  await expect.poll(async () => (await plots.first().locator('.main-svg').first().boundingBox())!.width).toBeLessThan(before);
  await visibleFigures(page, plots, webgl);

  const controls = page.locator('[data-thebe-controls]');
  await controls.getByRole('button', { name: 'Enable interactivity', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'ready', { timeout: 150000 });
  await controls.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(controls.getByRole('status')).toHaveText('All cells completed.', { timeout: 60000 });
  const live = page.locator('.jupyter-live-output [data-plotly]');
  await visibleFigures(page, live, webgl);
  await info.attach('live-plot', { body: await live.first().screenshot(), contentType: 'image/png' });
  expect(requests.filter(url => /mathjax-tex-svg\.js/.test(url))).toHaveLength(1);
  expect(requests.filter(url => /mathjax/i.test(url)).every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(errors).toEqual([]);
});

test('a failed math component download leaves the chart visible with plain labels', async ({ page }) => {
  await page.route('**/mathjax-tex-svg.js', route => route.abort());
  await page.goto('plots/');
  const plot = page.locator('.jupyter-outputs [data-plotly]').first();
  await expect(plot).toHaveAttribute('data-rendered', 'true');
  await expect.poll(() => tracePixels(page, plot)).toBeGreaterThan(50);
  await expect(plot.locator('.ytitle')).toHaveText('$C/k_B$');
});
