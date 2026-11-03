package app.rubminds.companion

import android.content.Context
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

    @Synchronized
    fun confirmGrant(
        deviceId: String,
        packageName: String,
        signer: String,
        localConfirmation: Boolean,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeGrant? {
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

    @Synchronized
    fun activeGrant(
        deviceId: String,
        packageName: String,
        signer: String,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeGrant? {
        val key = grantKey(deviceId, packageName, signer)
        val raw = preferences.getString(key, null) ?: return null
        val grant = decodeGrant(raw)
        if (!NativeWakeConsentPolicy.isGrantActive(grant, deviceId, packageName, signer, nowMillis)) {
            check(preferences.edit().remove(key).commit()) { "Could not clear expired native wake consent." }
            return null
        }
        return grant
    }

    @Synchronized
    fun revoke(deviceId: String, packageName: String, signer: String): Boolean {
        val key = grantKey(deviceId, packageName, signer)
        if (!preferences.contains(key)) return false
        check(preferences.edit().remove(key).commit()) { "Could not revoke native wake consent." }
        return true
    }

    @Synchronized
    fun revokePackage(deviceId: String, packageName: String): Int {
        val prefix = "$deviceId|$packageName|"
        val editor = preferences.edit()
        val keys = preferences.all().keys.filter { it.startsWith(prefix) }
        keys.forEach(editor::remove)
        if (keys.isEmpty()) return 0
        check(editor.commit()) { "Could not revoke package native wake consent." }
        return keys.size
    }

    /**
     * Reserves the one-shot event seal synchronously. A true result means the
     * caller may proceed to its final foreground/identity check and exact Send.
     * False means no Send is allowed. An uncertain native action must retain
     * the reservation; it must never be deleted to enable a blind retry.
     */
    @Synchronized
    fun reserveExecution(
        request: NativeWakeExecutionRequest,
        nowMillis: Long = System.currentTimeMillis()
    ): NativeWakeReservationDecision {
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
        row.grantId, row.eventId, row.deviceId, row.sessionId, row.packageName,
        row.signingCertificateSha256, row.composerTargetId, row.sendTargetId,
        row.targetRevision, row.reservedAtMillis, row.grantExpiresAtMillis
    ).joinToString("\t")

    private fun decodeReservation(value: String): NativeWakeExecutionReservation? {
        val fields = value.split('\t')
        if (fields.size != 11) return null
        return runCatching {
            NativeWakeExecutionReservation(
                grantId = fields[0], eventId = fields[1], deviceId = fields[2],
                sessionId = fields[3], packageName = fields[4],
                signingCertificateSha256 = fields[5], composerTargetId = fields[6],
                sendTargetId = fields[7], targetRevision = fields[8].toInt(),
                reservedAtMillis = fields[9].toLong(), grantExpiresAtMillis = fields[10].toLong()
            )
        }.getOrNull()
    }

    private companion object {
        const val KEY_RESERVATIONS = "execution_reservations"
    }
}
