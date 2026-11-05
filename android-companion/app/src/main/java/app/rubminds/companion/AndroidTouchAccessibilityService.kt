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
internal data class AndroidNativeWakeTargetIdentitySnapshot(
    val composerIdentityDigest: String,
    val sendControlIdentityDigest: String,
    val providerConversationIdentityDigest: String
)

class AndroidTouchAccessibilityService : AccessibilityService() {
    @Volatile private var boundSessionId: String? = null
    @Volatile private var boundPackageName: String? = null
    @Volatile private var gestureInFlight = false
    @Volatile private var boundComposerTargetId: String? = null
    @Volatile private var boundSendTargetId: String? = null
    @Volatile private var boundProviderConversationIdentityDigest: String? = null
    // Mutated and read under this service's monitor. It invalidates queued native
    // wake work when the selected session or composer binding is replaced/revoked.
    private var nativeBindingGeneration: Long = 0L
    @Volatile private var nativeWakeInFlight = false

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
        synchronized(this) {
            nativeBindingGeneration++
            boundSessionId = null
            boundPackageName = null
            boundComposerTargetId = null
            boundSendTargetId = null
            boundProviderConversationIdentityDigest = null
            nativeWakeInFlight = false
            gestureInFlight = false
        }
        // Accessibility is optional. Interrupting/removing it revokes local touch
        // and all native-wake bindings, but must not terminate a user-consented
        // view-only MediaProjection session.
        AndroidScreenShareService.revokeLocalTouch(applicationContext)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        synchronized(this) {
            nativeBindingGeneration++
            boundSessionId = null
            boundPackageName = null
            boundComposerTargetId = null
            boundSendTargetId = null
            boundProviderConversationIdentityDigest = null
            nativeWakeInFlight = false
            gestureInFlight = false
        }
        AndroidScreenShareService.revokeLocalTouch(applicationContext)
        super.onDestroy()
    }

    fun bindSession(sessionId: String, packageName: String): Boolean {
        if (currentRootPackage() != packageName) return false
        val digest = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
        if (AppGrantStore(this).get(packageName, digest) == null) return false
        synchronized(this) {
            // A session rebind invalidates any already queued native wake work.
            if (currentRootPackage() != packageName) return false
            nativeBindingGeneration++
            boundSessionId = sessionId
            boundPackageName = packageName
            boundComposerTargetId = null
            boundSendTargetId = null
            boundProviderConversationIdentityDigest = null
        }
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

    private fun canSelectComposerForApp(packageName: String, signer: String): Boolean {
        val grant = AppGrantStore(this).get(packageName, signer)
        val deviceId = DeviceCredentialVault(this).deviceId()
        val nativeWakeConsent = deviceId != null &&
            AndroidNativeWakeConsentStore(this).activeGrant(deviceId, packageName, signer) != null
        return AppGrantPolicy.canSelectComposerTarget(grant, signer, nativeWakeConsent)
    }

    fun selectComposerTarget(
        sessionId: String,
        packageName: String,
        selection: NormalizedComposerSelection
    ): ComposerSelectionDecision {
        val selectionGeneration = synchronized(this) {
            if (boundSessionId != sessionId || boundPackageName != packageName) {
                return ComposerSelectionDecision(null, "session_or_app_mismatch")
            }
            nativeBindingGeneration++
            boundComposerTargetId = null
            boundSendTargetId = null
            boundProviderConversationIdentityDigest = null
            nativeBindingGeneration
        }
        if (!isServiceEnabled(this)) return ComposerSelectionDecision(null, "accessibility_service_not_enabled")
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null }
            ?: return ComposerSelectionDecision(null, "active_app_window_unavailable")
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) {
                return ComposerSelectionDecision(null, "selected_app_not_foreground")
            }
            val providerConversationDigest = ProviderConversationIdentityResolver.resolve(packageName, root)
            val signer = AppIdentity.signingCertificateSha256(this, packageName)
                ?: return ComposerSelectionDecision(null, "app_signer_unavailable")
            if (!canSelectComposerForApp(packageName, signer)) {
                return ComposerSelectionDecision(null, "composer_selection_not_locally_approved")
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
            val selected = decision.candidate ?: return decision

            // Inspect the Send control locally. Do not publish its labels or node identity.
            val sendCandidates = mutableListOf<SendControlCandidate>()
            val sendTraversal = intArrayOf(0, 0)
            collectSendControlCandidates(root, packageName, sendCandidates, sendTraversal)
            if (sendTraversal[1] != 0) {
                val committed = synchronized(this) {
                    if (nativeBindingGeneration != selectionGeneration ||
                        boundSessionId != sessionId || boundPackageName != packageName
                    ) {
                        false
                    } else {
                        // Keep the verified composer available for ordinary draft
                        // insertion. Native wake remains unavailable without a
                        // complete, unique Send-control scan.
                        boundComposerTargetId = selected.targetId
                        boundSendTargetId = null
                        boundProviderConversationIdentityDigest = providerConversationDigest
                        true
                    }
                }
                if (!committed) return ComposerSelectionDecision(null, "session_or_selection_changed")
                val selectedProviderDigest = providerConversationDigest.takeIf {
                    ProviderConversationIdentityPolicy.isValidDigest(it)
                }
                return ComposerSelectionDecision(
                    selected,
                    "selected",
                    null,
                    "accessibility_tree_too_large",
                    selectedProviderDigest != null,
                    selectedProviderDigest
                )
            }
            val sendDecision = AndroidSendControlPolicy.choose(
                sendCandidates,
                packageName,
                ComposerScreenRect(rootBounds.left, rootBounds.top, rootBounds.right, rootBounds.bottom),
                selected.bounds
            )
            synchronized(this) {
                // A stop, rebind, clear or newer drag while the accessibility tree
                // was being inspected invalidates this selection result.
                if (nativeBindingGeneration != selectionGeneration ||
                    boundSessionId != sessionId || boundPackageName != packageName
                ) {
                    return ComposerSelectionDecision(null, "session_or_selection_changed")
                }
                boundComposerTargetId = selected.targetId
                boundSendTargetId = sendDecision.candidate?.targetId
                boundProviderConversationIdentityDigest = providerConversationDigest
            }
            val selectedProviderDigest = providerConversationDigest.takeIf {
                ProviderConversationIdentityPolicy.isValidDigest(it)
            }
            return ComposerSelectionDecision(
                selected,
                "selected",
                sendDecision.candidate,
                sendDecision.reason,
                selectedProviderDigest != null,
                selectedProviderDigest
            )
        } finally {
            root.recycle()
        }
    }
    fun revalidateSelectedSendControl(
        sessionId: String,
        packageName: String,
        composerTargetId: String,
        sendTargetId: String
    ): SendControlDecision {
        if (boundSessionId != sessionId || boundPackageName != packageName ||
            boundComposerTargetId != composerTargetId || boundSendTargetId != sendTargetId ||
            !Regex("^[a-f0-9]{64}$").matches(composerTargetId) ||
            !Regex("^[a-f0-9]{64}$").matches(sendTargetId)
        ) return SendControlDecision(null, "selection_identity_changed")
        if (!isServiceEnabled(this)) return SendControlDecision(null, "accessibility_service_not_enabled")

        val root = try { rootInActiveWindow } catch (_: SecurityException) { null }
            ?: return SendControlDecision(null, "active_app_window_unavailable")
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) {
                return SendControlDecision(null, "selected_app_not_foreground")
            }
            val signer = AppIdentity.signingCertificateSha256(this, packageName)
                ?: return SendControlDecision(null, "app_signer_unavailable")
            if (!canSelectComposerForApp(packageName, signer)) {
                return SendControlDecision(null, "composer_selection_not_locally_approved")
            }

            val focused = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                catch (_: SecurityException) { null }
                ?: return SendControlDecision(null, "selected_composer_not_focused")
            val focusedBounds = try {
                if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                    focused.isPassword || focused.packageName?.toString() != packageName ||
                    composerTargetId(focused, packageName) != composerTargetId
                ) return SendControlDecision(null, "selected_composer_changed")
                val bounds = Rect()
                focused.getBoundsInScreen(bounds)
                if (bounds.isEmpty) return SendControlDecision(null, "selected_composer_bounds_unavailable")
                ComposerScreenRect(bounds.left, bounds.top, bounds.right, bounds.bottom)
            } finally {
                focused.recycle()
            }

            val rootBounds = Rect()
            root.getBoundsInScreen(rootBounds)
            val candidates = mutableListOf<SendControlCandidate>()
            val traversal = intArrayOf(0, 0)
            collectSendControlCandidates(root, packageName, candidates, traversal)
            if (traversal[1] != 0) {
                return SendControlDecision(null, "accessibility_tree_too_large")
            }
            val current = AndroidSendControlPolicy.choose(
                candidates,
                packageName,
                ComposerScreenRect(rootBounds.left, rootBounds.top, rootBounds.right, rootBounds.bottom),
                focusedBounds
            )
            if (current.candidate?.targetId != sendTargetId) {
                return SendControlDecision(null,
                    if (current.candidate == null) current.reason else "send_control_identity_changed")
            }
            val currentProviderDigest = ProviderConversationIdentityResolver.resolve(packageName, root)
            val sameBoundConversation = ProviderConversationIdentityPolicy.matches(
                boundProviderConversationIdentityDigest, currentProviderDigest
            )
            return SendControlDecision(
                current.candidate,
                current.reason,
                currentProviderDigest.takeIf { sameBoundConversation }
            )
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
        synchronized(this) {
            nativeBindingGeneration++
            boundComposerTargetId = null
            boundSendTargetId = null
            boundProviderConversationIdentityDigest = null
        }
    }

    /**
     * Device-local native submit path. It accepts only an event ID and the
     * opaque identities created by the local drag selection; no caller text
     * or Send label crosses this API. It is intentionally NOT called from the
     * WebRTC remote_text handler or from a browser/WebView command.
     */
    private fun currentProviderConversationIdentityDigest(packageName: String): String? {
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null } ?: return null
        return try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) null
            else ProviderConversationIdentityResolver.resolve(packageName, root)
        } finally {
            root.recycle()
        }
    }

    /**
     * Local-only snapshot for the device-bearer registration request. The raw
     * provider conversation ID never leaves this service; callers receive only
     * the three SHA-256 digests, after a fresh foreground-root comparison.
     */
    fun nativeWakeTargetIdentitySnapshot(
        sessionId: String,
        packageName: String
    ): AndroidNativeWakeTargetIdentitySnapshot? {
        val selected = synchronized(this) {
            if (!isServiceEnabled(this) ||
                boundSessionId != sessionId ||
                boundPackageName != packageName
            ) return@synchronized null
            val composer = boundComposerTargetId
            val send = boundSendTargetId
            val provider = boundProviderConversationIdentityDigest
            if (!ProviderConversationIdentityPolicy.isValidDigest(composer) ||
                !ProviderConversationIdentityPolicy.isValidDigest(send) ||
                !ProviderConversationIdentityPolicy.isValidDigest(provider)
            ) return@synchronized null
            AndroidNativeWakeTargetIdentitySnapshot(composer!!, send!!, provider!!)
        } ?: return null
        val currentProvider = currentProviderConversationIdentityDigest(packageName)
        if (!ProviderConversationIdentityPolicy.matches(selected.providerConversationIdentityDigest, currentProvider)) {
            return null
        }
        return selected
    }

    fun isBoundToProviderConversation(
        sessionId: String,
        packageName: String,
        providerConversationIdentityDigest: String
    ): Boolean = synchronized(this) {
        boundSessionId == sessionId && boundPackageName == packageName &&
            ProviderConversationIdentityPolicy.matches(
                providerConversationIdentityDigest, boundProviderConversationIdentityDigest
            ) && ProviderConversationIdentityPolicy.matches(
                providerConversationIdentityDigest, currentProviderConversationIdentityDigest(packageName)
            )
    }

    fun submitCanonicalWake(
        request: NativeWakeExecutionRequest,
        onResult: (NativeWakeSubmissionResult) -> Unit
    ): Boolean {
        val bindingGenerationAtStart = synchronized(this) {
            if (boundSessionId != request.sessionId || boundPackageName != request.packageName ||
                !UUID_PATTERN.matches(request.deviceId) ||
                !UUID_PATTERN.matches(request.sessionId) ||
                request.handoffExpiresAtMillis <= System.currentTimeMillis() ||
                boundComposerTargetId != request.composerTargetId ||
                boundSendTargetId != request.sendTargetId ||
                !ProviderConversationIdentityPolicy.isValidDigest(request.providerConversationIdentityDigest) ||
                !ProviderConversationIdentityPolicy.matches(
                    request.providerConversationIdentityDigest, boundProviderConversationIdentityDigest
                ) ||
                nativeWakeInFlight
            ) return false
            nativeWakeInFlight = true
            nativeBindingGeneration
        }
        val handler = Handler(Looper.getMainLooper())
        val posted = handler.post {
            var promptInserted = false
            var sendInvoked = false
            var composerCleared = false
            var promptReadbackVerified = false
            var composerIdentityRevalidated = false
            var sendControlIdentityRevalidated = false
            var providerConversationIdentityRevalidated = false

            fun finish(state: NativeWakeSubmissionState, reason: String) {
                synchronized(this) { nativeWakeInFlight = false }
                runCatching {
                    onResult(NativeWakeSubmissionResult(
                        state = state,
                        reason = reason,
                        promptInserted = promptInserted,
                        sendInvoked = sendInvoked,
                        composerCleared = composerCleared,
                        promptReadbackVerified = promptReadbackVerified,
                        composerIdentityRevalidated = composerIdentityRevalidated,
                        sendControlIdentityRevalidated = sendControlIdentityRevalidated,
                        providerConversationIdentityRevalidated = providerConversationIdentityRevalidated,
                        providerConversationIdentityDigest = if (providerConversationIdentityRevalidated)
                            request.providerConversationIdentityDigest else null,
                        composerIdentityDigest = if (composerIdentityRevalidated) request.composerTargetId else null,
                        sendControlIdentityDigest = if (sendControlIdentityRevalidated) request.sendTargetId else null
                    ))
                }
            }

            val bindingCurrentAtExecution = synchronized(this) {
                NativeWakeBindingPolicy.isCurrent(
                    bindingGenerationAtStart, nativeBindingGeneration,
                    request.sessionId, boundSessionId,
                    request.packageName, boundPackageName,
                    request.composerTargetId, boundComposerTargetId,
                    request.sendTargetId, boundSendTargetId,
                    request.providerConversationIdentityDigest, boundProviderConversationIdentityDigest
                )
            }
            if (request.handoffExpiresAtMillis <= System.currentTimeMillis()) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "native_wake_handoff_expired_before_execution")
                return@post
            }
            if (!bindingCurrentAtExecution || !isServiceEnabled(this)) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "native_session_or_accessibility_unavailable")
                return@post
            }
            val root = try { rootInActiveWindow } catch (_: SecurityException) { null }
            if (root == null) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "active_app_window_unavailable")
                return@post
            }
            val preflight = try {
                if (!root.isVisibleToUser || root.packageName?.toString() != request.packageName) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_app_not_foreground")
                    return@post
                }
                if (!ProviderConversationIdentityPolicy.matches(
                        request.providerConversationIdentityDigest,
                        ProviderConversationIdentityResolver.resolve(request.packageName, root)
                    )
                ) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "provider_conversation_identity_unavailable_or_changed")
                    return@post
                }
                val signer = AppIdentity.signingCertificateSha256(this, request.packageName)
                val grant = signer?.let { AppGrantStore(this).get(request.packageName, it) }
                if (signer != request.signingCertificateSha256 ||
                    !AppGrantPolicy.canLaunch(grant, signer)
                ) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "app_or_signer_not_locally_approved")
                    return@post
                }
                if (!isSelectedComposerEmpty(request.sessionId, request.packageName, request.composerTargetId)) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_composer_not_empty_or_changed")
                    return@post
                }

                val focused = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                    catch (_: SecurityException) { null }
                    ?: run {
                        finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_composer_not_focused")
                        return@post
                    }
                val composerBounds = try {
                    if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                        focused.isPassword || focused.packageName?.toString() != request.packageName ||
                        composerTargetId(focused, request.packageName) != request.composerTargetId
                    ) {
                        finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_composer_changed")
                        return@post
                    }
                    val bounds = Rect()
                    focused.getBoundsInScreen(bounds)
                    if (bounds.isEmpty) {
                        finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_composer_bounds_unavailable")
                        return@post
                    }
                    ComposerScreenRect(bounds.left, bounds.top, bounds.right, bounds.bottom)
                } finally {
                    focused.recycle()
                }

                val rootBounds = Rect()
                root.getBoundsInScreen(rootBounds)
                val candidates = mutableListOf<SendControlCandidate>()
                val traversal = intArrayOf(0, 0)
                collectSendControlCandidates(root, request.packageName, candidates, traversal)
                if (traversal[1] != 0) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "accessibility_tree_too_large")
                    return@post
                }
                val decision = AndroidSendControlPolicy.choose(
                    candidates,
                    request.packageName,
                    ComposerScreenRect(rootBounds.left, rootBounds.top, rootBounds.right, rootBounds.bottom),
                    composerBounds
                )
                if (decision.candidate?.targetId != request.sendTargetId) {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_send_control_changed")
                    return@post
                }
                decision.candidate
            } finally {
                root.recycle()
            }

            if (!DraftInputMethodService.isEnabledAndSelected(this)) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "rub_minds_keyboard_not_selected")
                return@post
            }
            if (preflight == null) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "selected_send_control_unavailable")
                return@post
            }

            val insertion = synchronized(this) {
                if (!NativeWakeBindingPolicy.isCurrent(
                        bindingGenerationAtStart, nativeBindingGeneration,
                        request.sessionId, boundSessionId,
                        request.packageName, boundPackageName,
                        request.composerTargetId, boundComposerTargetId,
                        request.sendTargetId, boundSendTargetId,
                        request.providerConversationIdentityDigest, boundProviderConversationIdentityDigest
                    ) || !ProviderConversationIdentityPolicy.matches(
                        request.providerConversationIdentityDigest,
                        currentProviderConversationIdentityDigest(request.packageName)
                    )
                ) {
                    null
                } else {
                    DraftInputMethodService.insertNativeWakeTrigger(request)
                }
            }
            if (insertion == null) {
                finish(NativeWakeSubmissionState.PRECHECK_DENIED, "native_session_or_selection_changed_before_insert")
                return@post
            }
            when (insertion.state) {
                NativeWakeInsertState.PRECHECK_DENIED -> {
                    finish(NativeWakeSubmissionState.PRECHECK_DENIED, insertion.reason)
                    return@post
                }
                NativeWakeInsertState.NEEDS_REVIEW -> {
                    finish(NativeWakeSubmissionState.NEEDS_REVIEW, insertion.reason)
                    return@post
                }
                NativeWakeInsertState.INSERTED -> {
                    promptInserted = true
                }
            }

            val prompt = NativeWakeConsentPolicy.canonicalWakePrompt(request.eventId)
            if (prompt == null || !isSelectedComposerText(request.sessionId, request.packageName,
                    request.composerTargetId, prompt)
            ) {
                finish(NativeWakeSubmissionState.NEEDS_REVIEW, "canonical_trigger_readback_unconfirmed")
                return@post
            }
            promptReadbackVerified = true

            // Insertion may resize the keyboard/window. Re-identify both the
            // same composer and the same unique Send control after the seal.
            val finalSend = revalidateSelectedSendControl(
                request.sessionId, request.packageName,
                request.composerTargetId, request.sendTargetId
            )
            if (finalSend.candidate?.targetId != request.sendTargetId ||
                !isSelectedComposerText(request.sessionId, request.packageName,
                    request.composerTargetId, prompt)
            ) {
                finish(NativeWakeSubmissionState.NEEDS_REVIEW, "post_insert_native_target_revalidation_failed")
                return@post
            }
            composerIdentityRevalidated = true
            sendControlIdentityRevalidated = true

            val sendRoot = try { rootInActiveWindow } catch (_: SecurityException) { null }
            if (sendRoot == null || !isServiceEnabled(this) ||
                sendRoot.packageName?.toString() != request.packageName || !sendRoot.isVisibleToUser
            ) {
                sendRoot?.recycle()
                finish(NativeWakeSubmissionState.NEEDS_REVIEW, "foreground_changed_after_trigger_insert")
                return@post
            }

            // Composer, Send candidate, and the exact node to invoke are all
            // resolved from this same fresh accessibility-root snapshot.
            var sendNode: AccessibilityNodeInfo? = null
            try {
                val focused = try { sendRoot.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                    catch (_: SecurityException) { null }
                    ?: run {
                        finish(NativeWakeSubmissionState.NEEDS_REVIEW, "composer_focus_lost_before_send")
                        return@post
                    }
                val composerBounds = try {
                    if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                        focused.isPassword || focused.packageName?.toString() != request.packageName ||
                        composerTargetId(focused, request.packageName) != request.composerTargetId ||
                        focused.text?.toString() != prompt
                    ) {
                        finish(NativeWakeSubmissionState.NEEDS_REVIEW, "composer_identity_or_prompt_changed_before_send")
                        return@post
                    }
                    val bounds = Rect()
                    focused.getBoundsInScreen(bounds)
                    if (bounds.isEmpty) {
                        finish(NativeWakeSubmissionState.NEEDS_REVIEW, "composer_bounds_lost_before_send")
                        return@post
                    }
                    ComposerScreenRect(bounds.left, bounds.top, bounds.right, bounds.bottom)
                } finally {
                    focused.recycle()
                }
                val rootBounds = Rect()
                sendRoot.getBoundsInScreen(rootBounds)
                val candidates = mutableListOf<SendControlCandidate>()
                val traversal = intArrayOf(0, 0)
                collectSendControlCandidates(sendRoot, request.packageName, candidates, traversal)
                if (traversal[1] != 0) {
                    finish(NativeWakeSubmissionState.NEEDS_REVIEW, "accessibility_tree_changed_before_send")
                    return@post
                }
                val currentSend = AndroidSendControlPolicy.choose(
                    candidates,
                    request.packageName,
                    ComposerScreenRect(rootBounds.left, rootBounds.top, rootBounds.right, rootBounds.bottom),
                    composerBounds
                )
                if (currentSend.candidate?.targetId != request.sendTargetId) {
                    finish(NativeWakeSubmissionState.NEEDS_REVIEW, "same_unique_send_control_not_present_before_click")
                    return@post
                }
                sendNode = findNodeByTargetId(sendRoot, request.packageName, request.sendTargetId)
            } finally {
                sendRoot.recycle()
            }
            val exactSendNode = sendNode
            if (exactSendNode == null) {
                finish(NativeWakeSubmissionState.NEEDS_REVIEW, "same_send_control_node_not_found_after_insert")
                return@post
            }
            val invoked = try {
                synchronized(this) {
                    if (!NativeWakeBindingPolicy.isCurrent(
                            bindingGenerationAtStart, nativeBindingGeneration,
                            request.sessionId, boundSessionId,
                            request.packageName, boundPackageName,
                            request.composerTargetId, boundComposerTargetId,
                            request.sendTargetId, boundSendTargetId,
                            request.providerConversationIdentityDigest, boundProviderConversationIdentityDigest
                        ) || currentRootPackage() != request.packageName ||
                        !ProviderConversationIdentityPolicy.matches(
                            request.providerConversationIdentityDigest,
                            currentProviderConversationIdentityDigest(request.packageName)
                        ) ||
                        !exactSendNode.refresh() || exactSendNode.packageName?.toString() != request.packageName ||
                        !exactSendNode.isClickable || !exactSendNode.isEnabled || !exactSendNode.isVisibleToUser ||
                        composerTargetId(exactSendNode, request.packageName) != request.sendTargetId ||
                        exactSendNode.actionList.none { it.id == AccessibilityNodeInfo.ACTION_CLICK }
                    ) {
                        false
                    } else {
                        val textLabel = exactSendNode.text?.toString().orEmpty()
                        val descriptionLabel = exactSendNode.contentDescription?.toString().orEmpty()
                        val recognizedLabel = AndroidSendControlPolicy.isRecognizedLabel(textLabel) ||
                            AndroidSendControlPolicy.isRecognizedLabel(descriptionLabel)
                        val fallbackResource = textLabel.isBlank() && descriptionLabel.isBlank() &&
                            AndroidSendControlPolicy.isRecognizedResourceId(exactSendNode.viewIdResourceName.orEmpty())
                        if (recognizedLabel || fallbackResource) {
                            sendControlIdentityRevalidated = true
                            // Session/selection invalidation uses this same monitor.
                            // The deadline is checked immediately before the only
                            // native Send side effect.
                            if (request.handoffExpiresAtMillis <= System.currentTimeMillis()) false
                            else exactSendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        } else false
                    }
                }
            } catch (_: SecurityException) {
                false
            } finally {
                exactSendNode.recycle()
            }
            if (!invoked) {
                finish(
                    NativeWakeSubmissionState.NEEDS_REVIEW,
                    if (request.handoffExpiresAtMillis <= System.currentTimeMillis())
                        "native_wake_handoff_expired_after_seal"
                    else "native_send_action_unconfirmed"
                )
                return@post
            }
            sendInvoked = true
            awaitComposerClear(
                handler = handler,
                request = request,
                bindingGenerationAtStart = bindingGenerationAtStart,
                deadlineMillis = android.os.SystemClock.elapsedRealtime() + NATIVE_WAKE_CLEAR_TIMEOUT_MS,
                onComplete = { cleared ->
                    composerCleared = cleared
                    providerConversationIdentityRevalidated = cleared
                    finish(
                        if (cleared) NativeWakeSubmissionState.SUBMITTED else NativeWakeSubmissionState.NEEDS_REVIEW,
                        if (cleared) "canonical_trigger_sent_composer_cleared" else "send_outcome_needs_review"
                    )
                }
            )
        }
        if (!posted) {
            synchronized(this) { nativeWakeInFlight = false }
            return false
        }
        return true
    }

    private fun awaitComposerClear(
        handler: Handler,
        request: NativeWakeExecutionRequest,
        bindingGenerationAtStart: Long,
        deadlineMillis: Long,
        onComplete: (Boolean) -> Unit
    ) {
        handler.postDelayed({
            val bindingStillCurrent = synchronized(this@AndroidTouchAccessibilityService) {
                NativeWakeBindingPolicy.isCurrent(
                    bindingGenerationAtStart, nativeBindingGeneration,
                    request.sessionId, boundSessionId,
                    request.packageName, boundPackageName,
                    request.composerTargetId, boundComposerTargetId,
                    request.sendTargetId, boundSendTargetId,
                    request.providerConversationIdentityDigest, boundProviderConversationIdentityDigest
                )
            }
            if (!bindingStillCurrent ||
                !ProviderConversationIdentityPolicy.matches(
                    request.providerConversationIdentityDigest,
                    currentProviderConversationIdentityDigest(request.packageName)
                ) ||
                !isServiceEnabled(this@AndroidTouchAccessibilityService) ||
                currentRootPackage() != request.packageName
            ) {
                onComplete(false)
                return@postDelayed
            }
            val root = try { rootInActiveWindow } catch (_: SecurityException) { null }
            if (root == null) {
                if (android.os.SystemClock.elapsedRealtime() >= deadlineMillis) onComplete(false)
                else awaitComposerClear(handler, request, bindingGenerationAtStart, deadlineMillis, onComplete)
                return@postDelayed
            }
            val cleared = try {
                val composer = findNodeByTargetId(root, request.packageName, request.composerTargetId)
                if (composer == null) {
                    false
                } else try {
                    composer.isEditable && composer.isEnabled && composer.isVisibleToUser &&
                        composer.packageName?.toString() == request.packageName &&
                        composerTargetId(composer, request.packageName) == request.composerTargetId &&
                        composer.text?.toString() == ""
                } finally {
                    composer.recycle()
                }
            } finally {
                root.recycle()
            }
            if (cleared) {
                onComplete(true)
            } else if (android.os.SystemClock.elapsedRealtime() >= deadlineMillis) {
                onComplete(false)
            } else {
                awaitComposerClear(handler, request, bindingGenerationAtStart, deadlineMillis, onComplete)
            }
        }, NATIVE_WAKE_CLEAR_POLL_MS)
    }

    private fun findNodeByTargetId(
        root: AccessibilityNodeInfo,
        packageName: String,
        targetId: String
    ): AccessibilityNodeInfo? {
        var visited = 0
        fun search(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            visited += 1
            if (visited > MAX_COMPOSER_TREE_NODES) return null
            if (node.packageName?.toString() == packageName &&
                composerTargetId(node, packageName) == targetId
            ) return AccessibilityNodeInfo.obtain(node)
            for (index in 0 until node.childCount.coerceAtMost(MAX_COMPOSER_TREE_NODES)) {
                val child = try { node.getChild(index) } catch (_: SecurityException) { null } ?: continue
                val found = try { search(child) } finally { child.recycle() }
                if (found != null) return found
            }
            return null
        }
        return search(root)
    }

    fun isSelectedComposerEmpty(sessionId: String, packageName: String, targetId: String): Boolean {
        if (boundSessionId != sessionId || boundPackageName != packageName ||
            boundComposerTargetId != targetId || !isServiceEnabled(this)
        ) return false
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null } ?: return false
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) return false
            val focused = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                catch (_: SecurityException) { null } ?: return false
            try {
                if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                    focused.isPassword || focused.packageName?.toString() != packageName ||
                    composerTargetId(focused, packageName) != targetId
                ) return false
                // Empty must be explicit. A null/unreadable value is not treated
                // as empty; no editor content is transmitted off this device.
                return focused.text?.toString() == ""
            } finally {
                focused.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    fun isSelectedComposerText(
        sessionId: String,
        packageName: String,
        targetId: String,
        expectedText: String
    ): Boolean {
        if (boundSessionId != sessionId || boundPackageName != packageName ||
            boundComposerTargetId != targetId || !isServiceEnabled(this)
        ) return false
        val root = try { rootInActiveWindow } catch (_: SecurityException) { null } ?: return false
        try {
            if (!root.isVisibleToUser || root.packageName?.toString() != packageName) return false
            val focused = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                catch (_: SecurityException) { null } ?: return false
            try {
                if (!focused.isEditable || !focused.isEnabled || !focused.isVisibleToUser ||
                    focused.isPassword || focused.packageName?.toString() != packageName ||
                    composerTargetId(focused, packageName) != targetId
                ) return false
                return focused.text?.toString() == expectedText
            } finally {
                focused.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    private fun collectSendControlCandidates(
        node: AccessibilityNodeInfo,
        packageName: String,
        candidates: MutableList<SendControlCandidate>,
        traversal: IntArray
    ) {
        if (traversal[1] != 0) return
        traversal[0] += 1
        if (traversal[0] > MAX_COMPOSER_TREE_NODES) {
            traversal[1] = 1
            return
        }
        if (node.packageName?.toString() == packageName &&
            node.isClickable && node.isEnabled && node.isVisibleToUser
        ) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            val clickActionAvailable = try {
                node.actionList.any { action -> action.id == AccessibilityNodeInfo.ACTION_CLICK }
            } catch (_: SecurityException) {
                false
            }
            if (!bounds.isEmpty && clickActionAvailable) {
                val textLabel = node.text?.toString().orEmpty().take(120)
                val descriptionLabel = node.contentDescription?.toString().orEmpty().take(120)
                val label = when {
                    AndroidSendControlPolicy.isRecognizedLabel(textLabel) -> textLabel
                    AndroidSendControlPolicy.isRecognizedLabel(descriptionLabel) -> descriptionLabel
                    textLabel.isNotBlank() -> textLabel
                    else -> descriptionLabel
                }
                candidates += SendControlCandidate(
                    targetId = composerTargetId(node, packageName),
                    packageName = packageName,
                    bounds = ComposerScreenRect(bounds.left, bounds.top, bounds.right, bounds.bottom),
                    label = label,
                    resourceId = node.viewIdResourceName.orEmpty(),
                    clickable = node.isClickable,
                    enabled = node.isEnabled,
                    visible = node.isVisibleToUser
                )
            }
        }
        for (index in 0 until node.childCount.coerceAtMost(MAX_COMPOSER_TREE_NODES)) {
            if (traversal[1] != 0) return
            val child = try { node.getChild(index) } catch (_: SecurityException) { null } ?: continue
            try {
                collectSendControlCandidates(child, packageName, candidates, traversal)
            } finally {
                child.recycle()
            }
        }
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
        private const val NATIVE_WAKE_CLEAR_TIMEOUT_MS = 8_000L
        private const val NATIVE_WAKE_CLEAR_POLL_MS = 250L

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
            synchronized(current) {
                if (sessionId == null || current.boundSessionId == sessionId) {
                    current.nativeBindingGeneration++
                    current.boundSessionId = null
                    current.boundPackageName = null
                    current.boundComposerTargetId = null
                    current.boundSendTargetId = null
                    current.boundProviderConversationIdentityDigest = null
                }
            }
        }

        fun selectComposerTarget(
            sessionId: String,
            packageName: String,
            selection: NormalizedComposerSelection
        ): ComposerSelectionDecision = instance?.selectComposerTarget(sessionId, packageName, selection)
            ?: ComposerSelectionDecision(null, "accessibility_service_not_connected")

        fun revalidateSelectedSendControl(
            sessionId: String,
            packageName: String,
            composerTargetId: String,
            sendTargetId: String
        ): SendControlDecision = instance?.revalidateSelectedSendControl(
            sessionId, packageName, composerTargetId, sendTargetId
        ) ?: SendControlDecision(null, "accessibility_service_not_connected")

        fun isSelectedComposerFocused(sessionId: String, packageName: String, targetId: String): Boolean =
            instance?.isSelectedComposerFocused(sessionId, packageName, targetId) == true

        fun isSelectedComposerEmpty(sessionId: String, packageName: String, targetId: String): Boolean =
            instance?.isSelectedComposerEmpty(sessionId, packageName, targetId) == true

        fun isBoundToProviderConversation(
            sessionId: String,
            packageName: String,
            providerConversationIdentityDigest: String
        ): Boolean = instance?.isBoundToProviderConversation(
            sessionId, packageName, providerConversationIdentityDigest
        ) == true


        fun submitCanonicalWake(
            request: NativeWakeExecutionRequest,
            onResult: (NativeWakeSubmissionResult) -> Unit
        ): Boolean = instance?.submitCanonicalWake(request, onResult) == true

        fun clearSelectedComposer() {
            instance?.clearSelectedComposer()
        }

        fun currentForegroundPackage(): String? = instance?.currentRootPackage()
    }
}
