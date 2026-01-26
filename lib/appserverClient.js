"use strict";

const { spawn } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const path = require("node:path");

class AppServerClient {
  constructor({ logger, binary, args }) {
    this.logger = logger;
    this.binary = binary;
    this.args = args;

    this.child = null;
    this.stdin = null;
    this.stdout = null;

    this.nextId = 0;
    this.pending = new Map(); // id -> { resolve, reject, timeout }

    this.nextSubId = 0;
    this.subscribers = new Map(); // subId -> (buf) => void

    this.stopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.maxLineBytes = 10 * 1024 * 1024; // 10MB
  }

  async startAndInitialize({ signal } = {}) {
    if (this.child) throw new Error("client already started");

    const baseSpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    };

    const preferShell =
      process.platform === "win32" &&
      (() => {
        const ext = path.extname(this.binary || "").toLowerCase();
        if (ext === ".cmd" || ext === ".bat") return true;
        // Windows App Execution Aliases can be stubs in WindowsApps that behave better via cmd/shell.
        const normalized = String(this.binary || "").toLowerCase();
        if (normalized.includes("\\windowsapps\\")) return true;
        return false;
      })();

    const spawnOnce = (opts) => {
      this.logger.info(`spawning codex: ${this.binary} ${this.args.join(" ")}`.trimEnd());
      return spawn(this.binary, this.args, opts);
    };

    let child;
    try {
      child = spawnOnce({ ...baseSpawnOptions, shell: preferShell });
    } catch (err) {
      // On Windows, spawn can throw EINVAL for certain shims/stubs; retry via shell.
      if (process.platform === "win32" && err && err.code === "EINVAL" && !preferShell) {
        this.logger.warn("spawn returned EINVAL; retrying with shell=true");
        child = spawnOnce({ ...baseSpawnOptions, shell: true });
      } else {
        throw err;
      }
    }

    this.child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.logger.warn(`codex stderr: ${text}`);
    });

    child.on("exit", (code, sig) => {
      this.logger.warn(`codex app-server exited code=${code} signal=${sig || ""}`.trimEnd());
      this._onClosed(new Error("codex app-server closed"));
    });

    child.on("error", (err) => {
      this.logger.error(`codex app-server error: ${err && err.message ? err.message : String(err)}`);
      this._onClosed(err);
    });

    this.stdout.on("data", (chunk) => this._onStdoutData(chunk));

    if (signal) {
      if (signal.aborted) throw new Error("aborted");
      signal.addEventListener("abort", () => this.close(), { once: true });
    }

    // Perform initialize / initialized handshake.
    const initParams = {
      clientInfo: {
        name: "codex_http_bridge",
        title: "Codex HTTP Bridge",
        version: "0.1.0",
      },
    };

    await this.call("initialize", initParams, { signal });
    await this.notify("initialized", {});

    this.logger.info("codex app-server initialized");
  }

  subscribeNotifications(onMessage) {
    const id = (this.nextSubId += 1);
    this.subscribers.set(id, onMessage);
    return () => {
      this.subscribers.delete(id);
    };
  }

  async call(method, params, { signal, timeoutMs } = {}) {
    if (!method) throw new Error("method is required");
    if (!this.stdin) throw new Error("client not started");

    const id = (this.nextId += 1);

    const msg = { method, id };
    if (params !== undefined) msg.params = params;

    const response = await new Promise((resolve, reject) => {
      let timeoutHandle = null;
      if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("rpc call timed out"));
        }, timeoutMs);
        timeoutHandle.unref?.();
      }

      let onAbort = null;
      const entry = {
        resolve: (buf) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(buf);
        },
        reject: (err) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        },
      };

      this.pending.set(id, entry);

      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(new Error("aborted"));
          return;
        }
        onAbort = () => {
          this.pending.delete(id);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        this._writeJsonLine(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });

    return response;
  }

  async notify(method, params) {
    if (!method) throw new Error("method is required");
    if (!this.stdin) throw new Error("client not started");
    const msg = { method, params };
    this._writeJsonLine(msg);
  }

  close() {
    if (this.stopping) return;
    this.stopping = true;

    try {
      this.stdin?.end();
    } catch {}

    // Give the child a beat to exit cleanly.
    void (async () => {
      await sleep(100);
      try {
        this.child?.kill("SIGKILL");
      } catch {}
    })();
  }

  _onClosed(err) {
    for (const [id, entry] of this.pending.entries()) {
      entry.reject(err);
      this.pending.delete(id);
    }
    this.subscribers.clear();
  }

  _writeJsonLine(obj) {
    const line = `${JSON.stringify(obj)}\n`;
    const ok = this.stdin.write(line, "utf8");
    if (!ok) {
      this.stdin.once("drain", () => {});
    }
  }

  _onStdoutData(chunk) {
    if (!chunk || chunk.length === 0) return;

    // Append and split by newline.
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > this.maxLineBytes * 2) {
      this.logger.error("stdout buffer exceeded safety limit; dropping");
      this.stdoutBuffer = Buffer.alloc(0);
      return;
    }

    while (true) {
      const idx = this.stdoutBuffer.indexOf(0x0a); // \n
      if (idx === -1) {
        if (this.stdoutBuffer.length > this.maxLineBytes) {
          this.logger.error("stdout line exceeded max size; dropping");
          this.stdoutBuffer = Buffer.alloc(0);
        }
        break;
      }

      let lineBuf = this.stdoutBuffer.subarray(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.subarray(idx + 1);
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
      }
      if (lineBuf.length === 0) continue;

      this._handleLine(lineBuf);
    }
  }

  _handleLine(lineBuf) {
    let env;
    try {
      env = JSON.parse(lineBuf.toString("utf8"));
    } catch (err) {
      this.logger.warn(`failed to decode message: ${err && err.message ? err.message : String(err)} (line=${lineBuf.toString("utf8")})`);
      return;
    }

    if (env && Object.prototype.hasOwnProperty.call(env, "id") && env.id !== null && env.id !== undefined) {
      const id = env.id;
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.resolve(Buffer.from(lineBuf));
      }
      return;
    }

    // Notification
    for (const [subId, cb] of this.subscribers.entries()) {
      try {
        cb(Buffer.from(lineBuf));
      } catch (err) {
        this.logger.warn(`dropping notification for subscriber=${subId} (${err && err.message ? err.message : String(err)})`);
      }
    }
    this.logger.info(`notification: ${lineBuf.toString("utf8")}`);
  }
}

module.exports = { AppServerClient };
