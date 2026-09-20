export async function renderPlots(root: ParentNode = document) {
  const elements = root.querySelectorAll<HTMLElement>('[data-plotly]:not([data-rendered])');
  if (!elements.length) return;
  const { default: Plotly } = await import('plotly.js-dist-min');
  for (const element of elements) {
    const figure = JSON.parse(element.dataset.plotly!);
    // Plotly's SVG and WebGL wrappers use percentage heights. A min-height
    // alone leaves those wrappers with zero height in an auto-sized output.
    element.style.height = `${figure.layout?.height ?? 420}px`;
    await Plotly.newPlot(element, figure.data, { ...figure.layout, autosize: true }, {
      responsive: true, displaylogo: false, ...figure.config,
    });
    element.dataset.rendered = 'true';
  }
}
