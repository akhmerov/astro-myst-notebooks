import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';

// Astro can compile a page for both server and client. Reuse its execution
// within this process; a new build process always starts with an empty cache.
const notebooks = new Map();

const contract = JSON.parse(readFileSync(new URL('./execution-contract.json', import.meta.url)));

function requestPython(request, { python = 'python', cwd, timeout = 120, pixi } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./execute.py', import.meta.url))], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, MPLBACKEND: 'module://matplotlib_inline.backend_inline', PLOTLY_RENDERER: 'plotly_mimetype' },
    });
    // nbclient owns normal shutdown. This deadline also covers hung startup/cleanup.
    const deadline = setTimeout(() => {
      if (child.pid) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
      reject(new Error('Jupyter process deadline exceeded'));
    }, ((request.cells?.length ?? 0) * timeout + 90) * 1000);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(deadline);
      if (code !== 0) return reject(new Error(`Jupyter execution failed (${code}):\n${stderr}`));
      try {
        const response = JSON.parse(stdout);
        if (response.protocol !== contract.protocol) throw new Error('Incompatible Jupyter execution protocol');
        if (response.error) throw Object.assign(new Error(response.error.message), { cell: response.error.cell, name: response.error.name });
        resolve(response);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ protocol: contract.protocol, cwd, timeout,
      pixi: pixi && { ...pixi, manifest: pixi.manifest instanceof URL ? fileURLToPath(pixi.manifest) : pixi.manifest },
      ...request,
    }));
  });
}

export function checkEnvironment(options) { return requestPython({ operation: 'check' }, options); }

export async function executePage(cells, options) {
  const prepared = cells.map((cell, index) => typeof cell === 'string' ? {
    id: createHash('sha256').update(`${index}:${cell}`).digest('hex').slice(0, 32), source: cell,
  } : cell);
  return (await requestPython({ operation: 'execute', cells: prepared }, options)).notebook;
}

export function remarkJupyter({ interactive = false, ...options } = {}) {
  return async (tree, file) => {
    const metadata = file.data.astro?.frontmatter ?? {};
    const execution = metadata.kernelspec && file.path ? { ...options, cwd: dirname(file.path) } : options;
    const cells = [];
    visit(tree, 'code', (node, index, parent) => {
      if (node.executable) {
        if (node.lang && node.lang !== 'python') file.fail(`Unsupported execution language: ${node.lang}`);
        cells.push({ node, parent });
      }
    });
    if (!cells.length) return;
    let notebook;
    const sources = cells.map(({ node }, index) => ({
      id: createHash('sha256').update(`${file.path}:${index}:${node.value}`).digest('hex').slice(0, 32),
      source: node.value, origin: node.data?.origin,
    }));
    const key = JSON.stringify([file.path, sources, execution]);
    try {
      if (!notebooks.has(key)) {
        notebooks.set(key, executePage(sources, execution));
        console.info(`[jupyter] ${file.path}: executing ${cells.length} cells`);
      }
      notebook = await notebooks.get(key);
    } catch (error) {
      notebooks.delete(key);
      file.fail(`${error.cell?.origin?.file ?? file.path}: ${error.message}`, error.cell?.origin?.position);
    }
    for (let i = cells.length - 1; i >= 0; i--) {
      const { node, parent } = cells[i];
      const flags = new Set(parent.data?.tags ?? []);
      if (flags.has('remove-cell')) flags.add('hide-cell');
      if (flags.has('remove-output')) flags.add('hide-output');
      const replacement = [];
      if (!flags.has('hide-cell')) {
        if (!flags.has('hide-input') && !flags.has('remove-input')) replacement.push(node);
        else if (!flags.has('remove-input')) replacement.push({
          type: 'jupyterInput',
          data: { hName: 'details', hProperties: { className: ['jupyter-input'] } },
          children: [
            { type: 'jupyterSummary', data: { hName: 'summary' }, children: [{ type: 'text', value: 'Show code' }] },
            node,
          ],
        });
        if (!flags.has('hide-output')) {
          for (const bundle of notebook.cells[i].outputs) replacement.push({
            type: 'jupyterOutput', data: { hName: 'jupyter-output', hProperties: { bundle } }, children: [],
          });
        }
      }
      // Retain every authored cell (including hidden setup) for Thebe. The
      // browser consumes this source, never text scraped from highlighted HTML.
      const input = replacement.filter(child => child.type !== 'jupyterOutput');
      const outputs = replacement.filter(child => child.type === 'jupyterOutput');
      parent.children.splice(parent.children.indexOf(node), 1, {
        type: 'jupyterCell',
        data: { hName: 'div', hProperties: {
          className: ['jupyter-cell'], dataSource: node.value, dataCellId: sources[i].id,
          dataOrigin: node.data?.origin ? JSON.stringify(node.data.origin) : undefined,
          hidden: flags.has('hide-cell'),
          dataHideOutput: flags.has('hide-output') ? 'true' : 'false',
        } },
        children: [
          { type: 'jupyterInputGroup', data: { hName: 'div', hProperties: { className: ['jupyter-static-input'] } }, children: input },
          { type: 'jupyterOutputGroup', data: { hName: 'div', hProperties: { className: ['jupyter-outputs'] } }, children: outputs },
        ],
      });
    }
    if (interactive) {
      const element = (type, tag, properties, children) => ({
        type, data: { hName: tag, hProperties: properties }, children,
      });
      const button = (attribute, label, hidden = false) => element('notebookButton', 'button', {
        type: 'button', [attribute]: '', hidden,
      }, [{ type: 'text', value: label }]);
      const controls = element('notebookControls', 'div', { className: ['live-controls'], dataThebeControls: '' }, [
        button('dataThebeActivate', 'Run interactively'),
        button('dataThebeRunAll', 'Run all', true),
        button('dataThebeReset', 'Reset session', true),
        element('notebookStatus', 'span', { role: 'status', ariaLive: 'polite' }, [
          { type: 'text', value: 'Edit and run Python in your browser.' },
        ]),
      ]);
      tree.children = [element('notebook', 'jupyter-notebook', {}, [controls, ...tree.children])];
    }

  };
}
