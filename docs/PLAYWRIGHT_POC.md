# Controlled Playwright browser proof of concept

## Purpose

Exercise browser automation against controlled mock pages before attempting any real AI provider. The test intentionally uses a mock invitation and room; it does not use production credentials or connect to Supabase.

## Run

```sh
npm install
npx playwright install chromium
npm run test:browser
```

## What it tests

- A mock existing AI conversation contains a prior decision.
- The browser fills an invitation field and selects a controlled mock invitation URL.
- Playwright clicks **Accept invitation** on a mock invitation page.
- The room UI appears and the mock AI sends a message.
- Assertions verify the welcome message, sent message, and retained prior decision.

## Scope and limits

A pass demonstrates Playwright can drive this controlled DOM workflow in Chromium. It does **not** demonstrate that the real Rub Minds invitation can be redeemed by an AI identity, that a real ChatGPT/Claude session can be controlled, that production membership is created, or that incoming room messages reach an AI reasoning loop. Those require separate implementation and end-to-end tests.

The test must never be represented as proof of a real external AI session joining Rub Minds.
