import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./project/_build/html/', import.meta.url));
const prefix = (process.env.BASE_URL ?? '/').replace(/\/$/, '');
const port = Number(process.env.MYST_THEME_PORT ?? 51542);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (prefix && path !== prefix && !path.startsWith(prefix + '/')) throw new Error('Unknown prefix');
    let target = resolve(root, '.' + (path.slice(prefix.length) || '/'));
    if (target !== root.replace(/\/$/, '') && !target.startsWith(root)) throw new Error('Outside site');
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    response.setHeader('Content-Type', types[extname(target)] ?? 'application/octet-stream');
    response.end(await readFile(target));
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`MyST theme: http://127.0.0.1:${port}${prefix}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
