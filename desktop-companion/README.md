# Rub Minds Backroom Desktop Companion

The desktop companion runs selected applications and a native terminal **on the user's own computer**. Rub Minds does not replace that computer with a cloud VM. The companion initiates an authenticated outbound Supabase connection; no inbound host port, manually entered localhost URL, or one-time pairing code is required.

## Current implementation

- Tauri 2 desktop shell; React/Backroom remains the web workspace.
- Supabase account sign-in in the companion. Its Auth session and device bearer are stored through the native OS credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service, depending on the keyring backend).
- Owner-scoped desktop registration through the backroom-device Edge Function. The Edge Function generates a one-time device bearer and stores only its SHA-256 digest.
- Private Realtime topic scoped to the device UUID. The device owner alone may send directly; active human group members may receive. Browser commands and ICE signals go through the authenticated `backroom-device` Edge Function, which verifies user JWT, membership, active device binding, selected app/session scope, and records expiring sessions.
- The server sends private commands through the Supabase Realtime REST endpoint. Initial WebRTC offers/answers wait for ICE gathering to finish, so a browser session does not create one Edge Function request per ICE candidate. Device-status fallback is hourly; Realtime revocation/connection events are the primary path.
- Server session records are explicitly closed through a narrow device-bearer endpoint after denial, failed negotiation, disconnect, peer shutdown or Emergency Stop. It is device-bound, reports whether an active row was actually stopped, and is safe to retry; owner revocation marks sessions revoked server-side.
- Windows: explicit file-picker selection of an EXE, local SHA-256 allowlist, launch without shell interpolation, and direct-child process tracking. Linux/macOS app registration/launch is not implemented yet.
- Windows PowerShell, macOS zsh and Linux bash native PTY sessions using portable-pty.
- Monitor capture uses the operating system display picker (getDisplayMedia) and WebRTC. Coordinate-based input is enabled only after the user shares an entire monitor and capture geometry matches the companion display.
- Pointer/keyboard input, terminal control, and exact draft insertion are separate expiring grants. The final privileged Rust commands show a native OS Yes/No confirmation; an in-WebView card alone is not sufficient to grant control.
- Drag-select chooses a normalized target rectangle. On Windows, the native host resolves its centre through UI Automation to one visible, enabled, writable `Edit` or `Document` control, rejects password/protected controls, requires readable Value or Text access and an empty starting value, and records the process/runtime identity, control type/class, access mode and bounds. At least 65% of the selected rectangle must lie inside that single field. A fresh drag invalidates the previous selection and any pending draft for the session. The same identity and empty value are checked again after the native approval dialog. Single-line controls use the UIA Value pattern; multi-line controls with Text-pattern readback use the exact UIA element's focus-bound `send_text` operation after its focus, process/runtime identity, writability and empty value are confirmed. Both paths read back the exact resulting text. The local approval card identifies the destination process/control and write mode. Backroom does not click the rectangle centre or use an unscoped global keyboard action for draft insertion, and it never sends Enter or submits. Controls without reliable readback or read-only metadata are refused. macOS/Linux do not yet have equivalent accessibility target drivers.
- Emergency stop clears grants and draft state, kills tracked terminal and Backroom-launched direct-child processes, and stops browser-side media tracks.
- Revocation and repeated device-status failure stop active sessions locally and clear stored device credentials.
- Resource bounds: maximum 24 tracked Backroom-launched apps, 4 PTYs, 32 pending drafts, 32 pending UI approvals, 16 buffered ICE sessions / 64 candidates per session, input throttling and terminal output backpressure.

## Platform support

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Companion / account connection | Tauri 2 | Tauri 2 | Tauri 2 |
| App discovery / launch | Explicit EXE picker, SHA-256 recheck, local launch | Not implemented | Not implemented |
| Native terminal | PowerShell PTY | zsh PTY | bash PTY |
| Screen share | OS display picker | OS display picker (OS permission/policy applies) | OS display picker (desktop portal/compositor support applies) |
| Coordinate input | Full-monitor geometry match + native input permission | Depends on OS accessibility permission | Depends on compositor / input permission |

Protected or secure windows may deny display capture or input. Window-only capture is view-only; whole-monitor sharing is required for safe coordinate mapping. Some corporate security policies can block the OS input driver.

## Network and connectivity limits

The current WebRTC peer configuration uses public STUN servers and **does not include a TURN relay**. Direct peer connectivity may fail on symmetric NAT, restrictive enterprise firewalls, or networks that block UDP. In those cases the companion can be online in Supabase while live screen/terminal media does not connect. Do not report live control as ready until the WebRTC connection reaches its connected state.

## Development and build (Windows)

Prerequisites:
- Node.js 22 and npm.
- Rust stable toolchain and Cargo.
- Visual Studio Build Tools with the Desktop development with C++ workload.
- WebView2 Runtime.
- A Rub Minds Supabase project and a publishable (or legacy anon) API key; **never use the service-role key in the companion**.

From the repository root:
1. Copy .env.example to .env.local.
2. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
3. Run npm ci.
4. Install the Tauri CLI once: cargo install tauri-cli --version "^2" --locked.
5. Run the companion in development: cd desktop-companion/src-tauri, then cargo tauri dev.
6. Build Windows installers: cargo tauri build. MSI/NSIS artifacts are emitted under desktop-companion/src-tauri/target/release/bundle/.

The Tauri config starts the companion Vite server on loopback only in development. Release builds bundle static assets; they do not depend on a localhost Vite server.

## Tests

From the repository root:
- npm run test:companion — protocol, authorization, PTY adapter, desktop device validation and session-close scope tests.
- npm run test:external-workspaces — workspace host and native security regressions.
- cargo test --manifest-path desktop-companion/src-tauri/Cargo.toml — native geometry / input rate tests.
- cargo check --manifest-path desktop-companion/src-tauri/Cargo.toml — compile the native crate.
- node scripts/local-backroom-device-e2e.mjs — full disposable local Supabase registration, desktop inventory and revoke flow. Requires a local Supabase stack; do not point this destructive test at staging or production.

## Enrollment and use

1. Sign in with the same Rub Minds account that owns the group.
2. Select the group and choose Connect this computer. Confirm in the native OS dialog.
3. Add only the executable(s) you explicitly choose through the OS file picker.
4. In web Backroom, select the connected computer and app, then request launch. The computer shows a local approval card followed by a native OS confirmation.
5. Request a live screen. Approve it and choose the whole monitor in the OS picker.
6. Request control separately; then request draft typing separately. Drag-select the target in the live frame before staging a draft.
7. For terminal work, request a native terminal session, then request terminal control separately before typing.
8. Stop the session or use Emergency Stop to terminate tracked Backroom sessions. Use the device list to revoke the computer server-side.

## Security boundaries / known gaps before general release

- The companion currently has a separate sign-in form; automatic reuse of an already-authenticated browser session through OS deep-link SSO is not implemented.
- A command session has a maximum 12-hour server expiry; local one-time approval grants expire much sooner and cannot be upgraded from view to control.
- Live media is peer-to-peer and STUN-only; TURN relay / restrictive-network fallback remains unimplemented.
- Windows app enumeration is explicit picker-only, not a full installed-app catalog. Linux/macOS app launch is not implemented.
- Windows UI Automation targeting must be tested with real Notepad, Electron/Chromium, and representative added apps; controls without supported writable/readable UIA Value access or readable Text access plus keyboard focus are deliberately unsupported. macOS/Linux accessibility target adapters remain unimplemented. Screen capture/control and OS permission states still require physical-device acceptance.
- Emergency stop kills tracked direct-child processes and PTYs; it does not guarantee termination of every helper process an application may spawn.
- A real Windows build, installer launch, PowerShell control, screen share, native confirmation and drag-select draft flow are release gates. Passing Node protocol tests is not a substitute for this device-level test.

Do not claim the desktop companion is production-ready until the Windows integration matrix is completed and CI has a successful native build.
