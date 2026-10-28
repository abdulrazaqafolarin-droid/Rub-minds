# Backroom universal control: first implementation slice

## Scope (October 28, 2026)

Backroom is **not browser-only**. A Rub Minds group can coordinate existing ChatGPT/Claude web conversations, native desktop AI applications, Windows applications, integrated terminal sessions, and Android AI phone applications, each as a registered **space**. The UI's **drag-to-select typing area** must be offered on **all** five surfaces. A selection creates a typed, room/host/space/session-scoped **interaction target**; it does not itself type text or confer permission.

The first committed module is `target-registry.mjs`, a dependency-free domain contract with validation, immutable registrations, revision-checked rebinds, explicit scope resolution, and tenant-bound deletion. It intentionally does **not** claim that any native overlay, Android service, desktop driver, background host, or provider UI adapter is operational.

## Planned system boundaries

```text
Rub Minds group (messages, tasks, memberships, memory)
            |
        coordinator (durable task delivery / consent / budgets)
            |
        local Backroom host (online, paired and permission-scoped)
            |
   space registry -> target registry -> verifier -> executor
                                           |
          +--------------+----------------+--------------+
          |              |                |              |
     Browser DOM      Desktop         Terminal         Android
     / Playwright     accessibility   / PTY           accessibility
     / userscript     / CUA driver    named process   / ARTEMIS
```

### Interaction target contract

`{id,roomId,spaceId,hostId,sessionId,surface,appId,identityFingerprint,locatorKind,locatorValue,region?,revision}`

- `surface`: `browser_tab`, `desktop_app`, `windows_app`, `terminal`, `android_app`.
- `locatorKind`: `dom`, `accessibility`, `terminal_pty`, or `screen_region`. DOM is browser-only; a terminal PTY locator is terminal-only. Screen region is supported across all interfaces **as a fallback**.
- `region`: finite rectangle in the display's original coordinate system, including display width and height. It must fit within the display. Scaling/rotation/window changes require re-registration or revalidation before execution.
- `identityFingerprint`: platform adapter's *stable enough* app/window/session identity. Never grant a write solely from matching a rectangle.
- `revision`: increases on rebind. Pending commands referring to the old revision must fail.
- Each lookup requires room + host + space + session + fingerprint + revision, preventing cross-space and cross-group mistaken writes. A further authorization policy check is required at execution time.

### Drag-to-select UX common flow

1. User opens a Backroom space and chooses **Register typing area**.
2. Host requests the platform-specific overlay/capture/accessibility permission. Display a clear denial fallback; never bypass host OS controls.
3. The user drags a rectangle around the composer (or selects an accessibility/DOM element / named terminal session). Overlay shows selected bounds.
4. The host queries the underlying app/window/session and tries to bind a semantic element (DOM locator or accessibility node); a coordinate-only binding is marked **fragile**.
5. Host confirms detected application and session; user approves registration and allowed operations. A preview is shown but must not expose private content to the group.
6. A new target revision is stored locally; server holds only minimally necessary routing metadata. Rebind on identity change.
7. For a group event the coordinator picks the authorized space and target, sends `@RMConnects` context into that original interface *only if* permissions, foreground/window identity and target freshness still pass.
8. Adapter verifies input inserted; submission occurs only if separately approved. Then it verifies response/completion, posts an idempotent outcome and records audit information.

### Important platform distinctions

- **Browser:** extension/userscript/Playwright can inspect document elements in an explicitly authorized supported tab. Existing browser-loop code is a starting point, not evidence of reliable ChatGPT/Claude live adapters. Browser profiles/contexts can isolate storage.
- **Desktop and Windows:** prefer accessibility APIs/UI Automation for accurate typing targets; CUA is a possible lower-level input/screenshot driver subject to platform and license audit. An overlay above the app does not magically bypass operating-system accessibility and security permissions. A separate Backroom card is not guaranteed process/data isolation.
- **Terminal:** prefer explicit PTY identity and stdin, not blind screen clicks; dangerous commands require their own approval, sandbox policy and allowlist. A terminal space must be clearly distinguishable from its shell process and working directory.
- **Android phone apps (including native ChatGPT/Claude apps):** implement selection using an Android overlay/accessibility interaction only after checking Android permissions and app/store policy. ARTEMIS may help with authorized Android UI automation but does not itself provide a ready-to-run mobile overlay. Some secure surfaces will block overlays, screenshots or accessibility introspection. Never claim universal access or app cloning.
- **TwinSpace:** its work-profile approach is one possible *Android isolation backend* on compatible devices and management configurations; it is not a desktop technique and should not be confused with mere Backroom visual spaces. Work-profile lifecycle/admin restrictions need separate feasibility testing.
- Native apps cannot be assumed to support MCP internally. Visual automation and tool-integrated group participation are distinct paths.

### Authority and privacy

A user invitation, group post, model-generated text or `@RMConnects` tag is **data**, not a direct authorization grant. Authenticated user/host approval and operation-specific policies control writes. The host must protect local credentials, original conversation data, device images and personal messages. Do not persist full screenshots/transcripts centrally by default. Enforce consent for export and do not treat transcript import as a live session connection.

No cookie harvesting, authentication bypass, covert accessibility control or silent command execution. Host can pause/stop/disconnect independently of the cloud. Without an active authorized runtime, the online group can queue work but **cannot** wake the user's idle original ChatGPT/Claude phone/desktop app automatically.

### Next implementation slices and acceptance gates

1. **Universal registry** (this slice): validate all five surfaces, region bounds, isolation, stale revision and rebind. Pure Node tests.
2. **Space lifecycle:** paired hosts, registered sessions, capability negotiation, online/offline states and policies. Mock adapter first.
3. **Consent-aware dispatcher:** durable at-most-once *effect* design using idempotent event claims; on ambiguous UI submit **do not blindly replay**. User-directed retries and clear status.
4. **Selection overlay MVP:** start with browser and a controlled desktop test application; do *not* confine the interface design to browser. Android UX/prototype and PTY selection independently validated.
5. **Group round trip:** route one approved group event -> correct space -> `@RMConnects` prompt -> verified provider response -> idempotent group reply. Explicitly test wrong-focus/wrong-session refusal.
6. **Platform adapters:** Playwright/browser; Windows UI Automation/CUA; named PTY; ARTEMIS/Android accessibility. Test on actual installed apps including native ChatGPT/Claude where policy and permissions allow.
7. **Hardening & release:** OS access denial, display rotation, window move, app crash, login expiry, session reuse, multi-group isolation, reconnection, stale commands, adversarial group prompt content and kill switch. No production deploy before gates.

## Repository reuse map

- `integrations/playwright/session-bridge.mjs`: bounded existing AI browser session connector, currently adapter-injected.
- `integrations/playwright/hybrid-session-coordinator.mjs`: original-first or explicitly approved separate fallback.
- `integrations/browser-loop/rub-minds-continuation.user.js`: browser-local continuation with user stop controls.
- `integrations/mcp/`, `supabase/functions/rub-minds-mcp/`: tool and group protocol pieces.
- `supabase/functions/agent-messages/`: existing group message transport.
- `integrations/backroom/target-registry.mjs`: this first universal surface contract.

References to inspect before integrating third-party source: `google/artemis`, `trycua/cua`, uploaded TwinSpace `ARCHITECTURE.md` and `CHATGPT_BUNDLE.md`. Audit module-level licenses and deployment requirements before copying or vendoring anything. No third-party code has been copied in this slice.

## Current pull request additions

The branch now includes a responsive Backroom UI in `src/BackroomApp.tsx` and `src/backroom.css`. Authenticated members can select a group, create local space cards for the five interface types, switch spaces, and drag a rectangle across a clearly marked simulated preview. The group header links to `/?backroom=1&room=<id>`.

Space layouts are local to the signed-in user and room. This is not an installed device host or native operating-system overlay. The dispatcher and target registry are implemented as independent modules and are not yet wired to UI execution. Real device control remains blocked pending host pairing, permissions, identity checks and platform adapters.

Verification required before merge: `npm run test:backroom`, `npm run test:runtime`, `npm run build`, mobile and desktop visual checks, and a focused security review. A failed workflow without job steps does not count as an executed test.
