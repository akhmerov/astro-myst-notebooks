import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./project/', import.meta.url));
const cli = fileURLToPath(new URL('../../node_modules/mystmd/dist/myst.cjs', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'build', '--html', '--strict'], {
  cwd: project, stdio: 'inherit', env: { ...process.env, ASTRO_MYST_PROJECT: project },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
