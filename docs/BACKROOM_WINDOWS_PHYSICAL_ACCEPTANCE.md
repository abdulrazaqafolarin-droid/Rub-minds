# Backroom Windows companion — physical acceptance

Status (22 November 2026; latest evidence for draft PR #73): **the exact PR head passed the native Windows release build, executable fingerprint and artifact upload; physical acceptance remains pending.** Source branch head: `206a3d106b11e7f5a55a587995749592f6a28fd7`. The Windows workflow tested synthetic PR merge commit `177ec4479302e1a7378a16a9aaa464ba431da552`, incorporating base PR #69 head `ff2b81a23cf894749dcbd151e14b54cdedb992fd`.

The latest Windows run [45012419320](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45012419320) passed the web build, bundled WebView build, native Windows Rust tests, companion protocol/authorization regressions, x64 release linking, executable SHA-256 verification and artifact upload. The executable is 15,124,992 bytes with SHA-256 `6bd9ded005e24786146fc375a56e2683c9c7657c66b93249d112b80541880911`. The seven-day CI artifact [14750810754](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45012419320/artifacts/14750810754) has ZIP SHA-256 `f0afd391f996f12f83b0b9f15b7b7a629c8f7dc054998132a02db3a127d24352` and expires 29 November 2026.

The accompanying main validation [45012419349](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45012419349) passed Android companion, build, MCP migration and isolated local Supabase checks; terminal interoperability [45012419277](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45012419277) passed the official MCP SDK, Claude Code and OpenCode v2 clients; durable queue SQL [45012419331](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/45012419331) passed.

The CI executable manifest explicitly records `backend_configuration=empty; local-launch-and-native-build-verification-only`. This artifact can support a hash-checked local launch test only; it cannot sign in, register a device, connect to Staging or Production, or exercise a live provider session. No physical Windows workstation acceptance or authenticated ChatGPT/Claude provider round trip has been recorded. The older PR #69 artifact evidence below is historical and is superseded for this PR by the exact PR #73 run and hash above.

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
