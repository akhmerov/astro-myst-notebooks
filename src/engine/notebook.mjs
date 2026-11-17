import { createHash } from 'node:crypto';
import { visit } from 'unist-util-visit';
import { resolvePresentation, publishOutput } from '../presentation.js';

const element = (type, tag, properties, children = []) => ({ type, data: { hName: tag, hProperties: properties }, children });

// Translate already executed MyST cells into our existing browser runtime's
// markup. No executor is invoked here; the document compiler has already computed
// all static outputs before this adapter runs.
export function presentNotebooks({ interactive = true, presentation = {} } = {}) {
  return (tree, file) => {
    const metadata = file.data.astro?.frontmatter ?? {};
    const cells = [];
    visit(tree, 'block', (node, index, parent) => {
      if (node.kind === 'notebook-code') {
        if (!node.children?.find(child => child.type === 'code')) file.fail('Notebook block has no executable source');
        cells.push({ node, parent });
      }
    });
    for (const [index, { node, parent }] of cells.entries()) {
      const code = node.children.find(child => child.type === 'code');
      const outputs = node.children.find(child => child.type === 'outputs');
      const tags = node.data?.astroNotebookTags ?? node.data?.tags ?? [];
      const policy = resolvePresentation(presentation, metadata.presentation, tags);
      const group = (part, label, children) => element('jupyterGroup', policy[part] === 'hide' ? 'details' : 'div', {
        className: [`jupyter-${part}-area`, ...(policy[part] === 'hide' ? [`jupyter-${part}-disclosure`] : [])],
        hidden: policy[part] === 'remove',
      }, [...(policy[part] === 'hide' ? [element('jupyterSummary', 'summary', {}, [{ type: 'text', value: label }])] : []), ...children]);
      const input = element('jupyterInputGroup', 'div', { className: ['jupyter-static-input'] },
        policy.cell === 'remove' || policy.input === 'remove' ? [] : [code]);
      const bundles = (outputs?.children ?? []).map(output => output.jupyter_data);
      if (bundles.some(bundle => !bundle)) file.fail('Every computed MyST output must contain Jupyter data');
      const output = element('jupyterOutputGroup', 'div', { className: ['jupyter-outputs'] },
        bundles.filter(bundle => publishOutput(bundle, policy)).map(bundle => element('jupyterOutput', 'jupyter-output', { bundle })));
      parent.children[parent.children.indexOf(node)] = element('jupyterCell', 'div', {
        className: ['jupyter-cell'], dataSource: code.value,
        dataCellId: createHash('sha256').update(`${file.path}:${index}:${code.value}`).digest('hex').slice(0, 32),
        dataTags: tags.length ? tags.join(' ') : undefined,
        dataOrigin: code.data?.origin ? JSON.stringify(code.data.origin) : undefined,
        dataPresentation: JSON.stringify(policy), hidden: policy.cell === 'remove',
        id: node.html_id ?? node.identifier,
      }, [group('cell', 'Show cell', [group('input', 'Show code', [input]), group('output', 'Show output', [output])])]);
    }
    // Output-only embeds have no executable cell. Render them without adding
    // interactive controls or executing the producer a second time.
    visit(tree, 'outputs', node => {
      node.type = 'jupyterOutputGroup';
      node.data = { hName: 'div', hProperties: { className: ['jupyter-outputs'] } };
      node.children = node.children.map(output => element('jupyterOutput', 'jupyter-output', { bundle: output.jupyter_data }));
    });
    if (!cells.length || !interactive || metadata.thebe === false) return;
    const button = (attribute, label, hidden = false) => element('notebookButton', 'button', {
      type: 'button', [attribute]: '', hidden, disabled: attribute === 'dataThebeActivate',
    }, [element('notebookButtonLabel', 'span', {}, [{ type: 'text', value: label }])]);
    const controls = element('notebookControls', 'div', { className: ['live-controls'], dataThebeControls: '' }, [
      element('notebookActions', 'div', { className: ['live-actions'] }, [
        button('dataThebeActivate', 'Enable interactivity'), button('dataThebeRunAll', 'Run all', true),
        button('dataThebeReset', 'Restart Python', true),
      ]), element('notebookStatus', 'span', { role: 'status', ariaLive: 'polite' }),
    ]);
    tree.children = [element('notebook', 'jupyter-notebook', {}, [controls, ...tree.children])];
  };
}

// MyST stores MIME values as {content, content_type} or asset paths. Restore
// nbformat bundles for the existing MIME renderer, including binary figures.
export async function hydrateOutput(bundle, fetchAsset) {
  if (!bundle || typeof bundle !== 'object') throw new Error('MyST output has no Jupyter data');
  const output = structuredClone(bundle);
  if (output.data) for (const [mime, value] of Object.entries(output.data)) {
    const type = mime.split(';', 1)[0].trim().toLowerCase();
    const json = type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
    const textual = json || type.startsWith('text/') || type === 'image/svg+xml'
      || ['application/javascript', 'application/ecmascript', 'application/xml'].includes(type) || type.endsWith('+xml');
    if (value && typeof value === 'object' && ('content' in value || 'path' in value || 'hash' in value)) {
      let content = value.content;
      if (value.path) {
        if (!fetchAsset) throw new Error(`No asset reader supplied for MyST output: ${value.path}`);
        const response = await fetchAsset(value.path);
        content = textual ? await response.text() : Buffer.from(await response.arrayBuffer()).toString('base64');
      }
      if (content === undefined) throw new Error(`MyST output has no published content: ${mime}`);
      output.data[mime] = json ? JSON.parse(content) : content;
    }
  }
  if (output.path && ['stream', 'error'].includes(output.output_type)) {
    if (!fetchAsset) throw new Error(`No asset reader supplied for MyST output: ${output.path}`);
    output[output.output_type === 'stream' ? 'text' : 'traceback'] = await (await fetchAsset(output.path)).text();
  }
  if (output.output_type === 'error' && typeof output.traceback === 'string') output.traceback = output.traceback.split('\n');
  return output;
}
