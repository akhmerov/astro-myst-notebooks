import type { PresentationOptions } from './notebooks/types.js';

export const presentationDefaults: Required<PresentationOptions> = {
  input: 'show', output: 'show', cell: 'show', stdout: 'show', stderr: 'show',
};

/** Validate each layer before merging, so an override cannot conceal a typo. */
export function validatePresentation(value: unknown, context = 'presentation'): PresentationOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`);
  for (const [key, choice] of Object.entries(value)) {
    const allowed = ['input', 'output', 'cell'].includes(key) ? ['show', 'hide', 'remove']
      : ['stdout', 'stderr'].includes(key) ? ['show', 'remove'] : [];
    if (!allowed.includes(choice)) throw new Error(`Invalid ${context}.${key}: expected ${allowed.join(', ') || 'a known presentation field'}`);
  }
  return value as PresentationOptions;
}

export function resolvePresentation(site: PresentationOptions = {}, page: PresentationOptions = {}, tags: readonly string[] = []): Required<PresentationOptions> {
  const result = { ...presentationDefaults, ...validatePresentation(site), ...validatePresentation(page, 'page presentation') };
  for (const key of Object.keys(result) as (keyof PresentationOptions)[]) {
    const choices = key === 'stdout' || key === 'stderr' ? ['show', 'remove'] : ['show', 'hide', 'remove'];
    const selected = choices.filter(choice => tags.includes(`${choice}-${key}`));
    if (selected.length > 1) throw new Error(`Conflicting presentation tags for ${key}: ${selected.map(choice => `${choice}-${key}`).join(', ')}`);
    if (selected.length) (result as Record<string, string>)[key] = selected[0];
  }
  return result;
}

/** Filter presentation only. Keep execution errors in the kernel's output model. */
export function publishOutput(output: { output_type: string; name?: string }, presentation: Required<PresentationOptions>): boolean {
  if (presentation.cell === 'remove' || presentation.output === 'remove') return false;
  return output.output_type !== 'stream' || presentation[output.name as 'stdout' | 'stderr'] !== 'remove';
}
