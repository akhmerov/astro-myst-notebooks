import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./project/', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/myst-autodoc/cli.mjs', import.meta.url));
const mode = process.env.MYST_THEME_EXECUTION ?? 'document';
if (!['document', 'native', 'render'].includes(mode)) throw new Error(`Unknown execution mode: ${mode}`);
const native = mode === 'native' ? ['--execute', '--execute-parallel', '1'] : [];
const result = spawnSync(process.execPath, [cli, 'build', '--base', process.env.BASE_URL ?? '/', '--', '--html', '--strict', ...native], {
  cwd: project, stdio: 'inherit', env: { ...process.env, ASTRO_MYST_PROJECT: project },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
