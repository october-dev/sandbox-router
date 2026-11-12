# sandboxrouter

TypeScript client for [Sandbox Router](https://github.com/october-dev/sandbox-router): one API for cloud sandboxes on E2B and Daytona.

Not on npm yet. For now, use it from this repository (`packages/sdk`).

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

await sandbox.startBackground("python3 -m http.server 8000")
console.log((await sandbox.portUrl(8000)).url)

await sandbox.setTimeout(1800) // kill 30 minutes from now instead
const final = await sandbox.kill()
console.log(`cost: $${final.costUsd}`)
```

There is no default server: pass `baseUrl` or set `SANDBOXROUTER_BASE_URL`, so your API key only goes where you chose.

Sizes: `small` (1 vCPU, 1 GiB), `medium` (2 vCPU, 4 GiB), `large` (4 vCPU, 8 GiB).
Presets: `cheap` (lowest price) or `fast` (lowest recent create time), or pin `provider: "e2b" | "daytona"`.

Errors are thrown as `SandboxRouterError` with `status` and a stable `code`
(`sandbox_not_running`, `file_not_found`, `limit_exceeded`, …).

Requires Node 20+ (or any runtime with `fetch` and web streams).
