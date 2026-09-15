import { preview } from 'astro';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.DOCS_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DOCS_PORT');
const server = await preview({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void server.stop());
}
await server.closed();
