# sandboxrouter CLI

Command line for [Sandbox Router](https://github.com/october-dev/sandbox-router): create cloud sandboxes on E2B, Daytona, Modal, Vercel Sandbox, Novita or boat, run commands in them, copy files in and out, and kill them. It works with any Sandbox Router server, self-hosted or hosted.

```bash
npm install -g sandboxrouter-cli    # Node 22.12 or later; installs the `sandboxrouter` command

sandboxrouter login http://localhost:8787
id=$(sandboxrouter create --size small --timeout 10m)
sandboxrouter cp -r ./app $id:app
sandboxrouter exec $id 'cd app && npm install && npm test'
sandboxrouter kill $id
```

It isn't on npm yet. To run it from a checkout of the repository (Node 26 runs the TypeScript source directly):

```bash
pnpm install
alias sandboxrouter="node --conditions=sandboxrouter-source $PWD/packages/cli/src/index.ts"
```

## Logging in

```bash
sandboxrouter login <server-url>
```

On servers that offer browser login, this shows a code to approve in your browser. On a self-hosted server it asks for an API key (`sr_...`); you can paste the server's `ADMIN_TOKEN` instead, and the CLI uses it once to create an API key named after your machine. The admin token is never saved.

The key is saved in `~/.config/sandboxrouter/config.json` (or `$XDG_CONFIG_HOME/sandboxrouter/config.json`, `%APPDATA%\sandboxrouter\config.json` on Windows, or `$SANDBOXROUTER_CONFIG`), readable only by you. You can log in to several servers; the last one becomes the default, and `--base-url` picks another. A saved key is only ever sent to the server it was saved for.

In scripts and CI, skip login and set the environment instead:

```bash
export SANDBOXROUTER_BASE_URL=https://sandboxes.example.com
export SANDBOXROUTER_API_KEY=sr_...
```

or pipe a key in: `echo "$KEY" | sandboxrouter login <url> --with-key`.

`--base-url` and `--api-key` override both, `sandboxrouter status` shows which server and key are in use, and `sandboxrouter logout` removes a saved key (the key keeps working until it is revoked on the server).

## Commands

| Command | |
| --- | --- |
| `create [--size small\|medium\|large] [--preset cheap\|fast] [--provider <name>] [--timeout 10m] [--metadata k=v]` | Create a sandbox, wait until it runs, and print its id |
| `list [--all] [--status <status>] [-q]` | Running sandboxes (`--all` includes ended ones; `-q` prints only ids) |
| `get <id>` | Status, provider, resources, price, cost so far, deadline |
| `exec <id> [--cwd <dir>] [--env K=V] [--timeout 5m] [--background] <command...>` | Run a command, streaming its output, and exit with its exit code |
| `cp [-r] <source> <destination>` | Copy files or directories to or from a sandbox |
| `url <id> <port>` | A public HTTPS URL for a port in the sandbox |
| `timeout <id> <duration>` | Kill the sandbox this long from now |
| `kill <id...>` | Kill sandboxes and print what each cost |
| `providers` | Providers on the server, prices per size, recent create speed |
| `login`, `logout`, `status` | See above |

Every command has `--help`, and `--json` for output a script can parse. Durations are seconds or `90s`, `10m`, `1h`.

### Running commands

```bash
sandboxrouter exec $id 'cd app && npm test | tail -n 20'   # one argument: a shell script (bash -lc)
sandboxrouter exec $id python3 -c "print(6 * 7)"           # several: passed as separate arguments
sandboxrouter exec $id --cwd app --env CI=1 -- npm test    # options go before the command; -- is optional
```

The command's stdout and stderr stream to yours. The exit status is the command's own, `124` if it hit its timeout (default 60 seconds, at most an hour), and `130` if you pressed Ctrl-C, which also stops it in the sandbox. There is no interactive terminal or stdin; copy input in with `cp` first.

```bash
sandboxrouter exec $id --background 'python3 -m http.server 8000'
curl "$(sandboxrouter url $id 8000)"
```

### Copying files

Sandbox paths look like `sbx_abc123:path`. Relative paths start at the sandbox's home directory. `-` is stdin or stdout.

```bash
sandboxrouter cp ./main.py $id:app/main.py     # parent directories are created
sandboxrouter cp ./main.py $id:app/            # into a directory (trailing slash)
sandboxrouter cp -r ./src $id:app              # ./src/x lands at app/x
sandboxrouter cp $id:app/report.json .         # into the current directory
sandboxrouter cp -r $id:app/dist ./dist
tar cz . | sandboxrouter cp - $id:code.tgz && sandboxrouter exec $id 'tar xzf code.tgz'
```

Each file can be up to 100 MiB. File modes (such as the executable bit) are not kept, so run `chmod` in the sandbox if you need them.

## Scripting

Output meant for scripts goes to stdout, and progress and messages to stderr, so `$(...)` captures just the value. With `--json`, results are JSON on stdout and errors are JSON on stderr (`{"error": {"code", "message", "status"}}`).

```bash
id=$(sandboxrouter create --size medium --timeout 30m --metadata job=nightly)
trap 'sandboxrouter kill $id' EXIT
sandboxrouter cp -r . $id:repo
sandboxrouter exec $id --timeout 20m 'cd repo && make test'

sandboxrouter list --json | jq -r '.[] | select(.metadata.job == "nightly") | .id'
sandboxrouter list -q | xargs sandboxrouter kill
```

Exit status: `0` success, `1` an error from the server or the network, `2` a usage mistake; `exec` exits with the command's status.

## License

[Apache 2.0](LICENSE)
