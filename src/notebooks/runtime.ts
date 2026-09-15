import type { ThebeGlobal } from 'thebe';
import type { ThebeNotebook, ThebeServer, ThebeSession, ThebeEventCb } from 'thebe-core';
import type { BrowserOptions } from './types.js';

let runtime: Promise<ThebeGlobal> | undefined;
let disposeXeus: typeof import('./xeus-server.js').disposeXeusServer | undefined;

function script(src: string, timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      tag.remove();
      reject(new Error('Could not download the Python runtime. Check your connection and retry.'));
    };
    const timer = setTimeout(fail, timeout);
    tag.src = src;
    tag.onload = () => { clearTimeout(timer); resolve(); };
    tag.onerror = fail;
    document.head.append(tag);
  });
}

export function loadRuntime(options: BrowserOptions): Promise<ThebeGlobal> {
  return runtime ??= (async () => {
    if (!document.getElementById('jupyter-config-data')) {
      const config = document.createElement('script');
      config.id = 'jupyter-config-data';
      config.type = 'application/json';
      config.textContent = JSON.stringify({
        baseUrl: options.assetBase + '/', appVersion: 'astro-myst-notebooks', enableServiceWorkerCache: false,
      });
      document.head.append(config);
    }
    if (!document.querySelector('[data-thebe-styles]')) {
      const css = document.createElement('link');
      css.dataset.thebeStyles = '';
      css.rel = 'stylesheet';
      css.href = `${options.assetBase}/thebe.css`;
      document.head.append(css);
    }
    const provider = await import('./xeus-server.js');
    disposeXeus = provider.disposeXeusServer;
    window.thebeLite = {
      version: 'xeus-5.1.0',
      startJupyterLiteServer: () => provider.startXeusServer(options.assetBase),
    };
    await script(`${options.assetBase}/index.js`, options.startupTimeout);
    return window.thebe;
  })().catch(error => { runtime = undefined; throw error; });
}

/** Dispose the service manager and the Xeus application it owns. */
function disposeServer(server: ThebeServer) {
  try { server.dispose(); }
  finally { if (server.serviceManager) disposeXeus?.(server.serviceManager); }
}

/** A deadline bounds the UI even if an upstream shutdown promise never settles. */
async function bounded<T>(operation: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Kernel cleanup timed out. Retry to start a new session.')), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

/** Delete the Lite kernel through its REST API, which terminates its worker.
 * This does not queue a Python command behind the running cell.
 */
async function releaseSession(session: ThebeSession, server?: ThebeServer) {
  try {
    const kernel = session.kernel;
    if (kernel) await bounded(server?.serviceManager
      ? server.serviceManager.kernels.shutdown(kernel.id)
      : kernel.shutdown());
    await bounded(session.shutdown());
  } finally { session.dispose(); }
}

/** Own the handles returned by Thebe, never look them up in mutable globals. */
export class NotebookSession {
  private server?: ThebeServer;
  private notebook?: ThebeNotebook;
  private session?: ThebeSession;
  private unbind?: () => void;
  private closed = false;
  private generation = 0;

  constructor(private options: BrowserOptions) {}

  async start(root: HTMLElement, onStatus: ThebeEventCb, onSetup: () => void, onMount: () => void) {
    const thebe = await loadRuntime(this.options);
    if (this.closed) return;
    const { notebookRenderer } = await import('./live-mime.js');
    if (this.closed) return;
    // requestKernel:false exposes the server/notebook before waiting for startup,
    // so navigation or timeout can release them even while Lite is loading.
    const handles = await thebe.bootstrap({
      useBinder: false, useJupyterLite: true, requestKernel: false,
      selector: `#${root.id} [data-executable]`, outputSelector: `#${root.id} .jupyter-live-output`,
      mountActivateWidget: false, mountStatusWidget: false,
      mountRunAllButton: false, mountRestartButton: false, mountRestartAllButton: false,
      codeMirrorConfig: { lineNumbers: true }, kernelOptions: { kernelName: this.options.kernelName },
    }) as { server: ThebeServer; notebook: ThebeNotebook };
    this.server = handles.server;
    this.notebook = handles.notebook;
    if (this.closed) { await this.dispose(); return; }
    onMount();
    this.notebook.rendermime.addFactory(notebookRenderer, -10);
    thebe.on('status', onStatus);
    this.unbind = () => thebe.off('status', onStatus);
    await this.server.ready;
    if (this.closed) return;
    await this.newSession(onSetup);
  }

  private async newSession(onSetup: () => void) {
    const session = await this.server!.startNewSession(this.notebook!.rendermime);
    if (!session?.kernel) throw new Error('The browser kernel could not start. Please retry.');
    if (this.closed) { await releaseSession(session, this.server); return; }
    this.session = session;
    this.notebook!.attachSession(session);
    onSetup();
    const code = [
      ...(this.options.wheelPath ? ['import sys', `sys.path.insert(0, ${JSON.stringify(this.options.wheelPath)})`] : []),
      this.options.setup,
    ].filter(Boolean).join('\n');
    if (!code) return;
    const future = session.kernel.requestExecute({ code });
    try {
      const reply = await future.done;
      if (reply.content.status !== 'ok') throw new Error('Python package setup failed. Check your connection and retry.');
    } finally { future.dispose(); }
  }

  cellIndex(id?: string) { return this.notebook?.cells.findIndex(cell => cell.id === id) ?? -1; }

  async runAll() {
    const generation = this.generation;
    for (const cell of this.notebook!.cells) {
      if (this.closed || generation !== this.generation) return;
      const result = await cell.execute();
      if (!result || result.error?.length) throw new Error('A cell failed. Fix the error shown below and run again.');
    }
  }

  async reset(onSetup: () => void) {
    this.generation++;
    this.notebook!.detachSession();
    const session = this.session;
    this.session = undefined;
    if (session) await releaseSession(session, this.server);
    if (!this.closed) await this.newSession(onSetup);
  }

  async dispose() {
    this.closed = true;
    this.generation++;
    this.unbind?.();
    this.unbind = undefined;
    this.notebook?.detachSession();
    // Transfer ownership once: repeated cleanup calls must not shut down the
    // same session twice. Thebe.shutdown() already disposes its connection.
    const session = this.session;
    const server = this.server;
    this.session = undefined;
    this.server = undefined;
    try { if (session) await releaseSession(session, server); }
    finally {
      // Lite assigns its managers asynchronously. Disposing too early sets
      // Thebe's disposed flag before those managers exist, leaving them alive.
      if (server?.isReady) disposeServer(server);
      else if (server) void server.ready.then(() => disposeServer(server), () => disposeServer(server))
        .catch(error => console.warn('Late notebook cleanup failed', error));
    }
  }
}
