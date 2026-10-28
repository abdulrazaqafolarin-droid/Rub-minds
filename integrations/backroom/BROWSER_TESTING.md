# Controlled browser verification

`browser-draft-adapter.mjs` is the first operational-adapter code for the Backroom host contract. The caller must supply an explicitly authorized Playwright page. The adapter may **draft** into an empty composer only; it never clicks Send. It verifies exact origin and conversation pathname, single visible enabled locator, empty draft, session identity, and post-fill value.

Run `npm run test:backroom` for pure domain tests.

Run `npm run test:backroom:browser` for a real Chromium local integration test (requires installed Playwright Chromium; on machines with Chromium available set `CHROMIUM_PATH` to the executable). The test serves its own mock chat page on loopback, runs dispatcher -> registry -> local host guard -> Playwright, checks approval and verifies that the send button was never activated. It deliberately does **not** browse or log into real AI provider sites.

Native Windows/Android and terminal control remain separate adapters. This test proves only one local browser path, not universal overlay support, and has not yet been run in GitHub Actions because current workflows fail before runner step execution.
