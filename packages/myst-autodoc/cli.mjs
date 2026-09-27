#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { augmentInventory } from './inventory.mjs';

// The build wrapper is intentionally small: MyST remains responsible for its build.
const args = process.argv.slice(2);
const command = args.shift();
const options = { site: '_build/site', destinations: [], base: '/' };
const mystArgs = [];
try {
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { mystArgs.push(...args); break; }
    if (!['--site', '--output', '--base'].includes(arg) || !args.length) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args.shift();
    if (arg === '--site') options.site = value;
    if (arg === '--base') options.base = value;
    if (arg === '--output') options.destinations.push(value);
  }
  if (!['build', 'inventory'].includes(command)) throw new Error('Usage: myst-autodoc build|inventory [--site DIR] [--output objects.inv] [--base /prefix/] [-- MYST_BUILD_OPTIONS]');
  if (command === 'build') {
    if (mystArgs.includes('--watch')) throw new Error('autodoc build does not support --watch; rerun the build after Python edits');
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('mystmd/package.json');
    const cli = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.myst);
    const result = spawnSync(process.execPath, [cli, 'build', ...mystArgs.length ? mystArgs : ['--site', '--strict']], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    // --html has already copied the inventory; update that published copy too.
    if (mystArgs.includes('--html') && !options.destinations.length) {
      const path = resolve('_build/html/objects.inv');
      if (!existsSync(path)) throw new Error('HTML inventory not found; specify --output for your theme');
      options.destinations.push(path);
    }
  }
  const entries = await augmentInventory(options);
  console.log(`Exported ${entries.length} Python names to objects.inv`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
