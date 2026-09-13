import { copyFile } from 'node:fs/promises';
for (const path of ['execute.py', 'execution-contract.json', 'notebooks/style.css']) {
  await copyFile(new URL(`../src/${path}`, import.meta.url), new URL(`../dist/${path}`, import.meta.url));
}
