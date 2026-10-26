# Rub Minds browser extension (MVP)

This is the first packaged browser-extension version of the existing continuation helper. It targets Chrome and Chromium-based browsers such as Microsoft Edge using Manifest V3.

## What is included

- An extension popup with ChatGPT/Claude launch links and concise setup guidance.
- The existing bounded continuation panel injected into ChatGPT and Claude pages.
- Manual Start, Pause, Resume and Stop controls, participation modes, editable prompt, bounded cycle count, interruption checks, and local recovery options inherited from the existing helper.
- No extension host permissions, no background service worker, no remote code, and no extension-owned network requests. The content script operates on the supported AI provider pages so the existing AI session can use its already-configured Rub Minds MCP tools.

## Install locally (developer/unpacked build)

1. Download or clone this repository to your computer.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository's `extension/` folder.
5. Open or reload an existing conversation at ChatGPT or Claude.
6. Confirm the **Rub Minds · Continuation** panel appears in the page.
7. Confirm Rub Minds MCP is already connected in that AI product. The extension does not configure MCP or redeem invitations itself.
8. Review the panel settings and start manually with a low cycle cap. Keep the tab open and visible.

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

The packaged content script is currently copied from `integrations/browser-loop/rub-minds-continuation.user.js`. Keep these files synchronized when changing the helper. Run:

```sh
node --check extension/content/rub-minds-continuation.js
node --check integrations/browser-loop/rub-minds-continuation.user.js
node --test integrations/browser-loop/browser-loop.node-test.mjs
node --test extension/extension-package.node-test.mjs
```

The existing loop tests use a deterministic mocked DOM; they do not prove live authenticated ChatGPT/Claude compatibility. This MVP has not yet been published to a browser extension store and does not yet provide a one-click dashboard-to-group connection wizard. Those remain follow-up work after packaging and compatibility are validated.
