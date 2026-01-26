# codex-app-server (Node)

A simple Node.js server that bridges the Codex `app-server` stdio JSON-RPC interface to HTTP + Server-Sent Events (SSE).

## Endpoints

- `POST /` — JSON body: `{ "method": "...", "params": { ... } }`
- `GET /events` — SSE stream of Codex notifications (messages without an `id`)

## Environment Variables

- `PORT` (default: `8080`)
- `CODEX_HTTP_SECRET` (optional) — if set, requires `x-codex-secret` header to match

## CLI

Run:

```bash
npx codex-app-server
```

Note: this requires the `codex` executable to be on your `PATH` (or pass `--binary <path>`).

Options:

- `--no-auth` — disables `CODEX_HTTP_SECRET` checks
- `--port <n>` — overrides `PORT`
- `--binary <path>` — overrides the `codex` executable (default: `codex`)
- `-- <codex args...>` — overrides Codex args (default: `app-server`)
