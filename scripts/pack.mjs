import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

async function npmPack(cwd, args) {
  // npm supplies its CLI path to npm-run scripts and their test processes.
  // Invoke Node directly so this also works where npm is a .cmd wrapper.
  if (!process.env.npm_execpath) throw new Error('Run the pack script through npm run package');
  const { stdout } = await exec(process.execPath,
    [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', ...args],
    { cwd, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout)[0];
}

/** Pack a built checkout without ever modifying its installed dependencies. */
export async function pack({ root = process.cwd(), destination = root } = {}) {
  root = resolve(root);
  destination = resolve(destination);
  const patches = await readJson(join(root, 'scripts/dependency-patches.json'));
  const lock = await readJson(join(root, 'package-lock.json'));
  await mkdir(destination, { recursive: true });
  // Keep staging on the destination filesystem so publication is one rename.
  const work = await mkdtemp(join(destination, '.notebooks-pack-'));
  try {
    const stage = join(work, 'package');
    await mkdir(stage);
    // Let npm select the payload, including its bundled dependency closure.
    const { files } = await npmPack(root, ['--dry-run']);
    for (const { path } of files) {
      const target = join(stage, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, path), target);
    }
    for (const patch of patches) {
      const entries = Object.entries(lock.packages).filter(([path, entry]) =>
        entry.inBundle && path.split('node_modules/').at(-1) === patch.package);
      if (!entries.length) throw new Error(`Bundled dependency missing: ${patch.package}`);
      for (const [path, entry] of entries) {
        const manifest = join(stage, path, 'package.json');
        const pkg = await readJson(manifest);
        if (pkg.version !== patch.version || entry.version !== patch.version ||
            pkg.dependencies?.[patch.dependency] !== patch.from ||
            entry.dependencies?.[patch.dependency] !== patch.from) {
          throw new Error(`Review the release dependency patch for ${patch.package}`);
        }
        pkg.dependencies[patch.dependency] = patch.to;
        entry.dependencies[patch.dependency] = patch.to;
        await writeJson(manifest, pkg);
      }
    }
    const pkg = await readJson(join(stage, 'package.json'));
    // Consumers use the built files; checkout-only build hooks cannot run here.
    delete pkg.scripts;
    delete pkg.devDependencies;
    await writeJson(join(stage, 'package.json'), pkg);
    lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => !path || !entry.dev));
    delete lock.packages[''].devDependencies;
    await writeJson(join(stage, 'npm-shrinkwrap.json'), lock);
    await writeJson(join(stage, 'dist/DEPENDENCY-PATCHES.json'), patches);
    const result = await npmPack(stage, ['--pack-destination', work]);
    await rename(join(work, result.filename), join(destination, result.filename));
    return { ...result, path: join(destination, result.filename) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.includes('--guard')) {
      throw new Error('Use npm run package (or pixi run pack) to prepare the distributable; publish the resulting .tgz file.');
    } else console.log((await pack()).path);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
