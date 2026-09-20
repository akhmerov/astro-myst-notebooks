export type Visibility = 'show' | 'hide' | 'remove';
export interface PresentationOptions {
  /** show: visible; hide: a disclosure; remove: no reader-visible content. */
  input?: Visibility;
  output?: Visibility;
  cell?: Visibility;
  stdout?: 'show' | 'remove';
  stderr?: 'show' | 'remove';
}

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
  /** Copy files or directory contents into absolute browser directories. Files retain their names. */
  mounts?: { source: URL; target: string }[];
}
export interface ExecutionOptions {
  cwd?: URL;
  python?: string;
  timeout?: number;
  pixi?: { manifest: URL; feature: string };
}
