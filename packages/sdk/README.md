# sandboxrouter

TypeScript client for [Sandbox Router](https://sandboxrouter.com): one API key for cloud sandboxes on E2B and Daytona, at provider prices.

```bash
npm install sandboxrouter
```

```ts
import { SandboxRouter } from "sandboxrouter"

const router = new SandboxRouter({ apiKey: process.env.SANDBOXROUTER_API_KEY })

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

Sizes: `small` (1 vCPU, 1 GiB), `medium` (2 vCPU, 4 GiB), `large` (4 vCPU, 8 GiB).
Presets: `cheap` (lowest price) or `fast` (lowest recent create time), or pin `provider: "e2b" | "daytona"`.

Errors are thrown as `SandboxRouterError` with `status` and a stable `code`
(`insufficient_funds`, `sandbox_not_running`, `file_not_found`, …).

Requires Node 20+ (or any runtime with `fetch` and web streams).
