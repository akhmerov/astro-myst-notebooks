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
    // MyST frontmatter `execute.skip` (formerly `skip_execution`) publishes the
    // page's cells without running them; the skip-execution tag does so per cell.
    const skipPage = metadata.execute?.skip === true || metadata.skip_execution === true;
    const sources = cells.map(({ node, parent }, index) => ({
      id: createHash('sha256').update(`${file.path}:${index}:${node.value}`).digest('hex').slice(0, 32),
      source: node.value, origin: node.data?.origin, tags: [...(parent.data?.tags ?? [])],
    }));
    const executed = sources.filter(source => !skipPage && !source.tags.includes('skip-execution'));
    // Outputs by cell index; skipped cells publish their input only.
    const results = new Map();
    if (executed.length) {
      const key = JSON.stringify([file.path, executed, execution]);
      let notebook;
      try {
        if (!notebooks.has(key)) {
          notebooks.set(key, executePage(executed, execution));
          console.info(`[jupyter] ${file.path}: executing ${executed.length} cells`);
        }
        notebook = await notebooks.get(key);
      } catch (error) {
        notebooks.delete(key);
        file.fail(`${error.cell?.origin?.file ?? file.path}: ${error.message}`, error.cell?.origin?.position);
      }
      executed.forEach((source, index) => results.set(sources.indexOf(source), notebook.cells[index].outputs));
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
          const published = (results.get(i) ?? []).filter(bundle => bundle.output_type !== 'stream' || !flags.has(`remove-${bundle.name}`));
          for (const bundle of published) replacement.push({
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
          dataTags: sources[i].tags.length ? sources[i].tags.join(' ') : undefined,
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
    if (interactive && metadata.thebe !== false) {
      const element = (type, tag, properties, children) => ({
        type, data: { hName: tag, hProperties: properties }, children,
      });
      const button = (attribute, label, hidden = false) => element('notebookButton', 'button', {
        type: 'button', [attribute]: '', hidden, disabled: attribute === 'dataThebeActivate',
        title: attribute === 'dataThebeActivate' ? 'Enable editing and running without executing cells'
          : attribute === 'dataThebeRunAll' ? 'Run all cells in Python in your browser'
          : 'Restart Python: clear state and keep your edits',
      }, [element('notebookButtonLabel', 'span', {}, [{ type: 'text', value: label }])]);
      const controls = element('notebookControls', 'div', { className: ['live-controls'], dataThebeControls: '' }, [
        element('notebookActions', 'div', { className: ['live-actions'] }, [
          button('dataThebeActivate', 'Enable interactivity'),
          button('dataThebeRunAll', 'Run all', true),
          button('dataThebeReset', 'Restart Python', true),
        ]),
        element('notebookStatus', 'span', { role: 'status', ariaLive: 'polite' }, []),
      ]);
      tree.children = [element('notebook', 'jupyter-notebook', {}, [controls, ...tree.children])];
    }

  };
}
