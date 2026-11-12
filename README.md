<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="sandbox-router" width="600">
  </picture>
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/tagline-dark.svg">
    <img src="assets/tagline-light.svg" alt="One API for every sandbox provider." width="520">
  </picture>
</div>

---

<p>
  <a href="#run-it"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/button-start-dark.svg"><img src="assets/button-start-light.svg" height="40" align="top" alt="Quick start"></picture></a>
  <a href="#first-steps"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/button-api-dark.svg"><img src="assets/button-api-light.svg" height="40" align="top" alt="API"></picture></a>
  <a href="packages/sdk"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/button-sdk-dark.svg"><img src="assets/button-sdk-light.svg" height="40" align="top" alt="SDK"></picture></a>
  <a href="CONTRIBUTING.md"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/button-contribute-dark.svg"><img src="assets/button-contribute-light.svg" height="40" align="top" alt="Contribute"></picture></a>
  <a href="#run-it"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/callout-dark.svg"><img src="assets/callout-light.svg" height="40" align="top" alt="Self-hosted. Your provider keys never leave your environment."></picture></a>
</p>

---

**One API for cloud sandboxes on E2B, Daytona, Modal, Vercel, Novita and boat.** Ask for a size and say whether you want it `cheap` or `fast`. Sandbox Router picks the best provider, moves on to the next one if creation fails, and tells you what each sandbox costs at the provider's list price.

You run it yourself, with your own provider keys. They never leave your environment.

```ts
import { SandboxRouter } from "sandboxrouter"

const router = new SandboxRouter({ apiKey: "sr_...", baseUrl: "http://localhost:8787" })
const sandbox = await router.sandboxes.create({ size: "small", preset: "cheap", timeout: 600 })

console.log((await sandbox.exec("python3 -c 'print(6 * 7)'")).stdout) // 42
await sandbox.kill()
```

## What it does

- **Picks a provider for you.** `cheap` sorts providers by price, `fast` by how quickly they've been creating sandboxes recently.
- **Fails over.** If a provider is down or at capacity, the sandbox is created on the next one. Providers that keep failing go to the back of the line.
- **One API for everything you do in a sandbox.** Run commands (and stream their output), read and write files, open ports, change the timeout, kill it.
- **Cleans up.** A background worker kills sandboxes at their deadline and removes anything left behind on a provider.
- **Shows the cost.** Every sandbox records its price per hour and what it cost when it ended.

## Providers

Set the keys for the providers you want; any provider without keys is simply not offered.

| Provider | Name in the API | Isolation | Keys | Notes |
| --- | --- | --- | --- | --- |
| [E2B](https://e2b.dev) | `e2b` | Firecracker microVM | `E2B_API_KEY` | Build size templates once (below) |
| [Daytona](https://daytona.io) | `daytona` | Container | `DAYTONA_API_KEY` | |
| Daytona VM | `daytona-vm` | microVM | `DAYTONA_API_KEY` + `DAYTONA_VM=true` | Same account as Daytona |
| [Modal](https://modal.com) | `modal-gvisor`, `modal-vm` | gVisor, or a VM | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Timeouts can't be extended after creation. Ports 3000, 5173, 8000 and 8080 are exposed |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) | `vercel` | Firecracker microVM | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | 2 GB of memory per vCPU. Ports 3000, 5173, 8000 and 8080 are exposed |
| [Novita](https://novita.ai/sandbox) | `novita` | Firecracker microVM | `NOVITA_API_KEY` | Build size templates once (below) |
| [boat](https://boat.dev) | `boat` | KVM VM | `BOAT_API_KEY` | Smallest machine is 2 vCPU / 4 GiB |

Sizes are `small` (1 vCPU / 1 GiB), `medium` (2 / 4) and `large` (4 / 8). Where a provider has no exact match, you get the nearest larger machine, and the sandbox reports the resources and price it actually got.

**Status:** every adapter is built against its provider's current SDK and documentation, but none has been run against a live account yet. To check one with your own key (one small sandbox for about two minutes):

```bash
E2B_API_KEY=... pnpm --filter @sr/providers smoke e2b
```

**E2B and Novita** set CPU and memory per template, so build one template per size once, in your own account:

```bash
pnpm install
E2B_API_KEY=... pnpm --filter @sr/providers build:e2b-templates
NOVITA_API_KEY=... pnpm --filter @sr/providers build:novita-templates
```

The other providers need no setup.

## Run it

You need Postgres, and keys for at least one provider above.

**With Docker Compose** (includes Postgres):

```bash
export ADMIN_TOKEN=$(openssl rand -hex 32)
export E2B_API_KEY=...        # and/or any provider keys from the table above
docker compose up -d
```

**Or with Node 26:**

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, ADMIN_TOKEN and a provider key
pnpm dev
```

The server runs its own database migrations on start. The API is at `http://localhost:8787`, with a full reference at `/docs`.

## First steps

The admin token is for creating API keys. Use API keys for everything else.

```bash
# Create an API key
curl -X POST localhost:8787/v1/api-keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "laptop"}'
# → { "key": "sr_...", ... }   (shown once)

# Create a sandbox
curl -X POST localhost:8787/v1/sandboxes \
  -H "Authorization: Bearer sr_..." -H "Content-Type: application/json" \
  -d '{"size": "small", "preset": "cheap", "timeout": 600}'

# Run a command in it
curl -X POST localhost:8787/v1/sandboxes/<id>/exec \
  -H "Authorization: Bearer sr_..." -H "Content-Type: application/json" \
  -d '{"command": "echo hello"}'
```

| Endpoint | What it does |
| --- | --- |
| `POST /v1/sandboxes` | Create a sandbox (`size`, `preset`, `timeout`, optional `provider` and `metadata`) |
| `GET /v1/sandboxes`, `GET /v1/sandboxes/{id}` | List or get sandboxes |
| `POST /v1/sandboxes/{id}/exec` | Run a command (`command`, `cwd`, `env`, `timeout`). Send `Accept: text/event-stream` to stream its output, or `"background": true` to start it and return |
| `GET /v1/sandboxes/{id}/files?path=` | List a directory |
| `GET` / `PUT /v1/sandboxes/{id}/files/content?path=` | Read or write a file |
| `DELETE /v1/sandboxes/{id}/files?path=` | Delete a file |
| `GET /v1/sandboxes/{id}/ports/{port}` | A public URL for a port |
| `POST /v1/sandboxes/{id}/timeout` | Change when the sandbox is killed |
| `DELETE /v1/sandboxes/{id}` | Kill it |
| `GET /v1/providers` | Providers, prices per size and recent create speed (no key needed) |
| `GET` / `POST` / `DELETE /v1/api-keys` | Manage API keys (admin token only) |

## Settings

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Required |
| `ADMIN_TOKEN` | At least 32 characters. Required |
| `PORT` | Default `8787` |
| `MAX_RUNNING_SANDBOXES` | Sandboxes allowed at once, default `10` |

Provider settings, all optional except the keys:

| Variable | |
| --- | --- |
| `E2B_API_KEY`, `E2B_MAX_LIFETIME_HOURS` | `1` on Hobby, `24` on Pro (default `1`) |
| `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_VM` | Region (e.g. `us`); `true` to also offer `daytona-vm` |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Also `MODAL_ENVIRONMENT`, `MODAL_APP_NAME` (default `sandboxrouter`), `MODAL_IMAGE` (default `python:3.13-slim`), `MODAL_DISABLE_VM=true` for gVisor only |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Also `VERCEL_MAX_LIFETIME_HOURS` (`0.75` on Hobby, `24` on Pro; default `0.75`), `VERCEL_REGION` |
| `NOVITA_API_KEY` | Also `NOVITA_MAX_LIFETIME_HOURS` (`1` Free, `3` Paid, `4` Enterprise; default `1`), `NOVITA_DOMAIN` |
| `BOAT_API_KEY` | Also `BOAT_MAX_LIFETIME_HOURS` (`2` on trial, `720` on paid; default `2`), `BOAT_BASE_URL` |

## Layout

```
packages/providers  E2B, Daytona, Modal, Vercel, Novita and boat behind one interface
packages/core       routing, failover, the sandbox lifecycle, API keys
packages/db         Postgres schema and migrations (Drizzle)
packages/server     the HTTP API, auth, the background worker, and the self-hosted entry point
packages/sdk        the TypeScript SDK (`sandboxrouter`; not on npm yet)
```

Node 26 runs the TypeScript directly, so there is no build step. Keep the code to erasable syntax: no enums, no parameter properties, and `.ts` extensions in relative imports.

`packages/core` takes a `Billing` implementation. The self-hosted server uses `noBilling`, which records each sandbox's cost but never refuses or charges. A hosted service can plug in prepaid billing on top of the same code.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # needs Postgres; TEST_DATABASE_URL defaults to postgres://postgres:postgres@localhost:5432/sr_test
```

The tests use a real Postgres database and an in-memory provider, so they never call a real provider. `pnpm --filter @sr/providers smoke <provider>` checks one against a live account.

After changing the schema, run `pnpm db:generate` and commit the new migration in `packages/db/migrations`.

The `sandboxrouter` CLI is next, built on the SDK.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability. Your provider keys stay in your own environment.

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE)
