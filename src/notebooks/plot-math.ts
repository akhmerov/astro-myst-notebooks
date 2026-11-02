/** Plotly recognizes dollar-delimited TeX in titles, ticks, legends and annotations. */
export function needsPlotMath(value: unknown): boolean {
  if (typeof value === 'string') return /\$+[^$]+\$+/.test(value);
  return !!value && typeof value === 'object' && Object.values(value).some(needsPlotMath);
}

type MathJaxRuntime = {
  version?: string;
  startup?: { promise?: Promise<void> };
  _?: { output?: { svg_ts?: unknown } };
};
const global = globalThis as typeof globalThis & { MathJax?: MathJaxRuntime };
let loading: Promise<void> | undefined;

/** Use the local SVG component only for plots; KaTeX continues to own document math. */
export function loadPlotMath(): Promise<void> {
  return loading ??= (async () => {
    if (!global.MathJax?.version) {
      Object.assign(global.MathJax ??= {}, {
        startup: { typeset: false },
        options: { enableMenu: false },
        svg: { fontCache: 'local' },
        // The full component includes TeX extensions. Do not fetch arbitrary
        // extensions (or anything from a CDN) in response to authored labels.
        tex: { packages: { '[-]': ['autoload', 'require'] } },
        loader: { paths: { mathjax: new URL('./', import.meta.url).href } },
      });
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('./mathjax-tex-svg.js', import.meta.url).href;
        script.onload = () => resolve();
        script.onerror = () => { script.remove(); reject(new Error('Could not load Plotly math labels.')); };
        document.head.append(script);
      });
    }
    await global.MathJax?.startup?.promise;
    if (!/^[34]\./.test(global.MathJax?.version ?? '') || !global.MathJax?._?.output?.svg_ts) {
      throw new Error('Plotly math labels require MathJax 3 or 4 with its SVG renderer.');
    }
  })().catch(error => { loading = undefined; throw error; });
}
