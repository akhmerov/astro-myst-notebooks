import { WebWorkerKernel as XeusKernel } from '@jupyterlite/xeus/lib/index.js';
import { PageConfig } from '@jupyterlab/coreutils';
export { waitForServiceWorkerControl } from '@jupyterlite/xeus/lib/index.js';

/** Xeus ships classic, prebundled workers which call importScripts for Emscripten.
 * Keep them intact instead of letting Vite turn them into module workers.
 */
export class WebWorkerKernel extends XeusKernel {
  protected override async initFileSystem(options: XeusKernel.IOptions) {
    if (options.mountDrive) return super.initFileSystem(options);
    // Documentation pages need the packaged filesystem, not a JupyterLab drive.
    // Xeus 5.1's base class mounts the drive even when mountDrive is false.
    await this.remoteKernel.ready();
    await this.remoteKernel.cd('/');
  }

  override initWorker(): Worker {
    const name = crossOriginIsolated ? 'coincident' : 'comlink';
    return new Worker(`${PageConfig.getBaseUrl()}${name}.worker.js`);
  }
}
