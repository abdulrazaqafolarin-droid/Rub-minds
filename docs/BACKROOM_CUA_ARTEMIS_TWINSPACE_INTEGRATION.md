# CUA + ARTEMIS + TwinSpace integration

## Why these are separate adapters

| Workspace | Source-backed capability | Backroom integration shape |
|---|---|---|
| Desktop/native | CUA Driver MCP tools include list_windows, get_window_state and type_text; elements are snapshot-token addressed and actions return effect/verification signals. | Selected PID/window, fresh tree, exact element token, explicitly empty text control, owner-approved draft and readback. This first adapter does not press Enter or Send. |
| Terminal | CUA sandbox CLI can create local sandboxes and run commands. Its --stdin path executes argv without joining arguments into a shell line. | Dedicated local gVisor container, approved command argv, timeout/output cap, no host shell fallback and verified sandbox removal. |
| Android automation | ARTEMIS MCP provides mobile_run_task, mobile_manage_task, mobile_get_device_state, mobile_inspect_trace and mobile_diagnose. Its task runner is asynchronous and returns a trace ID. | Host-local device/package allowlists, explicit approval, package locking, trace-bound status/stop and inspected hierarchy. |
| Android dual space | The uploaded CHATGPT_BUNDLE.md and README.md define TwinSpace as an Android managed/work-profile companion using public platform APIs. | Isolated app copy/data is a separate companion-app track. A clone-space manager is neither a UI automation engine nor a trusted host-agent identity. |

## Official references consulted

- CUA: https://github.com/trycua/cua
- CUA Driver MCP tools: https://cua.ai/docs/cua-driver/reference/mcp-tools
- CUA window state: https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen
- CUA sandbox CLI: https://cua.ai/docs/cua-cli/reference/cli/sandboxes
- ARTEMIS: https://github.com/google/artemis
- ARTEMIS MCP tools: https://github.com/google/artemis/blob/main/mcp_server/README.md
- User-provided architecture: CHATGPT_BUNDLE.md and README.md attached in this conversation.

## Security review of the uploaded TwinSpace pattern

The supplied TwinSpace sample's cross-profile Auth.check() accepts an embedded key on first contact, persists it and returns success before checking signature/timestamp. Its HMAC covers only action and timestamp, not the complete command parameters or payload digest. Do not reuse this initial trust or payload authentication as a privileged install/uninstall RPC contract. For a production companion, use owner-mediated pairing/challenge, sign the canonical operation plus payload digest and nonce, enforce expiry/replay protection, and test across supported Android/OEM versions before enabling package installation/deletion.

The supplied source describes Android managed profiles as isolated app data under a second Android user, using cross-profile activity intents. Device/OEM support varies; the attachment itself notes that some OEM builds block work-profile provisioning. The source is architecture evidence, not proof of a tested APK build or production-secure implementation.

## Desktop behavior

Every operation is bound to a real app, PID, window ID, group and AI session. CUA element tokens are snapshot-scoped; fetch a fresh state before an action and refuse stale tokens. The adapter only types into a field whose accessibility role is text-like and value is explicitly empty. A second local confirmation covers exact draft text after target preflight. It reads back the value and returns needs_review for ambiguous results. Non-accessible fields remain denied rather than triggering a blind pixel fallback.

## Android behavior

ARTEMIS is an asynchronous task engine, not a generic text-input driver. The host allowlists serials and package names locally and binds run/status/stop to the trace and original group/session. The adapter sets the package lock and strict verification profile. Inspect trace, result and logs before reporting completion. Never manage an arbitrary trace from an untrusted message. Physical-device acceptance remains required.

## Terminal behavior

The command starts a dedicated local-only CUA Linux container with --kind container --runtime gvisor --headless. A command runs with --local --stdin --timeout and argv after --. The top-level executable is allowlisted and shell interpreters are rejected. Local confirmation is required per command. A sandbox does not make arbitrary software intrinsically safe; network, mounts and guest content still need threat review. If sandbox setup/removal fails, surface failure and do not fall back to host execution.

## Shared conversation limitation

The supplied ChatGPT share URL could not be retrieved by the available web context in this session, and the connected browser extension reported that no originating browser context was available. Accordingly, this implementation is checked against visible requirements and the supplied architecture files; this document does not claim the inaccessible shared conversation was read. Live provider roundtrips and original-session context sync remain acceptance gates.
