import { PageConfig } from '@jupyterlab/coreutils';
import { IServiceManager, ServiceManager } from '@jupyterlab/services';
import services from '@jupyterlab/services-extension';
import liteServices from '@jupyterlite/services-extension';
import { SingleWidgetApp, SingleWidgetShell } from '@jupyterlite/application';
import { IKernelSpecs } from '@jupyterlite/services';
import xeus from '@jupyterlite/xeus-extension';
import { PluginRegistry } from '@lumino/coreutils';

const applications = new WeakMap<ServiceManager.IManager, SingleWidgetApp>();

/** Thebe Lite's public provider contract, backed by JupyterLite's Xeus plugins. */
export async function startXeusServer(baseUrl: string): Promise<ServiceManager> {
  PageConfig.setOption('baseUrl', baseUrl + '/');
  PageConfig.setOption('appVersion', 'astro-myst-notebooks');
  PageConfig.setOption('terminalsAvailable', 'false');
  PageConfig.setOption('enableMemoryStorage', 'true');
  for (const name of ['contentsStorageDrivers', 'settingsStorageDrivers', 'workspacesStorageDrivers']) {
    PageConfig.setOption(name, JSON.stringify(['memoryStorageDriver']));
  }
  const registry = new PluginRegistry<null>();
  const replacements = new Set(liteServices.map(plugin => plugin.provides));
  registry.registerPlugins(services.filter(plugin => !replacements.has(plugin.provides)));
  registry.registerPlugins(liteServices);
  const manager = await registry.resolveRequiredService(IServiceManager);
  if (!(manager instanceof ServiceManager)) throw new Error('Unexpected JupyterLite service manager');
  const app = new SingleWidgetApp({ serviceManager: manager, shell: new SingleWidgetShell() });
  app.registerPlugin({
    id: 'astro-myst-notebooks:kernel-specs',
    provides: IKernelSpecs,
    activate: () => registry.resolveRequiredService(IKernelSpecs),
  });
  app.registerPlugins(xeus);
  try {
    for (const plugin of xeus) if (plugin.autoStart) await app.activatePlugin(plugin.id);
    await manager.ready;
    applications.set(manager, app);
    return manager;
  } catch (error) {
    manager.dispose();
    app.shell.dispose();
    throw error;
  }
}

export function disposeXeusServer(manager: ServiceManager.IManager) {
  applications.get(manager)?.shell.dispose();
  applications.delete(manager);
}
