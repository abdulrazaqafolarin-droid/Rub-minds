# Backroom interface surfaces and continuous AI continuation

Status: product/architecture decision record, not an implementation claim.

## Product decision

Backroom is a live workspace, not a logo dashboard or screenshot gallery. A connected panel must display the real working interface for that session: the actual ChatGPT/Claude web conversation, a real terminal, or another explicitly supported surface. On desktop, the user can keep several sessions visibly open side by side. On a phone, the same sessions can be shown as responsive panels/tabs or a stacked view; a phone's small screen must not be treated as proof that every interface can be simultaneously legible.

The similarity to a multi-space app is the organization and isolation of sessions—not a promise that Rub Minds can clone arbitrary native apps. Web-based AI interfaces are the first target. Native third-party app virtualization is a separate, platform-specific research problem and is not required for the first usable release.

## User journey

1. Sign in to Rub Minds and create or join a group.
2. In Backroom, choose Add AI session and select a supported provider/surface.
3. Backroom opens the provider's real HTTPS interface in a managed, isolated session panel. The user signs in directly with that provider. Rub Minds never asks for or stores the provider password.
4. The user opens or selects the conversation they intend to connect and presses Connect to group. Backroom verifies the provider adapter and active conversation identity, shows the destination group and sharing scope, and obtains explicit consent.
5. The session card shows its state: opened, signed in/unknown, connected to group, waiting, generating, needs attention, or disconnected. A site being open is not enough to mark the AI as joined.
6. When a permitted group message arrives, the local coordinator decides whether this session can safely receive it. If the provider is idle and its adapter is confident about the conversation, Backroom can offer or perform the approved continuation. The AI receives a bounded group context and a continuation instruction marked @RMConnects, replies in its own provider conversation, and the adapter waits for a stable completed response.
7. Only the resulting response (and any explicitly approved attachments) is sent back to the Rub Minds group. Private transcript history is not imported by default. Every send uses a source message ID/idempotency key so reconnects do not blindly repeat it.
8. Other connected AIs can react to that group reply under the room's turn/loop policy. An AI response must not be automatically re-broadcast as a new trigger to the same session indefinitely.

## Surface architecture

### Shared session model

Keep the current platform-neutral session registry/protocol and define a common adapter contract: detect, identifyConversation, inspectState, prepareContinuation, submitContinuation, waitForStableResponse, cancel, and close. The contract uses opaque session IDs and group IDs; provider-specific DOM details stay inside the adapter. A command is scoped to one explicitly connected session and one group. Driver handles, cookies, profile folders, full private URLs and raw browser objects never go to the server or MCP client.

### Windows desktop

Prototype a desktop shell capable of hosting multiple real web contents in independently sized panels. Electron's current WebContentsView is a credible first evaluation candidate because it supports multiple web contents inside one app window; the older BrowserView is deprecated. Keep provider pages out of the privileged UI renderer, disable Node integration in provider surfaces, and keep privileged actions behind a narrow main-process adapter/allowlist. The existing Playwright driver is useful for controlled tests and browser automation, but it is not by itself the side-by-side product shell.

A managed provider panel and an attached user-owned browser tab are different modes. Managed panels can be controlled only through their explicit adapter. Attaching to an ordinary browser still requires a supported extension/CDP connection and user selection; do not promise invisible attachment to any running browser.

### Android

Use a native Android shell with independently managed WebView sessions for the first web-AI panels, if provider testing confirms their login and conversation flows work. Implement the same protocol and adapter contract but a separate Android control driver. Handle narrow-screen layout honestly: switch to one active panel with fast switching, or a vertical stack, rather than shrinking multiple chat interfaces until unusable.

Do not treat Dual Space-style virtualization of arbitrary native applications as the initial implementation strategy. It may require capabilities Rub Minds cannot safely or policy-compliantly provide. Google Play's Accessibility policy explicitly prohibits using Accessibility API to autonomously initiate, plan and execute actions except for qualifying accessibility tools; examine narrower APIs and supported integrations first. Native applications should be added only through an app-specific API, supported intents/deep links, or a separately reviewed approach.

### Terminal

A terminal is a real terminal surface, not a simulated chat bubble. It requires a local pseudoterminal/process adapter and a separate security design: least-privileged OS user, explicit working-directory and executable policy, approval for consequential commands, cancellation/timeouts/output bounds, and no remote raw-shell endpoint. Keep terminal execution disabled until those constraints and isolation tests are implemented. A terminal panel is a later surface, not a reason to delay web-AI panels.

## @RMConnects and continuation trigger

Treat @RMConnects as a versioned semantic marker in a structured continuation envelope, not as the sole security mechanism. Example fields: protocolVersion, groupId, sourceMessageId, targetSessionId, senderParticipantId, boundedSharedContext, messageBody, replyPolicy, expiresAt, and idempotencyKey. Server authorization and local consent must still be checked independently.

The provider adapter translates this envelope into the provider UI's composer and submits it only when:
- the provider and conversation are positively identified;
- the page is on an approved HTTPS origin;
- no generation is active and the composer is available;
- the source message has not already been submitted;
- the session's group membership and consent are still valid; and
- the relevant auto-send policy permits it, otherwise Backroom asks the user to approve.

For provider websites, test a layered approach in this order:
1. A supported provider/MCP/API route where available (preferred for reliability).
2. A narrow, provider-specific adapter operating inside the Backroom-owned web surface, with a manual “review and send” fallback.
3. A companion browser extension or explicitly enabled CDP/Playwright bridge for existing browser sessions.
4. Screen/keyboard automation only as a last resort, with visible consent and verified completion.

A prompt appearing in a composer is not proof that it was submitted. A submit action is not proof that the model finished. A completed answer is not proof that it was posted to the group. Each stage needs a distinct correlated result.

## Continuous interaction limits

MCP group messaging and UI continuation are separate systems. MCP can transport group messages and shared memory, but it does not automatically start a new turn in a provider conversation after the model has finished. The local Backroom coordinator must observe the group event, make a policy decision, trigger the provider adapter, detect final completion or ambiguity, post the result, and recover safely after disconnects.

Do not promise always-on interaction while the device is asleep, Backroom is closed, the provider has logged out, a conversation is generating, a CAPTCHA is displayed, or the provider UI changes. A later independent responder/API worker is a separate product path and is not a substitute for proving original-session continuation.

## Minimum research and acceptance work

1. Provider compatibility matrix: ChatGPT and Claude web interfaces in a Backroom-managed panel, login persistence, conversation ID detection, current-generation detection, composer discovery, send result, stable final response, error/login/CAPTCHA handling, and behavior after provider UI updates. Test real accounts with disposable messages; no transcript export.
2. Desktop hosting spike: demonstrate two authenticated provider web surfaces displayed at once in one window, separate storage contexts, user resizing, focus/keyboard behavior, file upload and permission prompts, and safe close/reopen. Decide whether Electron WebContentsView is fit before committing to packaging.
3. Android WebView spike: test provider login/session persistence and two-panel performance on a real phone; determine an honest mobile layout. Review Google Play policy before any accessibility-based control.
4. Trigger prototype: compare a provider-specific DOM adapter inside a managed surface against the existing extension/Playwright route. Measure false detection, submit certainty, generation-state detection, duplicate prevention and recovery. Keep a manual confirm/send fallback.
5. Security and privacy: session/profile isolation per group, prompt-injection boundaries, remote-command authorization, content-sharing scope, local secret storage, renderer isolation, origin navigation, redaction, revocation and group-switch tests.
6. End-to-end test: sign in → create group → add two live provider panels → connect each selected conversation → send one human message → deliver a continuation to AI A → verify its finished response appears exactly once in the group → deliver it to AI B only if policy permits → verify no loop → pause/revoke → verify future events do not trigger either session.
7. Release gates: working installable Windows prototype, Android prototype/device evidence, real provider acceptance, testable rollback and no production deployment until explicitly approved.

## Current implementation status

The current Backroom PRs provide a shared protocol/queue foundation, a consent-gated session registry, a Windows Playwright-managed Chromium driver and read-only session inspection. They do not yet provide the side-by-side desktop shell, Android native app, provider conversation detection, @RMConnects UI adapter, send/read/wait completion loop, terminal process adapter, or an end-to-end live-provider proof. Do not label the described experience implemented until these gates pass.

## Official technical references

- Electron WebContentsView: https://www.electronjs.org/docs/latest/api/web-contents-view
- Electron web embeds guidance: https://www.electronjs.org/docs/latest/tutorial/web-embeds
- Playwright connectOverCDP: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Android WebView documentation: https://developer.android.com/develop/ui/views/layout/webapps
- Google Play Accessibility API policy: https://support.google.com/googleplay/android-developer/answer/10964491
