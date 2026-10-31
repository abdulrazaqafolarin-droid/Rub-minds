package app.rubminds.companion

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * User-enabled gesture bridge. It does not upload the accessibility tree or text.
 * Every gesture is scoped to a locally selected package and its current window bounds.
 */
class AndroidTouchAccessibilityService : AccessibilityService() {
    @Volatile private var boundSessionId: String? = null
    @Volatile private var boundPackageName: String? = null
    @Volatile private var gestureInFlight = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val target = boundPackageName ?: return
        // Re-check the actual active window on every window transition, including
        // events with a null or stale event.packageName.
        val activePackage = currentRootPackage()
        if (activePackage != target) {
            AndroidScreenShareService.requestStop(applicationContext, "foreground_app_changed")
        }
    }

    override fun onInterrupt() {
        synchronized(this) { gestureInFlight = false }
        AndroidScreenShareService.requestStop(applicationContext, "accessibility_interrupted")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        boundSessionId = null
        boundPackageName = null
        synchronized(this) { gestureInFlight = false }
        super.onDestroy()
    }

    fun bindSession(sessionId: String, packageName: String): Boolean {
        if (currentRootPackage() != packageName) return false
        val digest = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
        if (AppGrantStore(this).get(packageName, digest) == null) return false
        boundSessionId = sessionId
        boundPackageName = packageName
        return true
    }

    fun dispatchRemoteGesture(gesture: RemoteTouchGesture): Boolean {
        val expectedSession = boundSessionId
        val expectedPackage = boundPackageName
        if (!AndroidTouchPolicy.validate(
                gesture = gesture,
                activeSessionId = expectedSession,
                activePackageName = currentRootPackage(),
                localTouchArmed = RemoteTouchGate.isArmed(this),
                accessibilityEnabled = isServiceEnabled(this)
            )
        ) return false
        if (gesture.appPackageName != expectedPackage) return false

        val signer = AppIdentity.signingCertificateSha256(this, gesture.appPackageName) ?: return false
        if (AppGrantStore(this).get(gesture.appPackageName, signer) == null) return false

        val root = rootInActiveWindow ?: return false
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != gesture.appPackageName) return false
            val bounds = Rect()
            root.getBoundsInScreen(bounds)
            val windowBounds = TouchWindowBounds(bounds.left, bounds.top, bounds.right, bounds.bottom)
            val start = AndroidTouchPolicy.map(gesture.from, windowBounds) ?: return false
            val end = AndroidTouchPolicy.map(gesture.to, windowBounds) ?: return false
            val path = Path().apply {
                moveTo(start.first.toFloat(), start.second.toFloat())
                lineTo(end.first.toFloat(), end.second.toFloat())
            }
            val duration = when (gesture.kind) {
                RemoteGestureKind.TAP -> gesture.durationMillis.coerceIn(60, 180)
                RemoteGestureKind.SWIPE -> gesture.durationMillis.coerceIn(120, 1_000)
                RemoteGestureKind.LONG_PRESS -> gesture.durationMillis.coerceIn(500, 1_500)
            }
            synchronized(this) {
                if (gestureInFlight) return false
                gestureInFlight = true
            }
            val accepted = try {
                dispatchGesture(
                    GestureDescription.Builder()
                        .addStroke(GestureDescription.StrokeDescription(path, 0, duration.toLong()))
                        .build(),
                    object : GestureResultCallback() {
                        override fun onCompleted(gestureDescription: GestureDescription?) {
                            synchronized(this@AndroidTouchAccessibilityService) { gestureInFlight = false }
                        }
                        override fun onCancelled(gestureDescription: GestureDescription?) {
                            synchronized(this@AndroidTouchAccessibilityService) { gestureInFlight = false }
                        }
                    },
                    Handler(Looper.getMainLooper())
                )
            } catch (_: RuntimeException) {
                false
            }
            if (!accepted) synchronized(this) { gestureInFlight = false }
            return accepted
        } finally {
            root.recycle()
        }
    }

    private fun currentRootPackage(): String? =
        try { rootInActiveWindow?.let { root ->
            try { root.packageName?.toString() } finally { root.recycle() }
        } } catch (_: SecurityException) { null }

    companion object {
        @Volatile private var instance: AndroidTouchAccessibilityService? = null

        fun isServiceEnabled(context: Context): Boolean {
            val expected = ComponentName(context, AndroidTouchAccessibilityService::class.java).flattenToString()
            val enabled = Settings.Secure.getString(
                context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ).orEmpty()
            return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
        }

        fun bindActiveSession(sessionId: String, packageName: String): Boolean =
            instance?.bindSession(sessionId, packageName) == true

        fun dispatch(
            context: Context,
            gesture: RemoteTouchGesture
        ): Boolean = instance?.dispatchRemoteGesture(gesture) == true

        fun clearActiveSession(sessionId: String? = null) {
            val current = instance ?: return
            if (sessionId == null || current.boundSessionId == sessionId) {
                current.boundSessionId = null
                current.boundPackageName = null
            }
        }

        fun currentForegroundPackage(): String? = instance?.currentRootPackage()
    }
}
