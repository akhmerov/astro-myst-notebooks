import { after } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { registerEngine, buildEngine, enginePages } from '../../dist/engine/project.mjs';
import { renderPage } from '../../dist/engine/render.mjs';

const builds = new Map();
const directories = new Set();
after(async () => {
  await Promise.all([...directories].map(root => rm(root, { recursive: true, force: true })));
});

/** Compile ordinary authored input with the public MyST CLI and real plugins. */
async function compiled(source, frontmatter, execution) {
  const key = JSON.stringify([source, frontmatter, execution]);
  if (!builds.has(key)) builds.set(key, (async () => {
    const root = await mkdtemp(join(tmpdir(), 'myst-test-engine-'));
    directories.add(root);
    const rootUrl = pathToFileURL(root + '/');
    await writeFile(join(root, 'index.md'), Object.keys(frontmatter).length
      ? `---\n${stringify(frontmatter)}---\n\n${source}` : source);
    await writeFile(join(root, 'myst.yml'), 'version: 1\nproject:\n  title: Test document\n  toc:\n    - file: index.md\n');
    const engine = registerEngine({ root: rootUrl, srcDir: rootUrl,
      cacheDir: new URL('.astro/', rootUrl), base: '/', trailingSlash: 'always' }, {
      myst: { source: rootUrl }, execution: { cwd: root, ...execution },
    });
    await buildEngine(engine);
    const pages = await enginePages(engine);
    if (pages.length !== 1) throw new Error(`Expected one test document, received ${pages.length}`);
    return { engine, ...pages[0] };
  })().catch(error => { builds.delete(key); throw error; }));
  return builds.get(key);
}

/** Presentation rerenders share resolved documents, without another kernel. */
export async function renderEnginePage(source, frontmatter = {}, options = {}) {
  const { interactive = false, presentation = {}, base = '/', stripTitle = false, ...execution } = options;
  const { engine, page, frontmatter: metadata } = await compiled(source, frontmatter, execution);
  return renderPage(page, { root: engine.root, interactive, presentation, base, stripTitle,
    frontmatter: metadata,
    resolvePageUrl: slug => engine.routes.get(slug) ?? engine.routes.get(slug.replace(/^\/+|\/+$/g, '')),
    readAsset: path => readFile(join(engine.site, 'public', path.replace(/^\//, ''))),
  });
}

export async function renderEngine(source, frontmatter = {}, options = {}) {
  return (await renderEnginePage(source, frontmatter, options)).html;
}
