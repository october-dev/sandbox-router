/**
 * Self-hosted Sandbox Router: the API and the background worker in one process,
 * on your own provider keys. Nothing is billed; each sandbox records what it cost.
 *
 *   DATABASE_URL=postgres://...  ADMIN_TOKEN=<32+ chars>  E2B_API_KEY=...  node src/self-hosted.ts
 *
 * The admin token is the owner credential: use it to create API keys
 * (POST /v1/api-keys), then use those keys for everything else.
 */
import { startSelfHosted } from './self-hosted-server.ts';

const server = await startSelfHosted(process.env);
console.log(
  `sandbox router listening on :${server.port} with providers: ${server.providers.map((p) => p.name).join(', ')}`,
);

let draining = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (draining) {
    // A second signal skips the drain.
    process.exit(1);
  }
  draining = true;
  console.log(`${signal}: draining (send it again to stop now)`);
  void server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('shutdown failed:', error);
      process.exit(1);
    },
  );
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
