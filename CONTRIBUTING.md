# Contributing

Issues and pull requests are welcome.

## Before you open a pull request

```bash
pnpm install
pnpm typecheck
pnpm test        # needs Postgres; see README
```

- Keep to erasable TypeScript: no enums, no parameter properties, `.ts` extensions in relative imports.
- Tests use a real Postgres database and the in-memory `FakeProvider` in `test/helpers.ts`. Add one for any behaviour you change.
- Changes to the `/v1` API must stay backward compatible.
- After a schema change, run `pnpm db:generate` and commit the migration.

## How changes land

This repository is published from the maintainers' main repository. A merged pull request is
applied there and then exported back here, so the commit you see on `main` may be a squashed
copy of yours. You stay credited as co-author.

## Security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
