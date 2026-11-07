import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const service = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt');
const cloudApi = await read('../../android-companion/app/src/main/java/app/rubminds/companion/CloudDeviceApi.kt');
const ime = await read('../../android-companion/app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt');
const screen = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt');
const handoffPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidNativeWakeHandoffPolicy.kt');
const handoffTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/AndroidNativeWakeHandoffPolicyTest.kt');
const bindingPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeBindingPolicy.kt');
const bindingPolicyTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/NativeWakeBindingPolicyTest.kt');
const wakeGateway = await read('../../supabase/functions/backroom-wake/index.ts');
const nativeForwarder = await read('../../supabase/migrations/20261107090000_backroom_android_native_wake_forwarder.sql');
const deviceEdge = await read('../../supabase/functions/backroom-device/index.ts');
const attestedSettlement = await read('../../supabase/migrations/20261107110000_backroom_android_native_wake_attested_settlement.sql');
const providerConversation = await read('../../android-companion/app/src/main/java/app/rubminds/companion/ProviderConversationIdentity.kt');
const providerConversationTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/ProviderConversationIdentityPolicyTest.kt');
const consent = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeConsentPolicy.kt');
const store = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidNativeWakeConsentStore.kt');
const ackOutboxPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/NativeWakeAckOutboxPolicy.kt');
const ackOutboxTest = await read('../../android-companion/app/src/test/java/app/rubminds/companion/NativeWakeAckOutboxPolicyTest.kt');
const activity = await read('../../android-companion/app/src/main/java/app/rubminds/companion/MainActivity.kt');
const devicesUi = await read('../../src/BackroomDevicesApp.tsx');
const androidFrameUi = await read('../../src/BackroomAndroidControl.tsx');
const composerPolicy = await read('../../android-companion/app/src/main/java/app/rubminds/companion/AndroidComposerTargetPolicy.kt');

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
  assert.match(nativeDispatch, /ackStore\.activeGrant/);
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
    'private fun createNativeWakeAckPayload(',
    '    private fun acknowledgeNativeWake('
  );
  assert.match(acknowledge, /safeNativeWakeReason\(result\.reason\)/);
  assert.match(acknowledge, /if \(state == "submitted"\)/);
  assert.match(acknowledge, /composerIdentityDigest/);
  assert.match(acknowledge, /sendControlIdentityDigest/);
  assert.doesNotMatch(acknowledge, /result\.reason\.take\(120\)/);
});

test('provider-conversation digest never crosses the Android WebRTC browser boundary', () => {
  const selectionAck = method(
    screen,
    'private fun sendComposerTargetAcknowledgement(',
    '    private fun sendSendControlVerificationAcknowledgement('
  );
  const sendRecheckAck = method(
    screen,
    'private fun sendSendControlVerificationAcknowledgement(',
    '    private fun sendRemoteTextAcknowledgement('
  );
  assert.match(selectionAck, /providerConversationIdentityAvailable/);
  assert.doesNotMatch(selectionAck, /payload\.put\("providerConversationIdentityDigest"/);
  assert.match(sendRecheckAck, /providerConversationIdentityMatchesSelection/);
  assert.doesNotMatch(sendRecheckAck, /payload\.put\("providerConversationIdentityDigest"/);
  assert.doesNotMatch(androidFrameUi, /providerConversationIdentityDigest/);
  assert.match(service, /ProviderConversationIdentityPolicy\.matches\([\s\S]*boundProviderConversationIdentityDigest/);
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
  assert.match(consent, /retained\.any \{[\s\S]*it\.deviceId == request\.deviceId[\s\S]*it\.roomId == request\.roomId[\s\S]*it\.bindingId == request\.bindingId[\s\S]*it\.jobId == request\.jobId \|\| it\.eventId == request\.eventId \|\|[\s\S]*it\.leaseTokenDigest == request\.leaseTokenDigest/);
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
  assert.match(consent, /handoffExpiresAt <= nowMillis/);
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
  assert.match(devicesUi, /Not available · provider adapters \+ group forwarding missing/);
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

  const interrupt = method(service, '    override fun onInterrupt()', '    override fun onDestroy()');
  assert.match(interrupt, /nativeBindingGeneration\+\+/);
  assert.match(interrupt, /boundProviderConversationIdentityDigest = null/);
  assert.match(interrupt, /boundSessionId = null/);

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
  assert.match(insertionGuard, /NativeWakeBindingPolicy\.isCurrent/);
  assert.match(insertionGuard, /DraftInputMethodService\.insertNativeWakeTrigger\(request\)/);

  const finalClick = method(submit, '            val invoked = try {', '            if (!invoked)');
  assert.match(finalClick, /synchronized\(this\)[\s\S]*performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)/);
  assert.match(finalClick, /NativeWakeBindingPolicy\.isCurrent/);

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
  assert.match(service, /fun isBoundToProviderConversation\([\s\S]*?instance\?\.isBoundToProviderConversation\(/);
  assert.match(screen, /provider_conversation_identity_unavailable/);
  assert.match(screen, /provider_conversation.*conversation_scope_unavailable/);
  const ack = method(screen, '    private fun createNativeWakeAckPayload(', '    private fun acknowledgeNativeWake(');
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
  const executionRequest = method(consent, 'data class NativeWakeExecutionRequest(', 'data class NativeWakeExecutionReservation(');
  assert.match(executionRequest, /providerConversationIdentityDigest: String/);
  assert.doesNotMatch(executionRequest, /providerConversationIdentityDigest: String\s*=/);
});
test('Android Frame completes group binding through an owner challenge and phone-local device attestation', () => {
  assert.match(androidFrameUi, /export default function BackroomAndroidControl\(\{ device, roomId \}/);
  assert.match(androidFrameUi, /listAndroidNativeBindingCandidates\(roomId\)/);
  assert.match(androidFrameUi, /createAndroidNativeBindingChallenge\(/);
  assert.match(androidFrameUi, /deviceId: device\.device_id, roomId, sessionId: activeSession/);
  assert.match(androidFrameUi, /appPackageName: appPackage, bindingId/);
  assert.match(androidFrameUi, /kind: 'bind_native_group_target'/);
  assert.match(androidFrameUi, /challengeId: challenge\.challengeId/);
  assert.match(androidFrameUi, /nonce: challenge\.nonce/);
  assert.match(androidFrameUi, /acknowledgement\.kind === 'native_binding_ack'/);
  assert.match(androidFrameUi, /activeNativeBindingRef\.current = completedBindingId/);
  assert.doesNotMatch(androidFrameUi, /providerConversationIdentityDigest|sessionDigest|participantId/);
  assert.match(screen, /api\?\.completeNativeBinding\(token/);
  assert.match(screen, /AppIdentity\.signingCertificateSha256/);
  assert.match(screen, /evidence\.composerIdentityDigest/);
  assert.match(screen, /evidence\.sendControlIdentityDigest/);
  assert.match(screen, /evidence\.providerConversationIdentityDigest/);
  assert.match(deviceEdge, /android\/native-binding-complete/);
  assert.match(deviceEdge, /const current = await device\(req\)/);
  assert.match(deviceEdge, /p_app_signing_certificate_sha256: evidence\.appSigningCertificateSha256/);
  assert.match(deviceEdge, /p_provider_conversation_identity_digest: evidence\.providerConversationIdentityDigest/);
  assert.match(cloudApi, /fun completeNativeBinding\(deviceToken: String, fields: JSONObject\)/);
  assert.match(cloudApi, /post\("android\/native-binding-complete", deviceToken, fields\)/);
});

test('composer selection distinguishes Send discovery from provider-conversation readiness without exporting its digest', () => {
  assert.match(composerPolicy, /providerConversationIdentityAvailable: Boolean = false/);
  assert.match(service, /val selectedProviderDigest = providerConversationDigest\.takeIf \{[\s\S]*ProviderConversationIdentityPolicy\.isValidDigest\(it\)/);
  const composerAck = method(
    screen,
    'private fun sendComposerTargetAcknowledgement(',
    'private fun sendSendControlVerificationAcknowledgement('
  );
  assert.match(composerAck, /providerConversationIdentityAvailable/);
  assert.doesNotMatch(composerAck, /\.put\("(?:providerConversationIdentityDigest|providerConversationDigest)"/);
  assert.match(androidFrameUi, /acknowledgement\.providerConversationIdentityAvailable === true/);
  assert.match(androidFrameUi, /native wake blocked/);
  assert.match(androidFrameUi, /does not expose a verified stable conversation identity/);
});

test('Android native wake activation and claims require an unrevoked, unexpired attestation with the exact provider digest',()=>{
  const lookup = method(wakeGateway,'async function lookupBinding(', 'async function rpc(');
  assert.match(lookup,/backroom_android_native_bindings/);
  assert.match(lookup,/\.eq\('binding_id',data\.id\)/);
  assert.match(lookup,/\.eq\('provider_conversation_identity_digest',data\.provider_conversation_identity_digest\)/);
  assert.match(lookup,/\.is\('revoked_at',null\)/);
  assert.match(lookup,/\.gt\('expires_at',now\)/);
  assert.match(lookup,/nativeBindingAttested/);
});

test('native Android group leases cover the independent 60-second device command lease',()=>{
  const claimStore = method(wakeGateway,'async claim(', 'async acknowledge(');
  assert.match(claimStore,/surface:string/);
  assert.match(claimStore,/p_lease_seconds:surface==='android_app'\?120:30/);
  assert.match(claimStore,/hostId,sessionDigest,bindingId,surface,/);
});


test('Android group leases are forwarded by the service-role gateway and never returned to the generic host dispatcher', () => {
  const claimStore = method(wakeGateway, 'async claim(', 'async acknowledge(');
  assert.match(claimStore, /surface==='android_app'/);
  assert.match(claimStore, /queue_backroom_android_native_wake_command/);
  assert.match(claimStore, /p_job_id:lease\.jobId[\s\S]*p_lease_token:lease\.leaseToken/);
  assert.match(claimStore, /\['queued','already_queued'\]/);
  assert.match(claimStore, /return \[\]/);
  assert.ok(
    claimStore.indexOf('queue_backroom_android_native_wake_command') <
      claimStore.indexOf('return []'),
    'the native command must be persisted before the host receives an empty claim'
  );
  const androidBranchStart = claimStore.indexOf("if(surface==='android_app')");
  const androidBranchEnd = claimStore.indexOf('return []', androidBranchStart) + 'return []'.length;
  assert.ok(androidBranchStart >= 0 && androidBranchEnd > androidBranchStart);
  assert.doesNotMatch(claimStore.slice(androidBranchStart, androidBranchEnd), /return leases/);
});

test('the server-side Android forwarder checks the exact live lease, current device attestation and owner consent atomically', () => {
  assert.match(nativeForwarder, /security definer/);
  assert.match(nativeForwarder, /set search_path=''/);
  assert.match(nativeForwarder, /pg_advisory_xact_lock/);
  assert.match(nativeForwarder, /v_binding\.wake_enabled is distinct from true/);
  assert.match(nativeForwarder, /v_binding\.confirmed_at is null/);
  assert.match(nativeForwarder, /v_native\.provider_conversation_identity_digest is distinct from v_job\.provider_conversation_identity_digest/);
  assert.match(nativeForwarder, /n\.revoked_at is null/);
  assert.match(nativeForwarder, /n\.expires_at>v_now/);
  assert.match(nativeForwarder, /v_job\.state is distinct from 'leased'/);
  assert.match(nativeForwarder, /v_job\.lease_owner is distinct from p_host_id/);
  assert.match(nativeForwarder, /v_job\.lease_token_hash is distinct from[\s\S]*sha256/);
  assert.match(nativeForwarder, /s\.session_type='screen'/);
  assert.match(nativeForwarder, /d\.platform='android'/);
  assert.match(nativeForwarder, /v_app\.signing_certificate_sha256/);
  assert.match(nativeForwarder, /'identityFingerprint',v_native\.app_signing_certificate_sha256/);
  assert.match(nativeForwarder, /'leaseTokenDigest',v_job\.lease_token_hash/);
  assert.match(nativeForwarder, /v_now\+interval '20 seconds'/);
  assert.match(nativeForwarder, /on conflict do nothing/);
  assert.match(nativeForwarder, /leaseTokenDigest/);
  assert.match(nativeForwarder, /grant execute on function public\.queue_backroom_android_native_wake_command[\s\S]*to service_role/);
});

test('the generated SQL handoff uses the Android protocol signer field rather than the generic target fingerprint', () => {
  assert.match(nativeForwarder, /'appId',v_native\.app_package_name/);
  assert.match(nativeForwarder, /'identityFingerprint',v_native\.app_signing_certificate_sha256/);
  assert.doesNotMatch(nativeForwarder, /'identityFingerprint',v_job\.target_identity_fingerprint/);
  for (const field of [
    'handoffId','jobId','eventId','deviceId','roomId','screenSessionId','hostId','bindingId',
    'sessionDigest','sessionId','targetId','targetRevision','surface','appId','identityFingerprint',
    'composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityDigest',
    'leaseTokenDigest','prompt','promptDigest','issuedAt','leaseExpiresAt','expiresAt'
  ]) {
    assert.ok(nativeForwarder.includes("'" + field + "'"), 'missing Android handoff field: ' + field);
  }
});


test('Android device delivery rechecks the current group consent and exact phone attestation before leasing native wake commands', () => {
  assert.match(deviceEdge, /async function verifyCurrentNativeWakeHandoff/);
  assert.match(deviceEdge, /\.eq\('wake_enabled', true\)/);
  assert.match(deviceEdge, /\.gt\('wake_expires_at', now\)/);
  assert.match(deviceEdge, /\.eq\('app_signing_certificate_sha256', handoff\.identityFingerprint\)/);
  assert.match(deviceEdge, /\.eq\('composer_identity_digest', handoff\.composerIdentityDigest\)/);
  assert.match(deviceEdge, /\.eq\('send_control_identity_digest', handoff\.sendControlIdentityDigest\)/);
  assert.match(deviceEdge, /\.eq\('provider_conversation_identity_digest', handoff\.providerConversationIdentityDigest\)/);
  assert.equal((deviceEdge.match(/verifyCurrentNativeWakeHandoff\(row, current\.device_id\)/g) ?? []).length, 2);
  assert.match(deviceEdge, /native_wake_binding_or_consent_or_lease_revoked/);
  assert.match(deviceEdge, /backroom_wake_jobs/);
  assert.match(deviceEdge, /\.eq\('lease_token_hash', handoff\.leaseTokenDigest\)/);
  assert.match(deviceEdge, /\.gt\('lease_expires_at', now\)/);
});

test('native ACK settlement is tied to the exact attested app package, signer, screen and identity digests', () => {
  assert.match(deviceEdge, /settle_backroom_android_native_wake_result_attested/);
  assert.match(deviceEdge, /p_app_package_name: nativeWakeHandoff\.appId/);
  assert.match(deviceEdge, /p_app_signing_certificate_sha256: nativeWakeHandoff\.identityFingerprint/);
  assert.match(attestedSettlement, /v_native_binding_active boolean := false/);
  assert.match(attestedSettlement, /p_app_package_name is null/);
  assert.match(attestedSettlement, /p_app_signing_certificate_sha256 is null/);
  assert.match(attestedSettlement, /n\.expires_at>pg_catalog\.clock_timestamp\(\)/);
  assert.match(attestedSettlement, /n\.app_package_name=p_app_package_name/);
  assert.match(attestedSettlement, /n\.app_signing_certificate_sha256=p_app_signing_certificate_sha256/);
  assert.match(attestedSettlement, /n\.screen_session_id=p_screen_session_id/);
  assert.match(attestedSettlement, /n\.composer_identity_digest=p_composer_identity_digest/);
  assert.match(attestedSettlement, /n\.send_control_identity_digest=p_send_control_identity_digest/);
  assert.match(attestedSettlement, /n\.provider_conversation_identity_digest=p_provider_conversation_identity_digest/);
  assert.match(attestedSettlement, /for update/);
  assert.match(attestedSettlement, /and v_native_binding_active/);
  assert.match(attestedSettlement, /from public,anon,authenticated,service_role/);
});

test('device-attested registration uses a service-role-only definer wrapper instead of broad table write grants', () => {
  assert.match(nativeForwarder, /alter function public\.register_backroom_android_native_binding\([\s\S]*rename to register_backroom_android_native_binding_impl/);
  assert.match(nativeForwarder, /create function public\.register_backroom_android_native_binding\([\s\S]*security definer/);
  assert.match(nativeForwarder, /register_backroom_android_native_binding_impl[\s\S]*from public,anon,authenticated,service_role/);
  assert.doesNotMatch(nativeForwarder, /grant update on table public\.backroom_device_room_bindings/);
});


test('Android candidate display names sanitize Unicode control characters with valid regex ranges', () => {
  assert.ok(deviceEdge.includes(String.raw`participant.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g`));
  assert.ok(!deviceEdge.includes(String.raw`participant.display_name.replace(/[\\u0000`));
});


test('native Send reserves a durable ACK placeholder before scheduling the provider effect', () => {
  const dispatch = method(
    screen,
    'private fun processNativeWakeTrigger(',
    'private fun safeNativeWakeReason('
  );
  const prepare = dispatch.indexOf('savePendingNativeWakeAcknowledgement(');
  const submit = dispatch.indexOf('submitCanonicalWake(request)');
  assert.ok(prepare >= 0 && submit > prepare);
  assert.match(dispatch, /NativeWakeAckOutboxStage\.PREPARED/);
  assert.match(dispatch, /NativeWakeSubmissionState\.NEEDS_REVIEW, "outcome_unknown"/);
  assert.match(dispatch, /pendingAcks\.any \{ it\.commandId == commandId \}/);
});

test('native ACK receipt is persisted before HTTP and retried before matching commands can be redispatched', () => {
  const poll = method(screen, 'private fun pollDeviceCommands()', 'private fun processNativeWakeTrigger(');
  const retry = method(screen, 'private fun retryPendingNativeWakeAcknowledgements(', 'private fun processCommand(');
  const acknowledge = method(screen, 'private fun acknowledgeNativeWake(', 'private fun processCommand(');
  assert.ok(poll.indexOf('retryPendingNativeWakeAcknowledgements(token)') <
    poll.indexOf('processCommand(token, command)'));
  assert.match(poll, /pendingNativeAckIds == null/);
  assert.match(poll, /command\.optString\("commandId"\) in pendingNativeAckIds/);
  assert.ok(acknowledge.indexOf('savePendingNativeWakeAcknowledgement(') <
    acknowledge.indexOf('retryPendingNativeWakeAcknowledgements(token)'));
  assert.match(acknowledge, /NativeWakeAckOutboxStage\.FINAL/);
  assert.match(retry, /api\?\.post\("android\/ack", token, JSONObject\(entry\.payloadJson\)\)/);
  assert.match(retry, /response\?\.optBoolean\("ok"\) == true && response\.optBoolean\("acked"\) == true/);
  assert.match(retry, /removePendingNativeWakeAcknowledgement\(entry\.commandId, entry\.payloadJson\)/);
  assert.match(retry, /NativeWakeAckOutboxStage\.PREPARED[\s\S]*NativeWakeAckOutboxStage\.FINAL/);
});

test('durable ACK outbox is bounded, exact-payload scoped and never stores the device bearer token', () => {
  assert.match(ackOutboxPolicy, /MAX_PENDING_ACKS = 64/);
  assert.match(ackOutboxPolicy, /stage != NativeWakeAckOutboxStage\.PREPARED/);
  assert.match(ackOutboxPolicy, /incoming\.stage != NativeWakeAckOutboxStage\.FINAL/);
  assert.match(ackOutboxPolicy, /prior\.payloadJson != expectedPayloadJson/);
  assert.match(ackOutboxPolicy, /prior\.stage != NativeWakeAckOutboxStage\.FINAL/);
  assert.match(store, /KEY_PENDING_NATIVE_WAKE_ACKS/);
  assert.match(store, /\.commit\(\)/);
  assert.match(store, /isValidNativeWakeAckPayload/);
  assert.match(store, /evidence\.optString\("reason"\) == "outcome_unknown"/);
  assert.doesNotMatch(
    method(store, 'fun savePendingNativeWakeAcknowledgement(', 'fun pendingNativeWakeAcknowledgements('),
    /token|authorization|bearer/i
  );
  assert.match(ackOutboxTest, /preparedPlaceholderIsPromotedToOneExactFinalReceipt/);
  assert.match(ackOutboxTest, /receiptRemainsPendingUntilTheExactFinalPayloadIsConfirmed/);
  assert.match(ackOutboxTest, /outboxIsBoundedAndMalformedEntriesFailClosed/);
});
