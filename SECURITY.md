# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/october-dev/sandbox-router/security/advisories/new).
Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it.
We aim to reply within three working days and will keep you updated until it is fixed.

## Supported versions

Only the latest release on `main` gets security fixes.

## Running it safely

- Use a long, random `ADMIN_TOKEN` (`openssl rand -hex 32`). It can create API keys.
- Don't expose the server to the internet without TLS in front of it.
- Your provider keys stay in your environment. Nothing is sent to us.
