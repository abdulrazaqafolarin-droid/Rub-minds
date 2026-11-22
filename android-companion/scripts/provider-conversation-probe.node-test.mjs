import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [probe, runner] = await Promise.all([
  read("./provider_conversation_probe.py"),
  read("./run-provider-conversation-probe.ps1"),
]);

test("provider identity probe uses only local ephemeral keyed digests and never enables native Send", () => {
  assert.match(probe, /secrets\.token_bytes\(32\)/);
  assert.match(probe, /hmac\.new\(key, payload, hashlib\.sha256\)/);
  assert.match(probe, /raw_text_printed_or_uploaded["']?\s*:\s*False/);
  assert.match(probe, /stable_provider_conversation_id_exposed["']?\s*:\s*False/);
  assert.match(probe, /native_send_enabled["']?\s*:\s*False/);
  assert.match(probe, /Exactly three A1, B, A2 accessibility snapshots are required/);
  assert.match(probe, /DTD\/entity declarations are not accepted/);
  assert.match(probe, /nodes = \[node for node in all_nodes if node\.attrib\.get\("package"\) == package\]/);
  assert.match(probe, /system-bar, navigation, IME or accessibility-overlay/);
  assert.match(probe, /Snapshot contains no nodes for the requested provider package/);
});

test("physical A-B-A helper confirms package focus and deletes temporary snapshots", () => {
  assert.match(runner, /com\.openai\.chatgpt/);
  assert.match(runner, /com\.anthropic\.claude/);
  assert.match(runner, /Exactly one authorized ADB device is required/);
  assert.match(runner, /mCurrentFocus=\|mFocusedApp=/);
  assert.match(runner, /mResumedActivity\|ResumedActivity/);
  assert.match(runner, /ValidateSet\('A1', 'B', 'A2'\)/);
  assert.match(runner, /uiautomator', 'dump', '--compressed'/);
  assert.match(runner, /--delete-inputs/);
  assert.match(runner, /Remove-Item -LiteralPath \$tempDirectory -Recurse -Force/);
  assert.match(runner, /function Remove-RemoteCaptureChecked/);
  assert.match(runner, /shell', 'test', '!', '-e', \$RemotePath/);
  assert.match(runner, /Assert-ProviderForeground/);
  const captureBody = runner.slice(runner.indexOf("function Capture-ProviderSnapshot"), runner.indexOf("New-Item -ItemType Directory"));
  assert.equal((captureBody.match(/Assert-ProviderForeground/g) || []).length, 3, "foreground identity must be checked before dump, after dump and after pull");
  assert.match(runner, /Could not verify the temporary handset snapshot was removed/);
  assert.match(runner, /test', '!', '-e'/);
  assert.match(runner, /Remove-Item -LiteralPath \$tempDirectory -Recurse -Force -ErrorAction Stop/);
  assert.match(runner, /PROVIDER PROBE CLEANUP INCOMPLETE/);
  assert.match(runner, /Could not remove local accessibility snapshots/);
  assert.match(runner, /adb -s \$Serial shell rm -f \$RemotePath/);
  assert.match(runner, /does not send messages, tap Send, or enable native Send/);
});

test("the probe never substitutes app/composer identity for a conversation ID", () => {
  assert.match(probe, /stable_provider_conversation_id_exposed["']?\s*:\s*False/);
  assert.match(probe, /candidate_signal_only_manual_adapter_review_required/);
  assert.match(runner, /A candidate signal is not proof of a stable provider conversation ID/);
  assert.match(runner, /No provider adapter has been enabled/);
});
