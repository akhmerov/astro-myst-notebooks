import type { AstroConfig, ContentEntryType, MarkdownHeading } from 'astro';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { notebookEntry } from '../notebook-source.mjs';

type Renderer = { render(content: string, options: { frontmatter: Record<string, unknown>; fileURL?: URL }): Promise<{
  code: string; metadata: { headings: MarkdownHeading[]; localImagePaths: string[]; remoteImagePaths: string[]; frontmatter: Record<string, unknown> };
}> };

async function createRenderer(config: AstroConfig): Promise<Renderer> {
  const { markdown, image } = config;
  const processor = markdown.processor as unknown as { createRenderer(shared: Record<string, unknown>): Promise<Renderer> };
  return processor.createRenderer({ image, syntaxHighlight: markdown.syntaxHighlight, shikiConfig: markdown.shikiConfig, gfm: markdown.gfm, smartypants: markdown.smartypants });
}

/** Module code equivalent to Astro's Markdown module, including asset-pipeline images. */
function moduleCode(html: string, file: string, frontmatter: Record<string, unknown>, headings: MarkdownHeading[], local: string[], remote: string[]) {
  const imports = local.map((path, index) => `import image${index} from ${JSON.stringify(path)};`).join('\n');
  const map = `{ ${local.map((path, index) => `${JSON.stringify(path)}: image${index}`).join(', ')} }`;
  const images = local.length || remote.length ? `
import { getImage } from 'astro:assets';
${imports}
const imports = ${map};
const decode = value => JSON.parse(value.replace(/&(?:#x22|quot);/g, '"').replace(/&(?:#x27|apos);/g, "'"));
async function html() {
  const source = ${JSON.stringify(html)};
  const resolved = new Map();
  for (const [marker, attributes] of source.matchAll(/__ASTRO_IMAGE_="([^"]+)"/g)) {
    const { src, index, ...props } = decode(attributes);
    resolved.set(marker, await getImage(src in imports ? { src: imports[src], ...props } : { src, ...props }));
  }
  return source.replaceAll(/__ASTRO_IMAGE_="([^"]+)"/g, marker => {
    const image = resolved.get(marker);
    const { index, ...attributes } = image.attributes;
    if (image.srcSet?.values.length) attributes.srcset = image.srcSet.attribute;
    return spreadAttributes({ src: image.src, ...attributes });
  });
}` : `const html = async () => ${JSON.stringify(html)};`;
  return `
import { unescapeHTML, spreadAttributes, createComponent, render, maybeRenderHead } from 'astro/runtime/server/index.js';
${images}
export const frontmatter = ${JSON.stringify(frontmatter)};
export const file = ${JSON.stringify(file)};
export const url = undefined;
export async function compiledContent() { return await html(); }
export function getHeadings() { return ${JSON.stringify(headings)}; }
export const Content = createComponent(async () => render\`\${maybeRenderHead()}\${unescapeHTML(await html())}\`);
export default Content;
`;
}

/** Jupyter notebooks as content entries: converted to MyST text, rendered like Markdown. */
export function notebookEntryType(finalConfig: () => AstroConfig): ContentEntryType {
  let renderer: Promise<Renderer> | undefined;
  return {
    extensions: ['.ipynb'],
    getEntryInfo: ({ contents }) => notebookEntry(contents),
    handlePropagation: true,
    async getRenderFunction(config) {
      const ready = await createRenderer(config);
      return async entry => {
        const result = await ready.render(entry.body ?? '', { frontmatter: entry.data, fileURL: entry.filePath ? pathToFileURL(entry.filePath) : undefined });
        return { html: result.code, metadata: { ...result.metadata, imagePaths: [...result.metadata.localImagePaths, ...result.metadata.remoteImagePaths] } };
      };
    },
    async getRenderModule({ contents, fileUrl }) {
      renderer ??= createRenderer(finalConfig());
      const entry = notebookEntry(contents);
      const result = await (await renderer).render(entry.body, { frontmatter: entry.data, fileURL: fileUrl });
      const { headings, localImagePaths, remoteImagePaths, frontmatter } = result.metadata;
      return { code: moduleCode(result.code, fileURLToPath(fileUrl), frontmatter, headings, localImagePaths, remoteImagePaths), moduleType: 'js' };
    },
  };
}
