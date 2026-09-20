import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The CI image installs Chromium separately. Keep the additional browser
// required by this package's regression suite alongside its test command.
if (process.env.CI) {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath,
    [require.resolve('playwright/cli'), 'install', '--with-deps', 'firefox'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
