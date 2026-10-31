import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("Windows acceptance runner checks native MSVC prerequisites before building", async () => {
  const script = await read("scripts/backroom-windows-acceptance.ps1");
  assert.match(script, /native Windows PowerShell, not WSL or Linux/);
  assert.match(script, /Node\.js 22/);
  assert.match(script, /x86_64-pc-windows-msvc/);
  assert.match(script, /Require-Command 'cl\.exe'/);
  assert.match(script, /Require-Command 'link\.exe'/);
  assert.match(script, /npm' @\('run', 'build'\)/);
  assert.match(script, /'test', '--manifest-path'/);
  assert.match(script, /'check', '--manifest-path'.*'--target', \$target/s);
  assert.match(script, /'build', '--release'.*'--target', \$target/s);
  assert.match(script, /Start-Transcript/);
  assert.doesNotMatch(script, /vercel\s+deploy|supabase\s+db\s+push|adb\s+install/i);
});

test("Android acceptance runner builds only the current companion and verifies merged manifest", async () => {
  const script = await read("scripts/backroom-android-acceptance.ps1");
  assert.match(script, /JDK 17/);
  assert.match(script, /Gradle 8\.10\.2/);
  assert.match(script, /ANDROID_SDK_ROOT/);
  assert.match(script, /manifest-policy\.node-test\.mjs/);
  assert.match(script, /:app:testDebugUnitTest/);
  assert.match(script, /:app:auditDebugGuestHostManifest/);
  assert.match(script, /:app:assembleDebug/);
  assert.match(script, /Get-FileHash.*SHA256/s);
  assert.match(script, /No provider currently implements guest app launch or rendering/);
  assert.doesNotMatch(script, /adb\s+install|vercel\s+deploy|supabase\s+db\s+push/i);
});
