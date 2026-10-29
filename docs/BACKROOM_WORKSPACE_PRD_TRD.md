# Backroom Workspace PRD + TRD

Status: implementation specification for the CUA / ARTEMIS integration increment. This records the intended product flow and engineering acceptance; it does not assert live provider or physical-device acceptance.

## Product requirements

Backroom is a consent-governed execution companion to Rub Minds groups, not an unrestricted remote desktop controller. A group and AI participant/session are distinct from a trusted local host, physical device, focused application and automation job. Group invitations convey only capabilities the server actually issues; an invitation or group message does not implicitly authorize operating-system actions or import hidden provider context.

### Intended flow

1. A human signs in, creates or opens a group and sends an invitation. Auth recovery must preserve an unexpired invite.
2. A supported AI participant joins using a documented hosted MCP/provider path. Do not claim that pasting a normal URL automatically grants access to hidden ChatGPT/Claude conversation state.
3. Group messages use durable IDs, scope checks, replay-safe reads, idempotent sends and reconnection. Private imported history remains private until the user selects what to share.
4. A permitted group event may be offered to a paired local host. The host resolves it against the stored group, AI session, target, capability, approval and expiry; incoming text is untrusted data.
5. The user selects a target on their device. For external workspaces the owner approves the exact observation or action locally; a remote JSON field such as approved=true is not sufficient.
6. The adapter observes fresh state, verifies selected app/window/device/session, performs only its advertised capability and independently reads back the outcome.
7. A missing or ambiguous postcondition becomes needs_review. Never blindly retry a possibly completed side effect.
8. The verified summary returns to the same group/session. Revocation, emergency stop, offline host, stale target, lost device, unknown task ID or runtime failure fail closed.

## Surfaces and first usable capabilities

| Surface | Adapter | Initial scope | Not claimed |
|---|---|---|---|
| Existing browser | Current Playwright BrowserHostRuntime | Existing selected-tab draft/wake contracts in the core branch | Hosted ChatGPT/Claude two-way live roundtrip |
| Desktop / native app | CUA Driver MCP | Enumerate windows, inspect selected window, type approved text into an explicitly empty accessibility text field and verify readback | Send button, Enter, arbitrary clicks, non-accessible fields |
| Android | Google ARTEMIS MCP | Approved task on explicitly allowlisted device/package; trace status, inspected hierarchy, approved stop | General-purpose Android shell, device-unlock bypass, unattended broad access |
| Terminal / coding | CUA local gVisor sandbox | Per-command approved argv in newly created local sandbox; bounded output; explicit teardown | Host shell, arbitrary raw PTY, unapproved command execution |
| Android data isolation | Supplied TwinSpace architecture | Separate app data via Android managed/work profile using public platform APIs | Same thing as an AI runtime or ARTEMIS automation |

## Security invariants

- At every boundary compare host, room/group, space, AI session, participant, target ID/revision, device/app and trace ownership as relevant.
- A group message, model output, invitation, external tool description or client-submitted approval flag is not authority.
- External child processes launch without a shell and do not inherit ambient credential-looking environment values by default.
- Host authentication remains loopback-paired and retains exact Origin/Host checks. Do not expose service-role keys to an adapter or local host child.
- Android serial and package must be allowlisted on the trusted host. ARTEMIS trace IDs are only manageable through locally recorded scope.
- Terminal is a new local-only isolated CUA sandbox. Failure to create/remove it must be reported; never silently fall back to host commands or a cloud service.
- Capability status is derived from real configured runtime instances. Disabled/missing tools are advertised unavailable.
- All automation needs local owner confirmation and bounded execution. Stop/revocation latches new side effects before cleanup.
- Observed private text must not be logged or stored in group memory unless the user explicitly shares it.

## Technical plan

- integrations/backroom/mcp-stdio-client.mjs: local JSON-RPC MCP stdio lifecycle, process management, tool discovery, bounded calls, timeouts and no-shell spawn.
- integrations/backroom/external-workspaces.mjs: separate typed adapters for CUA desktop, asynchronous ARTEMIS Android and CUA sandbox terminal.
- integrations/backroom/workspace-http-api.mjs: authenticated workspace status and scoped action routes; strict request-field allowlists; sanitized errors; no browser-supplied executable paths, host tokens or driver instances.
- scripts/backroom-host-server.mjs: mount routes in the established loopback-only paired host. Runtime loading is opt-in and disabled by default.
- Unit tests cover the mocked MCP subprocess, approval policy, allowlists, scoping, stale window/element, trace lifecycle, terminal argv and API validation.
- Operational documentation covers configuration, stop behavior, limits and physical acceptance.

## Opt-in local configuration

Default: no external workspace process is started. Enable only in the trusted local host environment:
- BACKROOM_ENABLE_CUA_DRIVER=1 and optionally BACKROOM_CUA_DRIVER_BIN (default cua-driver).
- BACKROOM_ENABLE_ARTEMIS=1, BACKROOM_ARTEMIS_PYTHON, BACKROOM_ARTEMIS_HOME, BACKROOM_ARTEMIS_ALLOWED_DEVICE_SERIALS and BACKROOM_ARTEMIS_ALLOWED_PACKAGES (comma-delimited allowlists).
- BACKROOM_ENABLE_CUA_TERMINAL=1 and optionally BACKROOM_CUA_CLI (default cua).
- BACKROOM_TERMINAL_PROJECT_PATH can select the local project root to sync; by default the host process working directory is used.

The trusted local terminal must be interactive for approval. Headless/non-TTY hosts keep the main Backroom host available but report requested external adapters as unavailable with a startup reason. External runtimes require their native platform permissions and local prerequisites. This document contains no credentials; provider secrets stay in provider-owned secure local configuration, not the repository or group messages.

## Terminal source transfer and return boundary

The terminal sandbox provisions Node through the CUA installable (`node`) so the default npm-based project smoke command has a runtime. The terminal sandbox does not receive a GitHub token or clone the private repository over the network. Instead, the local host creates a user-approved source snapshot and copies it directly to the explicitly named local CUA sandbox. Defaults cap the transfer at 5,000 included files, 20,000 filesystem entries inspected, 32 MiB total included content and 3 MiB per file. Git metadata, dependency/build/cache trees, common environment and credential filenames, symlinks, and detected high-confidence secrets are omitted. The host displays the source root, digest, included/omitted counts, destination and overwrite warning before approval. This is a best-effort redaction filter, not a guarantee that all sensitive content can be detected; inspect the source before approving.

Once the project is synced, commands run only inside the dedicated local gVisor container and are subject to a separate host-terminal approval. Binary diffs are rejected rather than represented as a misleading partial text patch. Returned text patches are limited to 512 KiB and scanned for high-confidence credential patterns, requires another local approval and is surfaced in the Backroom UI for review only. It is not applied automatically to the host checkout or posted to group memory. Ambiguous results are withheld and must be inspected before retrying. The sandbox is destroyed when the paired host shuts down or is unpaired; restart and re-pair to create a new isolated sandbox.

## Acceptance gates

1. npm run test:runtime, npm run test:backroom, npm run test:external-workspaces, npm run test:multi-surface and npm run build.
2. Real CUA Driver session: list/select/observe exact window; approve text locally; type using a current snapshot token; verify value and no submission.
3. Real CUA local sandbox: create with local gVisor runtime; approve exact argv; run smoke test without host shell; remove sandbox and verify no orphan.
4. Real ARTEMIS device: run local readiness diagnostics (credential verification and device probing remain opt-in); confirm serial; run allowlisted app task; inspect output/logs/trace; status and authorized stop; test disconnect.
5. Full Rub Minds flow: invite, AI join, message, event, approved local action, verified result, same-group summary, memory/reconnect; negative tests for revoked invite, duplicate event, stale target, offline runtime and cross-scope leakage.
6. Human UX/auth recovery and native PostgreSQL 17 staging migration parity.
7. Only after staging acceptance and explicit owner approval may a production deployment be considered.

## Honest current state

This increment supplies contracts and mock tests. No physical desktop, local CUA CLI runtime, ARTEMIS Python environment/device, or live ChatGPT/Claude session was available to this coding runner. No live hardware/provider acceptance is claimed.
