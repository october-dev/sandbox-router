/**
 * One-time setup: builds one E2B template per sandbox size from E2B's `base` image.
 * Run again after changing sizes. Requires E2B_API_KEY.
 *
 *   E2B_API_KEY=... pnpm --filter @sr/providers build:e2b-templates
 */
import { Template, defaultBuildLogger } from 'e2b';
import { E2B_TEMPLATES } from '../src/e2b.ts';
import { SIZES, SIZE_SPECS } from '../src/types.ts';

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error('E2B_API_KEY is required');

for (const size of SIZES) {
  const { cpu, memoryMib } = SIZE_SPECS[size];
  const name = E2B_TEMPLATES[size];
  console.log(`building ${name} (${cpu} vCPU, ${memoryMib} MiB)`);
  await Template.build(Template().fromTemplate('base'), name, {
    apiKey,
    cpuCount: cpu,
    memoryMB: memoryMib,
    onBuildLogs: defaultBuildLogger(),
  });
}
console.log('done');
