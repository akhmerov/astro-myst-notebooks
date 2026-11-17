import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { mystLoader, type EngineLoaderOptions } from '../engine/loader.js';

export function notebookCollection(options: EngineLoaderOptions = {}): ReturnType<typeof defineCollection> {
  return defineCollection({ loader: mystLoader(options), schema: docsSchema() });
}

export function notebookCollections(options: EngineLoaderOptions = {}): Record<string, ReturnType<typeof defineCollection>> {
  return { docs: notebookCollection(options) };
}
