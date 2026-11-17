// Minimal lexical parser frozen from bd7fa84:src/documents.mjs. This fixture
// deliberately has no project resolver, execution, renderer or production API.
import { mystParse } from 'myst-parser';
import { getFrontmatter } from 'myst-transforms';
import { VFile } from 'vfile';
import { directives, roles, mdast } from './syntax.mjs';
import { attachOrigins } from './source-map.mjs';

export const baselineRevision = 'bd7fa84';
export function parseDocument(source, path, root, fullSource = source, keepTitleNode = false) {
  const file = new VFile({ path, value: source });
  const tree = mystParse(source, { vfile: file, roles, directives, mdast, extensions: { smartquotes: false } });
  const errors = file.messages.filter(message => message.fatal ||
    ['reference-target-resolves', 'include-content-loads', 'include-content-filters'].includes(message.ruleId));
  if (errors.length) file.fail(errors.map(message => message.reason).join('\n'));
  attachOrigins(tree, source, path, root, fullSource);
  const { frontmatter, identifiers } = getFrontmatter(file, tree, { keepTitleNode });
  return { tree, file, frontmatter, identifiers };
}
