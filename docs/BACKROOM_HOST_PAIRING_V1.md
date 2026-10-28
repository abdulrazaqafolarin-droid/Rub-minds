# Backroom local host pairing milestone

## What this adds
- A Node.js loopback-only control plane in `scripts/backroom-host-server.mjs`, runnable with `npm run backroom:host` via `scripts/backroom-host.mjs`.
- Exact-origin browser allowlist. Configure additional preview origins with `BACKROOM_ALLOWED_ORIGINS=https://rub-minds.vercel.app,https://your-exact-preview-host.example`; never use wildcards.
- One-time 128-bit pairing code printed once in the local terminal, 10-minute expiry and attempt limit. Successful pairing issues a random 256-bit session bearer, stores only its SHA-256 digest in host memory and binds it to the exact web origin.
- Loopback-only bind, Host-header checks, JSON size limit, no-store responses, CORS preflight and private-network preflight support.
- Authenticated host status and explicit unpair. Status deliberately states that app execution capabilities are false until platform drivers are installed.
- Node HTTP integration tests for pairing, origin binding, replay, revocation, CORS, expiry and safe capability reporting.

## Run
```sh
npm run backroom:host
```
Open Backroom in an allowed origin, enter the pairing code from the same machine's terminal, and inspect local host status. Pairing code and session token are bearer secrets. Keep the terminal private, do not paste these values into a group, issue tracker or screenshot. The browser holds the session token in memory only; a reload requires re-pairing.

## Security boundary
This local host does not listen on a LAN address, does not run arbitrary shell commands, does not silently access app credentials, and does not yet automate any application. Pairing is host identification, not permission to act on every surface. A browser page alone cannot install the native phone/desktop overlays. Actual interaction requires separate user-approved platform drivers and per-action authorization. Because a local HTTP host is a privileged local interface, only exact origins should be allowed; use private/local development origins only when testing locally.

## Known limitations
- The GitHub Actions runner currently fails before any job steps run, so native Node/TypeScript CI is not evidence yet.
- Pairing/session state is in memory; restarting the host invalidates the session.
- Status endpoint advertises no execution capability. Current native and browser driver modules remain disconnected from the server until the next milestone.
- Browser private-network access behavior varies by browser version and user settings. The interface should tell the user to confirm local network permission if a browser blocks the request.
