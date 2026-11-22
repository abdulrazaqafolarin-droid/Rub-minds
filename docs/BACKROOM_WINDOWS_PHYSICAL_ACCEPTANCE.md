# Backroom Windows companion — physical acceptance

Status (22 November 2026; PR #73 Windows build evidence, source parent PR #69 head `ff2b81a23cf894749dcbd151e14b54cdedb992fd`): **the native Windows compile/test and release-artifact lane passed; physical acceptance is still pending.** The Windows run [45001865821](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865821), main validation [45001865888](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865888), Android [45001865829](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865829), terminal interoperability [45001865806](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865806) and durable SQL [45001865807](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865807) all completed successfully. The Windows lane passed the web build, companion WebView, native Rust tests, authorization/protocol regressions, x64 release link, fingerprint and artifact upload. Main validation's local Supabase stack completed the device-frame binding and revocation checks.

The PR #69 Windows workflow tested synthetic merge commit 82eccc715ac95f957949480343b1976ebd199424, whose parents are PR #69 head 04f5938b80631d13ba6ddb0175d90d8a473a27c2 and parent PR #68 head 73debaab3f09df9c7e65fd564210e5a8813b9775. Windows artifact [14746112429](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45001865821/artifacts/14746112429) has ZIP SHA-256 bfbd5f51618019b36914434b9e4f49af0c5096880fafc155235b1ae97a1d3c53. Its manifest and executable agree on SHA-256 8467127abfdbe06e82e3510f5f4877ac0c7018e021aee8e36a3de6c7274969ab (15,124,480 bytes); the file is a PE32+ Windows x64 executable.

**Read-only Send discovery now requires InvokePattern availability.** The current Rust host only discovers and revalidates a unique enabled/visible/nearby Send control, including checking the exact control exposes UIA InvokePattern. It does not call InvokePattern or dispatch Send. This is preflight capability evidence only, not an enabled native wake path.

**CI and SQL evidence are not physical acceptance.** This CI artifact explicitly has backend_configuration=empty; it is for native launch/build checks only. It cannot sign in, register a device or connect to Staging. The Staging-connected build path below is added separately. No live Windows hardware test or live ChatGPT/Claude provider-session round trip has been recorded.

This matrix verifies the native Tauri companion on a real Windows 10/11 x64 computer. A successful GitHub-hosted Windows job is not physical-device acceptance.

## Build under test

For a native-only launch test, use the CI artifact for the exact PR workflow run above and verify its manifest/hash before launch.

For live Staging pairing and collaboration, build on a physical Windows workstation using the dedicated Staging builder:

1. Open an x64 Visual Studio Developer PowerShell with Node.js 22, Rust stable/MSVC, WebView2 and the Rust x86_64-pc-windows-msvc target installed.
2. Install the Tauri CLI once if needed: cargo install tauri-cli --version "^2" --locked.
3. Check out the intended PR #69 source commit. The builder records the actual local Git commit.
4. Run powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backroom-windows-staging-build.ps1.
5. Paste a **Staging project's** sb_publishable key or legacy anon JWT at the prompt. Never use a production key, service-role key or secret key.

The builder locks the Supabase URL to https://tzcuuynmviiuactafpld.supabase.co (project tzcuuynmviiuactafpld). Legacy JWTs must carry the Staging project ref, iss=supabase, and role=anon; secret/service-role JWTs are refused. Opaque sb_publishable keys can only be syntax-checked locally, so obtain that key from the Staging project itself—the Staging endpoint will reject a key from another project. The key is passed to Vite via process environment only, never written to a repository file, manifest, installer log or Supabase setting. The script restores the caller's previous Vite environment after the build and does not deploy anything.

The builder runs the existing Windows acceptance script, full regression/build checks, Rust tests and formatting, native release link and Tauri MSI/NSIS packaging. It creates a ZIP containing the companion executable, installer(s) and a non-secret manifest with commit, project ID, key type, file sizes and SHA-256 digests. The ZIP is a **Staging-connected** test artifact; treat it as a public-client binary, install it only on the dedicated test workstation, and do not use it against Production. The Tauri CLI must be installed before the builder is run.

The standard GitHub CI artifact has no Supabase URL/key. It proves native build/packaging readiness and permits a local launch check, but it is not a connected device build. Never embed a service-role key.

## Workstation preflight

- Physical Windows 10 or Windows 11 x64 machine (not WSL).
- Windows WebView2 Runtime available.
- Record Windows edition/build, CPU architecture, display resolution, user account type and date.
- Record the executable SHA-256 and confirm it matches the connected-build manifest.
- Use a dedicated Staging test account and disposable test group; do not use Production.
- Use harmless local targets such as Notepad and PowerShell.
- Do not test on payment pages, production files, real customer data or irreversible actions.

## Acceptance matrix

Record each item as PASS, FAIL or NOT RUN, with a short note or screenshot/log reference.

| Area | Test | Pass condition |
|---|---|---|
| Native launch | Launch the hash-matched Staging-connected executable on the physical PC | Tauri window opens without an immediate crash; record process ID and app version |
| Native restart | Close and reopen the companion | No stale local approval, active session or control grant is restored |
| Staging auth | Sign in with the dedicated Staging account | Auth succeeds against project tzcuuynmviiuactafpld; no Production host is contacted |
| Device registration | Select the disposable group and connect this computer | The owner-approved device is registered and appears in Backroom with the correct device identity |
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

## Device Frame AI identity acceptance

This is a separate collaboration gate after the Windows device is registered and a real screen/terminal frame is live. It verifies association to the exact MCP AI session, not merely the participant label.

1. Join the disposable Staging group from one real ChatGPT or Claude conversation using its supported Rub Minds MCP connection. Confirm that the intended session appears as a connected AI participant.
2. On the human Backroom owner UI, open the live Windows desktop or terminal frame and select that exact AI participant. Create the one-time frame link.
3. Copy the generated bind_device_frame tool arguments into the **same original AI conversation/session that joined the group** and ask that session to invoke the tool.
4. Confirm the frame appears bound to that exact AI session and runtime. Do not use a second conversation, another provider session or a different MCP handle for the positive case.
5. Attempt redemption from a different AI conversation/MCP session, including a second handle for the same participant. It must be rejected.
6. Attempt an incorrect nonce, expired challenge and replay after revocation. Incorrect/expired/revoked challenges must fail; a legitimate same-session retry may return its already-completed result but must not create a second binding.
7. Revoke the frame/device or end the AI MCP session. The binding must become inactive and the UI must no longer present it as current.

**This binding does not grant app launch, pointer/keyboard control, terminal input, draft insertion, native Send, autonomous wake or background execution.** Each remains separately authorized and may still be unavailable. A green Device Frame badge is not proof of provider conversation synchronization or autonomous control.

The native Emergency Stop is scoped to tracked Backroom-launched direct-child processes, PTYs, grants and draft state. It invalidates pre-existing approval generations and serializes native launches/input with shutdown. It does not guarantee termination of every helper process spawned by an application. The current WebRTC configuration is STUN-only; networks requiring TURN relay may prevent media connection even while account/device status is online.

## Evidence record

| Field | Recorded value |
|---|---|
| Date/operator | |
| Windows edition, version and build | |
| CPU architecture | |
| Source commit / PR / workflow run ID | |
| Build configuration and Staging project ID | |
| Executable SHA-256 / size | |
| Installer SHA-256 / size | |
| WebView2 Runtime version | |
| Test group ID (non-secret) | |
| App target and signer/hash | |
| Staging authentication | |
| Device registration / revoke | |
| Native launch / restart | |
| App picker / approval / deny | |
| PowerShell PTY / authorization | |
| Capability grant separation | |
| Draft insertion / invalidation | |
| Screen-capture mode and input gate | |
| Device Frame AI same-session binding | |
| Wrong-session / replay / expiry rejection | |
| MCP/device/session revocation | |
| Emergency Stop | |
| Network/WebRTC status | |
| Screenshots, logs and failures | |

## Release boundary

Do not mark Windows physical acceptance complete based only on GitHub-hosted CI, a linked executable, source tests or a successful installer build. The actual Windows workstation matrix and Device Frame same-session acceptance must pass. Keep release and Production deployment separate from this test.
