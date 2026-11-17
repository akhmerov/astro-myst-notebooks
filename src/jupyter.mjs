import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const contract = JSON.parse(readFileSync(new URL('./execution-contract.json', import.meta.url)));

function requestPython(request, { python = 'python', cwd, timeout = 120, pixi,
  deadline: deadlineSeconds = (request.cells?.length ?? 0) * timeout + 90 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
      reject(new Error('Jupyter timeout and deadline must be positive seconds'));
      return;
    }
    const child = spawn(python, [fileURLToPath(new URL('./execute.py', import.meta.url))], {
      cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, ASTRO_MYST_CONTROL_FD: '3', MPLBACKEND: 'module://matplotlib_inline.backend_inline', PLOTLY_RENDERER: 'plotly_mimetype' },
    });
    const kernels = new Map();
    let control = '';
    child.stdio[3].setEncoding('utf8').on('data', chunk => {
      control += chunk;
      let end;
      while ((end = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, end); control = control.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!Number.isSafeInteger(message.pid) || message.pid <= 0) continue;
          if (message.event === 'kernel-started') kernels.set(message.pid, message.pgid);
          if (message.event === 'kernel-stopped') kernels.delete(message.pid);
        } catch { /* The private control stream carries no document data. */ }
      }
    });
    const terminateKernels = () => {
      for (const [pid, pgid] of kernels) {
        try { process.kill(process.platform !== 'win32' && Number.isSafeInteger(pgid) && pgid > 0 ? -pgid : pid, 'SIGKILL'); } catch {}
      }
      kernels.clear();
    };
    // The kernel has its own process group. Terminate it directly before its
    // adapter, including if nbclient startup/cleanup or a native call hangs.
    const deadline = setTimeout(() => {
      terminateKernels();
      if (child.pid) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
      reject(new Error('Jupyter process deadline exceeded'));
    }, deadlineSeconds * 1000);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(deadline);
      terminateKernels();
      if (code === 124) return reject(new Error('Jupyter process deadline exceeded'));
      if (code !== 0) return reject(new Error(`Jupyter execution failed (${code}):\n${stderr}`));
      try {
        const response = JSON.parse(stdout);
        if (response.protocol !== contract.protocol) throw new Error('Incompatible Jupyter execution protocol');
        if (response.error) throw Object.assign(new Error(response.error.message), { cell: response.error.cell, name: response.error.name });
        resolve(response);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ protocol: contract.protocol, cwd, timeout, deadline: deadlineSeconds,
      pixi: pixi && { ...pixi, manifest: pixi.manifest instanceof URL ? fileURLToPath(pixi.manifest) : pixi.manifest },
      ...request,
    }));
  });
}

export function checkEnvironment(options) { return requestPython({ operation: 'check' }, options); }

/** Run cells and inline expressions in authored order; returns the notebook and expression results by id. */
export async function executeDocument(items, options) {
  const prepared = items.map((item, index) => typeof item === 'string' ? {
    id: createHash('sha256').update(`${index}:${item}`).digest('hex').slice(0, 32), source: item,
  } : item);
  return requestPython({ operation: 'execute', cells: prepared }, options);
}

export async function executePage(cells, options) { return (await executeDocument(cells, options)).notebook; }
