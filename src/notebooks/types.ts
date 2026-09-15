export interface BrowserOptions {
  wheelPath?: string;
  assetBase: string;
  setup: string;
  kernelName: string;
  startupTimeout: number;
}
export interface InteractiveOptions {
  /** Browser conda environment. Defaults to environment.yml in the Astro root. */
  environment?: URL;
  /** Custom JupyterLite command prefix. */
  command?: string[];
  /** Explicitly re-resolve the browser environment instead of reusing its cache. */
  refresh?: boolean;
  setup?: string;
  kernelName?: string;
  startupTimeout?: number;
  wheel?: { project: URL; command?: string[] };
}
export interface ExecutionOptions {
  cwd?: URL;
  python?: string;
  timeout?: number;
  pixi?: { manifest: URL; feature: string };
}
