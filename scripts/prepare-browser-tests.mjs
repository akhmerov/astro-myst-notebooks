import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Resolve on local runs too, so an invalid CLI export fails before reaching CI.
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

// The CI image installs Chromium separately. Keep the additional browser
// required by this package's regression suite alongside its test command.
if (process.env.CI) {
  const result = spawnSync(process.execPath,
    [cli, 'install', '--with-deps', 'firefox', ...(process.argv.includes('--dry-run') ? ['--dry-run'] : [])],
    { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
