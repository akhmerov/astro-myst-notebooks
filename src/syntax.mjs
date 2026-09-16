import { tabDirectives } from 'myst-ext-tabs';
import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { autodocDirective } from './autodoc.mjs';
import { autolinkRole } from './references.mjs';

/** MyST directives and roles beyond the parser defaults, shared by every parse of authored pages. */
export const directives = [autodocDirective, ...tabDirectives, ...gridDirectives, cardDirective];
export const roles = [autolinkRole];
