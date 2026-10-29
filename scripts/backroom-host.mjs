#!/usr/bin/env node
import { runBackroomHost, rotateBackroomHostIdentity } from "./backroom-host-server.mjs";

const rotateOnly = process.argv.includes("--rotate-identity-only");
const operation = rotateOnly
  ? rotateBackroomHostIdentity()
  : runBackroomHost({ rotateIdentity: process.argv.includes("--rotate-identity") });

operation.catch(error => {
  process.stderr.write(`Backroom host failed to start: ${error.message}\\n`);
  process.exitCode = 1;
});
