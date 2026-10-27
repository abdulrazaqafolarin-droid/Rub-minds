# Rub Minds Backroom — shared protocol v1

Backroom is the local control layer behind a Rub Minds group. A platform-neutral session manager is shared by Windows and Android; each OS implements its own driver. Backroom opens the real supported interface rather than cloning ChatGPT, Claude, Chrome or a terminal.

## Session modes

- **attach_existing** registers a page explicitly selected by a local adapter after the user approves the connection. It does not automatically attach to any arbitrary open browser. The first Windows implementation accepts a Playwright page handle supplied by a separately authorized connector; automatic attachment to a normal Chrome process is not implemented.
- **managed** opens a real site in a dedicated Backroom-managed browser profile scoped to the group.

The shared manager and driver are in `session-manager.mjs` and `windows-playwright-driver.mjs`. The Windows driver uses Playwright Chromium and a persistent profile per group. Different groups do not share a browser profile. It rejects unapproved top-level navigation and closes unregistered popups. Attach mode never closes the user's existing page when the session is disconnected.

The current session manager advertises only `session.inspect`. It does **not** yet send AI messages, read provider conversation content, click UI controls, capture screenshots, or run terminal commands. This is deliberate until a separately reviewed action executor exists.

## Explicit boundaries

- The session record stores the approved origin, not the full conversation URL, path, query string, invite token or page title.
- URL origins must be exact HTTPS origins. Embedded credentials, unapproved provider domains and unsupported schemes are rejected.
- The Windows Playwright driver blocks top-level navigation outside the origin allowlist and closes unregistered popups. This is defense in depth, not a full browser/network sandbox: provider subresources can still communicate with their own and third-party origins.
- Managed profiles contain local provider login state and browser history. Keep them on the device; never upload profile directories or cookies to Rub Minds.
- An existing-session attach requires a supported local page handle. Neither an invitation URL nor an MCP connection automatically grants control of another app's authenticated session.
- The generic session manager accepts a platform-specific driver, but **an Android driver is not implemented yet**. Android support must use native-supported mechanisms, not assume Playwright can drive native apps.
- These modules do not implement authenticated IPC or a remote device command channel. Do not expose the driver object or browser page to a remote caller.

## Offline queue foundation

`offline-queue.mjs` is a bounded, storage-agnostic queue engine for approved conversation sends and HTTPS navigation only. It checks limits/deduplication, waits while offline, expires old work, refreshes session and trusted-approval state before replay, passes idempotency keys to the executor, validates correlated results, and handles cancellation/recovery races.

This queue engine is **not yet durable local-device behavior**. It depends on injected storage methods and requires a single active drainer per store. No Windows/Android protected storage adapter is included. A crash during an external side effect can make the outcome ambiguous; any production adapter must enforce idempotency to avoid duplicate sends. Raw queued content remains on the device and must be protected locally, not synchronized to the group by default.

Terminal execution is reserved and rejected in v1 until a separately reviewed sandboxed executor ships. It must accept structured executable/arguments/working-directory values rather than a raw shell string.

## Tests

Run the complete Backroom suite:

```sh
npm run test:backroom
```

Or run the Node tests directly:

```sh
node --test integrations/backroom/protocol.node-test.mjs integrations/backroom/offline-queue.node-test.mjs integrations/backroom/managed-sessions.node-test.mjs
```

The suite covers registration and approval boundaries, queue bounds and retries, explicit consent, provider origin allowlists, no secret/path leakage in session records, dedicated profiles, navigation guard behavior, popup containment, group-scoped closure and preservation of already-open user pages.

## OS constraints

Windows UI automation works only for controls exposed through supported APIs; some interactions require an unlocked, interactive desktop ([Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)).

Android should prefer app-specific APIs, intents and supported managed web sessions. Do not build the product around general-purpose autonomous AccessibilityService control: [Google Play policy restricts Accessibility API use for autonomous action planning/execution](https://support.google.com/googleplay/android-developer/answer/10964491) except qualifying accessibility tools. Any accessibility-based design requires separate platform/policy review. Android background tasks can be suspended or restricted; see [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

## Not yet implemented by this slice

This is a shared protocol, session registry, Windows Playwright session driver, and queue engine—not an installable Windows companion, Android APK, autonomous local host, authenticated IPC service, protected durable queue storage, or group-to-device command gateway. Real provider authentication and device acceptance tests remain required. Cloud execution remains deferred until revenue and measured cost justify it.
