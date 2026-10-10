/**
 * The (host, model) pairs the model-fitness instruments call, outside the `.test.ts`
 * file so the offline check (tests/online-guards.test.ts) can import it without
 * registering the online suite. Same arrangement as `preset-slots.ts`.
 */
export const FITNESS_HOSTS = {
  fireworks: 'https://api.fireworks.ai/inference/v1',
  mistral: 'https://api.mistral.ai/v1',
} as const;

type Host = keyof typeof FITNESS_HOSTS;

interface RosterInput {
  candidates: ReadonlyArray<{ id: string; apiBaseURL?: string | undefined }>;
  replay: ReadonlyArray<{ modelId: string; apiBaseURL?: string | undefined }>;
  judgeModel: string;
}

// By hostname, not by the full URL string: a row that spells the base URL differently
// (trailing slash, other path) would otherwise drop out of the check without a word.
function hostOf(baseUrl: string | undefined): Host | undefined {
  if (!baseUrl) return undefined;
  const hostname = new URL(baseUrl).hostname;
  for (const [host, url] of Object.entries(FITNESS_HOSTS) as Array<[Host, string]>) {
    if (new URL(url).hostname === hostname) return host;
  }
  return undefined;
}

/** Every distinct Fireworks or Mistral model the run, the replay and the judge call,
 *  with the instruments that call it. Anthropic and OpenRouter rows are left out: no
 *  key for them is held where these guards run. */
export function fitnessRosterIds(input: RosterInput): Array<{ host: Host; modelId: string; usedBy: string[] }> {
  const byKey = new Map<string, { host: Host; modelId: string; usedBy: Set<string> }>();
  const add = (host: Host | undefined, modelId: string, user: string): void => {
    if (!host) return;
    const k = `${host}::${modelId}`;
    const e = byKey.get(k) ?? { host, modelId, usedBy: new Set<string>() };
    e.usedBy.add(user);
    byKey.set(k, e);
  };
  for (const c of input.candidates) add(hostOf(c.apiBaseURL), c.id, 'run.ts');
  for (const c of input.replay) add(hostOf(c.apiBaseURL), c.modelId, 'replay.ts');
  add('fireworks', input.judgeModel, 'judge.ts');
  return [...byKey.values()].map(e => ({ host: e.host, modelId: e.modelId, usedBy: [...e.usedBy].sort() }));
}
