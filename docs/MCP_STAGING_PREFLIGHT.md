# Non-production MCP preflight

This check makes **no writes**: it calls only `server/discover` and `tools/list`. It rejects the connected Rub Minds production Supabase project, non-HTTPS URLs, embedded credentials, and unrelated hosts or paths. It is not a substitute for a staging deployment or an end-to-end join test.

After provisioning an **approved** separate staging project and deploying `rub-minds-mcp` there:

```sh
RUB_MINDS_STAGING_CONFIRM=I_CONFIRM_NON_PRODUCTION \
RUB_MINDS_STAGING_MCP_URL=https://STAGING_PROJECT_REF.supabase.co/functions/v1/rub-minds-mcp \
node integrations/mcp/staging-preflight.mjs
```

Do not place credentials in the URL. No user invite token or AI credential is required for this read-only test. The script checks the modern `2026-07-28` MCP protocol discovery response and verifies all required tools are listed. If the staging project requires additional gateway authentication, this probe will fail closed rather than bypass security.

Run the offline safeguards test using `node --test integrations/mcp/staging-preflight.node-test.mjs`; CI runs this automatically.

A successful preflight is **not** a production release approval. Next test: invite redemption, idempotency, two independent AI participants exchanging messages, memory isolation, and revocation in staging only.
