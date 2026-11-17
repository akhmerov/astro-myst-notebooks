import { isMainThread, Worker, workerData } from 'node:worker_threads';

// The compiler runs in its own process group so its deadline can stop it.
// Watch its owner independently of the CLI event loop, including while a
// synchronous plugin runs and after the owner exits without running cleanup.
if (isMainThread) {
  const entry = new URL(import.meta.url);
  const owner = Number(entry.searchParams.get('owner'));
  entry.search = '';
  new Worker(entry, { execArgv: [], workerData: owner }).unref();
} else {
  const stopIfOrphaned = () => {
    if (process.ppid === workerData) return;
    process.kill(process.platform === 'win32' ? process.pid : -process.pid, 'SIGKILL');
  };
  stopIfOrphaned();
  setInterval(stopIfOrphaned, 100);
}
