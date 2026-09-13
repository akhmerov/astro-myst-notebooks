import { Widget } from '@lumino/widgets';
import { toHtml } from 'hast-util-to-html';
import { mimePriority, renderOutput } from '../mime.mjs';
import { renderPlots } from './plots.js';

// A JupyterLab renderer factory lets Thebe reuse the static site's MIME policy.
class NotebookOutput extends Widget {
  async renderModel(model: { data: Record<string, unknown>; metadata: Record<string, unknown> }) {
    this.node.innerHTML = toHtml(await renderOutput({
      output_type: 'display_data', data: model.data, metadata: model.metadata,
    }));
    await renderPlots(this.node);
  }
}

export const notebookRenderer = {
  safe: false,
  mimeTypes: mimePriority,
  createRenderer: () => new NotebookOutput(),
};
