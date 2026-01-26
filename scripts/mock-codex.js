#!/usr/bin/env node
"use strict";

// Minimal mock of: `codex app-server`
// - reads one JSON object per line from stdin
// - responds to requests with `{id, result}`
// - emits notifications with no `id`

let initialized = false;

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf("\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
      if (msg.method === "initialize") {
        initialized = true;
        write({ id: msg.id, result: { ok: true } });
        continue;
      }
      if (msg.method === "echo") {
        write({ id: msg.id, result: msg.params ?? null });
        continue;
      }
      if (msg.method === "triggerNotification") {
        write({ id: msg.id, result: { triggered: true } });
        setTimeout(() => {
          if (initialized) write({ method: "mock/notification", params: { hello: "world" } });
        }, 50);
        continue;
      }
      write({ id: msg.id, result: { method: msg.method, params: msg.params ?? null } });
      continue;
    }

    // notification from client
    if (msg && msg.method === "initialized") {
      setTimeout(() => {
        if (initialized) write({ method: "mock/ready", params: { ready: true } });
      }, 10);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

