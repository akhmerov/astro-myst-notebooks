import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InteractiveOptions } from './types.js';

const run = promisify(execFile);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
type Artifact = { path: string; sha256: string };
async function artifacts(root: string, directory = root): Promise<Artifact[]> {
  const result: Artifact[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await artifacts(root, path));
    else if (entry.isFile()) result.push({ path: relative(root, path), sha256: digest(await readFile(path)) });
    else throw new Error(`Unsupported browser artifact: ${relative(root, path)}`);
  }
  return result;
}

async function prepareMounts(options: InteractiveOptions) {
  const mounts = [];
  const destinations = new Set<string>();
  for (const { source, target } of options.mounts ?? []) {
    const path = resolve(fileURLToPath(source));
    if (path.includes(':')) throw new Error(`Xeus mount source cannot contain a colon: ${path}`);
    if (!target.startsWith('/') || /[:\\\0]/.test(target) || target.split('/').includes('..')) {
      throw new Error(`Browser mount target must be an absolute POSIX directory without '..': ${target}`);
    }
    const directory = posix.normalize(target);
    // Xeus reserves this prefix for its own content manager.
    if (directory.startsWith('/files')) throw new Error(`Browser mount target is reserved by JupyterLite: ${target}`);
    const info = await lstat(path).catch(() => { throw new Error(`Cannot read browser mount source: ${path}`); });
    let files: Artifact[];
    if (info.isDirectory()) files = await artifacts(path);
    else if (info.isFile()) files = [{ path: basename(path), sha256: digest(await readFile(path)) }];
    else throw new Error(`Browser mount source must be a regular file or directory: ${path}`);
    for (const file of files) {
      const destination = posix.join(directory, file.path);
      if (options.wheel && (destination === '/opt/wheels' || destination.startsWith('/opt/wheels/') || '/opt/wheels'.startsWith(destination + '/'))) {
        throw new Error(`Browser mount overlaps the package wheel: ${destination}`);
      }
      for (const existing of destinations) {
        if (destination === existing || destination.startsWith(existing + '/') || existing.startsWith(destination + '/')) {
          throw new Error(`Overlapping browser mount files: ${existing} and ${destination}`);
        }
      }
      destinations.add(destination);
    }
    mounts.push({ source: path, target: directory, files });
  }
  return mounts;
}

/** A completed, verified environment is reused until inputs change or refresh is requested. */
export async function buildEnvironment(options: InteractiveOptions, { root, cache, python = 'python', log = console.info }: {
  root: URL; cache: URL; python?: string; log?: (message: string) => void;
}): Promise<{ directory: string; version: string; wheelPath?: string }> {
  const environment = options.environment ?? new URL('environment.yml', root);
  const spec = await readFile(environment).catch(() => { throw new Error(`Missing browser environment ${fileURLToPath(environment)}. Run astro-myst-notebooks init, or set interactive.environment.`); });
  const mounts = await prepareMounts(options);
  const versions = (await run(python, ['-c', 'import importlib.metadata as m,json; print(json.dumps({p:m.version(p) for p in ["jupyterlite-core","jupyterlite-xeus"]},sort_keys=True))'])).stdout.trim();
  const [command, ...args] = options.command ?? ['jupyter', 'lite'];
  if (!command) throw new Error('The browser build command must not be empty');
  const base = fileURLToPath(new URL('browser/', cache));
  await mkdir(base, { recursive: true });
  // Scratch space is created only when a wheel is built or the cache misses.
  let work: string | undefined;
  const scratch = async () => work ??= await mkdtemp(join(base, '.build-'));
  try {
    let wheelPath: string | undefined;
    let wheelHash: string | undefined;
    let wheels: string | undefined;
    if (options.wheel) {
      wheels = join(await scratch(), 'wheels');
      await mkdir(wheels);
      if (options.wheel.command) {
        const [wheelCommand, ...wheelArgs] = options.wheel.command;
        if (!wheelCommand) throw new Error('The wheel build command must not be empty');
        await run(wheelCommand, [...wheelArgs, '-d', wheels], { cwd: fileURLToPath(options.wheel.project), maxBuffer: 10 * 1024 * 1024 });
      } else {
        await run(python, ['-m', 'build', '--wheel', '--no-isolation', '--outdir', wheels, fileURLToPath(options.wheel.project)], { maxBuffer: 10 * 1024 * 1024 });
      }
      const names = (await readdir(wheels)).filter(name => name.endsWith('.whl'));
      if (names.length !== 1) throw new Error('The notebook build must produce exactly one wheel');
      const name = names[0]!;
      if (!name.endsWith('-none-any.whl')) throw new Error('Local browser wheels must be pure Python; put compiled packages in environment.yml');
      // Wheel ZIP timestamps must not invalidate an otherwise identical environment.
      wheelHash = (await run(python, ['-c', 'import hashlib,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); h=hashlib.sha256(); [(h.update(n.encode()),h.update(b"\\0"),h.update(z.read(n))) for n in sorted(z.namelist())]; print(h.hexdigest())', join(wheels, name)])).stdout.trim();
      wheelPath = `/opt/wheels/${name}`;
    }
    const inputs = { format: 2, spec: spec.toString(), versions, command: [command, ...args], wheelHash, wheelPath,
      mounts: mounts.map(({ target, files }) => ({ target, files })) };
    const key = digest(JSON.stringify(inputs));
    const destination = join(base, key);
    if (!options.refresh) {
      try {
        const saved = JSON.parse(await readFile(join(destination, 'build.json'), 'utf8'));
        const current = await artifacts(join(destination, 'site'));
        if (JSON.stringify(saved.artifacts) === JSON.stringify(current)) {
          log('[notebooks] Reusing browser environment');
          return { directory: join(destination, 'site'), version: digest(JSON.stringify(current)), wheelPath };
        }
      } catch { /* Absent or incomplete caches are rebuilt below. */ }
    }
    log('[notebooks] Building Xeus browser environment');
    const build = await scratch();
    const site = join(build, 'site');
    const lite = join(build, 'lite');
    await mkdir(lite);
    await run(command, [...args, 'build', `--XeusAddon.environment_file=${fileURLToPath(environment)}`,
      `--output-dir=${site}`, `--lite-dir=${lite}`,
      ...(wheels ? [`--XeusAddon.mounts=${wheels}:/opt/wheels`] : []),
      ...mounts.map(({ source, target }) => `--XeusAddon.mounts=${source}:${target}`),
    ], { cwd: fileURLToPath(root), maxBuffer: 20 * 1024 * 1024 });
    await stat(join(site, 'xeus'));
    const built = await artifacts(site);
    await writeFile(join(build, 'build.json'), JSON.stringify({ inputs, artifacts: built }));
    // Keep only the completed site and its provenance; mounts are included in it.
    await rm(lite, { recursive: true, force: true });
    if (wheels) await rm(wheels, { recursive: true, force: true });
    // Rename only completed work. A failed refresh leaves the old cache intact.
    const previous = `${destination}.previous-${process.pid}`;
    try { await rename(destination, previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(build, destination); }
    catch (error) { await rename(previous, destination).catch(() => {}); throw error; }
    await rm(previous, { recursive: true, force: true });
    return { directory: join(destination, 'site'), version: digest(JSON.stringify(built)), wheelPath };
  } finally { if (work) await rm(work, { recursive: true, force: true }); }
}
