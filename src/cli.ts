/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";

import { startServer } from "./server";

type Protocol = "ws" | "sse";

function parseArgs(argv: string[]) {
  const args: {
    noAuth: boolean;
    port?: number;
    binary: string;
    protocol: Protocol;
    codexArgs: string[];
  } = {
    noAuth: false,
    port: undefined,
    binary: "codex",
    protocol: "ws",
    codexArgs: ["app-server"],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      args.codexArgs = argv.slice(i + 1);
      break;
    }

    if (token === "--no-auth") {
      args.noAuth = true;
      continue;
    }

    if (token === "--port") {
      const value = argv[i + 1];
      if (!value) throw new Error("--port requires a value");
      args.port = Number(value);
      if (!Number.isFinite(args.port) || args.port <= 0) throw new Error("invalid --port");
      i += 1;
      continue;
    }

    if (token === "--binary") {
      const value = argv[i + 1];
      if (!value) throw new Error("--binary requires a value");
      args.binary = value;
      i += 1;
      continue;
    }

    if (token === "--protocol") {
      const value = argv[i + 1];
      if (!value) throw new Error("--protocol requires a value");
      if (value !== "ws" && value !== "sse") throw new Error("invalid --protocol (expected ws or sse)");
      args.protocol = value;
      i += 1;
      continue;
    }

    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`unknown arg: ${token}`);
  }

  return args;
}

function resolveOnPath(executableName: string): string | null {
  if (!executableName) return null;

  const hasPathSep = executableName.includes("/") || executableName.includes("\\");
  if (hasPathSep) {
    return fs.existsSync(executableName) ? executableName : null;
  }

  const pathEnv = process.env.PATH || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);

  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);

    const alreadyHasExt = pathext.some((ext) => executableName.toLowerCase().endsWith(ext.toLowerCase()));
    const candidates = alreadyHasExt ? [executableName] : pathext.map((ext) => `${executableName}${ext}`);

    for (const dir of parts) {
      for (const cand of candidates) {
        const full = path.join(dir, cand);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  }

  for (const dir of parts) {
    const full = path.join(dir, executableName);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

function printHelp() {
  console.log(`codex-app-server

Usage:
  codex-app-server [--protocol <ws|sse>] [--port <n>] [--binary <path>] [--no-auth] [-- <codex args...>]

Env:
  PORT (default 8080)
  CODEX_HTTP_SECRET (optional) - shared secret for x-codex-secret header
`);
}

export async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const port = parsed.port ?? (process.env.PORT ? Number(process.env.PORT) : 8080);
    if (!Number.isFinite(port) || port <= 0) throw new Error("invalid PORT");

    const secret = parsed.noAuth ? "" : process.env.CODEX_HTTP_SECRET || "";

    const resolvedBinary = resolveOnPath(parsed.binary);
    if (!resolvedBinary) {
      const hint =
        parsed.binary === "codex"
          ? "Install Codex and ensure `codex` is on PATH (PowerShell: `where.exe codex`), or pass `--binary <full path to codex(.exe)>`."
          : "Ensure the binary exists/is on PATH, or pass `--binary <full path>`.";
      throw new Error(`could not find executable: ${parsed.binary}\n${hint}`);
    }

    await startServer({
      port,
      secret,
      binary: resolvedBinary,
      args: parsed.codexArgs.length > 0 ? parsed.codexArgs : ["app-server"],
      protocol: parsed.protocol,
    });
  } catch (err: any) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
}

