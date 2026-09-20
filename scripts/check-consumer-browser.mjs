import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]);
const port=Number(process.argv[3] ?? 51488);
const base=process.argv[4] ?? '/manual/';
const require=createRequire(join(root,'package.json'));
const {preview}=await import(pathToFileURL(require.resolve('astro')).href);
const server=await preview({root,base,server:{host:'127.0.0.1',port}});
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}${base}`);
  const notebook=page.locator('jupyter-notebook');
  await page.locator('[data-thebe-controls]').getByRole('button',{name:'Enable interactivity',exact:true}).click();
  await page.locator('[data-thebe-controls][data-state="ready"]').waitFor({timeout:120000});
  await page.getByRole('button',{name:'Run all',exact:true}).click();
  await page.getByRole('status').filter({hasText:'All cells completed.'}).waitFor({timeout:60000});
  assert.match(await notebook.locator('.jupyter-live-output').textContent(),/Hello from Jupyter/);
  // Interrupting an infinite cell tests worker termination, rather than merely disposing a connection.
  await notebook.locator('.CodeMirror').first().evaluate(element=>element.CodeMirror.setValue('while True: pass'));
  await page.getByRole('button',{name:'Run all',exact:true}).click();
  await page.locator('[data-thebe-controls][data-state="running"]').waitFor();
  await page.getByRole('button',{name:'Restart Python',exact:true}).click();
  await page.locator('[data-thebe-controls][data-state="ready"]').waitFor({timeout:60000});
  await notebook.locator('.CodeMirror').first().evaluate(element=>element.CodeMirror.setValue('print("Recovered")'));
  await page.getByRole('button',{name:'Run all',exact:true}).click();
  await notebook.locator('.jupyter-live-output').filter({hasText:'Recovered'}).waitFor({timeout:60000});
  assert.deepEqual(errors,[]);
  await page.goto(`http://127.0.0.1:${port}${base}features/`);
  await page.evaluate(() => document.fonts.ready);
  const equation = await page.locator('#packaged-equation .katex-html').evaluate(element => {
    const tag = element.querySelector('.katex-tag');
    if (!tag) throw new Error('Missing styled equation number');
    return { position: getComputedStyle(tag).position, tagLeft: tag.getBoundingClientRect().left,
      formulaRight: Math.max(...Array.from(element.querySelectorAll(':scope > .base'), node => node.getBoundingClientRect().right)) };
  });
  assert.equal(equation.position, 'absolute', 'equation numbering must use the installed KaTeX stylesheet');
  assert.ok(equation.tagLeft > equation.formulaRight + 8, 'equation number must be separate from the formula');
  assert.deepEqual(errors,[]);
  console.log(`Packed consumer browser execution and infinite-loop reset passed at ${base}`);
} finally {await browser?.close();await server.stop();}
