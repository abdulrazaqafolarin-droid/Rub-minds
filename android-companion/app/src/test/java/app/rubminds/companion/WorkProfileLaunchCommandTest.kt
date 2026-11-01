package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WorkProfileLaunchCommandTest {
    private val secret = ByteArray(WorkProfileLaunchAuthenticator.SECRET_BYTES) { it.toByte() }
    private val packageName = "com.example.editor"
    private val signer = "a".repeat(64)
    private val now = 1_800_000_000_000L

    @Test fun validSignerBoundCommandIsAcceptedOnce() {
        val command = WorkProfileLaunchAuthenticator.create(
            secret, packageName, signer, now, "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        )!!
        assertNull(WorkProfileLaunchAuthenticator.verify(secret, command, now, false))
        assertEquals(
            "profile_command_replayed",
            WorkProfileLaunchAuthenticator.verify(secret, command, now, true)
        )
    }

    @Test fun tamperedPackageSignerTimestampNonceAndMacAreRejected() {
        val command = WorkProfileLaunchAuthenticator.create(secret, packageName, signer, now)!!
        assertNotNull(WorkProfileLaunchAuthenticator.verify(secret, command.copy(packageName = "com.attacker.app"), now, false))
        assertNotNull(WorkProfileLaunchAuthenticator.verify(secret, command.copy(signerSha256 = "b".repeat(64)), now, false))
        assertNotNull(WorkProfileLaunchAuthenticator.verify(secret, command.copy(issuedAtMillis = now + 10_000), now, false))
        assertNotNull(WorkProfileLaunchAuthenticator.verify(secret, command.copy(nonce = "not-a-uuid"), now, false))
        assertNotNull(WorkProfileLaunchAuthenticator.verify(secret, command.copy(macSha256 = "0".repeat(64)), now, false))
    }

    @Test fun expiredFutureAndWrongSecretCommandsAreRejected() {
        val command = WorkProfileLaunchAuthenticator.create(secret, packageName, signer, now)!!
        assertEquals(
            "profile_command_expired",
            WorkProfileLaunchAuthenticator.verify(secret, command, now + 60_001, false)
        )
        assertEquals(
            "profile_command_expired",
            WorkProfileLaunchAuthenticator.verify(secret, command, now - 5_001, false)
        )
        assertEquals(
            "profile_command_authentication_failed",
            WorkProfileLaunchAuthenticator.verify(ByteArray(32) { 7 }, command, now, false)
        )
        assertEquals(
            "profile_secret_unavailable",
            WorkProfileLaunchAuthenticator.verify(ByteArray(16), command, now, false)
        )
    }

    @Test fun malformedPackageSignerAndNonceCannotBeSigned() {
        assertNull(WorkProfileLaunchAuthenticator.create(secret, "com..bad", signer, now))
        assertNull(WorkProfileLaunchAuthenticator.create(secret, packageName, "not-a-digest", now))
        assertNull(WorkProfileLaunchAuthenticator.create(secret, packageName, signer, now, "not-a-uuid"))
        assertNull(WorkProfileLaunchAuthenticator.create(ByteArray(8), packageName, signer, now))
    }
}
