import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const service = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt');
const ime = await read('../../android-companion/app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt');
const screen = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt');
const handoffPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidNativeWakeHandoffPolicy.kt');
const handoffTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/AndroidNativeWakeHandoffPolicyTest.kt');
const bindingPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeBindingPolicy.kt');
const bindingPolicyTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/NativeWakeBindingPolicyTest.kt');
const providerConversation = await read('../../android-companion/app/src/main/java/app/rubminds/companion/ProviderConversationIdentity.kt');
const providerConversationTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/ProviderConversationIdentityPolicyTest.kt');
const consent = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeConsentPolicy.kt');
const store = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidNativeWakeConsentStore.kt');
const activity = await read('../../android-companion/app/src/main/java/app/rubminds/companion/MainActivity.kt');
const devicesUi = await read('../../src/BackroomDevicesApp.tsx');

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
});

test('native_wake_trigger is dispatched only by the device queue, separately from remote_text', () => {
  const commandDispatcher = method(
    screen,
    'private fun processCommand(token: String, command: JSONObject)',
    '    private fun invalidatePeerDisconnectTimer()'
  );
  assert.match(commandDispatcher, /"native_wake_trigger" -> processNativeWakeTrigger/);
  const nativeDispatch = method(
    screen,
    'private fun processNativeWakeTrigger(',
    '    private fun safeNativeWakeReason('
  );
  assert.match(nativeDispatch, /AndroidNativeWakeHandoffPolicy\.validate/);
  assert.match(nativeDispatch, /DeviceCredentialVault\(this\)\.deviceId\(\)/);
  assert.match(nativeDispatch, /activeSessionId != screenSessionId/);
  assert.match(nativeDispatch, /activeRoomId != roomId/);
  assert.match(nativeDispatch, /activeAppPackage != appPackage/);
  assert.match(nativeDispatch, /currentForegroundPackage\(\) != appPackage/);
  assert.match(nativeDispatch, /AndroidNativeWakeConsentStore\(this\)\.activeGrant/);
  assert.match(nativeDispatch, /AndroidTouchAccessibilityService\.submitCanonicalWake/);
  assert.doesNotMatch(nativeDispatch, /remote_text|insertRemoteText/);
});

test('a replayed local one-shot seal cannot be reported as a retryable preflight denial', () => {
  const nativeInsert = method(
    ime,
    'private fun insertNativeWakeTrigger(request: NativeWakeExecutionRequest)',
    '    companion object {'
  );
  assert.match(consent, /fun isTerminalReservationDenial\(reason: String\)/);
  assert.match(nativeInsert, /isTerminalReservationDenial\(seal\.reason\)/);
  assert.match(nativeInsert, /NativeWakeInsertState\.NEEDS_REVIEW/);
});

test('native wake ACK uses normalized reasons and successful identity evidence only', () => {
  const acknowledge = method(
    screen,
    'private fun acknowledgeNativeWake(',
    '    private fun processCommand('
  );
  assert.match(acknowledge, /safeNativeWakeReason\(result\.reason\)/);
  assert.match(acknowledge, /if \(state == "submitted"\)/);
  assert.match(acknowledge, /composerIdentityDigest/);
  assert.match(acknowledge, /sendControlIdentityDigest/);
  assert.doesNotMatch(acknowledge, /result\.reason\.take\(120\)/);
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
  assert.match(consent, /request\.jobId/);
  assert.match(consent, /request\.roomId/);
  assert.match(consent, /request\.bindingId/);
  assert.match(consent, /request\.leaseTokenDigest/);
  assert.match(store, /row\.jobId, row\.hostId, row\.roomId, row\.bindingId/);
  assert.match(consent, /it\.grantId == grant\.grantId && it\.eventId == request\.eventId/);
  assert.match(store, /\.commit\(\)/);
  assert.match(store, /fun revokeDevice\(deviceId: String\)/);
  assert.match(consent, /native_wake_replay_ledger_corrupt/);
});

test('local UI warns that saving consent does not activate remote automatic Send', () => {
  assert.match(activity, /Save app-level consent for 24 hours/);
  assert.match(activity, /phone-side native-wake queue consumer exists/i);
  assert.match(activity, /does not identify or pin a specific AI conversation\/thread/i);
  assert.match(activity, /Saving this consent alone will not trigger any action/i);
  assert.match(activity, /If an app cannot expose a stable conversation identity, native autonomous Send must remain unavailable for that app/i);
  assert.match(activity, /provider-conversation identity adapter/i);
  assert.match(activity, /will not trigger any action in ChatGPT, Claude or another app/i);
  assert.match(activity, /private fun pairedDeviceId\(\)/);
  assert.match(activity, /val credential = vault\.token\(\) \?: return null/);
});
test('the 20-second native handoff deadline is carried to the driver and rechecked before seal, insertion and Send', () => {
  assert.match(handoffPolicy, /handoffIssuedAtMillis = issuedAtMillis/);
  assert.match(handoffPolicy, /handoffExpiresAtMillis = expiresAtMillis/);
  assert.match(consent, /MAX_HANDOFF_CLOCK_SKEW_MILLIS = 3_000L/);
  assert.match(consent, /handoffExpiresAt - handoffIssuedAt > MAX_HANDOFF_TTL_MILLIS/);
  assert.match(consent, /MAX_HANDOFF_TTL_MILLIS = 20_000L/);
  assert.match(consent, /request\.handoffExpiresAtMillis <= nowMillis/);
  const nativeInsert = method(
    ime,
    'private fun insertNativeWakeTrigger(request: NativeWakeExecutionRequest)',
    '    companion object {'
  );
  assert.match(nativeInsert, /reserveExecution\(request\)/);
  assert.match(nativeInsert, /request\.handoffExpiresAtMillis <= System\.currentTimeMillis\(\)/);
  const submit = method(
    service,
    'fun submitCanonicalWake(',
    '    private fun awaitComposerClear('
  );
  const deadlineChecks = [...submit.matchAll(/request\.handoffExpiresAtMillis <= System\.currentTimeMillis\(\)/g)];
  assert.ok(deadlineChecks.length >= 3);
  assert.match(submit, /native_wake_handoff_expired_after_seal/);
});
test('Backroom capability copy reports the missing group forwarder rather than a missing phone queue', () => {
  assert.match(devicesUi, /AI-directed sending \/ native Off · On · Auto/);
  assert.match(devicesUi, /Not available · provider adapters \\+ group forwarding missing/);
  assert.doesNotMatch(devicesUi, /Not available · wake queue not connected/);
});

test('native consent and one-shot journal mutations share a process-wide lock across store instances', () => {
  assert.match(consent, /internal object NativeWakeJournalLock/);
  for (const name of ['confirmGrant', 'activeGrant', 'revoke', 'revokePackage', 'revokeDevice', 'reserveExecution']) {
    const start = store.indexOf(`fun ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const end = store.indexOf('\n    }', start);
    assert.notEqual(end, -1, `missing end for ${name}`);
    assert.match(store.slice(start, end), /synchronized\(NativeWakeJournalLock\.monitor\)/, `${name} must use the shared store lock`);
  }
  assert.doesNotMatch(store, /@Synchronized/);
});

test('Android issuer-skew regression preserves issue time and rejects skew beyond three seconds', () => {
  assert.match(handoffPolicy, /handoffIssuedAtMillis = issuedAtMillis/);
  assert.match(consent, /MAX_HANDOFF_CLOCK_SKEW_MILLIS = 3_000L/);
  assert.match(consent, /handoffExpiresAt - handoffIssuedAt > MAX_HANDOFF_TTL_MILLIS/);
  assert.match(handoffTest, /acceptsFutureIssuedHandoffWithinTheValidatedClockSkewAndPreservesItsTimestamp/);
  assert.match(handoffTest, /now \+ 2_000L/);
  assert.match(handoffTest, /now \+ 22_000L/);
});


test('native Send is serialized against session and composer-target invalidation', () => {
  const bind = method(service, '    fun bindSession(sessionId: String, packageName: String): Boolean {', '    fun dispatchRemoteBack(');
  assert.match(bind, /synchronized\(this\)[\s\S]*nativeBindingGeneration\+\+/);

  const select = method(service, '    fun selectComposerTarget(', '    fun revalidateSelectedSendControl(');
  assert.match(select, /nativeBindingGeneration\+\+/);
  assert.match(select, /nativeBindingGeneration != selectionGeneration/);
  assert.match(select, /sendTraversal\[1\] != 0[\s\S]*boundComposerTargetId = selected\.targetId[\s\S]*boundSendTargetId = null/);

  const clear = method(service, '    fun clearSelectedComposer()', '    /**\n     * Device-local native submit path');
  assert.match(clear, /synchronized\(this\)/);
  assert.match(clear, /nativeBindingGeneration\+\+/);

  const submit = method(service, '    fun submitCanonicalWake(', '    private fun awaitComposerClear(');
  assert.match(submit, /bindingGenerationAtStart/);
  assert.match(submit, /NativeWakeBindingPolicy\.isCurrent/);
  const insertionGuard = method(submit, '            val insertion = synchronized(this)', '            if (insertion == null)');
  assert.match(insertionGuard, /NativeWakeBindingPolicy\\.isCurrent/);
  assert.match(insertionGuard, /DraftInputMethodService\\.insertNativeWakeTrigger\\(request\\)/);

  const finalClick = method(submit, '            val invoked = try {', '            if (!invoked)');
  assert.match(finalClick, /synchronized\\(this\\)[\\s\\S]*performAction\\(AccessibilityNodeInfo\\.ACTION_CLICK\\)/);
  assert.match(finalClick, /NativeWakeBindingPolicy\\.isCurrent/);

  const clearActive = method(service, '        fun clearActiveSession(', '        fun selectComposerTarget(');
  assert.match(clearActive, /synchronized\(current\)[\s\S]*nativeBindingGeneration\+\+/);

  const awaitClear = method(service, '    private fun awaitComposerClear(', '    private fun findNodeByTargetId(');
  assert.match(awaitClear, /bindingGenerationAtStart/);
  assert.match(bindingPolicy, /expectedGeneration == currentGeneration/);
  assert.match(bindingPolicyTest, /nativeWakeRequiresTheExactUninterruptedSessionAndTargetBinding/);
});


test('native wake fails closed without provider conversation identity and carries only its digest', () => {
  assert.match(providerConversation, /private val adapters: Map<String, ProviderConversationIdentityAdapter> = emptyMap\(\)/);
  assert.match(providerConversation, /fun activeConversationStableId/);
  assert.match(providerConversation, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(providerConversation, /fun matches\(expectedDigest: String\?, currentDigest: String\?\)/);
  assert.match(providerConversationTest, /providerAndConversationIdentityAreHashedLocallyAndDifferentThreadsDoNotMatch/);
  assert.match(providerConversationTest, /noUnverifiedProviderAdapterIsReportedAsConversationCapable/);
  assert.match(bindingPolicy, /expectedProviderConversationDigest/);
  assert.match(bindingPolicy, /ProviderConversationIdentityPolicy\.matches/);
  assert.match(handoffPolicy, /providerConversationIdentityDigest/);
  assert.match(service, /ProviderConversationIdentityResolver\.resolve\(packageName, root\)/);
  assert.match(service, /ProviderConversationIdentityResolver\.resolve\(request\.packageName, root\)/);
  assert.match(service, /currentProviderConversationIdentityDigest\(request\.packageName\)/);
  assert.match(service, /boundProviderConversationIdentityDigest = null/);
  assert.match(screen, /isBoundToProviderConversation\(/);
  assert.match(screen, /providerConversationIdentityUnavailable/);
  assert.match(screen, /provider_conversation.*conversation_scope_unavailable/);
  const ack = method(screen, '    private fun acknowledgeNativeWake(', '    private fun processCommand(');
  assert.match(ack, /providerConversationIdentityRevalidated/);
  assert.match(ack, /providerConversationDigest != handoff\.providerConversationIdentityDigest/);
  assert.match(ack, /providerConversationIdentityDigest/);

  const clearVerification = method(service, '    private fun awaitComposerClear(', '    private fun findNodeByTargetId(');
  assert.match(clearVerification, /ProviderConversationIdentityPolicy\.matches/);
  assert.match(service, /providerConversationIdentityRevalidated = cleared/);
  assert.match(service, /providerConversationIdentityDigest = if \(providerConversationIdentityRevalidated\)/);
  assert.match(ime, /isSelectedComposerEmpty/);
  assert.equal((ime.match(/isBoundToProviderConversation\(/g) || []).length, 3);
  assert.match(ime, /provider_conversation_identity_changed_after_seal/);
  const serviceSubmit = method(service, '    fun submitCanonicalWake(', '    private fun awaitComposerClear(');
  const insertionGuard = method(serviceSubmit, '            val insertion = synchronized(this)', '            if (insertion == null)');
  assert.match(insertionGuard, /currentProviderConversationIdentityDigest\(request\.packageName\)/);
  assert.match(insertionGuard, /DraftInputMethodService\.insertNativeWakeTrigger\(request\)/);
  assert.match(store, /row.providerConversationIdentityDigest/);
  assert.match(store, /providerConversationIdentityDigest = fields.getOrNull\(16\)/);
  assert.match(store, /fields.size !in 16\.\.17/);
  assert.match(consent, /val providerConversationIdentityDigest: String/);
  assert.doesNotMatch(consent, /providerConversationIdentityDigest: String =/);
});
