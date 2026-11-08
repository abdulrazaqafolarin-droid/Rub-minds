package app.rubminds.companion

import java.security.MessageDigest

internal object DeviceFrameBindingPolicy {
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    private val hex64 = Regex("^[0-9a-fA-F]{64}$")
    private val signerSet = Regex("^[0-9a-fA-F]{64}(?:\\.[0-9a-fA-F]{64})*$")
    private val packageName = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")

    fun isValidAndroidChallenge(
        deviceId: String,
        runtimeSessionId: String,
        appPackageName: String,
        challengeId: String,
        nonce: String,
        surface: String,
        appId: String,
        appIdentityFingerprint: String,
        expiresAtMillis: Long,
        nowMillis: Long
    ): Boolean {
        if (!uuid.matches(deviceId) || !uuid.matches(runtimeSessionId) ||
            !uuid.matches(challengeId) || !hex64.matches(nonce) ||
            surface != "android_app" || !packageName.matches(appPackageName) ||
            appId != appPackageName || !signerSet.matches(appIdentityFingerprint) ||
            expiresAtMillis <= nowMillis || expiresAtMillis - nowMillis > 90_000L
        ) return false
        return true
    }

    fun runtimeIdentityDigest(
        deviceId: String,
        runtimeSessionId: String,
        appPackageName: String,
        appIdentityFingerprint: String
    ): String {
        require(uuid.matches(deviceId) && uuid.matches(runtimeSessionId))
        require(packageName.matches(appPackageName) && signerSet.matches(appIdentityFingerprint))
        val canonical = "rub-minds-device-frame-v1|$deviceId|$runtimeSessionId|$appPackageName|$appIdentityFingerprint"
        return MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }
}
