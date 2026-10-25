/**
 * Compose the authorized message transport, injected provider adapter, browser
 * bridge and room-scoped Realtime signal into one explicitly started runtime.
 *
 * The Supabase client must be scoped to the authorized human member; never pass
 * a service-role key to client-side runtime code. Group reads/writes use the
 * room-bound hosted MCP session handle. Provider DOM interaction remains injected.
 */
import { McpSessionMessageTransport } from "./mcp-session-message-transport.mjs";
import { OriginalSessionWakeRunner } from "./wake-bridge-runner.mjs";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";
import { SupabaseRealtimeWakeSource } from "./supabase-realtime-wake-source.mjs";

export function createOriginalSessionWakeRuntime({
  endpoint,
  sessionHandle,
  participantId,
  roomId,
  page,
  adapter,
  supabaseClient,
  fetchImpl = globalThis.fetch,
  protocolVersion,
  waitTimeoutMs = 1000,
  requestTimeoutMs = 20000,
  intervalMs = 5000,
  maxReplies = 20,
  maxMessagesPerStep = 1,
  processExistingMessages = false,
  maxSeenMessageIds = 2000,
  heartbeatMs = 15000,
  maxConsecutiveErrors = 3,
  subscriptionTimeoutMs = 10000,
  maxQueuedWakes = 1,
  channelName,
  onStatus = () => {},
} = {}) {
  const transport = new McpSessionMessageTransport({
    endpoint,
    sessionHandle,
    fetchImpl,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    waitTimeoutMs,
    requestTimeoutMs,
  });
  const bridge = new PlaywrightSessionBridge({
    page,
    adapter,
    participantId,
    ...transport.createBridgeAdapters(),
    intervalMs,
    maxReplies,
    maxMessagesPerStep,
    processExistingMessages,
    maxSeenMessageIds,
    stateStore: {
      load: options => transport.loadBridgeState(options),
      save: (snapshot, options) => transport.saveBridgeState(snapshot, options),
    },
  });
  const wakeSource = new SupabaseRealtimeWakeSource({
    client: supabaseClient,
    roomId,
    maxQueuedWakes,
    channelName,
    subscriptionTimeoutMs,
  });
  const runner = new OriginalSessionWakeRunner({
    bridge,
    wakeSource,
    heartbeatMs,
    maxReplies,
    maxConsecutiveErrors,
    onStatus,
  });

  return Object.freeze({
    transport,
    bridge,
    wakeSource,
    runner,
    run: (options = {}) => runner.run(options),
    stop: () => runner.stop(),
  });
}
