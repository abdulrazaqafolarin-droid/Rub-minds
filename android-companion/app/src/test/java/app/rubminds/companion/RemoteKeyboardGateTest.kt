package app.rubminds.companion

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteKeyboardGateTest {
    @After
    fun resetGrant() {
        RemoteKeyboardGate.disarm()
    }

    @Test
    fun remoteTypingStartsDisarmed() {
        RemoteKeyboardGate.disarm()
        assertFalse(RemoteKeyboardGate.isArmed(10_000L))
    }

    @Test
    fun localConfirmationGrantsOnlyFifteenMinutes() {
        val now = 100_000L
        RemoteKeyboardGate.armFromLocalConfirmation(now)
        assertTrue(RemoteKeyboardGate.isArmed(now))
        assertTrue(RemoteKeyboardGate.isArmed(now + RemoteKeyboardGate.ARM_LIFETIME_MS - 1))
        assertFalse(RemoteKeyboardGate.isArmed(now + RemoteKeyboardGate.ARM_LIFETIME_MS))
    }

    @Test
    fun disarmRevokesImmediately() {
        val now = 200_000L
        RemoteKeyboardGate.armFromLocalConfirmation(now)
        assertTrue(RemoteKeyboardGate.isArmed(now))
        RemoteKeyboardGate.disarm()
        assertFalse(RemoteKeyboardGate.isArmed(now + 1))
    }

    @Test
    fun clockMovingBackwardsFailsClosed() {
        val now = 300_000L
        RemoteKeyboardGate.armFromLocalConfirmation(now)
        assertFalse(RemoteKeyboardGate.isArmed(now - 1))
        assertFalse(RemoteKeyboardGate.isArmed(now))
    }
}
