"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

function waitForLine(stream, predicate, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for line"));
    }, timeoutMs);
    timeout.unref?.();

    function cleanup() {
      clearTimeout(timeout);
      stream.off("data", onData);
    }

    function onData(chunk) {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    }

    stream.on("data", onData);
  });
}

async function startBridge({ port, secret }) {
  const args = [
    "bin/codex-app-server.js",
    "--port",
    String(port),
    "--binary",
    process.execPath,
    "--",
    "scripts/mock-codex.js",
  ];

  const env = { ...process.env, PORT: "", CODEX_HTTP_SECRET: secret || "" };

  const child = spawn(process.execPath, args, {
    cwd: `${__dirname}/..`,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  await waitForLine(child.stdout, (line) => line.includes(`HTTP server listening on :${port}`), { timeoutMs: 8000 });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    child,
    stop: async () => {
      child.kill("SIGINT");
      await waitForLine(child.stdout, (line) => line.includes("shutting down HTTP server"), { timeoutMs: 3000 }).catch(() => {});
      child.kill("SIGKILL");
    },
  };
}

async function readSseData(reader, { timeoutMs = 5000 } = {}) {
  const timeoutAt = Date.now() + timeoutMs;
  let text = "";

  while (Date.now() < timeoutAt) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for SSE")), 250).unref?.()),
    ]).catch((err) => {
      if (err && err.message === "timeout waiting for SSE") return { value: null, done: false };
      throw err;
    });

    if (done) break;
    if (!value) continue;

    text += Buffer.from(value).toString("utf8");
    const idx = text.indexOf("\n\n");
    if (idx === -1) continue;

    const frame = text.slice(0, idx);
    text = text.slice(idx + 2);
    const line = frame.split(/\r?\n/).find((l) => l.startsWith("data: "));
    if (!line) continue;
    return line.slice("data: ".length);
  }

  throw new Error("timeout waiting for SSE");
}

test("POST / forwards JSON-RPC to app-server", async () => {
  const bridge = await startBridge({ port: 18080, secret: "" });
  try {
    const resp = await fetch(`${bridge.baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "echo", params: { a: 1 } }),
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.deepEqual(json.result, { a: 1 });
    assert.equal(json.error, undefined);
  } finally {
    await bridge.stop();
  }
});

test("GET /events streams notifications via SSE", async () => {
  const bridge = await startBridge({ port: 18081, secret: "" });
  const controller = new AbortController();

  try {
    const sseResp = await fetch(`${bridge.baseUrl}/events`, { signal: controller.signal });
    assert.equal(sseResp.status, 200);
    assert.ok(sseResp.body, "missing response body");

    const reader = sseResp.body.getReader();

    // Trigger a notification from the mock.
    const triggerResp = await fetch(`${bridge.baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "triggerNotification" }),
    });
    assert.equal(triggerResp.status, 200);

    const deadline = Date.now() + 5000;
    while (true) {
      const data = await readSseData(reader, { timeoutMs: Math.max(250, deadline - Date.now()) });
      const msg = JSON.parse(data);
      if (msg.method === "mock/notification") {
        assert.deepEqual(msg.params, { hello: "world" });
        break;
      }
      if (Date.now() > deadline) throw new Error("timeout waiting for mock/notification");
    }
  } finally {
    controller.abort();
    await bridge.stop();
  }
});

test("shared secret blocks requests without header", async () => {
  const bridge = await startBridge({ port: 18082, secret: "shh" });
  try {
    const resp = await fetch(`${bridge.baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "echo", params: { a: 1 } }),
    });
    assert.equal(resp.status, 401);

    const ok = await fetch(`${bridge.baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-secret": "shh" },
      body: JSON.stringify({ method: "echo", params: { a: 1 } }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await bridge.stop();
  }
});
