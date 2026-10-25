#!/usr/bin/env node
// Read-only MCP staging smoke test. Never redeems an invite or writes data.
import assert from "node:assert/strict";
import { MCP_MODERN_PROTOCOL_VERSION, getModernMcpTools } from "./protocol.mjs";

const endpoint = process.env.RUB_MINDS_STAGING_MCP_URL;
const confirmation = process.env.RUB_MINDS_STAGING_CONFIRM;
const PROD_REF = "zucaeevlbwhcvjwbhwmq";
const fail = (message) => { console.error("STAGING PREFLIGHT BLOCKED:", message); process.exitCode = 1; };
if (confirmation !== "I_CONFIRM_NON_PRODUCTION" || !endpoint) {
  fail("Set RUB_MINDS_STAGING_CONFIRM=I_CONFIRM_NON_PRODUCTION and RUB_MINDS_STAGING_MCP_URL to a dedicated staging Supabase MCP endpoint.");
} else {
  try {
    const url = new URL(endpoint);
    assert.equal(url.protocol, "https:", "HTTPS required");
    assert.equal(url.username, "", "Embedded credentials are prohibited");
    assert.equal(url.password, "", "Embedded credentials are prohibited");
    assert.equal(url.search, "", "Query strings are prohibited");
    assert.equal(url.hash, "", "Fragments are prohibited");
    assert.match(url.hostname, /^[a-z0-9-]+\.supabase\.co$/, "Must use a Supabase project hostname");
    assert.notEqual(url.hostname, PROD_REF + ".supabase.co", "Production project is forbidden");
    assert.equal(url.pathname, "/functions/v1/rub-minds-mcp", "Unexpected Edge Function path");

    const rpc = async (method, id) => {
      const request = {
        jsonrpc: "2.0", id, method,
        params: { _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
            "Mcp-Method": method,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
          redirect: "error",
        });
        assert.equal(response.status, 200, method + " HTTP status " + response.status);
        const body = await response.json();
        assert.equal(body.jsonrpc, "2.0");
        assert.equal(body.id, id);
        assert.ok(body.result && !body.error, method + " returned a JSON-RPC error");
        return body.result;
      } finally { clearTimeout(timeout); }
    };

    const discovery = await rpc("server/discover", "staging-discover");
    assert.ok(discovery.supportedVersions?.includes(MCP_MODERN_PROTOCOL_VERSION), "Protocol version missing");
    const listed = await rpc("tools/list", "staging-list");
    const names = new Set(listed.tools?.map((tool) => tool.name));
    for (const tool of getModernMcpTools()) {
      assert.ok(names.has(tool.name), "Missing required tool: " + tool.name);
    }
    assert.ok(names.has("join_group") && names.has("leave_group"));
    console.log("PASS: non-production MCP discovery and tool listing; no invitation redeemed or data modified.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
