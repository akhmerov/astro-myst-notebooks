import options from 'virtual:notebook-options';
import { NotebookSession } from './runtime.js';
import type { ThebeEventCb } from 'thebe-core';

type State = 'idle' | 'loading' | 'ready' | 'running' | 'resetting' | 'error' | 'disposed';

/** One controller per rendered notebook, with explicit lifecycle and state. */
class JupyterNotebook extends HTMLElement {
  private state: State = 'disposed';
  private listeners = new AbortController();
  private session?: NotebookSession;
  private cells: HTMLElement[] = [];
  private original: string[] = [];
  private operation = 0;
  private busy = new Set<string>();
  private controls!: HTMLElement;
  private activateButton!: HTMLButtonElement;
  private runButton!: HTMLButtonElement;
  private resetButton!: HTMLButtonElement;
  private status!: HTMLElement;

  connectedCallback() {
    if (this.state !== 'disposed') return;
    this.id ||= `notebook-${crypto.randomUUID()}`;
    this.listeners = new AbortController();
    this.cells = Array.from(this.querySelectorAll<HTMLElement>('.jupyter-cell'));
    this.original = this.cells.map(cell => cell.innerHTML);
    this.controls = this.querySelector('[data-thebe-controls]')!;
    this.activateButton = this.querySelector('[data-thebe-activate]')!;
    this.runButton = this.querySelector('[data-thebe-run-all]')!;
    this.resetButton = this.querySelector('[data-thebe-reset]')!;
    this.status = this.querySelector('[role="status"]')!;
    const { signal } = this.listeners;
    this.activateButton.addEventListener('click', () => void this.activate(), { signal });
    this.runButton.addEventListener('click', () => void this.runAll(), { signal });
    this.resetButton.addEventListener('click', () => void this.reset(), { signal });
    // Thebe also binds keyboard execution; prevent it during setup/reset/run-all.
    this.addEventListener('keydown', event => {
      if ((this.state !== 'ready' || this.busy.size > 0) && event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, { signal, capture: true });
    window.addEventListener('pagehide', () => this.disconnectedCallback(), { signal, once: true });
    this.setState('idle', 'Edit and run Python in your browser.');
  }

  disconnectedCallback() {
    if (this.state === 'disposed') return;
    this.operation++;
    this.listeners.abort();
    this.setState('disposed', '');
    void this.session?.dispose().catch(() => {});
    this.session = undefined;
    this.restore();
  }

  private restore() {
    this.cells.forEach((cell, index) => { cell.innerHTML = this.original[index]!; });
    this.busy.clear();
  }

  private setState(state: State, message?: string) {
    this.state = state;
    this.controls.dataset.state = state;
    if (message !== undefined) this.status.textContent = message;
    const active = state === 'ready' || state === 'running' || state === 'resetting';
    this.activateButton.hidden = active;
    this.activateButton.disabled = state === 'loading';
    this.activateButton.textContent = state === 'error' ? 'Retry interactive mode' : 'Run interactively';
    this.runButton.hidden = this.resetButton.hidden = !active;
    this.runButton.disabled = state !== 'ready' || this.busy.size > 0;
    this.resetButton.disabled = state !== 'ready' && state !== 'running';
    this.querySelectorAll<HTMLButtonElement>('.thebe-button').forEach(button => { button.disabled = state !== 'ready' || this.busy.size > 0; });
  }

  private onStatus: ThebeEventCb = (_event, data) => {
    if (this.state === 'disposed' || this.state === 'resetting' || data.subject !== 'cell' || !data.id) return;
    const index = this.session?.cellIndex(data.id) ?? -1;
    if (index < 0) return; // Ignore events from another notebook.
    if (data.status === 'executing') {
      this.busy.add(data.id);
      this.cells[index]!.querySelector<HTMLElement>('.jupyter-outputs')!.hidden = true;
    } else if (data.status === 'idle') this.busy.delete(data.id);
    this.setState(this.state);
  };

  private async startup(operation: Promise<void>) {
    const signal = this.listeners.signal;
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    try {
      await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new DOMException('Notebook detached', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Python startup timed out. Check your connection and retry.')), options.startupTimeout);
      })]);
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener('abort', abort!);
    }
  }

  private async fail(error: unknown, session: NotebookSession) {
    void session.dispose().catch(error => console.warn('Notebook cleanup failed', error));
    if (this.session !== session || this.state === 'disposed') return;
    this.restore();
    this.session = undefined;
    this.setState('error', error instanceof Error ? error.message : 'Python could not start. Please retry.');
  }

  private async activate() {
    if (this.state !== 'idle' && this.state !== 'error') return;
    this.setState('loading', 'Starting Python… The first download can take a minute.');
    for (const cell of this.cells) {
      const source = document.createElement('pre');
      source.dataset.executable = 'true';
      source.dataset.language = 'python';
      source.textContent = cell.dataset.source!;
      cell.querySelector('.jupyter-static-input')!.replaceWith(source);
      const output = document.createElement('div');
      output.className = 'jupyter-live-output';
      output.hidden = cell.dataset.hideOutput === 'true';
      cell.append(output);
    }
    const session = this.session = new NotebookSession(options);
    try {
      await this.startup(session.start(this, this.onStatus, () => {
        if (this.session === session && this.state !== 'disposed') this.setState('loading', 'Loading scientific Python packages…');
      }, () => this.setState(this.state)));
      if (this.session !== session) return;
      this.setState('ready', 'Python ready. Run all to initialize the examples, then edit any cell.');
    } catch (error) { await this.fail(error, session); }
  }

  private async runAll() {
    if (this.state !== 'ready' || this.busy.size) return;
    const session = this.session!;
    const operation = ++this.operation;
    this.setState('running', 'Running cells…');
    try {
      await session.runAll();
      if (this.session === session && this.operation === operation) this.setState('ready', 'All cells completed.');
    } catch (error) {
      if (this.session === session && this.operation === operation) this.setState('ready', error instanceof Error ? error.message : 'Execution failed.');
    }
  }

  private async reset() {
    if (this.state !== 'ready' && this.state !== 'running') return;
    this.operation++;
    this.busy.clear();
    const session = this.session!;
    this.setState('resetting', 'Resetting Python…');
    try {
      await this.startup(session.reset(() => {
        if (this.session === session) this.setState('resetting', 'Loading scientific Python packages…');
      }));
      if (this.session === session) this.setState('ready', 'Session reset. Run all to initialize the examples again.');
    } catch (error) { await this.fail(error, session); }
  }
}

if (!customElements.get('jupyter-notebook')) customElements.define('jupyter-notebook', JupyterNotebook);
// A browser back/forward cache restores the DOM without reconnecting elements.
window.addEventListener('pageshow', () => document.querySelectorAll<JupyterNotebook>('jupyter-notebook').forEach(node => node.connectedCallback()));
