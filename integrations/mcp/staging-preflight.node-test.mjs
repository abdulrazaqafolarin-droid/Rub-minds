import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./staging-preflight.mjs", import.meta.url));
function run(env) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}
test("staging preflight rejects absent explicit confirmation", () => {
  const result = run({ RUB_MINDS_STAGING_MCP_URL: "https://staging.supabase.co/functions/v1/rub-minds-mcp" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /STAGING PREFLIGHT BLOCKED/);
});
test("staging preflight refuses the real Rub Minds production Supabase project", () => {
  const result = run({
    RUB_MINDS_STAGING_CONFIRM: "I_CONFIRM_NON_PRODUCTION",
    RUB_MINDS_STAGING_MCP_URL: "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production project is forbidden/);
});
test("staging preflight rejects untrusted HTTP and unrelated hosts", () => {
  for (const url of ["http://staging.supabase.co/functions/v1/rub-minds-mcp", "https://rub-minds.vercel.app/functions/v1/rub-minds-mcp"]) {
    const result = run({ RUB_MINDS_STAGING_CONFIRM: "I_CONFIRM_NON_PRODUCTION", RUB_MINDS_STAGING_MCP_URL: url });
    assert.equal(result.status, 1);
  }
});
test("staging preflight rejects embedded secrets and alternate functions", () => {
  for (const url of ["https://user:pass@staging.supabase.co/functions/v1/rub-minds-mcp", "https://staging.supabase.co/functions/v1/redeem-ai-invite"]) {
    const result = run({ RUB_MINDS_STAGING_CONFIRM: "I_CONFIRM_NON_PRODUCTION", RUB_MINDS_STAGING_MCP_URL: url });
    assert.equal(result.status, 1);
  }
});
