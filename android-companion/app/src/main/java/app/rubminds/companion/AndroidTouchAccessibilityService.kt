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
import java.security.MessageDigest

/**
 * User-enabled gesture bridge. It does not upload the accessibility tree or text.
 * Every gesture is scoped to a locally selected package and its current window bounds.
 */
class AndroidTouchAccessibilityService : AccessibilityService() {
    @Volatile private var boundSessionId: String? = null
    @Volatile private var boundPackageName: String? = null
    @Volatile private var gestureInFlight = false
    @Volatile private var boundComposerTargetId: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val target = boundPackageName ?: return
        // Re-check the actual active window on every window transition, including
        // events with a null or stale event.packageName.
        val activePackage = currentRootPackage()
        // A null root can be a transient window-transition/OS-protected surface.
        // Touch still fails closed when the active root is unknown; stop only when
        // Android positively identifies a different foreground package.
        if (activePackage != null && activePackage != target) {
            AndroidScreenShareService.requestStop(applicationContext, "foreground_app_changed")
        }
    }

    override fun onInterrupt() {
        synchronized(this) { gestureInFlight = false }
        // Accessibility is optional. Interrupting/removing it revokes remote touch
        // but must not terminate a user-consented view-only MediaProjection session.
        AndroidScreenShareService.revokeLocalTouch(applicationContext)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        boundSessionId = null
        boundPackageName = null
        boundComposerTargetId = null
        synchronized(this) { gestureInFlight = false }
        AndroidScreenShareService.revokeLocalTouch(applicationContext)
        super.onDestroy()
    }

    fun bindSession(sessionId: String, packageName: String): Boolean {
        if (currentRootPackage() != packageName) return false
        val digest = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
        if (AppGrantStore(this).get(packageName, digest) == null) return false
        boundSessionId = sessionId
        boundPackageName = packageName
        boundComposerTargetId = null
        return true
    }

    fun dispatchRemoteBack(sessionId: String, packageName: String): Boolean {
        if (boundSessionId != sessionId || boundPackageName != packageName ||
            !RemoteTouchGate.isArmed(this) || !isServiceEnabled(this)
        ) return false
        val signer = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
        if (AppGrantStore(this).get(packageName, signer) == null) return false
        val root = rootInActiveWindow ?: return false
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) return false
            synchronized(this) { if (gestureInFlight) return false }
            return performGlobalAction(GLOBAL_ACTION_BACK)
        } finally {
            root.recycle()
        }
    }

    fun dispatchRemoteGesture(gesture: RemoteTouchGesture, onResult: (Boolean) -> Unit): Boolean {
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
                            onResult(true)
                        }
                        override fun onCancelled(gestureDescription: GestureDescription?) {
                            synchronized(this@AndroidTouchAccessibilityService) { gestureInFlight = false }
                            onResult(false)
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

    fun selectComposerTarget(
        sessionId: String,
        packageName: String,
        selection: NormalizedComposerSelection
    ): ComposerSelectionDecision {
        boundComposerTargetId = null
        if (boundSessionId != sessionId || boundPackageName != packageName) {
            return ComposerSelectionDecision(null, "session_or_app_mismatch")
        }
        if (!isServiceEnabled(this)) return ComposerSelectionDecision(null, "accessibility_service_not_enabled")
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null }
            ?: return ComposerSelectionDecision(null, "active_app_window_unavailable")
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) {
                return ComposerSelectionDecision(null, "selected_app_not_foreground")
            }
            val signer = AppIdentity.signingCertificateSha256(this, packageName)
                ?: return ComposerSelectionDecision(null, "app_signer_unavailable")
            val grant = AppGrantStore(this).get(packageName, signer)
                ?: return ComposerSelectionDecision(null, "app_not_locally_approved")
            if (!grant.allowDraftInsertion || !AppGrantPolicy.canLaunch(grant, signer)) {
                return ComposerSelectionDecision(null, "draft_insertion_not_locally_approved")
            }

            val rootBounds = Rect()
            root.getBoundsInScreen(rootBounds)
            val windowBounds = TouchWindowBounds(rootBounds.left, rootBounds.top, rootBounds.right, rootBounds.bottom)
            val selectedBounds = AndroidComposerTargetPolicy.mapRegion(selection, windowBounds)
                ?: return ComposerSelectionDecision(null, "invalid_selection_region")

            val candidates = mutableListOf<ComposerCandidate>()
            val traversal = intArrayOf(0, 0) // visited nodes, overflow flag
            collectComposerCandidates(root, packageName, candidates, traversal)
            if (traversal[1] != 0) return ComposerSelectionDecision(null, "accessibility_tree_too_large")
            val decision = AndroidComposerTargetPolicy.choose(candidates, packageName, selectedBounds)
            if (decision.candidate != null) boundComposerTargetId = decision.candidate.targetId
            return decision
        } finally {
            root.recycle()
        }
    }

    fun isSelectedComposerFocused(sessionId: String, packageName: String, targetId: String): Boolean {
        if (boundSessionId != sessionId || boundPackageName != packageName ||
            boundComposerTargetId != targetId || !isServiceEnabled(this)
        ) return false
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null } ?: return false
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) return false
            val signer = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
            val grant = AppGrantStore(this).get(packageName, signer) ?: return false
            if (!grant.allowDraftInsertion || !AppGrantPolicy.canLaunch(grant, signer)) return false
            val focused = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } catch (_: SecurityException) { null }
                ?: return false
            try {
                if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                    focused.isPassword || focused.packageName?.toString() != packageName
                ) return false
                val bounds = Rect()
                focused.getBoundsInScreen(bounds)
                if (bounds.isEmpty) return false
                return composerTargetId(focused, packageName) == targetId
            } finally {
                focused.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    fun clearSelectedComposer() {
        boundComposerTargetId = null
    }

    private fun collectComposerCandidates(
        node: AccessibilityNodeInfo,
        packageName: String,
        candidates: MutableList<ComposerCandidate>,
        traversal: IntArray
    ) {
        if (traversal[1] != 0) return
        traversal[0] += 1
        if (traversal[0] > MAX_COMPOSER_TREE_NODES) {
            traversal[1] = 1
            return
        }
        if (node.packageName?.toString() == packageName &&
            node.isEditable && node.isEnabled && node.isVisibleToUser && !node.isPassword
        ) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            if (!bounds.isEmpty) {
                candidates += ComposerCandidate(
                    targetId = composerTargetId(node, packageName),
                    packageName = packageName,
                    bounds = ComposerScreenRect(bounds.left, bounds.top, bounds.right, bounds.bottom),
                    editable = node.isEditable,
                    enabled = node.isEnabled,
                    visible = node.isVisibleToUser,
                    password = node.isPassword
                )
            }
        }
        for (index in 0 until node.childCount.coerceAtMost(MAX_COMPOSER_TREE_NODES)) {
            if (traversal[1] != 0) return
            val child = try { node.getChild(index) } catch (_: SecurityException) { null } ?: continue
            try {
                collectComposerCandidates(child, packageName, candidates, traversal)
            } finally {
                child.recycle()
            }
        }
    }

    /**
     * Bind a stable AccessibilityNodeInfo identity, not screen coordinates.
     * Coordinates change when the on-screen keyboard resizes the app window;
     * the platform node hash identifies the same source node across that layout
     * change. No text, hint, label or content description is read.
     */
    private fun composerTargetId(
        node: AccessibilityNodeInfo,
        packageName: String
    ): String {
        val identity = listOf(
            packageName,
            node.windowId.toString(),
            node.hashCode().toString(16),
            node.className?.toString().orEmpty(),
            node.viewIdResourceName.orEmpty()
        ).joinToString("|")
        return MessageDigest.getInstance("SHA-256")
            .digest(identity.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }

    private fun currentRootPackage(): String? =
        try { rootInActiveWindow?.let { root ->
            try { root.packageName?.toString() } finally { root.recycle() }
        } } catch (_: SecurityException) { null }

    companion object {
        @Volatile private var instance: AndroidTouchAccessibilityService? = null
        private const val MAX_COMPOSER_TREE_NODES = 160

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
            gesture: RemoteTouchGesture,
            onResult: (Boolean) -> Unit
        ): Boolean = instance?.dispatchRemoteGesture(gesture, onResult) == true

        fun performBack(sessionId: String, packageName: String): Boolean =
            instance?.dispatchRemoteBack(sessionId, packageName) == true

        fun clearActiveSession(sessionId: String? = null) {
            val current = instance ?: return
            if (sessionId == null || current.boundSessionId == sessionId) {
                current.boundSessionId = null
                current.boundPackageName = null
                current.boundComposerTargetId = null
            }
        }

        fun selectComposerTarget(
            sessionId: String,
            packageName: String,
            selection: NormalizedComposerSelection
        ): ComposerSelectionDecision = instance?.selectComposerTarget(sessionId, packageName, selection)
            ?: ComposerSelectionDecision(null, "accessibility_service_not_connected")

        fun isSelectedComposerFocused(sessionId: String, packageName: String, targetId: String): Boolean =
            instance?.isSelectedComposerFocused(sessionId, packageName, targetId) == true

        fun clearSelectedComposer() {
            instance?.clearSelectedComposer()
        }

        fun currentForegroundPackage(): String? = instance?.currentRootPackage()
    }
}
