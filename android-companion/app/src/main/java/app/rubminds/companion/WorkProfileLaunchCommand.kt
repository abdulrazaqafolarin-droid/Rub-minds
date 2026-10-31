package app.rubminds.companion

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Authenticates a local parent-profile request to launch one signer-pinned app
 * inside the managed Work Profile. This is deliberately not a cloud command.
 */
data class WorkProfileLaunchCommand(
    val packageName: String,
    val signerSha256: String,
    val issuedAtMillis: Long,
    val nonce: String,
    val macSha256: String
)

object WorkProfileLaunchAuthenticator {
    private val packagePattern =
        Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val signerPattern = Regex("^[a-f0-9]{64}(?:\\.[a-f0-9]{64})*$")
    private val uuidPattern =
        Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

    const val SECRET_BYTES = 32
    const val MAX_AGE_MILLIS = 60_000L
    const val MAX_FUTURE_SKEW_MILLIS = 5_000L

    fun create(
        secret: ByteArray,
        packageName: String,
        signerSha256: String,
        issuedAtMillis: Long,
        nonce: String = UUID.randomUUID().toString()
    ): WorkProfileLaunchCommand? {
        if (!validSecret(secret) || !validPackage(packageName) ||
            !signerPattern.matches(signerSha256) || issuedAtMillis <= 0L ||
            !uuidPattern.matches(nonce)
        ) return null

        val mac = hmac(secret, canonical(packageName, signerSha256, issuedAtMillis, nonce))
        return WorkProfileLaunchCommand(packageName, signerSha256, issuedAtMillis, nonce, mac)
    }

    fun verify(
        secret: ByteArray,
        command: WorkProfileLaunchCommand,
        nowMillis: Long,
        nonceAlreadyUsed: Boolean
    ): String? {
        if (!validSecret(secret)) return "profile_secret_unavailable"
        if (!validPackage(command.packageName) || !signerPattern.matches(command.signerSha256) ||
            !uuidPattern.matches(command.nonce) || command.issuedAtMillis <= 0L
        ) return "profile_command_invalid"
        if (nonceAlreadyUsed) return "profile_command_replayed"
        if (command.issuedAtMillis > nowMillis + MAX_FUTURE_SKEW_MILLIS ||
            nowMillis - command.issuedAtMillis > MAX_AGE_MILLIS
        ) return "profile_command_expired"

        val expected = hmac(
            secret,
            canonical(command.packageName, command.signerSha256, command.issuedAtMillis, command.nonce)
        )
        val supplied = command.macSha256
        if (!Regex("^[a-f0-9]{64}$").matches(supplied) ||
            !MessageDigest.isEqual(
                expected.toByteArray(StandardCharsets.US_ASCII),
                supplied.toByteArray(StandardCharsets.US_ASCII)
            )
        ) return "profile_command_authentication_failed"
        return null
    }

    private fun validSecret(secret: ByteArray): Boolean = secret.size == SECRET_BYTES

    private fun validPackage(packageName: String): Boolean =
        packagePattern.matches(packageName) &&
            !packageName.startsWith("android.") &&
            !packageName.startsWith("java.")

    private fun canonical(
        packageName: String,
        signerSha256: String,
        issuedAtMillis: Long,
        nonce: String
    ): String = listOf(packageName, signerSha256, issuedAtMillis.toString(), nonce).joinToString("\n")

    private fun hmac(secret: ByteArray, text: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        val bytes = mac.doFinal(text.toByteArray(StandardCharsets.UTF_8))
        val hex = "0123456789abcdef"
        return buildString(bytes.size * 2) {
            bytes.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(hex[value ushr 4])
                append(hex[value and 0x0f])
            }
        }
    }
}
