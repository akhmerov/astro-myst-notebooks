import { Widget } from '@lumino/widgets';
import { toHtml } from 'hast-util-to-html';
import { mimePriority, renderOutput } from '../mime.mjs';
import { renderPlots } from './plots.js';
import { publishOutput } from '../presentation.js';
import type { PresentationOptions } from './types.js';

// A JupyterLab renderer factory lets Thebe reuse the static site's MIME policy.
class NotebookOutput extends Widget {
  private mounted!: () => void;
  private attachment = new Promise<void>(resolve => { this.mounted = resolve; });
  private revision = 0;

  protected onAfterAttach() { this.mounted(); }
  dispose() { this.mounted(); super.dispose(); }

  async renderModel(model: { data: Record<string, unknown>; metadata: Record<string, unknown> }) {
    const revision = ++this.revision;
    // OutputArea calls renderModel before attaching the widget to its cell.
    await this.attachment;
    if (this.isDisposed || revision !== this.revision) return;
    const cell = this.node.closest<HTMLElement>('.jupyter-cell');
    if (!cell?.dataset.presentation) throw new Error('Missing notebook presentation policy');
    const policy = JSON.parse(cell.dataset.presentation) as Required<PresentationOptions>;
    const error = model.data['application/vnd.jupyter.error'];
    const stream = ['stdout', 'stderr'].find(name => Object.hasOwn(model.data, `application/vnd.jupyter.${name}`));
    const output = error ? error as { output_type: string }
      : stream ? { output_type: 'stream', name: stream, text: model.data[`application/vnd.jupyter.${stream}`] }
      : { output_type: 'display_data', data: model.data, metadata: model.metadata };
    const suppressed = !publishOutput(output, policy);
    this.node.classList.toggle('jupyter-output-suppressed', suppressed);
    if (suppressed) { this.node.replaceChildren(); return; }
    const html = toHtml(await renderOutput(output));
    if (this.isDisposed || revision !== this.revision) return;
    this.node.innerHTML = html;
    await renderPlots(this.node);
  }
}

export const notebookRenderer = {
  safe: false,
  mimeTypes: [...mimePriority, 'application/vnd.jupyter.error', 'application/vnd.jupyter.stdout', 'application/vnd.jupyter.stderr'],
  createRenderer: () => new NotebookOutput(),
};
