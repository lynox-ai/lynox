/**
 * One gate prompt at a time per Session. The prompt store holds a single pending prompt per
 * Session (a second one throws `PromptConflictError`), so the gates that ask before or inside
 * a tool call — the secret-destination gate and the write-consent question of `http_request`
 * — queue on ONE chain. Two chains would collide again on the store.
 *
 * Each waiter runs `fn` once the prompt before it settled, and re-reads whatever approvals
 * it depends on inside `fn`: the answer it waited for may already cover it.
 */
export async function inSessionPromptChain<T>(
  counters: { secretPromptChain?: Promise<void> | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  const prev = counters.secretPromptChain ?? Promise.resolve();
  let release!: () => void;
  counters.secretPromptChain = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); }
}
