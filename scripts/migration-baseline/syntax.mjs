// Frozen bd7fa84 syntax registration; extraction omits inventory/network/runtime code.
import { tabDirectives } from 'myst-ext-tabs';
import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { refRole } from 'myst-roles';


export const autodocDirective = {
  name: 'autodoc',
  doc: 'Render a Python object with Starlight Pydocs.',
  arg: { type: String, required: true, doc: 'Fully qualified Python object name.' },
  options: { 'summary-only': { type: Boolean, doc: 'Render only the module docstring.' }, 'heading-level': { type: Number, doc: 'Heading level of the object (default 3).' } },
  run(data, file) {
    const name = data.arg;
    const level = data.options?.['heading-level'] ?? 3;
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(name)) file.fail(`Invalid Python object: ${name}`);
    if (!Number.isInteger(level) || level < 2 || level > 6) file.fail('autodoc heading-level must be 2–6');
    return [{ type: 'html', value: `<template data-myst-autodoc="${name}" data-heading-level="${level}" data-summary-only="${data.options?.['summary-only'] === true}"></template>` }];
  },
};

export const autolinkRole = {
  ...refRole, name: 'autolink', alias: [],
  run(data) {
    const [reference] = refRole.run(data);
    const label = reference.label;
    const short = label.startsWith('~');
    const target = short ? label.slice(1) : label;
    return [{ type: 'link', url: `xref:auto#${target}`, children: reference.children ?? [
      { type: 'inlineCode', value: short ? target.split('.').at(-1) : target },
    ] }];
  },
};

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
