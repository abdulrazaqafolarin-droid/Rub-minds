import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "scripts/rub-minds-mcp.mjs");
const minimalEnv = { PATH: process.env.PATH ?? "" };

test("terminal MCP CLI help is available without credentials or network access", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: root,
    env: minimalEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Rub Minds terminal MCP bridge/);
  assert.match(result.stdout, /--stdio/);
  assert.equal(result.stderr, "");
});

test("stdio mode fails closed when the staging endpoint is not configured", () => {
  const result = spawnSync(process.execPath, [cli, "--stdio"], {
    cwd: root,
    env: minimalEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /RUB_MINDS_MCP_ENDPOINT/);
  assert.equal(result.stdout, "");
});

test("unknown CLI options are rejected without starting a connection", () => {
  const result = spawnSync(process.execPath, [cli, "--anything"], {
    cwd: root,
    env: minimalEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run with --stdio/);
});
