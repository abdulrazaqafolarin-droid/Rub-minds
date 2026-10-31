package app.rubminds.companion

import android.content.Context

/** A short, local-only arm switch. No cloud or AI actor can enable this preference. */
object RemoteTouchGate {
    private const val PREFS = "backroom_remote_touch_gate"
    private const val KEY_UNTIL = "armed_until_ms"
    private const val ARM_LIFETIME_MS = 15 * 60 * 1000L

    fun armFromLocalConfirmation(context: Context, nowMillis: Long = System.currentTimeMillis()) {
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_UNTIL, nowMillis + ARM_LIFETIME_MS).commit()) {
            "Could not save the local touch-control grant."
        }
    }

    fun isArmed(context: Context, nowMillis: Long = System.currentTimeMillis()): Boolean {
        val until = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_UNTIL, 0L)
        if (until <= nowMillis || until - nowMillis > ARM_LIFETIME_MS) {
            disarm(context)
            return false
        }
        return true
    }

    fun disarm(context: Context) {
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_UNTIL).commit()) {
            "Could not revoke the local touch-control grant."
        }
    }
}
