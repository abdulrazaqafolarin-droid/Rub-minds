# Backroom local host pairing milestone

## What this adds
- A Node.js loopback-only control plane in `scripts/backroom-host-server.mjs`, runnable with `npm run backroom:host` via `scripts/backroom-host.mjs`.
- Exact-origin browser allowlist. Configure additional preview origins with `BACKROOM_ALLOWED_ORIGINS=https://rub-minds.vercel.app,https://your-exact-preview-host.example`; never use wildcards.
- One-time 128-bit pairing code printed once in the local terminal, 10-minute expiry and attempt limit. Successful pairing issues a random 256-bit session bearer, stores only its SHA-256 digest in host memory and binds it to the exact web origin.
- Loopback-only bind, Host-header checks, JSON size limit, no-store responses, strict CORS preflight support for supported browser Local Network Access.
- Authenticated host status and explicit unpair. Status deliberately states that app execution capabilities are false until platform drivers are installed.
- Node HTTP integration tests for pairing, origin binding, replay, revocation, CORS, expiry and safe capability reporting.

## Run
```sh
npm run backroom:host
```
Open Backroom in an allowed origin, enter the pairing code from the same machine's terminal, and inspect local host status. Pairing code and session token are bearer secrets. Keep the terminal private, do not paste these values into a group, issue tracker or screenshot. The web UI holds the session token in tab-scoped sessionStorage so a refresh can restore the pairing. It is never placed in a URL or group message. XSS on the allowed web origin could access it; keep the app origin secure and the session is revoked at unpair/expiry. Closing the tab normally clears the token. A host restart invalidates in-memory session records and requires a new pairing code. Restarting the host invalidates the session and requires a new pairing code.

## Security boundary
This local host does not listen on a LAN address, does not run arbitrary shell commands, does not silently access app credentials, and does not yet automate any application. Pairing is host identification, not permission to act on every surface. A browser page alone cannot install the native phone/desktop overlays. Actual interaction requires separate user-approved platform drivers and per-action authorization. Because a local HTTP host is a privileged local interface, only exact origins should be allowed; use private/local development origins only when testing locally.

## Known limitations
- The GitHub Actions runner currently fails before any job steps run, so native Node/TypeScript CI is not evidence yet.
- Pairing/session state is in memory; restarting the host invalidates the session.
- Status endpoint advertises no execution capability. Current native and browser driver modules remain disconnected from the server until the next milestone.
- Current Chromium-based browsers are moving to Local Network Access permission prompts. This host intentionally relies on exact-origin standard CORS and does not rely on the deprecated Access-Control-Allow-Private-Network preflight header. Browser support varies; the user must allow loopback/local-network access when prompted. Safari/WebKit behavior differs.


## Current browser policy reference

The official Chrome guidance and MDN explain that Local Network Access permissions govern browser requests to loopback/local addresses and that deprecated Private Network Access preflight headers should not be the primary mechanism. See [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access?hl=en) and [MDN Local Network Access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

## Browser-origin local network permission

The hosted Backroom UI calls the host at an explicit loopback URL from a secure HTTPS origin. Modern Chromium browsers may prompt for local/loopback network permission; this is independent of host pairing. The app does not attempt to bypass the permission prompt. The local host binds only to IPv4 loopback and has an exact-origin allowlist. See the Chrome and MDN references above.


## Managed browser adapter (development milestone)

The local host now exposes authenticated `/v1/browser/*` routes. When the user explicitly starts the managed browser, it launches a **separate visible Playwright Chromium profile** at `~/.rub-minds/backroom/browser-profile` (or the platform-equivalent home directory). The user signs in directly; no existing browser cookies/profile are copied. The profile persists locally so the user can keep its sessions. Closing the managed browser closes its tabs but retains the local profile.

In the Backroom host dialog, select a managed tab, click **Select input**, switch to that visible browser tab and drag around exactly one editable input. The script derives a unique CSS locator without reading/sending the input's contents. The host stores the target locally. **Insert draft — never send** requires a confirmation and only fills an empty visible composer, then reads the value back. There is no Send click or group-driven automatic input yet. This first adapter covers managed browser tabs only; it is not the global desktop/Android overlay.

Install Chromium on the machine with `npx playwright install chromium` if the browser launch action reports a missing runtime. Start the host with `npm run backroom:host`. Keep pairing credentials private. The original/primary browser profile is not accessed.


## Rub Minds group-scoped draft routing

A target is registered with the UUID of the currently selected Rub Minds group. The browser host stores that room ID in the target and requires the same room ID for every draft call; a target created in Group A cannot be used by the UI to draft while Group B is selected. Backroom retrieves recent messages only through the signed-in member's existing Supabase membership policies. A person selects a specific group message (or enters text manually), sees the exact draft text, and confirms **Insert draft — never send**. This is still a user-directed drafting workflow; it does not turn every group message into an automatic browser action, and it does not submit text or autonomously wake ChatGPT/Claude.


## Chrome / Edge loopback requests

Backroom calls `127.0.0.1` from the secure hosted UI. Browser-side host requests set `targetAddressSpace: 'loopback'` for engines that support this Local Network Access signal. This does not bypass permissions: the browser may prompt the user to allow Rub Minds to connect to loopback. Other browsers may not support this option, so device pairing must show an actionable unsupported-browser error rather than pretending a host is offline. Reference: [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access) and [Microsoft Edge Local Network Access guidance (updated March 2026)](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access).


## Opening an AI site in the managed browser

Use the **Open an AI website** field or the ChatGPT/Claude quick links. The local host validates the destination and only permits HTTPS sites or explicit loopback HTTP URLs. It reuses a blank tab or opens a new tab; it never silently navigates away from an existing nonblank tab. The user logs in and chooses the conversation themselves. Site navigation happens in the visible managed browser and is not a hidden background request.


## Full browser-host acceptance test

`npm run test:backroom:browser` includes a real headless Chromium acceptance test over the local HTTP host, not only an adapter mock. It starts a controlled local chat page, pairs with the host API, launches a managed persistent Playwright context in a temporary profile, uses the actual drag-selection overlay, registers the selected input to one group, inserts and verifies a draft, asserts the Send counter remains zero, rejects a repeated write into an occupied composer, rejects cross-group target use, and confirms unpair revokes access. The test deletes its temporary profile on completion.

This is a development integration test for the browser adapter only. It does not test ChatGPT/Claude production sites, native apps, OS accessibility or background participation. Requires an installed Playwright Chromium browser; use `npx playwright install chromium` before running it.


### SPA session identity check

Browser targets now bind to the exact origin, path, query string and hash at registration. The runtime prunes the registered locator if a tab changes route or closes. This prevents a locator selected for one SPA conversation from silently being reused after an in-place navigation to another session. The target must be selected again for the new conversation.
