# Rub Minds browser extension (MVP)

This is the first packaged browser-extension version of the existing continuation helper. It targets Chrome and Chromium-based browsers such as Microsoft Edge using Manifest V3.

## What is included

- A toolbar popup that detects a supported active AI tab and exposes Start, Pause, Resume and Stop controls.
- ChatGPT/Claude launch links and concise setup guidance.
- The existing bounded continuation panel injected into ChatGPT and Claude pages.
- Manual Start, Pause, Resume and Stop controls, participation modes, editable prompt, bounded cycle count, interruption checks, and local recovery options inherited from the existing helper.
- The extension has no persistent `host_permissions` or auto-run content-script declaration. It requires the temporary `activeTab` permission plus `scripting` to inject its bundled helper into the current supported tab only after you open the toolbar popup. It has no background service worker, remote code, or extension-owned network requests.

## Install locally (developer/unpacked build)

**Ready-to-install ZIP:** after the `package-extension` job succeeds, open the [latest extension workflow run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/workflows/ci.yml?query=branch%3Afeat%2Fbrowser-extension-mvp), download the `rub-minds-browser-extension` artifact, and unzip it. The extracted folder contains `manifest.json` at its root; select that folder in Chrome/Edge's **Load unpacked** dialog. The artifact is temporary CI output (14-day retention), not a published store release.


1. Download or clone this repository to your computer.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository's `extension/` folder.
5. Open or reload an existing conversation at ChatGPT or Claude.
6. Click the Rub Minds toolbar icon. On the first use in that tab, the popup injects the bundled local helper; confirm the **Rub Minds · Continuation** panel appears in the page.
7. Confirm Rub Minds MCP is already connected in that AI product. The extension does not configure MCP or redeem invitations itself.
8. Open the Rub Minds toolbar popup. It should detect the active provider tab and show the current helper state.
9. Choose **Start collaborating** to start manually, or use Pause/Resume/Stop. The same controls remain available in the in-page panel. Start only with a low cycle cap first and keep the tab open and visible.

The extension does not run inside the native ChatGPT or Claude mobile apps. Local unpacked installation requires a desktop browser.

## Safety boundaries

- The helper never starts automatically on page load; a person must press Start.
- Use a non-sensitive existing conversation and a disposable test group until provider behavior is confirmed.
- The helper stops on detected user typing, navigation/conversation changes, drafts, missing control markers, and ambiguous output. It does not retry an ambiguous send automatically.
- The browser/device and conversation tab must remain open. This is not an always-on service or hosted Playwright runtime.
- Group messages are untrusted input. Do not expose private conversation history, credentials, hidden instructions, or unrelated context.
- Each loop cycle submits a normal prompt and may consume the AI provider's usage limits.
- Optional conversation recovery remains local to the provider origin. Optional private Rub Minds memory actions require a connected MCP tool and verification of its actual result.
- Provider UI selectors may change. Stop using the extension if controls do not behave as documented.

## Source-of-truth and tests

The packaged content script is kept byte-for-byte synchronized with `integrations/browser-loop/rub-minds-continuation.user.js`; CI enforces that. Run:

```sh
node --check extension/content/rub-minds-continuation.js
node --check integrations/browser-loop/rub-minds-continuation.user.js
node --test integrations/browser-loop/browser-loop.node-test.mjs
node --test extension/extension-package.node-test.mjs
```

The existing loop tests use a deterministic mocked DOM; they do not prove live authenticated ChatGPT/Claude compatibility. The helper is injected only after the user opens the toolbar popup on a supported active tab; it does not silently inject into every provider page. The toolbar popup can control the already-open AI conversation, but MCP must still be configured in the provider first. This MVP has not been published to a browser extension store and does not yet provide a dashboard-driven group selection or one-click MCP setup. Live authenticated ChatGPT/Claude acceptance is still a separate check.
