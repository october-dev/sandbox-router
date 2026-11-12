import type { SandboxService } from '@sr/core';

export interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Runs each task on its own interval, never overlapping with itself. Returns a
 * function that stops scheduling and resolves once running tasks have finished.
 */
export function startTasks(tasks: readonly Task[]): () => Promise<void> {
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<void>>();

  const loop = (task: Task) => {
    if (stopping) return;
    const run = (async () => {
      const started = Date.now();
      try {
        const result = await task.run();
        if (hasWork(result)) console.log(`${task.name}: ${JSON.stringify(result)} in ${Date.now() - started}ms`);
      } catch (error) {
        console.error(`${task.name} failed:`, error);
      }
    })();
    running.add(run);
    void run.finally(() => {
      running.delete(run);
      if (stopping) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        loop(task);
      }, task.everyMs);
      timers.add(timer);
    });
  };

  for (const task of tasks) loop(task);

  return async () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    await Promise.all(running);
  };
}

function hasWork(result: unknown): boolean {
  if (typeof result === 'number') return result > 0;
  if (result && typeof result === 'object') return Object.values(result).some((v) => typeof v === 'number' && v > 0);
  return false;
}

/**
 * The background work every deployment needs: settling sandboxes at their
 * deadline, failing creates that never finished, and reconciling with providers.
 * Returns a function that stops the tasks and waits for running ones.
 */
export function startWorker(sandboxes: Pick<SandboxService, 'settleExpired' | 'failStuckCreates' | 'reconcile'>) {
  return startTasks([
    // Settles sandboxes that reached their deadline and makes sure they are killed.
    { name: 'settle-expired', everyMs: 10_000, run: () => sandboxes.settleExpired() },
    // Releases reservations held by creates that never finished.
    { name: 'fail-stuck-creates', everyMs: 60_000, run: () => sandboxes.failStuckCreates() },
    // Kills leftover provider sandboxes and settles ones a provider lost.
    { name: 'reconcile', everyMs: 60_000, run: () => sandboxes.reconcile() },
  ]);
}
