import { tabDirectives } from 'myst-ext-tabs';
import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { autodocDirective } from './autodoc.mjs';
import { autolinkRole } from './references.mjs';

/** MyST directives and roles beyond the parser defaults, shared by every parse of authored pages. */
export const directives = [autodocDirective, ...tabDirectives, ...gridDirectives, cardDirective];
export const roles = [autolinkRole];

// MyST defaults every list item to spread=true. Preserve MarkdownIt's
// tight/loose paragraph decision so the HTML renderer does not add gaps.
export const mdast = { handlers: { list_item: {
  type: 'listItem',
  getAttrs(token, tokens, index) {
    let spread = false;
    for (let i = index + 1; i < tokens.length && tokens[i].level > token.level; i++) {
      if (tokens[i].level === token.level + 1 && tokens[i].type === 'paragraph_open' && !tokens[i].hidden) spread = true;
    }
    return {
      spread,
      ...(token.attrGet('class') === 'task-list-item' ? { __taskList: true } : {}),
    };
  },
} } };
