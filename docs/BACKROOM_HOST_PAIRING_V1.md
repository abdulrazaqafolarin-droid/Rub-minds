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
Open Backroom in an allowed origin, enter the pairing code from the same machine's terminal, and inspect local host status. Pairing code and session token are bearer secrets. Keep the terminal private, do not paste these values into a group, issue tracker or screenshot. The web UI holds the session token in tab-scoped sessionStorage so a refresh can restore the pairing. It is never placed in a URL or group message. XSS on the allowed web origin could access it; keep the app origin secure and the session is revoked at unpair/expiry. Closing the tab normally clears the token. Restarting the host invalidates the session and requires a new pairing code.

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
