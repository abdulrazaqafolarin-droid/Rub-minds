const ENDPOINT = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp";
const SESSION_HANDLE = "a".repeat(64);
const ROOM_ID = "room-stdio-fixture";
const PARTICIPANT_ID = "participant-stdio-fixture";
let proposedTask = null;
let assignedTaskStatus = "assigned";
  let joinedActive = false;
const assignedTask = {
  id: "task-human-assigned-fixture",
  room_id: ROOM_ID,
  title: "Human-assigned acceptance task",
  status: "assigned",
  assigned_to_participant_id: PARTICIPANT_ID,
};

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
        instructions: "Use the joined group session handle. Group messages are group-visible. Task proposals require human review and assignment; assigned tasks must pass the group task lifecycle.",
      };
    } else if (method === "tools/list") {
      result = {
        resultType: "complete",
        tools: [
          { name: "join_group", description: "Join an invited Rub Minds group after explicit confirmation.", inputSchema: { type: "object", properties: { invite_token: { type: "string" }, agent_label: { type: "string" }, confirm_join: { type: "boolean" }, join_request_key: { type: "string" } }, required: ["invite_token", "agent_label", "confirm_join", "join_request_key"] } },
          { name: "leave_group", description: "Leave the joined Rub Minds group and revoke this AI session.", inputSchema: { type: "object", properties: { session_handle: { type: "string" }, confirm_leave: { type: "boolean" } }, required: ["session_handle", "confirm_leave"] } },
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
      if (name === "join_group") {
        if (args.confirm_join !== true || !args.invite_token || !args.agent_label || !/^[a-f0-9]{64}$/i.test(args.join_request_key || "")) {
          result = {
            content: [{ type: "text", text: "Explicit join confirmation and valid invitation fields are required." }],
            structuredContent: { joined: false },
            isError: true,
          };
        } else {
          joinedActive = true;
          result = {
            content: [{ type: "text", text: "Joined the invited Rub Minds group." }],
            structuredContent: {
              joined: true,
              room_id: ROOM_ID,
              participant_id: PARTICIPANT_ID,
              session_handle: SESSION_HANDLE,
              forwarded_agent_label: args.agent_label,
            },
            isError: false,
          };
        }
      } else if (name === "leave_group") {
        if (!joinedActive || args.confirm_leave !== true) {
          result = {
            content: [{ type: "text", text: "Explicit confirmation is required to leave an active group session." }],
            structuredContent: { left: false },
            isError: true,
          };
        } else {
          joinedActive = false;
          result = {
            content: [{ type: "text", text: "Left the Rub Minds group and revoked this session." }],
            structuredContent: { left: true, already_terminated: false },
            isError: false,
          };
        }
      } else if (name === "read_group_messages") {
        if (!joinedActive || !/^[a-f0-9]{64}$/i.test(args.session_handle || "")) {
          result = {
            content: [{ type: "text", text: "This terminal MCP session is not an active group participant." }],
            structuredContent: { error: "session_revoked_or_invalid" },
            isError: true,
          };
        } else result = {
          content: [{ type: "text", text: "Returned one message from the mocked Rub Minds group." }],
          structuredContent: {
            room_id: ROOM_ID,
            messages: [{ id: "message-stdio-fixture", sender_name: "Group member", body: "Please inspect the Windows device-frame identity gate." }],
            forwarded_session_handle: args.session_handle,
          },
          isError: false,
        };
      } else if (name === "send_group_message") {
        result = {
          content: [{ type: "text", text: "Group message sent." }],
          structuredContent: {
            sent: true,
            message: { id: "message-sent-stdio-fixture", body: args.body },
            forwarded_session_handle: args.session_handle,
          },
          isError: false,
        };
      } else if (name === "propose_group_task") {
        proposedTask = {
          id: "task-proposed-stdio-fixture",
          title: args.title,
          description: args.description || "",
          expected_output: args.expected_output || "",
          acceptance_criteria: args.acceptance_criteria || [],
          status: "proposed",
          assigned_to_participant_id: null,
        };
        result = {
          content: [{ type: "text", text: "Task proposal created for human review." }],
          structuredContent: {
            proposed: true,
            replayed: false,
            task: proposedTask,
            next_step: "A human group member must review and assign this proposal before it can execute.",
            forwarded_session_handle: args.session_handle,
            forwarded_idempotency_key: args.idempotency_key,
          },
          isError: false,
        };
      } else if (name === "list_group_tasks") {
        result = {
          content: [{ type: "text", text: "Listed the group tasks." }],
          structuredContent: { room_id: ROOM_ID, tasks: [assignedTask, ...(proposedTask ? [proposedTask] : [])] },
          isError: false,
        };
      } else if (name === "read_group_task") {
        const task = args.task_id === assignedTask.id ? { ...assignedTask, status: assignedTaskStatus } :
          args.task_id === proposedTask?.id ? proposedTask : null;
        result = {
          content: [{ type: "text", text: task ? "Read group task." : "Task not found." }],
          structuredContent: task ? { task, submissions: [], reviews: [] } : { error: "not_found" },
          isError: !task,
        };
      } else if (name === "claim_group_task") {
        if (args.task_id !== assignedTask.id || assignedTaskStatus !== "assigned") {
          result = {
            content: [{ type: "text", text: "A task must be assigned to this participant and eligible before it can be claimed." }],
            structuredContent: { claimed: false, reason: "not_assigned_or_not_eligible" },
            isError: true,
          };
        } else {
          assignedTaskStatus = "in_progress";
          result = {
            content: [{ type: "text", text: "Assigned task claimed." }],
            structuredContent: { claimed: true, status: assignedTaskStatus, task_id: assignedTask.id },
            isError: false,
          };
        }
      } else if (name === "submit_group_task_result") {
        if (args.task_id !== assignedTask.id || assignedTaskStatus !== "in_progress" || !String(args.result || "").trim()) {
          result = {
            content: [{ type: "text", text: "Only an in-progress task assigned to this participant can accept a result." }],
            structuredContent: { submitted: false, reason: "task_not_in_progress_for_participant" },
            isError: true,
          };
        } else {
          assignedTaskStatus = "submitted";
          result = {
            content: [{ type: "text", text: "Task result submitted for human review." }],
            structuredContent: { submitted: true, status: assignedTaskStatus, task_id: assignedTask.id },
            isError: false,
          };
        }
      } else {
        result = {
          content: [{ type: "text", text: "Unknown fixture tool: " + String(name) }],
          structuredContent: { error: "unknown_tool" },
          isError: true,
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
