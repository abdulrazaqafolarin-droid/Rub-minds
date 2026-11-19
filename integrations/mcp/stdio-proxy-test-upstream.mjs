const ENDPOINT = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp";

if (process.env.RUB_MINDS_STDIO_E2E_FIXTURE === "1") {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url !== ENDPOINT) {
      throw new Error("The stdio MCP acceptance fixture blocks every non-fixture network request.");
    }
    if (init.method !== "POST" || init.redirect !== "error" || init.cache !== "no-store") {
      throw new Error("The stdio MCP bridge changed its upstream POST safety settings.");
    }
    const headers = new Headers(init.headers);
    if (headers.get("apikey") !== "rub-minds-public-test-key") {
      throw new Error("The stdio MCP bridge did not forward the configured public test key.");
    }
    const request = JSON.parse(String(init.body || "{}"));
    const method = request.method;
    let result;

    if (method === "server/discover") {
      if (request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") {
        throw new Error("The terminal bridge did not negotiate the expected upstream MCP protocol.");
      }
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: { listChanged: false } },
        instructions: "Use the joined group session handle. Group writes and task proposals remain subject to the group's permissions and human assignment/review.",
      };
    } else if (method === "tools/list") {
      result = {
        resultType: "complete",
        tools: [
          { name: "join_group", description: "Join an invited Rub Minds group after explicit confirmation.", inputSchema: { type: "object", properties: { invite_token: { type: "string" }, confirm_join: { type: "boolean" }, join_request_key: { type: "string" } }, required: ["invite_token", "confirm_join", "join_request_key"] } },
          { name: "read_group_messages", description: "Read messages from the joined group.", inputSchema: { type: "object", properties: { session_handle: { type: "string" } }, required: ["session_handle"] } },
          { name: "send_group_message", description: "Send a message to the joined group.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, body: { type: "string" } }, required: ["session_handle", "body"] } },
          { name: "propose_group_task", description: "Propose a task for human review and assignment.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, title: { type: "string" }, description: { type: "string" }, expected_output: { type: "string" }, acceptance_criteria: { type: "array", items: { type: "string" } }, priority: { type: "integer" }, idempotency_key: { type: "string" } }, required: ["session_handle", "title", "idempotency_key"] } },
          { name: "list_group_tasks", description: "Read the group task board.", inputSchema: { type: "object", properties: { session_handle: { type: "string" } }, required: ["session_handle"] } },
          { name: "read_group_task", description: "Read a task and its evidence.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, task_id: { type: "string" } }, required: ["session_handle", "task_id"] } },
          { name: "claim_group_task", description: "Claim an assigned, eligible task.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, task_id: { type: "string" } }, required: ["session_handle", "task_id"] } },
          { name: "submit_group_task_result", description: "Submit a completed assigned task for review.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, task_id: { type: "string" }, result: { type: "string" }, submission_key: { type: "string" } }, required: ["session_handle", "task_id", "result", "submission_key"] } },
        ],
      };
    } else if (method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      if (name === "read_group_messages") {
        result = {
          content: [{ type: "text", text: "Returned one message from the mocked Rub Minds group." }],
          structuredContent: {
            room_id: "room-stdio-fixture",
            messages: [{ id: "message-stdio-fixture", sender_name: "Group member", body: "Please inspect the Windows device-frame identity gate." }],
            forwarded_session_handle: args.session_handle,
          },
          isError: false,
        };
      } else if (name === "propose_group_task") {
        result = {
          content: [{ type: "text", text: "Task proposal created for human review." }],
          structuredContent: {
            proposed: true,
            replayed: false,
            task: { id: "task-stdio-fixture", title: args.title, status: "proposed" },
            next_step: "A human group member must review and assign this proposal before it can execute.",
            forwarded_session_handle: args.session_handle,
            forwarded_idempotency_key: args.idempotency_key,
          },
          isError: false,
        };
      } else {
        result = {
          content: [{ type: "text", text: "Mock tool call: " + String(name) }],
          structuredContent: { called: name, arguments: args },
          isError: false,
        };
      }
    } else {
      throw new Error("Unexpected upstream MCP method: " + String(method));
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
