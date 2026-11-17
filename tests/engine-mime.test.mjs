import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from 'hast-util-to-html';
import { hydrateOutput } from '../dist/engine/notebook.mjs';
import { renderOutput } from '../dist/mime.mjs';

test('only application/json and application/*+json MIME values are decoded as JSON', async () => {
  const output = await hydrateOutput({ output_type: 'display_data', data: {
    'application/json': { content: '{"value":42}' },
    'application/vnd.plotly.v1+json': { content: '{"data":[]}' },
    'application/pdf': { content: 'JVBERi0xLjQ=' },
    'application/javascript': { content: 'console.log("hello")' },
    'text/plain': { content: 'fallback output' },
  } });
  assert.deepEqual(output.data['application/json'], { value: 42 });
  assert.deepEqual(output.data['application/vnd.plotly.v1+json'], { data: [] });
  assert.equal(output.data['application/pdf'], 'JVBERi0xLjQ=');
  assert.equal(output.data['application/javascript'], 'console.log("hello")');
  delete output.data['application/vnd.plotly.v1+json'];
  assert.match(toHtml(await renderOutput(output)), /fallback output/);
});

test('unsupported binary assets survive hydration while a supported textual fallback renders', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 128]);
  const output = await hydrateOutput({ output_type: 'display_data', data: {
    'application/pdf': { path: '/figure.pdf', content_type: 'application/pdf' },
    'text/plain': { content: 'PDF preview unavailable' },
  } }, async path => { assert.equal(path, '/figure.pdf'); return new Response(bytes); });
  assert.equal(output.data['application/pdf'], Buffer.from(bytes).toString('base64'));
  assert.match(toHtml(await renderOutput(output)), /PDF preview unavailable/);
});
