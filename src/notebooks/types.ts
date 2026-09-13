export interface BrowserOptions {
  assetBase: string;
  packages: string[];
  wheelUrl?: string;
  setup: string;
  kernelName: string;
  startupTimeout: number;
}
export interface InteractiveOptions {
  packages?: string[];
  setup?: string;
  kernelName?: string;
  startupTimeout?: number;
  wheel?: { project: URL; command: string[] };
}
export interface ExecutionOptions {
  cwd: URL;
  python?: string;
  timeout?: number;
  pixi?: { manifest: URL; feature: string };
}
