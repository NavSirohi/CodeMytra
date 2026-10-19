/**
 * Async context isolator for Inngest step isolation.
 *
 * Why this is needed:
 * Inngest functions use Node.js AsyncLocalStorage to expose step tooling to nested calls.
 * When `@inngest/agent-kit` agents run inside an active Inngest function context, AgentKit's
 * `AgenticModel.infer` detects the ambient `step` via `getAsyncCtx()` and calls `step.ai.infer()`.
 *
 * If this happens inside an outer `step.run()` callback (such as during planning, design, or architecture),
 * Inngest detects an illegal nested step (`code: NESTING_STEPS`) and duplicate step IDs
 * (`code: AUTOMATIC_PARALLEL_INDEXING`). This causes step collisions, repeated replays, and multi-minute stalls.
 *
 * Wrapping single-turn agent inferences with `runWithoutStepContext` temporarily unbinds the Inngest
 * AsyncLocalStorage store during that specific call, forcing AgentKit to perform a direct model call (fetch)
 * while allowing the outer `step.run()` to cleanly memoize the deterministic output.
 */
export async function runWithoutStepContext<T>(fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const alsSymbol = Symbol.for("inngest:als");
  const cache = g[alsSymbol];
  const als = cache?.resolved;

  if (als && typeof als.run === "function") {
    return als.run(undefined, fn);
  }

  return fn();
}
