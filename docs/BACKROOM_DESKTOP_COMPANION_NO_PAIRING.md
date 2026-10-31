# Backroom desktop companion — current implementation and release gates

**Scope:** The user's own computer runs the installed desktop applications and native terminal. Backroom is the authenticated remote control surface. A cloud VM does not replace the computer.

**Enrollment UX:** Install and open the Rub Minds Desktop Companion, sign into the same Rub Minds account, choose a group the account owns, and confirm registration in the companion's native dialog. There is no user-entered localhost URL, inbound host port, or one-time pairing code. The companion currently has its own sign-in form; automatic deep-link SSO from an already-signed-in browser session is not implemented.

## Implemented architecture

```text
Backroom web client
  └─ signed-in Supabase session
      └─ backroom-device Edge Function (JWT verified with Supabase Auth)
          ├─ validates active human group membership
          ├─ validates active device + room binding
          ├─ validates selected app / session scope
          ├─ records screen / terminal session with expiry
          └─ server-side private Realtime REST broadcast
                └─ device-private Realtime topic
                    └─ Tauri companion on the actual PC
                        ├─ trusted local approval UI
                        ├─ OS credential store
                        ├─ Windows .exe allowlist + SHA-256 check
                        ├─ native process launcher
                        ├─ Windows PowerShell / macOS zsh / Linux bash PTY
                        └─ monitor picker + WebRTC media / input channel
```

### Account and device authentication

- The companion uses Supabase Auth and persists its own auth session with the operating-system credential store.
- Registration requires a valid signed-in user JWT; the Edge Function resolves the user through Supabase Auth rather than trusting a caller-supplied user ID.
- The registration RPC verifies room ownership, records a hash of the generated device bearer, stores the device identity, and binds it to the chosen room. The raw bearer is retained in the OS credential store.
- The native Rust client restricts its Supabase URL to an HTTPS Supabase project origin. Non-Supabase endpoints, URL credentials, paths, query strings, and fragments are rejected; HTTP loopback is debug-build-only.
- The companion's device bearer is never returned to the web page. Service-role credentials stay in the Edge Function and are not bundled into the app.

### Command and Realtime authorization

- Browser commands and ICE signals go through the authenticated `backroom-device` Edge Function. The browser does not write commands directly to the private device topic.
- The Edge Function verifies the JWT, active human room membership (or room ownership), active device status, and an unrevoked device-room binding before dispatch.
- Selected-app launch requests must reference an app already registered by the companion.
- Screen and terminal sessions are server-recorded, bound to device + room, and expire after at most 12 hours. Control/draft requests must reference an active session; draft permission is restricted to screen sessions. A native device-bearer endpoint closes sessions after local denial, failed negotiation, disconnect, or peer shutdown; it reports whether it actually changed an active row and is safe to retry.
- Edge commands are sent by the server through the private Realtime REST broadcast endpoint, without keeping a server WebSocket open.
- The device-owner is the only authenticated role allowed to send directly to a device's private Realtime topic. Active human group members may receive responses/signals for the bound device.
- Device revocation changes the server-side device/binding status, marks its active sessions revoked, and sends a private revocation event. The companion's status check is a fallback, not the primary command path.
- Realtime loss, revocation, sign-out, disconnect, and Emergency Stop clear local grants and stop Backroom-managed PTYs / direct child processes.

### Local application and terminal execution

- Windows supports explicit EXE selection using the OS file picker, local SHA-256 allowlisting, path revalidation, shell-free process launch, and tracking of direct child processes launched by Backroom.
- Windows PowerShell, macOS zsh, and Linux bash use a native PTY via `portable-pty`.
- macOS/Linux installed-app discovery and launch are not implemented yet; current app launch is Windows-only.
- The companion asks locally before launch. Screen view, desktop control, terminal control, and draft typing are separate permissions. A remote payload cannot self-approve a request.
- Terminal input is separately authorized and bounded. For remote terminal sessions, the browser peer UUID is validated by the server and passed to the native PTY launcher; the companion uses the same UUID as the local PTY key. The remote client cannot submit an independent native process ID. Local-only terminals still generate their own UUID.
- Emergency Stop revokes local grants, clears draft state, stops PTYs, and kills direct child processes tracked as launched by Backroom. It cannot guarantee cleanup of all helper processes spawned by a desktop application.

### Screen, input, and drag-select

- Screen share uses the operating-system display picker and WebRTC. Windows can bind either a selected application window or a monitor to native coordinates. A window is interactive only when the companion confirms the foreground HWND/process/class and captured dimensions match; it rechecks that identity before every input and fails closed on focus/window changes. Unsupported or mismatched capture stays view-only.
- Control is separately approved after capture geometry is matched. Pointer/keyboard events are bounded and rate-limited in native code.
- Drag-select sends a normalized rectangle to the companion. Draft insertion targets the selected region's center, types the exact approved single-line draft, reads the result where supported, and does not press Enter or Send.
- **Important limitation:** the current overlay is coordinate-based; it does not prove that the rectangle encloses a specific accessible text-field element or detect all protected/password fields. A successful typing call is not a claim of semantic input-field verification.
- Protected windows, OS privacy settings, display servers, security software, or corporate policies can reject capture/input. Backroom must report these failures rather than show a fake live frame.

### Network and request budget

- WebRTC offer/answer SDP is exchanged only after ICE gathering completes. Initial browser ICE candidates are embedded in the SDP rather than each triggering a separate Edge Function request.
- The device sends its SDP answer over its authenticated private Realtime channel.
- The current WebRTC configuration uses public STUN servers and has **no TURN relay**. Symmetric NAT, UDP-blocking networks, and restrictive firewalls can prevent media connectivity even when account/device presence is healthy.
- The companion's device-status fallback check is hourly. Private Realtime revocation and connection failure are intended to stop sessions sooner. No five-second polling loop is used.

## Tauri host and CUA control are complementary

Tauri is the installed, account-authenticated **host** on the actual PC. It owns the OS keyring, native dialogs, app launcher, PTYs, screen-sharing permissions, and Emergency Stop. A CUA (computer-use) adapter is the **AI action interface** that can request screenshots, click/type/scroll, and inspect the desktop through the host. CUA cannot replace device enrollment, native process execution, or WebRTC display transport by itself.

The branch currently provides a native mouse/keyboard driver through Rust and a human-operated Backroom frame; it **does not yet expose a complete CUA tool surface for AI agents**. An existing `NativeAccessibilityDraftAdapter` establishes a fail-closed identity/focus/draft contract but is not a production Windows accessibility driver.

The planned CUA bridge must:

1. Accept only server-authorized `roomId`, `deviceId`, and exact active `sessionId` scopes; verify the session is live and the agent is authorized in that group.
2. Reuse the companion's native, time-limited view/control/draft grants. Never let an AI message forge `approved:true`, bypass the OS consent dialog, or read OS keyring material.
3. Provide explicit `observe`, `click`, `move`, `scroll`, `keypress`, `type` and `draft` tools with bounded coordinates/text and rate limits. **Observe** requires its own approved capture, while control tools require a separate local grant.
4. Keep CUA screenshot and input actions bound to the same selected monitor/window geometry and grant lifetime; stop immediately on disconnect, monitor changes, revoked membership, session expiry, OS lock, or Emergency Stop.
5. Preserve the drag-select overlay as a distinct **draft** operation. Coordinate targeting is provisional until an accessibility driver confirms an editable non-password field, its identity, and that no submit/Enter occurred.
6. Record an audit receipt for each accepted action without logging screenshots, passwords, clipboard contents or unredacted terminal output. Provide an explicit human approval path for destructive operations.
7. Keep the interface independent from any single AI vendor: ChatGPT, Claude, or another connected agent uses the same permitted CUA tool contract when that connector/runtime is actually supported and tested.

**Release claim rule:** Do not label Backroom AI CUA control as implemented until a real AI tool-call-to-native-action-to-observation round trip, local approval, focus/geometry checks, revocation, and emergency-stop regression tests all pass on actual Windows hardware.

## Repository map

| Area | Key files |
|---|---|
| Desktop app shell and native commands | `desktop-companion/src-tauri/src/lib.rs`, `desktop-companion/src/main.js` |
| Backroom remote control UI | `src/BackroomDesktopControl.tsx`, `src/backroomDesktopControl.css` |
| Supabase authenticated device gateway | `supabase/functions/backroom-device/index.ts` |
| Command and REST broadcast protocol | `desktop-command-protocol.mjs`, `realtime-broadcast.mjs` in that function directory |
| Authorization and device/session schema | `supabase/migrations/20261030210225_backroom_desktop_server_signals.sql` plus earlier desktop companion migrations |
| SDP gathering and signal validation | `integrations/backroom/ice-gathering.mjs`, `desktop-realtime-protocol.mjs` |

## Tests and build gates

From repository root:

- `npm run test:companion` — approval, device, native-kernel, command, broadcast, ICE and terminal adapter tests.
- `npm run test:external-workspaces` — native/external workspace regressions.
- `npm run build:desktop-companion` — build the desktop companion WebView bundle.
- `cargo test --manifest-path desktop-companion/src-tauri/Cargo.toml` — native Rust tests.
- `cargo check --manifest-path desktop-companion/src-tauri/Cargo.toml` — native crate compile.
- `node scripts/local-backroom-device-e2e.mjs` — destructive end-to-end test against a disposable local Supabase stack only. Never point it at staging or production.

GitHub Actions includes a Windows native job to build the WebView, run Rust tests, and compile the Windows target. A run with jobs that start and finish without any runner steps is infrastructure/quota failure, not a passing build.

## Staging status — 30 October 2026

- The staging project has the desktop companion registration, app inventory, room-membership Realtime, topic authorization, and desktop-session migrations applied.
- The staging `backroom-device` Edge Function is active at **version 10**, with the authenticated desktop command/signal routes, private server broadcast helper, and device-authenticated session-close endpoint.
- The staging session table is RLS-enabled; `anon` and `authenticated` have no table privileges, while the service role has the required read/insert/update privileges.
- Staging Realtime policies were checked: the device owner can send to the private topic and active human room members can receive.
- Production has not been migrated or deployed by this work.

## General-release blockers

Do not mark the companion production-ready until all of these are demonstrated:

1. Successful Windows installer build and first-run launch on a real Windows PC.
2. Same-account registration, restart/keyring persistence, re-authentication, server revoke, and re-enrollment.
3. Launch a real approved EXE; verify hash mismatch blocks launch; verify the selected process can be stopped.
4. Open a real PowerShell PTY; view output, resize it, type only after device approval, and prove stop/revoke closes it.
5. Test whole-monitor share, view-only window share, OS permission denial, coordinate alignment on scaled/multi-monitor displays, and live drag-select draft insertion.
6. Exercise disconnect, sleep/wake, network loss, ICE timeout, duplicate requests, room membership removal, and Emergency Stop.
7. Add TURN relay for networks where STUN-only peer connectivity fails.
8. Add macOS/Linux installed-app discovery/launch and validate their OS permission paths before claiming feature parity.

The staging gateway and database changes are deployed. The desktop companion is **not yet release-certified**: automated tests are authored but could not be executed in this environment, and no real Windows hardware end-to-end run has been completed.
