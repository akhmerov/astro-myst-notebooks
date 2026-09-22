import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { mystContent } from '../content.mjs';

export const collections = {
  docs: defineCollection({ loader: mystContent(), schema: docsSchema() }),
};
