/**
 * Shared test helpers for the AgentRunnerController suites.
 *
 * These tests drive an async agent generator whose first action is to register a
 * pending approval / question resolver. A fixed `setTimeout(10)` "wait a tick"
 * races under load: if the resolver is not registered yet, `respondToApproval`
 * / `respondToQuestion` is a no-op and the subsequent `await runPromise()`
 * deadlocks until the test runner's timeout. Waiting on the actual observable
 * condition removes that race entirely.
 */
export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    // Yield to the event loop so the agent generator can progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
