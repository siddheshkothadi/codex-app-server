# codex-app-server

A simple Golang server that bridges the Codex app-server to HTTP. It wraps the standard input/output (stdin/stdout) communication of the underlying binary and exposes it via a RESTful API and Server-Sent Events (SSE).

## Features

- **JSON-RPC Bridge:** Forwards HTTP POST requests to the app-server.
- **SSE Notifications:** Streams app-server notifications via `GET /events`.
- **Security:** Optional shared secret authentication via `x-codex-secret` header.

## Endpoints

### `POST /`
Exposes the JSON-RPC interface. Send a JSON body with `method` and `params`.

### `GET /events`
Streams notifications from the app-server using Server-Sent Events (SSE).

## Environment Variables

- `PORT`: The port the server listens on (default: `8080`).
- `CODEX_HTTP_SECRET`: (Optional) If set, requires the `x-codex-secret` header to match this value for all requests.

## Usage

1. Ensure the `codex` binary is in your PATH.
2. Run the server:
   ```bash
   go run cmd/server/main.go
   ```
