"use strict";

function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function createLogger(prefix) {
  const p = prefix || "[codex-http] ";

  function log(line) {
    process.stdout.write(`${p}${formatTimestamp(new Date())} ${line}\n`);
  }

  return {
    info: log,
    warn: log,
    error: log,
  };
}

module.exports = { createLogger };

