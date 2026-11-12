import { describe, expect, it } from 'vitest';
import { startTasks } from '../src/worker.ts';

describe('startTasks', () => {
  it('repeats each task without overlapping and waits for the running one on stop', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const stop = startTasks([
      {
        name: 'slow',
        everyMs: 5,
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          runs++;
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 120));
    await stop();
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(active).toBe(0);
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(after);
  });

  it('keeps running after a task throws', async () => {
    let runs = 0;
    const stop = startTasks([
      {
        name: 'flaky',
        everyMs: 5,
        run: async () => {
          runs++;
          throw new Error('expected');
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 60));
    await stop();
    expect(runs).toBeGreaterThan(1);
  });
});
