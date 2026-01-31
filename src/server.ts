import http from "node:http";
import crypto from "node:crypto";

import WebSocket, { type RawData, WebSocketServer } from "ws";

import { AppServerClient } from "./client";
import { createLogger } from "./logger";

export type Protocol = "ws" | "sse";

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as any));
  const buf = Buffer.concat(chunks);
  return JSON.parse(buf.toString("utf8"));
}

function isAuthorized(req: http.IncomingMessage, secret: string): boolean {
  if (!secret) return true;
  const header = req.headers["x-codex-secret"];
  const value = Array.isArray(header) ? header[0] : header;
  return !!value && constantTimeEqual(value, secret);
}

export async function startServer({
  port,
  secret,
  binary,
  args,
  protocol,
}: {
  port: number;
  secret: string;
  binary: string;
  args: string[];
  protocol: Protocol;
}): Promise<{ server: http.Server; client: AppServerClient }> {
  const logger = createLogger("[codex-http] ");

  const client = new AppServerClient({ logger, binary, args });
  await client.startAndInitialize();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const remote = req.socket.remoteAddress || "";

    if (protocol === "sse") {
      if (req.method === "GET" && url.pathname === "/events") {
        if (!isAuthorized(req, secret)) {
          res.statusCode = 401;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("unauthorized");
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        (res as any).flushHeaders?.();

        const unsubscribe = client.subscribeNotifications((buf) => {
          const msg = buf.toString("utf8");
          const ok = res.write(`data: ${msg}\n\n`);
          if (!ok) logger.warn("dropping notification (listener slow)");
        });

        req.on("close", () => unsubscribe());
        return;
      }

      if (req.method === "POST" && url.pathname === "/") {
        const start = Date.now();
        logger.info(`incoming HTTP request path=${url.pathname} remote=${remote}`);

        if (!isAuthorized(req, secret)) {
          logger.warn(`unauthorized request path=${url.pathname} remote=${remote}`);
          res.statusCode = 401;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("unauthorized");
          return;
        }

        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (err: any) {
          logger.warn(
            `invalid JSON body path=${url.pathname} remote=${remote}: ${err && err.message ? err.message : String(err)}`,
          );
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("invalid JSON body");
          return;
        }

        if (!body || !body.method) {
          logger.warn(`missing method in request path=${url.pathname} remote=${remote}`);
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("missing method");
          return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        (timeout as any).unref?.();

        try {
          const hasParams = Object.prototype.hasOwnProperty.call(body, "params");
          const params = hasParams ? body.params : undefined;

          const respLine = await client.call(body.method, params, { signal: controller.signal });

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(respLine);

          logger.info(
            `completed HTTP request method=${body.method} path=${url.pathname} remote=${remote} duration=${Date.now() - start}ms`,
          );
        } catch (err: any) {
          logger.error(
            `rpc call error method=${body.method} remote=${remote} duration=${Date.now() - start}ms: ${err && err.message ? err.message : String(err)}`,
          );
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("rpc call failed");
        } finally {
          clearTimeout(timeout);
        }

        return;
      }
    }

    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("not found");
  });

  let wss: WebSocketServer | null = null;
  if (protocol === "ws") {
    wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    let internalId = 0;
    const inflight = new Map<number, { ws: WebSocket; clientId: unknown }>();

    const unsubscribe = client.subscribeNotifications((buf) => {
      const msg = buf.toString("utf8");
      for (const ws of sockets) {
        try {
          ws.send(msg);
        } catch {}
      }
    });

    server.on("close", () => unsubscribe());

    server.on("upgrade", (req, socket, head) => {
      if (!isAuthorized(req, secret)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        ws.on("message", async (data: RawData) => {
          let env: any;
          try {
            env = JSON.parse(String(data));
          } catch {
            return;
          }
          if (!env || typeof env.method !== "string" || !env.method) return;

          // notification
          if (!Object.prototype.hasOwnProperty.call(env, "id") || env.id === null || env.id === undefined) {
            try {
              await client.notify(env.method, Object.prototype.hasOwnProperty.call(env, "params") ? env.params : undefined);
            } catch {}
            return;
          }

          const clientId = env.id;
          const id = (internalId += 1);
          inflight.set(id, { ws, clientId });

          try {
            const respLine = await client.callWithId(id, env.method, env.params, { timeoutMs: 120_000 });
            let resp: any;
            try {
              resp = JSON.parse(respLine.toString("utf8"));
            } catch {
              return;
            }
            const entry = inflight.get(id);
            inflight.delete(id);
            if (!entry) return;
            resp.id = entry.clientId;
            entry.ws.send(JSON.stringify(resp));
          } catch {
            inflight.delete(id);
          }
        });
      });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => resolve());
  });

  logger.info(`HTTP server listening on :${port}`);
  if (protocol === "ws") logger.info("WS transport enabled (connect to ws://HOST:PORT/)");
  if (protocol === "sse") logger.info("SSE transport enabled (POST / and GET /events)");

  function shutdown() {
    logger.info("shutting down HTTP server...");
    server.close(() => {});
    wss?.close();
    client.close();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, client };
}
