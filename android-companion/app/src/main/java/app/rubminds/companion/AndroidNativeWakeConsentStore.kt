package app.rubminds.companion

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * Device-local native-wake consent and one-shot execution journal.
 *
 * SharedPreferences writes use commit(), not apply(), so the event seal is
 * durable before a caller is allowed to invoke the native Send control.
 * Only opaque IDs, signer hashes and timestamps are stored; never app text.
 */
class AndroidNativeWakeConsentStore(context: Context) {
    private val preferences = context.getSharedPreferences("native_wake_consent_v1", Context.MODE_PRIVATE)

    fun confirmGrant(
        deviceId: String,
        packageName: String,
        signer: String,
        localConfirmation: Boolean,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeGrant? {
        synchronized(NativeWakeJournalLock.monitor) {
            val grant = NativeWakeConsentPolicy.createGrant(
                grantId = UUID.randomUUID().toString(),
                deviceId = deviceId,
                packageName = packageName,
                signer = signer,
                nowMillis = nowMillis,
                localConfirmation = localConfirmation
            ) ?: return null
            val committed = preferences.edit()
                .putString(grantKey(deviceId, packageName, signer), encodeGrant(grant))
                .commit()
            check(committed) { "Could not persist native wake consent." }
            return grant
        }
    }

    fun activeGrant(
        deviceId: String,
        packageName: String,
        signer: String,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeGrant? {
        synchronized(NativeWakeJournalLock.monitor) {
            val key = grantKey(deviceId, packageName, signer)
            val raw = preferences.getString(key, null) ?: return null
            val grant = decodeGrant(raw)
            if (!NativeWakeConsentPolicy.isGrantActive(grant, deviceId, packageName, signer, nowMillis)) {
                check(preferences.edit().remove(key).commit()) { "Could not clear expired native wake consent." }
                return null
        }
        return grant
        }
    }

    fun revoke(deviceId: String, packageName: String, signer: String): Boolean {
        synchronized(NativeWakeJournalLock.monitor) {
            val key = grantKey(deviceId, packageName, signer)
            if (!preferences.contains(key)) return false
            check(preferences.edit().remove(key).commit()) { "Could not revoke native wake consent." }
            return true
        }
    }

    fun revokePackage(deviceId: String, packageName: String): Int {
        synchronized(NativeWakeJournalLock.monitor) {
            val prefix = "$deviceId|$packageName|"
            val editor = preferences.edit()
            val keys = preferences.all.keys.filter { it.startsWith(prefix) }
            keys.forEach { key -> editor.remove(key) }
            if (keys.isEmpty()) return 0
            check(editor.commit()) { "Could not revoke package native wake consent." }
            return keys.size
        }
    }

    fun revokeDevice(deviceId: String): Int {
        synchronized(NativeWakeJournalLock.monitor) {
            if (!deviceId.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))) {
                return 0
        }
        val prefix = "grant|$deviceId|"
        val editor = preferences.edit()
        val keys = preferences.all.keys.filter { it.startsWith(prefix) }
        keys.forEach { key -> editor.remove(key) }
        // This Android companion installation is paired to one device ID.
        // Revoking that identity also retires its one-shot event journal.
        editor.remove(KEY_RESERVATIONS)
        check(editor.commit()) { "Could not revoke this device's native wake state." }
        return keys.size
        }
    }

    /**
     * Persist a native-wake ACK before attempting network delivery. PREPARED is
     * written before the provider effect; FINAL atomically replaces it with the
     * exact device result. No device bearer credential is persisted here.
     */
    fun savePendingNativeWakeAcknowledgement(
        commandId: String,
        requestId: String,
        sessionId: String,
        payload: JSONObject,
        stage: NativeWakeAckOutboxStage,
        nowMillis: Long = System.currentTimeMillis()
    ): Boolean {
        synchronized(NativeWakeJournalLock.monitor) {
            val existing = readPendingNativeWakeAcknowledgements() ?: return false
            val payloadJson = runCatching { JSONObject(payload.toString()).toString() }.getOrNull()
                ?: return false
            val incoming = PendingNativeWakeAcknowledgement(
                commandId = commandId,
                requestId = requestId,
                sessionId = sessionId,
                payloadJson = payloadJson,
                stage = stage,
                savedAtMillis = nowMillis
            )
            if (!NativeWakeAckOutboxPolicy.isValid(incoming) ||
                !isValidNativeWakeAckPayload(incoming)
            ) return false
            val updated = NativeWakeAckOutboxPolicy.upsert(existing, incoming) ?: return false
            return preferences.edit()
                .putStringSet(KEY_PENDING_NATIVE_WAKE_ACKS, updated.map(::encodePendingNativeWakeAcknowledgement).toSet())
                .commit()
        }
    }

    /**
     * null means the durable outbox is corrupt/unreadable; callers must fail
     * closed and must not execute more native wake commands in that state.
     */
    fun pendingNativeWakeAcknowledgements(): List<PendingNativeWakeAcknowledgement>? {
        synchronized(NativeWakeJournalLock.monitor) {
            return readPendingNativeWakeAcknowledgements()?.sortedBy { it.savedAtMillis }
        }
    }

    /** Remove only the exact FINAL payload after the server confirms ACKed. */
    fun removePendingNativeWakeAcknowledgement(
        commandId: String,
        expectedPayloadJson: String
    ): Boolean {
        synchronized(NativeWakeJournalLock.monitor) {
            val existing = readPendingNativeWakeAcknowledgements() ?: return false
            val updated = NativeWakeAckOutboxPolicy.removeExact(
                existing, commandId, expectedPayloadJson
            ) ?: return false
            return preferences.edit()
                .putStringSet(KEY_PENDING_NATIVE_WAKE_ACKS, updated.map(::encodePendingNativeWakeAcknowledgement).toSet())
                .commit()
        }
    }

    private fun readPendingNativeWakeAcknowledgements(): List<PendingNativeWakeAcknowledgement>? {
        val rawRows = preferences.getStringSet(KEY_PENDING_NATIVE_WAKE_ACKS, emptySet()).orEmpty().toSet()
        val rows = rawRows.mapNotNull(::decodePendingNativeWakeAcknowledgement)
        if (rows.size != rawRows.size || rows.any {
                !NativeWakeAckOutboxPolicy.isValid(it) || !isValidNativeWakeAckPayload(it)
            } || rows.map { it.commandId }.toSet().size != rows.size
        ) return null
        return rows
    }

    private fun isValidNativeWakeAckPayload(
        entry: PendingNativeWakeAcknowledgement
    ): Boolean = runCatching {
        val payload = JSONObject(entry.payloadJson)
        val payloadKeys = payload.keys().asSequence().toSet()
        if (payloadKeys != setOf("commandId", "requestId", "sessionId", "result", "nativeWakeResult") ||
            payload.optString("commandId") != entry.commandId ||
            payload.optString("requestId") != entry.requestId ||
            payload.optString("sessionId") != entry.sessionId
        ) return@runCatching false

        val resultName = payload.optString("result")
        val evidence = payload.optJSONObject("nativeWakeResult") ?: return@runCatching false
        val state = evidence.optString("state")
        val expectedResult = when (state) {
            "preflight_denied" -> "native_wake_preflight_denied"
            "submitted" -> "native_wake_submitted"
            "needs_review" -> "native_wake_needs_review"
            else -> return@runCatching false
        }
        if (resultName != expectedResult) return@runCatching false

        val required = setOf(
            "version", "kind", "handoffId", "jobId", "deviceId", "roomId",
            "screenSessionId", "bindingId", "targetId", "targetRevision",
            "state", "promptInserted", "sendInvoked", "composerCleared"
        )
        val successEvidence = setOf(
            "promptReadbackVerified", "composerIdentityRevalidated",
            "sendControlIdentityRevalidated", "composerIdentityDigest",
            "sendControlIdentityDigest", "providerConversationIdentityRevalidated",
            "providerConversationIdentityDigest"
        )
        val allowedEvidence = required + successEvidence + "reason"
        val evidenceKeys = evidence.keys().asSequence().toSet()
        if (!evidenceKeys.containsAll(required) || evidenceKeys.any { it !in allowedEvidence } ||
            evidence.optInt("version", -1) != 1 ||
            evidence.optString("kind") != "native_wake_result" ||
            !UUID_PATTERN.matches(evidence.optString("handoffId")) ||
            !UUID_PATTERN.matches(evidence.optString("jobId")) ||
            !UUID_PATTERN.matches(evidence.optString("deviceId")) ||
            !UUID_PATTERN.matches(evidence.optString("roomId")) ||
            !UUID_PATTERN.matches(evidence.optString("screenSessionId")) ||
            evidence.optString("screenSessionId") != entry.sessionId ||
            !UUID_PATTERN.matches(evidence.optString("bindingId")) ||
            !Regex("^[a-f0-9]{64}$").matches(evidence.optString("targetId")) ||
            evidence.optInt("targetRevision", 0) <= 0 ||
            evidence.opt("promptInserted") !is Boolean ||
            evidence.opt("sendInvoked") !is Boolean ||
            evidence.opt("composerCleared") !is Boolean
        ) return@runCatching false

        when (entry.stage) {
            NativeWakeAckOutboxStage.PREPARED ->
                state == "needs_review" &&
                    evidence.optString("reason") == "outcome_unknown" &&
                    !evidence.optBoolean("promptInserted") &&
                    !evidence.optBoolean("sendInvoked") &&
                    !evidence.optBoolean("composerCleared") &&
                    evidenceKeys.intersect(successEvidence).isEmpty()
            NativeWakeAckOutboxStage.FINAL -> when (state) {
                "preflight_denied" ->
                    evidence.has("reason") &&
                        !evidence.optBoolean("promptInserted") &&
                        !evidence.optBoolean("sendInvoked") &&
                        !evidence.optBoolean("composerCleared") &&
                        evidenceKeys.intersect(successEvidence).isEmpty()
                "submitted" ->
                    !evidence.has("reason") &&
                        evidence.optBoolean("promptInserted") &&
                        evidence.optBoolean("sendInvoked") &&
                        evidence.optBoolean("composerCleared") &&
                        evidence.optBoolean("promptReadbackVerified") &&
                        evidence.optBoolean("composerIdentityRevalidated") &&
                        evidence.optBoolean("sendControlIdentityRevalidated") &&
                        evidence.optBoolean("providerConversationIdentityRevalidated") &&
                        Regex("^[a-f0-9]{64}$").matches(evidence.optString("composerIdentityDigest")) &&
                        Regex("^[a-f0-9]{64}$").matches(evidence.optString("sendControlIdentityDigest")) &&
                        Regex("^[a-f0-9]{64}$").matches(evidence.optString("providerConversationIdentityDigest"))
                else ->
                    evidence.has("reason") && !evidence.optBoolean("composerCleared") &&
                        (!evidence.optBoolean("sendInvoked") || evidence.optBoolean("promptInserted")) &&
                        evidenceKeys.intersect(successEvidence).isEmpty()
            }
        }
    }.getOrDefault(false)

    private fun encodePendingNativeWakeAcknowledgement(
        entry: PendingNativeWakeAcknowledgement
    ): String = JSONObject()
        .put("commandId", entry.commandId)
        .put("requestId", entry.requestId)
        .put("sessionId", entry.sessionId)
        .put("payloadJson", entry.payloadJson)
        .put("stage", entry.stage.name)
        .put("savedAtMillis", entry.savedAtMillis)
        .toString()

    private fun decodePendingNativeWakeAcknowledgement(value: String): PendingNativeWakeAcknowledgement? =
        runCatching {
            val json = JSONObject(value)
            if (json.keys().asSequence().toSet() != setOf(
                    "commandId", "requestId", "sessionId", "payloadJson", "stage", "savedAtMillis"
                )
            ) return@runCatching null
            PendingNativeWakeAcknowledgement(
                commandId = json.getString("commandId"),
                requestId = json.getString("requestId"),
                sessionId = json.getString("sessionId"),
                payloadJson = json.getString("payloadJson"),
                stage = NativeWakeAckOutboxStage.valueOf(json.getString("stage")),
                savedAtMillis = json.getLong("savedAtMillis")
            )
        }.getOrNull()

    /**
     * Reserves the one-shot event seal synchronously. A true result means the
     * caller may proceed to its final foreground/identity check and exact Send.
     * False means no Send is allowed. An uncertain native action must retain
     * the reservation; it must never be deleted to enable a blind retry.
     */
    fun reserveExecution(
        request: NativeWakeExecutionRequest,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeReservationDecision {
        synchronized(NativeWakeJournalLock.monitor) {
            val grant = activeGrant(
                request.deviceId, request.packageName,
                request.signingCertificateSha256, nowMillis
            ) ?: return NativeWakeReservationDecision(false, "native_wake_grant_inactive", emptyList())

            val rawRows = preferences.getStringSet(KEY_RESERVATIONS, emptySet()).orEmpty()
            val parsed = rawRows.mapNotNull(::decodeReservation)
            if (parsed.size != rawRows.size) {
                return NativeWakeReservationDecision(false, "native_wake_replay_ledger_corrupt", parsed)
        }
        val decision = NativeWakeConsentPolicy.reserveExecution(grant, request, parsed, nowMillis)
        if (!decision.allowed) return decision

        val encoded = decision.reservations.map(::encodeReservation).toSet()
        val committed = preferences.edit().putStringSet(KEY_RESERVATIONS, encoded).commit()
        if (!committed) {
            return NativeWakeReservationDecision(false, "native_wake_seal_persistence_failed", parsed)
        }
        return decision
        }
    }

    private fun grantKey(deviceId: String, packageName: String, signer: String) =
        "grant|$deviceId|$packageName|$signer"

    private fun encodeGrant(grant: NativeWakeGrant): String = listOf(
        grant.grantId, grant.deviceId, grant.packageName,
        grant.signingCertificateSha256, grant.grantedAtMillis, grant.expiresAtMillis
    ).joinToString("\t")

    private fun decodeGrant(value: String): NativeWakeGrant? {
        val fields = value.split('\t')
        if (fields.size != 6) return null
        return runCatching {
            NativeWakeGrant(
                grantId = fields[0], deviceId = fields[1], packageName = fields[2],
                signingCertificateSha256 = fields[3],
                grantedAtMillis = fields[4].toLong(), expiresAtMillis = fields[5].toLong()
            )
        }.getOrNull()
    }

    private fun encodeReservation(row: NativeWakeExecutionReservation): String = listOf(
        row.grantId, row.eventId, row.jobId, row.hostId, row.roomId, row.bindingId,
        row.leaseTokenDigest, row.deviceId, row.sessionId, row.packageName,
        row.signingCertificateSha256, row.composerTargetId, row.sendTargetId,
        row.targetRevision, row.reservedAtMillis, row.grantExpiresAtMillis,
        row.providerConversationIdentityDigest
    ).joinToString("\t")

    private fun decodeReservation(value: String): NativeWakeExecutionReservation? {
        val fields = value.split('\t')
        if (fields.size !in 16..17) return null
        return runCatching {
            NativeWakeExecutionReservation(
                grantId = fields[0], eventId = fields[1], jobId = fields[2],
                hostId = fields[3], roomId = fields[4], bindingId = fields[5],
                leaseTokenDigest = fields[6], deviceId = fields[7], sessionId = fields[8],
                packageName = fields[9], signingCertificateSha256 = fields[10],
                composerTargetId = fields[11], sendTargetId = fields[12],
                targetRevision = fields[13].toInt(), reservedAtMillis = fields[14].toLong(),
                grantExpiresAtMillis = fields[15].toLong(),
                providerConversationIdentityDigest = fields.getOrNull(16)
                    ?: NativeWakeConsentPolicy.LEGACY_CONVERSATION_SCOPE
            )
        }.getOrNull()
    }

    private companion object {
        const val KEY_RESERVATIONS = "execution_reservations"
        const val KEY_PENDING_NATIVE_WAKE_ACKS = "pending_native_wake_acks"
        val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}
