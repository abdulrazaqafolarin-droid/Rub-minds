#!/usr/bin/env node
import { runBackroomHost } from "./backroom-host-server.mjs";
runBackroomHost().catch(error => {
  process.stderr.write(`Backroom host failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
