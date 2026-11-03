import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const service = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt');
const ime = await read('../../android-companion/app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt');
const screen = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt');
const consent = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeConsentPolicy.kt');
const store = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidNativeWakeConsentStore.kt');
const activity = await read('../../android-companion/app/src/main/java/app/rubminds/companion/MainActivity.kt');

function method(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, 'missing method anchor: '+start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, 'missing method boundary: '+end);
  return source.slice(from, to);
}

test('native IME trigger accepts a typed request, constructs the canonical prompt and no caller-authored text', () => {
  const nativeInsert = method(
    ime,
    'private fun insertNativeWakeTrigger(request: NativeWakeExecutionRequest)',
    '    companion object {'
  );
  assert.match(nativeInsert, /canonicalWakePrompt\(request\.eventId\)/);
  assert.doesNotMatch(nativeInsert, /request\.text|prompt:\s*String|text:\s*String/);
  assert.match(nativeInsert, /AndroidNativeWakeConsentStore\(this\)\.reserveExecution\(request\)/);
  assert.ok(nativeInsert.indexOf('reserveExecution(request)') < nativeInsert.indexOf('connection.commitText(prompt, 1)'));
  assert.match(nativeInsert, /NativeWakeInsertState\.NEEDS_REVIEW/);
});

test('native trigger uses its own grant and does not inherit the general remote-typing arm', () => {
  const nativeInsert = method(
    ime,
    'private fun insertNativeWakeTrigger(request: NativeWakeExecutionRequest)',
    '    companion object {'
  );
  assert.doesNotMatch(nativeInsert, /RemoteKeyboardGate\.isArmed/);
  const remoteInsert = method(
    ime,
    'private fun insertRemoteText(sessionId: String, packageName: String, targetId: String, text: String)',
    '    companion object {'
  );
  assert.match(remoteInsert, /RemoteKeyboardGate\.isArmed\(\)/);
  assert.match(remoteInsert, /connection\.commitText\(text, 1\)/);
});

test('existing WebRTC remote_text remains draft-only and cannot invoke native Send', () => {
  const remoteBranch = method(
    screen,
    'if (input.optString("kind") == "remote_text")',
    'if (input.optString("kind") == "navigation")'
  );
  assert.match(remoteBranch, /DraftInputMethodService\.insertRemoteText/);
  assert.doesNotMatch(remoteBranch, /insertNativeWakeTrigger|submitCanonicalWake|ACTION_CLICK|performAction/);
  assert.doesNotMatch(screen, /native_wake_trigger|submitCanonicalWake/);
});

test('native Send path rechecks composer and Send identity from the final snapshot before ACTION_CLICK', () => {
  const submit = method(
    service,
    'fun submitCanonicalWake(',
    '    private fun awaitComposerClear('
  );
  assert.match(submit, /NativeWakeConsentPolicy\.canonicalWakePrompt\(request\.eventId\)/);
  assert.match(submit, /isSelectedComposerEmpty/);
  assert.match(submit, /revalidateSelectedSendControl/);
  assert.match(submit, /Composer, Send candidate, and the exact node to invoke are all/);
  assert.match(submit, /currentSend\.candidate\?\.targetId != request\.sendTargetId/);
  assert.match(submit, /composerTargetId\(exactSendNode, request\.packageName\) != request\.sendTargetId/);
  assert.match(submit, /performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)/);
  assert.match(submit, /awaitComposerClear\(/);
  assert.match(submit, /NativeWakeSubmissionState\.NEEDS_REVIEW/);
});

test('composer selection can rely on its separate native-wake grant without enabling remote typing', () => {
  const selector = method(
    service,
    'private fun canSelectComposerForApp(',
    '    fun selectComposerTarget('
  );
  assert.match(selector, /AndroidNativeWakeConsentStore\(this\)\.activeGrant/);
  assert.match(selector, /AppGrantPolicy\.canSelectComposerTarget/);
  assert.match(service, /if \(!grant\.allowDraftInsertion \|\| !AppGrantPolicy\.canLaunch\(grant, signer\)\) return false/);
});

test('native wake consent is device, app and signer bound with a 24-hour cap and one-shot persistent seal', () => {
  assert.match(consent, /MAX_GRANT_TTL_MILLIS = 24L \* 60L \* 60L \* 1000L/);
  assert.match(consent, /MAX_WAKES_PER_MINUTE = 6/);
  assert.match(consent, /MAX_REPLAY_RECORDS = 4096/);
  assert.match(consent, /request\.grantId != grant\?\.grantId/);
  assert.match(consent, /it\.grantId == grant\.grantId && it\.eventId == request\.eventId/);
  assert.match(store, /\.commit\(\)/);
  assert.match(store, /fun revokeDevice\(deviceId: String\)/);
  assert.match(consent, /native_wake_replay_ledger_corrupt/);
});

test('local UI warns that saving consent does not activate remote automatic Send', () => {
  assert.match(activity, /Save local consent for 24 hours/);
  assert.match(activity, /native wake delivery and automatic Send are not connected in this build/i);
  assert.match(activity, /will not trigger any action in ChatGPT, Claude or another app/i);
});
