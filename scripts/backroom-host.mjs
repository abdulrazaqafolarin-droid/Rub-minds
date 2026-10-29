#!/usr/bin/env node
import { runBackroomHost, rotateBackroomHostIdentity } from "./backroom-host-server.mjs";

const rotateOnly = process.argv.includes("--rotate-identity-only");
const ambiguousRotate = process.argv.includes("--rotate-identity");
const operation = ambiguousRotate
  ? Promise.reject(new Error("Local rotation does not revoke a server host. Revoke the host in Rub Minds first, then run npm run backroom:rotate-host."))
  : rotateOnly
    ? rotateBackroomHostIdentity()
    : runBackroomHost();

operation.catch(error => {
  process.stderr.write(`Backroom host failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
