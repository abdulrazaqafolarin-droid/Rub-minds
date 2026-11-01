package app.rubminds.companion

/**
 * Process-local remote-typing consent.
 *
 * A grant is never persisted, so process death, service restart or device restart
 * automatically revokes remote typing. The phone user must arm it again locally.
 */
object RemoteKeyboardGate {
    const val ARM_LIFETIME_MS = 15 * 60 * 1000L

    @Volatile private var armedUntilMillis = 0L

    @Synchronized
    fun armFromLocalConfirmation(nowMillis: Long = System.currentTimeMillis()) {
        armedUntilMillis = nowMillis + ARM_LIFETIME_MS
    }

    @Synchronized
    fun isArmed(nowMillis: Long = System.currentTimeMillis()): Boolean {
        val until = armedUntilMillis
        if (until <= nowMillis || until - nowMillis > ARM_LIFETIME_MS) {
            armedUntilMillis = 0L
            return false
        }
        return true
    }

    @Synchronized
    fun disarm() {
        armedUntilMillis = 0L
    }
}
