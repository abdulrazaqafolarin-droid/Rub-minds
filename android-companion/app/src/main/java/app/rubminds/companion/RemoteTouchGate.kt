package app.rubminds.companion

import android.content.Context

/** A short, local-only arm switch. No cloud or AI actor can enable this preference. */
object RemoteTouchGate {
    private const val PREFS = "backroom_remote_touch_gate"
    private const val KEY_UNTIL = "armed_until_ms"
    private const val ARM_LIFETIME_MS = 15 * 60 * 1000L

    // A disk failure must not resurrect a grant during this process. Local
    // confirmation clears this latch only after the new expiry is persisted.
    @Volatile private var processRevoked = false

    @Synchronized
    fun armFromLocalConfirmation(context: Context, nowMillis: Long = System.currentTimeMillis()) {
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_UNTIL, nowMillis + ARM_LIFETIME_MS).commit()) {
            "Could not save the local touch-control grant."
        }
        processRevoked = false
    }

    @Synchronized
    fun isArmed(context: Context, nowMillis: Long = System.currentTimeMillis()): Boolean {
        if (processRevoked) return false
        val until = runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_UNTIL, 0L)
        }.getOrDefault(0L)
        if (until <= nowMillis || until - nowMillis > ARM_LIFETIME_MS) {
            disarm(context)
            return false
        }
        return true
    }

    @Synchronized
    fun disarm(context: Context) {
        // Revoke in memory first. The persistent removal is best-effort because
        // stop/interrupt cleanup must never abort if storage is unavailable.
        processRevoked = true
        runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_UNTIL).commit()
        }
    }
}
