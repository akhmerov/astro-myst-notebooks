export interface BrowserOptions {
  xeus?: { wheelPath?: string };
  assetBase: string;
  packages: string[];
  wheelUrl?: string;
  setup: string;
  kernelName: string;
  startupTimeout: number;
}
export interface InteractiveOptions {
  xeus?: { environment: URL; command?: string[] };
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
