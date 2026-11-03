package app.rubminds.companion

import org.json.JSONObject
import java.security.MessageDigest

data class ValidatedAndroidNativeWakeHandoff(
    val handoffId: String,
    val jobId: String,
    val eventId: String,
    val deviceId: String,
    val roomId: String,
    val screenSessionId: String,
    val hostId: String,
    val bindingId: String,
    val aiSessionId: String,
    val targetId: String,
    val targetRevision: Int,
    val packageName: String,
    val signingCertificateSha256: String,
    val composerTargetId: String,
    val sendTargetId: String,
    val leaseTokenDigest: String,
    val issuedAtMillis: Long,
    val leaseExpiresAtMillis: Long,
    val expiresAtMillis: Long
) {
    fun toExecutionRequest(grantId: String): NativeWakeExecutionRequest =
        NativeWakeExecutionRequest(
            grantId = grantId,
            jobId = jobId,
            hostId = hostId,
            roomId = roomId,
            bindingId = bindingId,
            leaseTokenDigest = leaseTokenDigest,
            deviceId = deviceId,
            sessionId = screenSessionId,
            packageName = packageName,
            signingCertificateSha256 = signingCertificateSha256,
            eventId = eventId,
            composerTargetId = composerTargetId,
            sendTargetId = sendTargetId,
            targetRevision = targetRevision
        )
}

/**
 * Strict Android-side validation for the separate device-authenticated
 * native_wake_trigger queue action. This is intentionally not a remote_text
 * message and never accepts a caller-authored prompt.
 */
object AndroidNativeWakeHandoffPolicy {
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val hex = Regex("^[a-f0-9]{64}$")
    private val eventId = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    private val promptDigest = Regex("^[a-f0-9]{64}$")

    private val commandKeys = setOf(
        "action", "deviceId", "roomId", "requestId", "issuedAt", "sessionId",
        "appPackageName", "nativeWakeHandoff", "commandId"
    )
    private val handoffKeys = setOf(
        "version", "kind", "handoffId", "jobId", "eventId", "deviceId", "roomId",
        "screenSessionId", "hostId", "bindingId", "sessionId", "targetId",
        "targetRevision", "surface", "appId", "identityFingerprint",
        "composerIdentityDigest", "sendControlIdentityDigest", "leaseTokenDigest",
        "prompt", "promptDigest", "issuedAt", "leaseExpiresAt", "expiresAt"
    )

    fun validate(
        command: JSONObject,
        expectedDeviceId: String,
        expectedRoomId: String,
        expectedScreenSessionId: String,
        expectedPackageName: String,
        expectedSignerSha256: String,
        nowMillis: Long = System.currentTimeMillis(),
        clockSkewMillis: Long = 3_000L
    ): ValidatedAndroidNativeWakeHandoff? = runCatching {
        if (!hasExactKeys(command, commandKeys) ||
            command.optString("action") != "native_wake_trigger" ||
            !uuid.matches(expectedDeviceId) || !uuid.matches(expectedRoomId) ||
            !uuid.matches(expectedScreenSessionId) ||
            !AppGrantPolicy.isValidPackageName(expectedPackageName) ||
            !AppGrantPolicy.isValidSigningCertificateSha256(expectedSignerSha256) ||
            nowMillis <= 0L || clockSkewMillis !in 0L..10_000L
        ) return null

        val commandDeviceId = command.getString("deviceId")
        val commandRoomId = command.getString("roomId")
        val commandRequestId = command.getString("requestId")
        val commandSessionId = command.getString("sessionId")
        val commandPackage = command.getString("appPackageName")
        val commandId = command.getString("commandId")
        val commandIssuedAt = exactLong(command, "issuedAt") ?: return null
        if (!uuid.matches(commandId) || !uuid.matches(commandRequestId) ||
            commandDeviceId != expectedDeviceId || commandRoomId != expectedRoomId ||
            commandSessionId != expectedScreenSessionId || commandPackage != expectedPackageName
        ) return null

        val handoff = command.getJSONObject("nativeWakeHandoff")
        if (!hasExactKeys(handoff, handoffKeys)) return null

        val version = exactLong(handoff, "version") ?: return null
        val targetRevision = exactLong(handoff, "targetRevision") ?: return null
        val issuedAt = exactLong(handoff, "issuedAt") ?: return null
        val leaseExpiresAt = exactLong(handoff, "leaseExpiresAt") ?: return null
        val expiresAt = exactLong(handoff, "expiresAt") ?: return null

        val handoffId = handoff.getString("handoffId")
        val jobId = handoff.getString("jobId")
        val event = handoff.getString("eventId")
        val deviceId = handoff.getString("deviceId")
        val roomId = handoff.getString("roomId")
        val screenSessionId = handoff.getString("screenSessionId")
        val hostId = handoff.getString("hostId")
        val bindingId = handoff.getString("bindingId")
        val aiSessionId = handoff.getString("sessionId")
        val targetId = handoff.getString("targetId")
        val surface = handoff.getString("surface")
        val packageName = handoff.getString("appId")
        val signer = handoff.getString("identityFingerprint")
        val composerDigest = handoff.getString("composerIdentityDigest")
        val sendDigest = handoff.getString("sendControlIdentityDigest")
        val leaseDigest = handoff.getString("leaseTokenDigest")
        val prompt = handoff.getString("prompt")
        val digest = handoff.getString("promptDigest")

        if (version != 1L || handoff.getString("kind") != "native_wake_trigger" ||
            !uuid.matches(handoffId) || !uuid.matches(jobId) || !eventId.matches(event) ||
            !uuid.matches(deviceId) || !uuid.matches(roomId) || !uuid.matches(screenSessionId) ||
            !uuid.matches(hostId) || !uuid.matches(bindingId) ||
            aiSessionId.isBlank() || aiSessionId.length > 256 ||
            targetId.isBlank() || targetId.length > 128 ||
            targetRevision !in 1L..Int.MAX_VALUE.toLong() ||
            surface != "android_app" || packageName != expectedPackageName ||
            signer != expectedSignerSha256 ||
            !hex.matches(composerDigest) || !hex.matches(sendDigest) ||
            !hex.matches(leaseDigest) || !promptDigest.matches(digest) ||
            prompt != canonicalPrompt(event) || sha256(prompt) != digest ||
            deviceId != expectedDeviceId || roomId != expectedRoomId ||
            screenSessionId != expectedScreenSessionId ||
            commandIssuedAt != issuedAt || issuedAt > nowMillis + clockSkewMillis ||
            expiresAt <= nowMillis || leaseExpiresAt <= nowMillis ||
            expiresAt > leaseExpiresAt || expiresAt - issuedAt > MAX_HANDOFF_TTL_MILLIS ||
            issuedAt >= leaseExpiresAt
        ) return null

        ValidatedAndroidNativeWakeHandoff(
            handoffId = handoffId,
            jobId = jobId,
            eventId = event,
            deviceId = deviceId,
            roomId = roomId,
            screenSessionId = screenSessionId,
            hostId = hostId,
            bindingId = bindingId,
            aiSessionId = aiSessionId,
            targetId = targetId,
            targetRevision = targetRevision.toInt(),
            packageName = packageName,
            signingCertificateSha256 = signer,
            composerTargetId = composerDigest,
            sendTargetId = sendDigest,
            leaseTokenDigest = leaseDigest,
            issuedAtMillis = issuedAt,
            leaseExpiresAtMillis = leaseExpiresAt,
            expiresAtMillis = expiresAt
        )
    }.getOrNull()

    private fun hasExactKeys(value: JSONObject, expected: Set<String>): Boolean {
        val actual = value.keys().asSequence().toSet()
        return actual == expected
    }

    private fun exactLong(value: JSONObject, key: String): Long? {
        val raw = value.opt(key) ?: return null
        if (raw !is Number) return null
        val converted = raw.toLong()
        return if (raw.toDouble() == converted.toDouble()) converted else null
    }

    private fun canonicalPrompt(event: String): String? {
        if (!eventId.matches(event)) return null
        return "@RMconnects\nEvent: $event\nRetrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP."
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private const val MAX_HANDOFF_TTL_MILLIS = 20_000L
}
