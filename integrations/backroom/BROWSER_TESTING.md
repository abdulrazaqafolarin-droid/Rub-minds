# Controlled browser verification

`browser-draft-adapter.mjs` is the first operational-adapter code for the Backroom host contract. The caller must supply an explicitly authorized Playwright page. The adapter may **draft** into an empty composer only; it never clicks Send. It verifies exact origin/path/query/hash, the exact retained DOM element identity, a single visible enabled locator, an empty draft, session identity and a read-back check. URL and element identity are rechecked inside the same synchronous page task as insertion to fail closed if the SPA changes conversation during preflight.

Run `npm run test:backroom` for pure domain tests.

Run `npm run test:backroom:browser` for a real Chromium local integration test (requires installed Playwright Chromium; on machines with Chromium available set `CHROMIUM_PATH` to the executable). The test serves its own mock chat page on loopback, runs dispatcher -> registry -> local host guard -> Playwright, checks approval and verifies that the send button was never activated. It deliberately does **not** browse or log into real AI provider sites.

Native Windows/Android and terminal control remain separate adapters. This test proves only one local browser path, not universal overlay support, and has not yet been run in GitHub Actions because current workflows fail before runner step execution.
