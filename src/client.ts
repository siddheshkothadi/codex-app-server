import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import type { Logger } from "./logger";

type PendingEntry = {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
  onAbort?: () => void;
};

export class AppServerClient {
  private readonly logger: Logger;
  private readonly binary: string;
  private readonly args: string[];

  private child: ReturnType<typeof spawn> | null = null;
  private stdin: NodeJS.WritableStream | null = null;
  private stdout: NodeJS.ReadableStream | null = null;

  private nextId = 0;
  private readonly pending = new Map<number, PendingEntry>();

  private nextSubId = 0;
  private readonly subscribers = new Map<number, (buf: Buffer) => void>();

  private stopping = false;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly maxLineBytes = 10 * 1024 * 1024; // 10MB

  constructor({ logger, binary, args }: { logger: Logger; binary: string; args: string[] }) {
    this.logger = logger;
    this.binary = binary;
    this.args = args;
  }

  async startAndInitialize({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.child) throw new Error("client already started");

    const baseSpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"] as any,
      windowsHide: true,
      env: process.env,
    };

    const preferShell =
      process.platform === "win32" &&
      (() => {
        const ext = path.extname(this.binary || "").toLowerCase();
        if (ext === ".cmd" || ext === ".bat") return true;
        const normalized = String(this.binary || "").toLowerCase();
        if (normalized.includes("\\windowsapps\\")) return true;
        return false;
      })();

    const spawnOnce = (opts: typeof baseSpawnOptions & { shell?: boolean }) => {
      this.logger.info(`spawning codex: ${this.binary} ${this.args.join(" ")}`.trimEnd());
      return spawn(this.binary, this.args, opts);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnOnce({ ...baseSpawnOptions, shell: preferShell });
    } catch (err: any) {
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

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.logger.warn(`codex stderr: ${text}`);
    });

    child.on("exit", (code, sig) => {
      this.logger.warn(`codex app-server exited code=${code} signal=${sig || ""}`.trimEnd());
      this.onClosed(new Error("codex app-server closed"));
    });

    child.on("error", (err) => {
      this.logger.error(`codex app-server error: ${err && (err as any).message ? (err as any).message : String(err)}`);
      this.onClosed(err instanceof Error ? err : new Error(String(err)));
    });

    child.stdout!.on("data", (chunk) => this.onStdoutData(chunk as Buffer));

    if (signal) {
      if (signal.aborted) throw new Error("aborted");
      signal.addEventListener("abort", () => this.close(), { once: true });
    }

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

  subscribeNotifications(onMessage: (buf: Buffer) => void): () => void {
    const id = (this.nextSubId += 1);
    this.subscribers.set(id, onMessage);
    return () => {
      this.subscribers.delete(id);
    };
  }

  async call(
    method: string,
    params: unknown,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const id = (this.nextId += 1);
    return this.callWithId(id, method, params, { signal, timeoutMs });
  }

  async callWithId(
    id: number,
    method: string,
    params: unknown,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    if (!method) throw new Error("method is required");
    if (!this.stdin) throw new Error("client not started");

    const msg: Record<string, unknown> = { method, id };
    if (params !== undefined) msg.params = params;

    const response = await new Promise<Buffer>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("rpc call timed out"));
        }, timeoutMs);
        timeoutHandle.unref?.();
      }

      let onAbort: (() => void) | null = null;
      const entry: PendingEntry = {
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
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        this.writeJsonLine(msg);
      } catch (err: any) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return response;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!method) throw new Error("method is required");
    if (!this.stdin) throw new Error("client not started");
    const msg: Record<string, unknown> = { method, params };
    this.writeJsonLine(msg);
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;

    try {
      (this.stdin as any)?.end?.();
    } catch {}

    void (async () => {
      await sleep(100);
      try {
        this.child?.kill("SIGKILL");
      } catch {}
    })();
  }

  private onClosed(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      entry.reject(err);
      this.pending.delete(id);
    }
    this.subscribers.clear();
  }

  private writeJsonLine(obj: unknown): void {
    const line = `${JSON.stringify(obj)}\n`;
    const ok = (this.stdin as NodeJS.WritableStream).write(line, "utf8");
    if (!ok) {
      (this.stdin as NodeJS.WritableStream).once("drain", () => {});
    }
  }

  private onStdoutData(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;

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

      this.handleLine(lineBuf);
    }
  }

  private handleLine(lineBuf: Buffer): void {
    let env: any;
    try {
      env = JSON.parse(lineBuf.toString("utf8"));
    } catch (err: any) {
      this.logger.warn(
        `failed to decode message: ${err && err.message ? err.message : String(err)} (line=${lineBuf.toString("utf8")})`,
      );
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

    for (const [subId, cb] of this.subscribers.entries()) {
      try {
        cb(Buffer.from(lineBuf));
      } catch (err: any) {
        this.logger.warn(
          `dropping notification for subscriber=${subId} (${err && err.message ? err.message : String(err)})`,
        );
      }
    }
    this.logger.info(`notification: ${lineBuf.toString("utf8")}`);
  }
}

