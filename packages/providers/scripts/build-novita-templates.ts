/**
 * One-time setup: builds one Novita template per sandbox size from Novita's base image.
 * Run again after changing sizes. Requires NOVITA_API_KEY; NOVITA_DOMAIN must be a regional
 * domain (template builds are not supported on legacy domains such as sandbox.novita.ai).
 * `large` (4 vCPU, 8 GiB) needs a Paid plan.
 *
 *   NOVITA_API_KEY=... node packages/providers/scripts/build-novita-templates.ts
 */
import { Template, defaultBuildLogger } from 'novita-sandbox';
import { NOVITA_DEFAULT_DOMAIN, NOVITA_TEMPLATES } from '../src/novita.ts';
import { SIZES, SIZE_SPECS } from '../src/types.ts';

const apiKey = process.env.NOVITA_API_KEY;
if (!apiKey) throw new Error('NOVITA_API_KEY is required');
const domain = process.env.NOVITA_DOMAIN || NOVITA_DEFAULT_DOMAIN;

for (const size of SIZES) {
  const { cpu, memoryMib } = SIZE_SPECS[size];
  const name = NOVITA_TEMPLATES[size];
  console.log(`building ${name} (${cpu} vCPU, ${memoryMib} MiB)`);
  // fromBaseImage() is `novita/base`, the image behind the default `base` template.
  const info = await Template.build(Template().fromBaseImage(), name, {
    apiKey,
    domain,
    cpuCount: cpu,
    memoryMB: memoryMib,
    onBuildLogs: defaultBuildLogger(),
  });
  // If the name isn't usable at create time, pass these ids as NovitaConfig.templates.
  console.log(`${name}: template id ${info.templateId}`);
}
console.log('done');
