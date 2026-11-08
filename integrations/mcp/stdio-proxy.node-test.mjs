import test from "node:test";
import assert from "node:assert/strict";
import { createMcpStdioProxy, validateMcpEndpoint } from "./stdio-proxy.mjs";

const ENDPOINT = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp";

function upstream(fetchImpl) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const request = requests.at(-1).body;
    let result;
    if (request.method === "server/discover") {
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions: "Use invitations only with explicit approval.",
      };
    } else if (request.method === "tools/list") {
      result = { resultType: "complete", tools: [{ name: "join_group", inputSchema: { type: "object" } }] };
    } else {
      result = { content: [{ type: "text", text: JSON.stringify({ session_handle: "a".repeat(64) }) }] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, requests };
}

test("accepts only a clean HTTPS Supabase Rub Minds MCP function URL", () => {
  assert.equal(validateMcpEndpoint(ENDPOINT), ENDPOINT);
  for (const value of [
    "http://rub-minds-staging.supabase.co/functions/v1/rub-minds-mcp",
    "https://user:secret@rub-minds-staging.supabase.co/functions/v1/rub-minds-mcp",
    "https://rub-minds-staging.supabase.co/functions/v1/other",
    ENDPOINT + "?token=secret",
    ENDPOINT + "#fragment",
    "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp",
    "https://evil.example/functions/v1/rub-minds-mcp",
  ]) assert.throws(() => validateMcpEndpoint(value));
});

test("initialization validates upstream capability and carries safety instructions", async () => {
  const mock = upstream();
  const proxy = createMcpStdioProxy({ endpoint: ENDPOINT, fetchImpl: mock.fetch });
  const response = await proxy.handle({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(response.result.serverInfo.name, "rub-minds-terminal-bridge");
  assert.match(response.result.instructions, /explicit approval/);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.method, "server/discover");
  assert.equal(mock.requests[0].init.headers["MCP-Protocol-Version"], "2026-07-28");
  assert.equal(mock.requests[0].init.headers["Mcp-Method"], "server/discover");
  assert.equal(mock.requests[0].body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
});

test("tool discovery and calls are forwarded without mutating the existing MCP contract", async () => {
  const mock = upstream();
  const proxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    apiKey: "public-publishable-key",
    fetchImpl: mock.fetch,
  });
  const list = await proxy.handle({ jsonrpc: "2.0", id: "list", method: "tools/list" });
  assert.equal(list.result.tools[0].name, "join_group");
  const inviteArgs = {
    invite_token: "b".repeat(64),
    agent_label: "Terminal agent",
    confirm_join: true,
    join_request_key: "c".repeat(64),
  };
  const call = await proxy.handle({
    jsonrpc: "2.0", id: "join", method: "tools/call",
    params: { name: "join_group", arguments: inviteArgs },
  });
  assert.equal(call.result.content[0].type, "text");
  assert.deepEqual(mock.requests[1].body.params, {
    name: "join_group",
    arguments: inviteArgs,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "rub-minds-terminal-mcp-bridge",
        version: "0.1.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(mock.requests[1].init.headers["Mcp-Name"], "join_group");
  assert.equal(mock.requests[1].init.headers.apikey, "public-publishable-key");
  assert.equal(mock.requests.every(item => item.init.redirect === "error" && item.init.cache === "no-store"), true);
});

test("notifications are ignored and malformed or unsupported calls fail safely", async () => {
  const mock = upstream();
  const proxy = createMcpStdioProxy({ endpoint: ENDPOINT, fetchImpl: mock.fetch });
  assert.equal(await proxy.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await proxy.handle({ jsonrpc: "1.0", id: 1, method: "tools/list" })).error.code, -32600);
  assert.equal((await proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "" } })).error.code, -32602);
  assert.equal((await proxy.handle({ jsonrpc: "2.0", id: 3, method: "not/a-method" })).error.code, -32601);
  assert.equal(mock.requests.length, 0);
});

test("rejects redirects, oversized calls and mismatched upstream response ids", async () => {
  const redirectProxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    fetchImpl: async () => { throw new Error("redirect blocked"); },
  });
  const redirectResult = await redirectProxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(redirectResult.error.code, -32000);
  assert.match(redirectResult.error.message, /Could not reach or read/);

  const mismatchProxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })),
  });
  const mismatch = await mismatchProxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.match(mismatch.error.message, /mismatched/);

  const largeProxy = createMcpStdioProxy({ endpoint: ENDPOINT, fetchImpl: upstream().fetch });
  const large = await largeProxy.handle({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "send_group_message", arguments: { body: "x".repeat(1_200_000) } },
  });
  assert.match(large.error.message, /message size/);
});

test("upstream HTTP and JSON-RPC failures never leak credentials into the response", async () => {
  const apiKey = "DO_NOT_LEAK_THIS_KEY";
  const credential = "DO_NOT_LEAK_INVITE_TOKEN";
  const proxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ error: "rejected request" }), { status: 403 }),
  });
  const result = await proxy.handle({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "join_group", arguments: { invite_token: credential } },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(credential));
  assert.equal(result.error.code, -32000);
});

test("rejects Supabase secret and legacy service-role API keys before any network request", () => {
  const serviceRole = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const jwt = "e30." + serviceRole + ".signature";
  for (const apiKey of ["sb_secret_do_not_use", jwt]) {
    assert.throws(() => createMcpStdioProxy({
      endpoint: ENDPOINT,
      apiKey,
      fetchImpl: async () => { throw new Error("must not be called"); },
    }), /not allowed|forbidden/);
  }
});

test("request timeout remains active while the upstream response body is being read", async () => {
  let aborted = false;
  const proxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      init.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return {
        ok: true,
        status: 200,
        text: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      };
    },
  });
  const result = await proxy.handle({ jsonrpc: "2.0", id: 99, method: "tools/list" });
  assert.equal(aborted, true);
  assert.equal(result.error.code, -32000);
  assert.match(result.error.message, /Could not reach or read/);
});

test("the proxy caps concurrent upstream calls and releases capacity after completion", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const proxy = createMcpStdioProxy({
    endpoint: ENDPOINT,
    fetchImpl: async (_url, init) => {
      await gate;
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }), { status: 200 });
    },
  });
  const pending = Array.from({ length: 32 }, (_, id) =>
    proxy.handle({ jsonrpc: "2.0", id, method: "tools/list" })
  );
  const overflow = await proxy.handle({ jsonrpc: "2.0", id: "overflow", method: "tools/list" });
  assert.equal(overflow.error.code, -32000);
  assert.match(overflow.error.message, /busy/);
  release();
  const results = await Promise.all(pending);
  assert.equal(results.every(result => Array.isArray(result.result.tools)), true);
  const after = await proxy.handle({ jsonrpc: "2.0", id: "after", method: "tools/list" });
  assert.deepEqual(after.result.tools, []);
});
