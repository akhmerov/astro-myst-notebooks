import { needsPlotMath, loadPlotMath } from './plot-math.js';

export async function renderPlots(root: ParentNode = document) {
  const elements = root.querySelectorAll<HTMLElement>('[data-plotly]:not([data-rendered])');
  if (!elements.length) return;
  const { default: Plotly } = await import('plotly.js-dist-min');
  for (const element of elements) {
    const figure = JSON.parse(element.dataset.plotly!);
    let typesetMath = figure.config?.typesetMath !== false;
    if (typesetMath && needsPlotMath(figure)) {
      try { await loadPlotMath(); }
      catch (error) {
        // A failed optional label download must not make the whole chart blank.
        console.warn('Could not typeset Plotly math labels; rendering plain text.', error);
        typesetMath = false;
      }
    }
    // Plotly's SVG and WebGL wrappers use percentage heights. A min-height
    // alone leaves those wrappers with zero height in an auto-sized output.
    element.style.height = `${figure.layout?.height ?? 420}px`;
    await Plotly.newPlot(element, figure.data, { ...figure.layout, autosize: true }, {
      responsive: true, displaylogo: false, ...figure.config, typesetMath,
    });
    element.dataset.rendered = 'true';
  }
}
