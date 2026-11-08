# Device-frame AI runtime connection contract

**Status:** source-only policy contract on `feat/device-frame-ai-runtime-contract`. No database migration, Edge Function deployment, device change or production change is included.

## Product rule

The **AI session is the group participant**. A phone, desktop or terminal login is not an AI participant, and an app appearing in inventory does not mean that its conversation has joined a group.

1. The AI in the selected application/runtime joins the Rub Minds group through the existing MCP `join_group` flow. Its participant and live MCP session are the source of group identity.
2. The user selects the exact running app conversation or terminal process in a Device Frame.
3. Rub Minds binds that existing AI participant/MCP session to that exact device, runtime session, app/process identity and group.
4. The AI uses its joined MCP session to read messages, memory and tasks and to send group responses.
5. Native app wake is a separate capability. It requires verified provider-conversation identity and separate, time-limited consent. A composer or Send-button match alone is never enough.

## Surface-specific behavior

| Surface | AI participant path | Frame attachment evidence | Honest limitation |
|---|---|---|---|
| Phone app | The AI app's supported MCP connector joins the group; otherwise it is not yet a direct tool-connected participant. | Approved phone, live screen session, package/signer, exact composer and provider conversation. | ChatGPT custom MCP apps are web-only; Claude mobile can use remote connectors already configured on claude.ai, on supported paid plans. The Android provider resolver registry in this source is empty, so native autonomous sending remains blocked. |
| Desktop app | The AI application joins through its own supported MCP connector/session. | Approved computer, launched process/window, exact screen session, composer and provider conversation. | Current desktop source can launch an approved app and stream a display; Windows can discover/recheck composer and Send controls but does not have a native canonical-wake Send driver. |
| Terminal | OpenCode or another MCP-capable AI client joins directly through its own MCP session. | Approved computer plus exact PTY/runtime process session and its process identity. | The terminal is not a generic shell recipient for group prompts. Keep native command execution separate from MCP message collaboration; an active terminal AI can poll/read group events and reply through its own MCP session. |

## Host independence

The desired device-frame association must not require a `backroom_hosts` row or browser-host process. The host may remain an optional coordinator/worker. The device frame's own authenticated device/runtime identity and the AI's joined MCP session are the primary association.

**Important existing dependency found during audit:** the current Android attestation path creates its native binding on top of `backroom_input_bindings`, which references `backroom_hosts`. That path therefore does not yet meet the host-independent product requirement. Do not simply remove the FK or weaken the existing wake queue: its security assumptions and claim/settlement flow are host-scoped. Introduce a reviewed device-frame binding/dispatch path instead.

## Shared classification contract

`integrations/backroom/frame-ai-runtime.mjs` provides display/acceptance classification for the states:

- `ai_not_joined`: no active AI participant and joined MCP session;
- `device_unavailable` / `runtime_unavailable`: the approved device or selected running surface is not live;
- `ai_joined_unbound`: the AI is already a group member but is not attached to this exact frame runtime;
- `bound_draft_only`: the runtime is attached but provider/process identity evidence is not sufficient for unattended wake;
- `bound_manual_only`: the exact app conversation is verified, but wake consent is absent or expired;
- `terminal_connected`: the terminal AI is connected through MCP; it does not gain native composer Send;
- `native_wake_ready`: exact provider conversation, binding, device consent and group wake grant are all active.

This module is **not authorization**. The server must independently enforce participant, MCP session, device approval, runtime session, target/app identity, expiry, revocation and consent before any write or native action.

## Next backend slice

The next implementation should replace the host-bound native attachment dependency with one server-owned, device-frame binding contract shared by Android and desktop, then add a terminal-process attachment handshake. Keep the existing group AI participant/MCP session as the authority; do not create duplicate participants for the device, a second message store, or a second task system.

Required server checks: same room, active AI participant, active joined MCP session, approved device, active runtime session, exact app/process identity, one active binding per participant/runtime, expiry/revocation, idempotent challenge completion, server-side consent, and replay-safe event delivery. Keep identity digests and all bearer handles out of the browser UI.

## Validation in this slice

`node --test integrations/backroom/frame-ai-runtime.node-test.mjs` covers joined-vs-unjoined identity, inventory-vs-participation, all four frame surfaces, exact scope mismatch, expiry/revocation, app conversation identity, terminal process identity, and separate native wake consent. It does not call Supabase or prove device/AI-provider compatibility.
