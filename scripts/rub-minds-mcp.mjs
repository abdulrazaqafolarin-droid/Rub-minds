#!/usr/bin/env node
import { createMcpStdioProxy, MCP_PROXY_LIMITS } from "../integrations/mcp/stdio-proxy.mjs";

const HELP = `Rub Minds terminal MCP bridge

Usage:
  node scripts/rub-minds-mcp.mjs --stdio

Environment:
  RUB_MINDS_MCP_ENDPOINT   Required HTTPS Supabase Rub Minds MCP function URL.
  RUB_MINDS_MCP_API_KEY    Optional public Supabase publishable/anon key when the
                           project's API gateway requires an apikey header.

This process exposes Rub Minds' existing group, memory and task tools to a local
MCP-compatible terminal agent over stdio. It does not create a second backend,
store invitation/session credentials, or run an always-on host.
The calling agent must request explicit approval for group joining and writes.

Protocol limits:
  local MCP: ${MCP_PROXY_LIMITS.localProtocolVersion}
  upstream MCP: ${MCP_PROXY_LIMITS.remoteProtocolVersion}
  max message: ${MCP_PROXY_LIMITS.maxMessageBytes} bytes
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--stdio") {
  process.stderr.write("Run with --stdio (or --help).\n");
  process.exit(2);
}

let proxy;
try {
  proxy = createMcpStdioProxy({
    endpoint: process.env.RUB_MINDS_MCP_ENDPOINT,
    apiKey: process.env.RUB_MINDS_MCP_API_KEY,
  });
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Invalid Rub Minds MCP configuration.") + "\n");
  process.exit(2);
}

let buffer = "";
let stopped = false;
const writeResponse = (response) => {
  if (!response || stopped || process.stdout.destroyed) return;
  process.stdout.write(JSON.stringify(response) + "\n");
};
const handleLine = (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > MCP_PROXY_LIMITS.maxMessageBytes) {
    writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "MCP message exceeds the supported size." } });
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC JSON." } });
    return;
  }
  void proxy.handle(message).then(writeResponse).catch(() => {
    writeResponse({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32000, message: "Rub Minds MCP request failed." } });
  });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    handleLine(line);
    newline = buffer.indexOf("\n");
  }
  if (Buffer.byteLength(buffer, "utf8") > MCP_PROXY_LIMITS.maxMessageBytes) {
    process.stderr.write("MCP input exceeded the supported message size; stopping the bridge.\n");
    stopped = true;
    process.stdin.destroy();
    process.exitCode = 1;
  }
});
process.stdin.on("end", () => {
  stopped = true;
});
process.stdin.on("error", () => {
  stopped = true;
  process.stderr.write("MCP input stream failed.\n");
  process.exitCode = 1;
});
