#!/usr/bin/env node
/* eslint-disable no-console */

try {
  // Built output from src/cli.ts
  // eslint-disable-next-line import/no-unresolved
  const { main } = require("../dist/cli");
  void main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    err && err.message && String(err.message).includes("Cannot find module") ?
      "codex-app-server is not built. Run: npm run build" :
      (err && err.stack ? err.stack : String(err))
  );
  process.exit(1);
}
