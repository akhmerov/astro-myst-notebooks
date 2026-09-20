import { preview } from 'astro';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';

const port = Number(process.env.DOCS_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DOCS_PORT');
const server = await preview({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port, headers: { 'Cache-Control': 'no-cache' } },
});
// Browser automation omits dedicated-worker fetch events. Count requests at
// the server to verify that cached Python assets really avoid the network.
const requests = new URL('../.astro/browser-requests.jsonl', import.meta.url);
mkdirSync(new URL('./', requests), { recursive: true });
writeFileSync(requests, '');
server.server.prependListener('request', request => {
  appendFileSync(requests, JSON.stringify(new URL(request.url, 'http://localhost').pathname) + '\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void server.stop());
}
await server.closed();
