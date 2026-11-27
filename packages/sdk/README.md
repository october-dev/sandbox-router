# sandboxrouter

TypeScript client for [Sandbox Router](https://github.com/october-dev/sandbox-router): one API for cloud
sandboxes on E2B, Daytona, Modal, Vercel Sandbox, Novita and boat. You point it at a Sandbox Router server,
for example one you [run yourself](https://github.com/october-dev/sandbox-router#run-it). The server holds
the provider keys and picks the provider.

> Not on npm yet. Until it is, use it from this repository (`packages/sdk`).

```ts
import { SandboxRouter } from "sandboxrouter"

// Or set SANDBOXROUTER_API_KEY and SANDBOXROUTER_BASE_URL and call new SandboxRouter()
const router = new SandboxRouter({ apiKey: "sr_...", baseUrl: "http://localhost:8787" })

const sandbox = await router.sandboxes.create({ size: "small", preset: "cheap", timeout: 600 })

const result = await sandbox.exec("python3 -c 'print(6 * 7)'")
console.log(result.exitCode, result.stdout)

for await (const event of sandbox.execStream("npm test", { cwd: "app", timeout: 600 })) {
  if (event.type === "stdout") process.stdout.write(event.data)
  if (event.type === "exit") console.log("exit code", event.exitCode)
}

await sandbox.files.write("app/main.py", "print('hello')")
console.log(await sandbox.files.readText("app/main.py"))
console.log(await sandbox.files.list("app"))

await sandbox.startBackground("python3 -m http.server 8000")
console.log((await sandbox.portUrl(8000)).url)

await sandbox.setTimeout(1800) // kill it 30 minutes from now instead
const final = await sandbox.kill()
console.log(`cost: $${final.costUsd}`)
```

There is no default server: pass `baseUrl` or set `SANDBOXROUTER_BASE_URL`, so your API key only goes
where you chose.

## API

| | |
| --- | --- |
| `router.sandboxes.create(options)` | `size` (`small`, `medium`, `large`), `preset` (`cheap` or `fast`), `timeout` in seconds (60 to 86400), and optionally `provider` to pin one and `metadata` |
| `router.sandboxes.get(id)`, `router.sandboxes.list({ status, limit, before })` | Look sandboxes up. `list` returns one page and a `nextCursor` |
| `router.providers()` | The configured providers, their price per size and recent create speed |
| `sandbox.exec(command, { cwd, env, timeout, signal })` | Runs the command with `bash -lc` and resolves when it exits |
| `sandbox.execStream(command, options)` | Yields `stdout` and `stderr` events as they happen, then an `exit` event. Breaking out of the loop or aborting `signal` kills the command |
| `sandbox.startBackground(command, { cwd, env })` | Starts a command and returns at once |
| `sandbox.files.read`, `readText`, `readStream`, `write`, `list`, `remove` | Paths are absolute or relative to the sandbox's home directory. `readStream` returns a `ReadableStream` instead of buffering. `write` takes a string, bytes, a `Blob` or a stream, up to 100 MiB |
| `sandbox.portUrl(port)` | A public HTTPS URL for a port inside the sandbox |
| `sandbox.setTimeout(seconds)`, `sandbox.kill()`, `sandbox.refresh()` | Each updates `sandbox.data`, which holds the latest state, price and cost |

Sizes: `small` (1 vCPU, 1 GiB), `medium` (2 vCPU, 4 GiB), `large` (4 vCPU, 8 GiB). Where a provider has no
exact match, the sandbox gets the nearest larger machine, and `sandbox.data` reports what it actually got.

Errors are thrown as `SandboxRouterError`, with the HTTP `status` and a stable `code` such as
`bad_request`, `unauthorized`, `forbidden`, `not_found`, `limit_exceeded`, `rate_limited`, `sandbox_not_running`,
`conflict`, `file_not_found`, `payload_too_large`, `insufficient_funds` (servers with billing), `no_provider`,
`provider_error` or `internal_error`. A command stream that drops before
the command exits throws with code `stream_closed`.

`exec` with a `timeout` over 240 seconds runs over a stream under the hood, since Node's `fetch` stops
waiting for a response after 300 seconds.

Requires Node 22.12 or later, or another runtime with `fetch` and web streams.

## License

[Apache 2.0](LICENSE)
