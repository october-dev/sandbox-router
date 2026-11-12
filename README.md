# Sandbox Router

**One API for cloud sandboxes on E2B and Daytona.** Ask for a size and say whether you want it `cheap` or `fast`. Sandbox Router picks the best provider, moves on to the next one if creation fails, and tells you what each sandbox costs at the provider's list price.

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

## Run it

You need Postgres, and an API key for at least one of [E2B](https://e2b.dev) or [Daytona](https://daytona.io).

**Using E2B?** Build its templates once first. E2B sets CPU and memory per template, so Sandbox Router needs one template per size (`sandboxrouter-small`, `-medium`, `-large`) in your E2B team:

```bash
pnpm install
E2B_API_KEY=... pnpm --filter @sr/providers build:e2b-templates
```

Daytona needs no setup.

**With Docker Compose** (includes Postgres):

```bash
export ADMIN_TOKEN=$(openssl rand -hex 32)
export E2B_API_KEY=...        # and/or DAYTONA_API_KEY
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
| `E2B_API_KEY` | Offer E2B |
| `E2B_MAX_LIFETIME_HOURS` | `1` on E2B Hobby, `24` on E2B Pro |
| `DAYTONA_API_KEY` | Offer Daytona |
| `DAYTONA_TARGET` | Daytona region, default `us` |
| `PORT` | Default `8787` |
| `MAX_RUNNING_SANDBOXES` | Sandboxes allowed at once, default `10` |

## Layout

```
packages/providers  E2B and Daytona behind one interface
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

The tests use a real Postgres database and an in-memory provider, so they never call E2B or Daytona.

After changing the schema, run `pnpm db:generate` and commit the new migration in `packages/db/migrations`.

The `sandboxrouter` CLI is next, built on the SDK.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability. Your provider keys stay in your own environment.

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE)
