import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { visit } from 'unist-util-visit';
import { executeDocument } from '../../dist/jupyter.mjs';

const frontmatter = source => parse(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1] ?? '') ?? {};

// MyST 1.11's document transform receives the tree and VFile, but not resolved
// frontmatter. This deliberately limited adapter handles one local project.
// It rereads settings on every invocation so a long-lived process cannot retain
// old Python execution results or page policy. It is a checkout-local prototype.
export function createDocumentExecution({ root = process.cwd(), python = 'python', timeout = 30, skip = false } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Execution timeout must be a positive number of seconds');
  if (typeof skip !== 'boolean') throw new Error('Execution skip must be a boolean');
  return {
    name: 'nbclient document execution (experimental)',
    transforms: [{
      name: 'nbclient-execution', stage: 'document',
      plugin: () => async (tree, file) => {
        if (process.argv.includes('--execute')) file.fail('Do not combine nbclient document execution with MyST --execute');
        const source = await readFile(file.path, 'utf8');
        const config = parse(await readFile(resolve(root, 'myst.yml'), 'utf8'));
        if (config.extends || config.project?.extends) file.fail('Experimental execution does not support inherited configuration');
        let page;
        if (file.path.endsWith('.ipynb')) {
          const notebook = JSON.parse(source);
          const first = notebook.cells.find(cell => cell.cell_type === 'markdown');
          page = { ...notebook.metadata, ...frontmatter(Array.isArray(first?.source) ? first.source.join('') : first?.source ?? '') };
        } else page = frontmatter(source);
        const kernel = page.kernelspec ?? page.jupyter?.kernelspec;
        if (kernel?.language && !['python', 'python3', 'ipython3'].includes(kernel.language)) {
          file.fail(`Unsupported execution language: ${kernel.language}`);
        }
        const policy = { skip, ...page.execute };
        const items = [];
        const targets = new Map();
        visit(tree, ['block', 'inlineExpression'], node => {
          if (node.type === 'block' && node.kind !== 'notebook-code') return;
          const code = node.type === 'block' ? node.children.find(child => child.type === 'code') : node;
          if (!code) file.fail('Notebook block has no executable source');
          if (node.type === 'block' && code.lang && !['python', 'python3', 'ipython3', 'pycon'].includes(code.lang)) {
            file.fail(`Unsupported execution language: ${code.lang}`);
          }
          const tags = node.data?.astroNotebookTags ?? node.data?.tags ?? [];
          if (policy.skip || tags.includes('skip-execution')) {
            if (node.type === 'inlineExpression') file.fail('Inline expressions need execution; remove execute.skip or the {eval} roles');
            // Match the package's existing publication contract: skipped cells
            // publish input, without retaining potentially stale saved outputs.
            const outputs = node.children.find(child => child.type === 'outputs');
            if (outputs) outputs.children = [];
            return;
          }
          const id = createHash('sha256').update(`${file.path}:${items.length}:${code.value}`).digest('hex').slice(0, 32);
          const item = { id, kind: node.type === 'inlineExpression' ? 'expression' : 'cell',
            source: code.value, tags, origin: code.data?.origin };
          items.push(item);
          targets.set(id, node);
        });
        if (!items.length) return;
        let response;
        try {
          response = await executeDocument(items, { python, timeout, cwd: dirname(file.path) });
        } catch (error) {
          file.fail(`${error.cell?.origin?.file ?? file.path}: ${error.message}`, error.cell?.origin?.position);
        }
        for (const item of items.filter(item => item.kind === 'expression')) {
          const result = response.expressions[item.id];
          targets.get(item.id).result = { status: 'ok', data: result.data, metadata: result.metadata };
        }
        for (const cell of response.notebook.cells) {
          const block = targets.get(cell.id);
          let outputs = block.children.find(child => child.type === 'outputs');
          if (!outputs) { outputs = { type: 'outputs', children: [] }; block.children.push(outputs); }
          outputs.children = cell.outputs.map((bundle, index) => ({ type: 'output', children: [], jupyter_data: bundle,
            ...(outputs.identifier ? { identifier: `${outputs.identifier}-${index}` } : {}) }));
        }
      },
    }],
  };
}

export default ['native', 'render'].includes(process.env.MYST_THEME_EXECUTION) ? { name: 'external execution', transforms: [] } : createDocumentExecution({
  python: process.env.MYST_EXECUTION_PYTHON ?? 'python',
  timeout: Number(process.env.MYST_EXECUTION_TIMEOUT ?? 30),
});
