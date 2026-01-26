"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const { AppServerClient } = require("./appserverClient");
const { createLogger } = require("./logger");

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return JSON.parse(buf.toString("utf8"));
}

async function startServer({ port, secret, binary, args }) {
  const logger = createLogger("[codex-http] ");

  const client = new AppServerClient({ logger, binary, args });
  await client.startAndInitialize();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const remote = req.socket.remoteAddress || "";

    if (req.method === "GET" && url.pathname === "/events") {
      if (secret) {
        const header = req.headers["x-codex-secret"];
        const value = Array.isArray(header) ? header[0] : header;
        if (!value || !constantTimeEqual(value, secret)) {
          res.statusCode = 401;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("unauthorized");
          return;
        }
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.flushHeaders?.();

      const unsubscribe = client.subscribeNotifications((buf) => {
        const msg = buf.toString("utf8");
        const ok = res.write(`data: ${msg}\n\n`);
        if (!ok) {
          logger.warn("dropping notification (listener slow)");
        }
      });

      req.on("close", () => {
        unsubscribe();
      });

      return;
    }

    if (req.method === "POST" && url.pathname === "/") {
      const start = Date.now();
      logger.info(`incoming HTTP request path=${url.pathname} remote=${remote}`);

      if (secret) {
        const header = req.headers["x-codex-secret"];
        const value = Array.isArray(header) ? header[0] : header;
        if (!value || !constantTimeEqual(value, secret)) {
          logger.warn(`unauthorized request path=${url.pathname} remote=${remote}`);
          res.statusCode = 401;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("unauthorized");
          return;
        }
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        logger.warn(`invalid JSON body path=${url.pathname} remote=${remote}: ${err && err.message ? err.message : String(err)}`);
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
      const timeout = setTimeout(() => controller.abort(), 120_000).unref?.();

      try {
        const hasParams = Object.prototype.hasOwnProperty.call(body, "params");
        const params = hasParams ? body.params : undefined;

        const respLine = await client.call(body.method, params, { signal: controller.signal });

        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(respLine);

        logger.info(`completed HTTP request method=${body.method} path=${url.pathname} remote=${remote} duration=${Date.now() - start}ms`);
      } catch (err) {
        logger.error(`rpc call error method=${body.method} remote=${remote} duration=${Date.now() - start}ms: ${err && err.message ? err.message : String(err)}`);
        res.statusCode = 502;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("rpc call failed");
      } finally {
        clearTimeout(timeout);
      }

      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => resolve());
  });

  logger.info(`HTTP server listening on :${port}`);

  function shutdown() {
    logger.info("shutting down HTTP server...");
    server.close(() => {});
    client.close();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, client };
}

module.exports = { startServer };
