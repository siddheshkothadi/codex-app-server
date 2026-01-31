# codex-app-server

Bridge for `codex app-server` (stdio JSON-RPC) over either WebSocket (default) or HTTP+SSE.

## Endpoints

### `--protocol ws` (default)

- `GET /` — WebSocket upgrade
  - client -> server: `{ "id": 1, "method": "...", "params": { ... } }`
  - server -> client: JSON-RPC responses + Codex notifications (messages without an `id`)

### `--protocol sse`

- `POST /` — JSON body: `{ "method": "...", "params": { ... } }`
- `GET /events` — SSE stream of Codex notifications (messages without an `id`)

## Environment Variables

- `PORT` (default: `8080`)
- `CODEX_HTTP_SECRET` (optional) — if set, requires `x-codex-secret` header to match (disable with `--no-auth`)

## CLI

```bash
npx codex-app-server
```

This requires the `codex` executable to be on your `PATH` (or pass `--binary <path>`).

Options:

- `--protocol <ws|sse>` — selects transport (default: `ws`)
- `--no-auth` — disables `CODEX_HTTP_SECRET` checks
- `--port <n>` — overrides `PORT`
- `--binary <path>` — overrides the `codex` executable (default: `codex`)
- `-- <codex args...>` — overrides Codex args (default: `app-server`)

## Development

- `npm run build` compiles `src/` to `dist/`.
- Published installs (including `npm i -g codex-app-server`) use the prebuilt `dist/` and do not require `typescript` at install time.

## License

MIT (see `LICENSE`).

