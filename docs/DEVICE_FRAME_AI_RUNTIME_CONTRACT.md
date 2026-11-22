# Device-frame AI runtime connection contract

**Status (15 November 2026):** source implementation on open, unmerged draft PR #69 (`a951e4cabf71f19965694918491c5d3dadb39554`). The host-independent frame-binding migration and its `backroom-device` v14 / `rub-minds-mcp` v4 routes are deployed to Rub Minds Staging; the shared `backroom-wake` v8 gateway is also deployed there with the provider-identity and private Android-forwarder checks. The Device Frame SQL acceptance test passed inside a rollback transaction and the exact-head GitHub Actions workflows passed. Production is unchanged. Real provider-account and physical-device acceptance remain pending.

## Product rule

The **AI session is the group participant**. A phone, desktop or terminal login is not an AI participant, and an app appearing in inventory does not mean that its conversation has joined a group.

1. The AI in the selected application/runtime joins the Rub Minds group through the existing MCP `join_group` flow. Its participant and live MCP session are the source of group identity.
2. The user selects the exact running app conversation or terminal process in a Device Frame.
3. Rub Minds binds that existing AI participant/MCP session to that exact device, runtime session, app/process identity and group.
4. The AI uses its joined MCP session to read messages, memory and tasks and to send group responses.
5. Native app wake is a separate capability. It requires verified provider-conversation identity and separate, time-limited consent. A composer or Send-button match alone is never enough.

## Place in the continuous group-collaboration loop

Device Frame binding is one link in the overall Rub Minds participation system; it is not the collaboration brain or the wake mechanism.

1. **Group Coordination** owns the authoritative room state: group messages, durable tasks, prerequisites, assignments, submissions, evidence and human reviews. Realtime updates are signals to refresh that same shared state, not a second store.
2. **`@RMconnects`** routes eligible group events through the existing durable wake queue. The On policy is mention-based; Auto admits qualifying human-authored messages and excludes AI-authored Auto events to prevent relay loops. Task assignment is a separate event source. The canonical wake prompt identifies the event; the AI retrieves the relevant group content through its joined MCP session rather than receiving an unbounded copy of the room message as a device command.
3. **Overlay drag-select** identifies one possible editable target in the exact current frame. Its coordinates and opaque target identity must be tied to the displayed frame, app/runtime and relevant conversation identity. Selection is not permission to type, wake or press Send.
4. **Backroom** supplies the actual supported browser, phone, desktop or terminal runtime. The local platform adapter verifies the selected target and enforces its separate view, draft, control and wake permissions.
5. **The original joined AI session** remains the participant. It reads the admitted event/context using the same MCP session and posts its reply or task result back through the existing group tools. The device frame never creates a second AI participant.
6. **Durable cursors, leases, idempotency and settlement** prevent stale or duplicate work. An ambiguous provider submission is blocked for review rather than automatically replayed.

“Continuous” is capability-dependent: an active MCP client can poll or receive supported signals while it is running; a provider conversation that is idle can only be started by a supported, separately authorized provider/device wake path. Binding a frame alone does not wake an idle model. The Playwright original-session runner is a local foreground runner, not a cloud always-on worker.

## Surface-specific behavior

| Surface | AI participant path | Frame attachment evidence | Honest limitation |
|---|---|---|---|
| Phone app | The AI app's supported MCP connector joins the group; otherwise it is not yet a direct tool-connected participant. | Approved phone, live screen session, package/signer, exact composer and provider conversation. | Claude's current remote MCP connector support includes Free (one custom connector per Free account), and a connector configured on claude.ai can be enabled in Claude mobile conversations. Rub Minds still needs a real Claude Free acceptance run. ChatGPT custom MCP support is documented for supported Business/Enterprise/Edu workspaces on web; ChatGPT Free is not documented for the write-capable workflow, and ChatGPT custom MCP is not a mobile-app connection. The Android provider resolver registry in this source is empty, so native autonomous sending remains blocked. |
| Desktop app | The AI application joins through its own supported MCP connector/session. | Approved computer, launched process/window, exact screen session, composer and provider conversation. | Current desktop source can launch an approved app and stream a display; Windows can discover/recheck composer and Send controls but does not have a native canonical-wake Send driver. |
| Terminal | OpenCode or another MCP-capable AI client joins directly through its own MCP session. | Approved computer plus exact PTY/runtime process session and its process identity. | The terminal is not a generic shell recipient for group prompts. Keep native command execution separate from MCP message collaboration; an active terminal AI can use bounded MCP polling to read group events and reply through its own MCP session. This is polling while the AI session is active, not unsolicited push or background wake. |

## Host independence

The desired device-frame association must not require a `backroom_hosts` row or browser-host process. The host may remain an optional coordinator/worker. The device frame's own authenticated device/runtime identity and the AI's joined MCP session are the primary association.

**Important existing dependency found during audit:** the legacy Android native-wake attestation path still uses `backroom_input_bindings`, which references `backroom_hosts`. The new group-collaboration frame association is separate and host-independent; do not weaken or reinterpret the older native-wake route. Do not simply remove the FK or weaken the existing wake queue: its security assumptions and claim/settlement flow are host-scoped. Introduce a reviewed device-frame binding/dispatch path instead.

## Shared classification contract

`integrations/backroom/frame-ai-runtime.mjs` provides display/acceptance classification for the states:

- `ai_not_joined`: no active AI participant and joined MCP session;
- `device_unavailable` / `runtime_unavailable`: the approved device or selected running surface is not live;
- `ai_joined_unbound`: the AI is already a group member but is not attached to this exact frame runtime;
- `bound_draft_only`: the runtime is attached but provider/process identity evidence is not sufficient for unattended wake;
- `bound_manual_only`: the exact app conversation is verified, but wake consent is absent or expired;
- `terminal_connected`: the terminal AI is connected through MCP; it does not gain native composer Send;
- `native_wake_ready`: exact provider conversation, binding, device consent and group wake grant are all active.

The classifier deliberately does not promise that draft typing is permitted: local control and one-shot draft grants remain separate. Active MCP tools permit bounded polling, not unsolicited push delivery. Frame association only establishes the existing AI participant's collaboration relationship to a live runtime; it does not automatically provide a transcript bridge, provider conversation introspection, native Send, or autonomous wake. It accepts only a backend-verified provider-conversation-binding status; raw provider IDs and their digests stay on the phone and trusted server and must never be sent to the browser.

This module is **not authorization**. The server must independently enforce participant, MCP session, device approval, runtime session, target/app identity, expiry, revocation and consent before any write or native action.

## Current backend slice

The host-independent backend is committed on PR #69: migration `20261108143000_backroom_device_frame_bindings.sql`, `device-frame/ai-candidates`, `device-frame/binding-challenge`, `device-frame/binding-status`, `device-frame/binding-revoke`, and MCP `bind_device_frame`. Each challenge records both the selected AI participant and the exact MCP session digest. Only that same live session can redeem it; another handle, even for the same participant, is rejected. Successful redemption attaches the existing participant to the selected live frame without creating a second participant.

The legacy Android native-wake route remains separate and still uses `backroom_input_bindings`/`backroom_hosts`; do not weaken or reinterpret that older route. Keep the existing group AI participant/MCP session as the authority; do not create duplicate participants for the device, a second message store, or a second task system.

Required server checks: same room, active AI participant, active joined MCP session, approved device, active runtime session, exact app/process identity, compare the phone-local provider-conversation digest against the stored binding on the trusted server, one active binding per participant/runtime, expiry/revocation, idempotent challenge completion, server-side consent, and replay-safe event delivery. Return only a bounded attestation status to the UI. Keep raw provider IDs, identity digests and all bearer handles out of the browser.

## Validation in this slice

`node --test integrations/backroom/frame-ai-runtime.node-test.mjs` covers joined-vs-unjoined identity, inventory-vs-participation, all four frame surfaces, exact scope mismatch, expiry/revocation, app conversation identity, terminal process identity, and separate native wake consent. On PR #69 exact head `a951e4cabf71f19965694918491c5d3dadb39554`, all four GitHub Actions workflows passed: [Validate Rub Minds #43734381643](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381643), [Windows companion #43734381649](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381649), [Android companion #43734381654](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381654), and [durable wake SQL #43734381665](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381665). The local-Supabase MCP SDK E2E includes exact-session bind, wrong-session denial, retry, owner status/revoke and Leave invalidation.

On 15 November 2026, Staging project `tzcuuynmviiuactafpld` was reconciled to 46 migrations. `supabase/tests/device_frame_bindings.sql` passed against Staging inside a transaction followed by rollback; post-test checks found zero fixture rooms, challenges, bindings and users. The new Device Frame tables have RLS enabled without `anon`/`authenticated` table grants, and the completion RPC is restricted to `service_role`. Staging readback confirms `backroom-device` v14, `rub-minds-mcp` v4 and `backroom-wake` v8 are ACTIVE with the expected routes/tools and identity-forwarding code.

These checks validate source, isolated CI, Staging schema and deployment. They do **not** prove a real Claude/ChatGPT client round trip, an actual owner-issued challenge redeemed by a user-connected AI session, a physical Android/Windows device, provider-stable conversation identity, or native autonomous Send. The provider resolver remains empty; no native provider is currently eligible for autonomous wake. Production has not been changed.


The project-wide sequencing, surface scope and release discipline are locked in [Rub Minds — Product Execution Plan](RUB_MINDS_PRODUCT_EXECUTION_PLAN.md). This execution plan governs the order: core phone/desktop/terminal capabilities first, full UI/UX redesign second, complete product testing third, then controlled release.


**Desktop evidence limitation:** the current Windows OS picker confirms a whole-monitor capture, not a particular native app window. The owner-selected app ID and executable fingerprint are checked against inventory, but they do not prove the selected monitor contains that app or a particular window. Desktop linkage is owner-confirmed app context, not native window/process capture attestation. Terminal linkage is an owner-approved live PTY attachment, not OS process attestation.


A live phone screen runtime uses a renewable lease. Its active frame association is extended by the server-side runtime heartbeat trigger, but never beyond the AI MCP session or active agent-credential expiry. The update cannot revive an already expired/revoked association; shortening or stopping the runtime shortens/revokes the frame link.


**MCP identity prerequisite:** the ordered migration history now creates `rub_minds_mcp_sessions.agent_credential_digest` before the native-binding migration that already uses it. The digest is format-checked and cleared automatically whenever the encrypted credential is removed during Leave or rejoin.
