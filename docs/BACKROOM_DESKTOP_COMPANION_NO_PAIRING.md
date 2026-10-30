# Backroom desktop companion: device-owned execution (draft implementation)

## User interaction contract — no manual host URL or pairing code

1. The desktop companion is installed once and opened on the user's actual computer.
2. It authenticates to the **same Rub Minds account** through an external system browser using an OAuth PKCE flow. The native app must retain its own device-bound credential in the OS secure credential store, not copy the browser's session.
3. The signed-in Backroom app shows the user's registered computer by name. Selecting an installed application or terminal creates a **request**, not an execution grant.
4. The companion shows a trusted native approval prompt naming the group, exact executable and requested action. Only the device's trusted UI can call the broker's `confirm`; never accept an `approved: true` field over a network request.
5. The companion launches the selected actual desktop application or native PTY after consuming a one-use `launch` approval.
6. `view`, `control` and `draft` require separate device confirmation. A desktop frame is not implicitly interactive.
7. Backroom displays the real app/PTY using an authenticated, revocable interactive stream. The overlay's drag rectangle is converted to the selected window's coordinate system, clamped to the frame, and maps to an exact verified text target before draft insertion.
8. Stop/disconnect/revoke the device instantly closes the session and clears pending grants.

## Current code in this branch

- `desktop-companion-permissions.mjs`: strict room/space/executable/fingerprint/capability binding, expiration, one-use grants, revocation and emergency stop.
- `native-companion-kernel.mjs`: launch boundary using native-discovered executable metadata, shell interpolation disabled for desktop processes, real PTY injection point and separately authorized terminal writes.
- Node tests for rejection, scope isolation, expiration, process spawning and emergency stop.

These are **security primitives**, not a shipping desktop application. In particular, a trusted native prompt, OAuth PKCE, device-credential storage, account-based RPC transport, platform PTY implementation, installed-app discovery, screen capture and mouse/keyboard drivers **are not implemented yet**. Do not enable the Backroom UI's live controls based solely on these files.

## Integration architecture

Browser → Supabase authenticated request queue → registered companion outbound HTTPS/WebSocket connection → device-native approval window → native launcher / PTY / capture adapter → encrypted authorized frame response.

No inbound public port, user-typed localhost address, or one-time pairing code is part of this design. Account/device registration is still mandatory. Neither Supabase Edge Functions nor Vercel Functions should be used to host the desktop OS process itself.

For the native UI use Tauri 2 or a comparable signed desktop application. On Windows use ConPTY; on Linux/macOS use a native PTY. For the desktop frame, use per-window capture when available and an interactive VNC/WebRTC-style transport that checks the device authorization before accepting pointer/keyboard events. Protected windows can refuse capture/input; report unavailable rather than fake controls. Explicit operating-system screen-recording/accessibility permissions must be requested as supported by each OS.

## Security acceptance criteria before enabling it in production

- Native account login via external browser; token stored in OS keychain. Server verifies device ownership and room authorization for every operation.
- Network messages are only *requests*. Approval originates solely in a trusted native window and is not serializable from caller input.
- Fingerprints bind exact executable path/signature; changed binaries require renewed approval.
- One-time grants cannot be replayed, switched across groups/apps, or upgraded from view to control.
- File access uses OS file-picker/scoped access independently of desktop control. File permission alone does not allow window/shell control.
- Preview stream tokens expire, are scoped to room/device/window, and are never stored in a public group message.
- Output is bounded; terminal writes are audited and require device authorization for each action or a transparently time-boxed control session.
- Confirm capture input coordinates against the *actual* visible frame dimensions, refuse stale frames and secure text/password fields.
- Disconnect, group removal, OS lock, sign-out and emergency stop revoke control.
- Exercise real Windows ConPTY + app launch + interactive frame in integration tests; repeat macOS/Linux where supported.

## Deployment status

Draft only; not merged, not deployed, not verified against a real device. The existing local-pairing UI in `BackroomSimulatorApp.tsx` remains legacy and must be replaced before this UX meets the requested no-pairing experience. Android companion changes are separately pending.
