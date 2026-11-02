# Backroom Windows companion — physical acceptance

Status: **The earlier PR #62 Windows test lane passed; this branch adds a linked release artifact and Emergency Stop race protections. Exact-head CI has not executed its steps (failed jobs returned no runner logs); physical host acceptance remains pending.**

This matrix verifies the native Tauri companion on a real Windows 10/11 x64 computer. A successful GitHub-hosted Windows job is not physical-device acceptance.

## Build under test

The Windows CI workflow is configured to execute the native Rust test suite on Windows, link the x64 MSVC release executable and upload that executable with a SHA-256 provenance file. It does not currently run a separate Rust-formatting check. Download the artifact from the successful workflow run for the exact commit being tested. Record the commit, run ID and executable SHA-256 before launch.

The CI build does not receive a Rub Minds Supabase URL or publishable key. It proves native build/packaging readiness and permits a local launch check, but it is not a connected device build. Full sign-in, registration, group authorization, remote terminal and Backroom collaboration require a separately configured build against an approved isolated staging project. Do not use production for this acceptance, and never embed a service-role key.

## Workstation preflight

- Physical Windows 10 or Windows 11 x64 machine (not WSL).
- Windows WebView2 Runtime available.
- Record Windows edition/build, CPU architecture, display resolution, user account type and date.
- Record the executable SHA-256 and confirm it matches the artifact provenance file.
- Use a dedicated test account, a disposable test group and harmless local targets such as Notepad and PowerShell.
- Do not test on payment pages, production files, real customer data or irreversible actions.

## Acceptance matrix

Record each item as PASS, FAIL or NOT RUN, with a short note or screenshot/log reference.

| Area | Test | Pass condition |
|---|---|---|
| Native launch | Launch the hash-matched executable on the physical PC | Tauri window opens without an immediate crash; record process ID and app version |
| Native restart | Close and reopen the companion | No stale local approval, active session or control grant is restored |
| App selection | Select Notepad through the native file picker | Only the chosen EXE is registered; its path and SHA-256 are rechecked |
| Launch approval | Request a Notepad launch, deny once, then approve once | Denial launches nothing; approval launches only the selected direct child |
| Terminal PTY | Request a PowerShell terminal and run a harmless unique Write-Output marker | Output returns through the PTY; remote input remains blocked until terminal control is separately approved |
| Grant separation | Exercise view, pointer/keyboard, terminal and draft permissions separately | A grant for one capability does not unlock another; each expires/revokes independently |
| Native confirmation | Deny and approve each supported privileged action using the native OS confirmation | Only an explicit local approval authorizes the exact scoped action |
| Draft insertion | Select one empty Notepad text area and insert a harmless unique draft | The exact text is read back; no Enter or submit is sent; changing selection invalidates the draft |
| Revocation | Revoke the device from the owner-controlled Backroom device list during a test session | Active sessions stop, local control grants clear and stored device credentials are removed |
| Session expiry | Allow a disposable test session to expire | Commands are rejected and local session resources are cleaned up |
| Emergency Stop | Start a tracked Notepad process and PTY, then invoke Emergency Stop | Grants and draft state clear; tracked direct-child app processes and PTYs stop; further commands are rejected |
| Pending-approval invalidation | Open a native launch/terminal approval, trigger Emergency Stop through the approved local/device-revocation path, then accept the old dialog | The old approval is rejected; it cannot create a new process or PTY after Emergency Stop returns |
| Capture-picker invalidation | Open the OS screen-share picker, trigger Emergency Stop on the companion, then complete the old picker | The stale picker result is rejected; it cannot create a new capture/input session or publish an offer |
| Screen capture | Share a monitor and, separately, a single window | Window sharing stays view-only; input is enabled only for a verified whole-monitor capture with separate approval |
| Network loss | Test on a normal network, then a restrictive network if available | Connection state is truthful; no session is shown as connected when WebRTC is not connected |

The native Emergency Stop is scoped to tracked Backroom-launched direct-child processes, PTYs, grants and draft state. It invalidates pre-existing approval generations and serializes native launches/input with shutdown. It does not guarantee termination of every helper process spawned by an application. The current WebRTC configuration is STUN-only; networks requiring TURN relay may prevent media connection even while account/device status is online.

## Evidence record

| Field | Recorded value |
|---|---|
| Date/operator | |
| Windows edition, version and build | |
| CPU architecture | |
| Executable commit / workflow run ID | |
| Executable SHA-256 | |
| WebView2 Runtime version | |
| Test group ID (non-secret) | |
| App target and signer/hash | |
| Native launch / restart | |
| App picker / approval / deny | |
| PowerShell PTY / authorization | |
| Capability grant separation | |
| Draft insertion / invalidation | |
| Device revoke / session expiry | |
| Emergency Stop | |
| Screen-capture mode and input gate | |
| Network/WebRTC status | |
| Screenshots, logs and failures | |

## Release boundary

Do not mark Windows physical acceptance complete based only on GitHub-hosted CI, a linked executable, source tests or a successful installer build. The actual Windows workstation matrix must pass. Keep release and production deployment separate from this test.
