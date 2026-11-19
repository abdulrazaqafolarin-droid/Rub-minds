package app.rubminds.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Rect
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground MediaProjection/WebRTC sender. It accepts only short-lived device-queue
 * commands; the Android companion does not join a private Realtime channel as a fake user.
 */
class AndroidScreenShareService : Service() {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var api: CloudDeviceApi? = null
    private var deviceToken: String? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var eglBase: EglBase? = null
    private var peerFactory: PeerConnectionFactory? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    @Volatile private var peer: PeerConnection? = null
    @Volatile private var dataChannel: DataChannel? = null
    @Volatile private var activeSessionId: String? = null
    @Volatile private var activeAppPackage: String? = null
    @Volatile private var activeRoomId: String? = null
    @Volatile private var locallySelectedPackage: String? = null
    @Volatile private var localControlGranted = false
    @Volatile private var answeringSessionId: String? = null
    @Volatile private var answerAlreadySent = false
    private var projectionStartedAt = 0L
    private var pollingStarted = false
    @Volatile private var consecutivePollFailures = 0
    @Volatile private var capturedContentVisible = false
    @Volatile private var peerDisconnectToken = 0L
    @Volatile private var serverCloseSent = false
    @Volatile private var stopping = false

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture("local_stop")
                return START_NOT_STICKY
            }
            ACTION_START -> {
                if (pollingStarted) return START_NOT_STICKY
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    )
                } else {
                    startForeground(NOTIFICATION_ID, buildNotification())
                }
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
                if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
                    stopCapture("missing_projection_consent")
                    return START_NOT_STICKY
                }
                val targetPackage = intent.getStringExtra(EXTRA_TARGET_PACKAGE).orEmpty()
                startCapture(resultData, targetPackage)
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture(resultData: Intent, targetPackage: String) {
        try {
            require(AppGrantPolicy.isValidPackageName(targetPackage)) { "A locally selected app package is required." }
            val signer = AppIdentity.signingCertificateSha256(this, targetPackage)
                ?: error("The selected app signer could not be verified.")
            require(AppGrantStore(this).get(targetPackage, signer) != null) { "The selected app is not in the saved local allowlist." }
            locallySelectedPackage = targetPackage
            val vault = DeviceCredentialVault(this)
            deviceToken = vault.token() ?: error("Pair and obtain group-owner approval before streaming.")
            api = CloudDeviceApi()
            projectionStartedAt = System.currentTimeMillis()
            serverCloseSent = false
            stopping = false
            initializeWebRtc(resultData)
            consecutivePollFailures = 0
            pollingStarted = true
            executor.scheduleWithFixedDelay({ pollDeviceCommands() }, 0, POLL_INTERVAL_SECONDS, TimeUnit.SECONDS)
        } catch (error: Exception) {
            stopCapture(error.message ?: "screen_capture_start_failed")
        }
    }

    private fun initializeWebRtc(resultData: Intent) {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
        )
        val egl = EglBase.create()
        eglBase = egl
        val factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        peerFactory = factory

        val source = factory.createVideoSource(true)
        videoSource = source
        val helper = SurfaceTextureHelper.create("BackroomAndroidScreenCapture", egl.eglBaseContext)
        textureHelper = helper
        capturedContentVisible = true
        val screenCapturer = ScreenCapturerAndroid(resultData, object : MediaProjection.Callback() {
            override fun onStop() {
                stopCapture("android_projection_revoked")
            }

            override fun onCapturedContentResize(width: Int, height: Int) {
                if (width <= 0 || height <= 0) return
                val (captureWidth, captureHeight) = boundedCaptureSize(width, height)
                mainHandler.post {
                    val activeCapturer = capturer ?: return@post
                    if (!stopping) activeCapturer.changeCaptureFormat(captureWidth, captureHeight, CAPTURE_FPS)
                }
            }

            override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
                capturedContentVisible = isVisible
                mainHandler.post {
                    videoTrack?.setEnabled(isVisible && !stopping)
                    dataChannel?.let { sendAppVisibility(it, activeSessionId ?: return@post, isVisible) }
                }
            }
        })
        capturer = screenCapturer
        screenCapturer.initialize(helper, applicationContext, source.capturerObserver)
        val metrics = captureMetrics()
        screenCapturer.startCapture(metrics.widthPixels, metrics.heightPixels, CAPTURE_FPS)
        val track = factory.createVideoTrack("backroom-android-screen", source)
        track.setEnabled(capturedContentVisible)
        videoTrack = track
    }

    private fun captureMetrics(): DisplayMetrics {
        val metrics = resources.displayMetrics
        val (width, height) = boundedCaptureSize(metrics.widthPixels, metrics.heightPixels)
        return DisplayMetrics().apply {
            setTo(metrics)
            widthPixels = width
            heightPixels = height
        }
    }

    private fun boundedCaptureSize(width: Int, height: Int): Pair<Int, Int> {
        val safeWidth = width.coerceAtLeast(2)
        val safeHeight = height.coerceAtLeast(2)
        val scale = minOf(1f, MAX_CAPTURE_DIMENSION.toFloat() / maxOf(safeWidth, safeHeight))
        var outWidth = (safeWidth * scale).toInt().coerceAtLeast(2)
        var outHeight = (safeHeight * scale).toInt().coerceAtLeast(2)
        // Keep H.264-friendly even dimensions and never exceed the selected app bounds.
        outWidth -= outWidth % 2
        outHeight -= outHeight % 2
        return outWidth.coerceAtLeast(2) to outHeight.coerceAtLeast(2)
    }

    private fun pollDeviceCommands() {
        val token = deviceToken ?: return stopCapture("device_credential_missing")
        try {
            // Replay saved result receipts first, independently of command polling.
            // This makes ACK recovery progress even when command retrieval fails.
            val nativeAckCommandIds = retryPendingNativeWakeAcknowledgements(token)
            val pollFields = JSONObject()
            val sessionId = activeSessionId
            val roomId = activeRoomId
            if (sessionId != null && roomId != null) {
                pollFields.put("sessionId", sessionId)
                pollFields.put("roomId", roomId)
            }
            val result = api?.post("android/commands", token, pollFields)
                ?: throw IllegalStateException("Cloud command response missing.")
            consecutivePollFailures = 0
            val stopSessions = result.optJSONArray("stopSessionIds")
            if (stopSessions != null && (0 until stopSessions.length()).any { stopSessions.optString(it) == activeSessionId }) {
                stopCapture("device_room_binding_revoked")
                return
            }
            val commands = result.optJSONArray("commands") ?: return
            for (index in 0 until commands.length()) {
                if (stopping) break
                val command = commands.optJSONObject(index) ?: continue
                if (command.optString("action") == "native_wake_trigger" &&
                    (nativeAckCommandIds == null || command.optString("commandId") in nativeAckCommandIds)
                ) continue
                processCommand(token, command)
            }
            if (System.currentTimeMillis() - projectionStartedAt > MAX_WAIT_WITHOUT_SESSION_MS &&
                activeSessionId == null
            ) stopCapture("stream_request_timeout")
        } catch (error: CloudDeviceApiException) {
            when {
                error.statusCode == 401 || error.statusCode == 403 ->
                    stopCapture("device_access_revoked")
                error.statusCode in 400..499 && error.statusCode != 429 ->
                    stopCapture("device_command_poll_rejected")
                else -> {
                    consecutivePollFailures += 1
                    if (consecutivePollFailures >= MAX_POLL_FAILURES) {
                        stopCapture("device_cloud_heartbeat_lost")
                    }
                }
            }
        } catch (_: Exception) {
            // Bound an offline device session: do not keep capturing indefinitely after
            // losing the server heartbeat that proves the group/device grant is current.
            consecutivePollFailures += 1
            if (consecutivePollFailures >= MAX_POLL_FAILURES) stopCapture("device_cloud_heartbeat_lost")
        }
    }

    private fun processNativeWakeTrigger(
        token: String,
        commandId: String,
        requestId: String,
        screenSessionId: String,
        appPackage: String,
        roomId: String,
        command: JSONObject
    ) {
        if (!UUID_PATTERN.matches(commandId) || !UUID_PATTERN.matches(requestId) ||
            !UUID_PATTERN.matches(screenSessionId) || !UUID_PATTERN.matches(roomId)
        ) return

        val deviceId = DeviceCredentialVault(this).deviceId()
        val signer = if (AppGrantPolicy.isValidPackageName(appPackage))
            AppIdentity.signingCertificateSha256(this, appPackage) else null
        val handoff = if (deviceId != null && signer != null) {
            AndroidNativeWakeHandoffPolicy.validate(
                command = command,
                expectedDeviceId = deviceId,
                expectedRoomId = roomId,
                expectedScreenSessionId = screenSessionId,
                expectedPackageName = appPackage,
                expectedSignerSha256 = signer
            )
        } else null

        if (handoff == null || activeSessionId != screenSessionId ||
            activeRoomId != roomId || activeAppPackage != appPackage ||
            AndroidTouchAccessibilityService.currentForegroundPackage() != appPackage
        ) {
            // Invalid/stale handoffs are deliberately not converted into remote
            // typing or a WebRTC message. The command expires if its exact live
            // device/session scope cannot be established.
            return
        }

        val ackStore = AndroidNativeWakeConsentStore(this)
        val pendingAcks = ackStore.pendingNativeWakeAcknowledgements() ?: return
        // A previously received command with an outstanding receipt must never
        // enter the native driver again. The poller retries its exact ACK first.
        if (pendingAcks.any { it.commandId == commandId }) return

        val grant = ackStore.activeGrant(
            handoff.deviceId, handoff.packageName, handoff.signingCertificateSha256
        )
        if (grant == null) {
            acknowledgeNativeWake(
                token, commandId, requestId, screenSessionId, handoff,
                NativeWakeSubmissionResult(
                    NativeWakeSubmissionState.PRECHECK_DENIED,
                    "native_wake_grant_inactive"
                )
            )
            return
        }

        if (!AndroidTouchAccessibilityService.isBoundToProviderConversation(
                screenSessionId, appPackage, handoff.providerConversationIdentityDigest
            )
        ) {
            acknowledgeNativeWake(
                token, commandId, requestId, screenSessionId, handoff,
                NativeWakeSubmissionResult(
                    NativeWakeSubmissionState.PRECHECK_DENIED,
                    "provider_conversation_identity_unavailable"
                )
            )
            return
        }

        val request = handoff.toExecutionRequest(grant.grantId)
        // Reserve a durable ambiguous-outcome receipt before scheduling any
        // native provider effect. If the process dies after this point, the
        // outbox settles needs_review rather than repeating a possible Send.
        val prepared = createNativeWakeAckPayload(
            commandId, requestId, screenSessionId, handoff,
            NativeWakeSubmissionResult(NativeWakeSubmissionState.NEEDS_REVIEW, "outcome_unknown")
        ) ?: return
        if (!ackStore.savePendingNativeWakeAcknowledgement(
                commandId, requestId, screenSessionId, prepared, NativeWakeAckOutboxStage.PREPARED
            )
        ) return

        val accepted = AndroidTouchAccessibilityService.submitCanonicalWake(request) { result ->
            // submitCanonicalWake completes on the Accessibility main thread;
            // keep network I/O on the service's bounded command executor.
            runCatching {
                executor.execute {
                    acknowledgeNativeWake(
                        token, commandId, requestId, screenSessionId, handoff, result
                    )
                }
            }
        }
        if (!accepted) {
            acknowledgeNativeWake(
                token, commandId, requestId, screenSessionId, handoff,
                NativeWakeSubmissionResult(
                    NativeWakeSubmissionState.PRECHECK_DENIED,
                    "native_wake_local_driver_unavailable"
                )
            )
        }
    }

    private fun safeNativeWakeReason(reason: String): String {
        val value = reason.lowercase()
        return when {
            value.contains("outcome_unknown") || value.contains("already_reserved") ||
                value.contains("replay_ledger") || value.contains("insertion_outcome_unknown") ||
                value.contains("send_outcome") -> "outcome_unknown"
            value.contains("provider_conversation") -> "conversation_scope_unavailable"
            value.contains("foreground") || value.contains("active_app_window") -> "foreground_changed"
            value.contains("not_empty") -> "composer_not_empty"
            value.contains("composer") || value.contains("focus") || value.contains("target") &&
                !value.contains("send") -> "composer_identity_changed"
            value.contains("send_control_unavailable") || value.contains("send_control") &&
                value.contains("unavailable") -> "send_control_unavailable"
            value.contains("send") && value.contains("changed") -> "send_identity_changed"
            value.contains("send") -> "send_unconfirmed"
            value.contains("grant") || value.contains("permission") || value.contains("signer") ||
                value.contains("approved") -> "permission_denied"
            value.contains("device") || value.contains("session") -> "device_disconnected"
            else -> "other"
        }
    }

    private fun createNativeWakeAckPayload(
        commandId: String,
        requestId: String,
        screenSessionId: String,
        handoff: ValidatedAndroidNativeWakeHandoff,
        result: NativeWakeSubmissionResult
    ): JSONObject? {
        if (!UUID_PATTERN.matches(commandId) || !UUID_PATTERN.matches(requestId) ||
            !UUID_PATTERN.matches(screenSessionId)
        ) return null
        val state = when (result.state) {
            NativeWakeSubmissionState.PRECHECK_DENIED -> "preflight_denied"
            NativeWakeSubmissionState.SUBMITTED -> "submitted"
            NativeWakeSubmissionState.NEEDS_REVIEW -> "needs_review"
        }
        val resultName = when (state) {
            "preflight_denied" -> "native_wake_preflight_denied"
            "submitted" -> "native_wake_submitted"
            else -> "native_wake_needs_review"
        }
        val evidence = JSONObject()
            .put("version", 1)
            .put("kind", "native_wake_result")
            .put("handoffId", handoff.handoffId)
            .put("jobId", handoff.jobId)
            .put("deviceId", handoff.deviceId)
            .put("roomId", handoff.roomId)
            .put("screenSessionId", handoff.screenSessionId)
            .put("bindingId", handoff.bindingId)
            .put("targetId", handoff.targetId)
            .put("targetRevision", handoff.targetRevision)
            .put("state", state)
            .put("promptInserted", result.promptInserted)
            .put("sendInvoked", result.sendInvoked)
            .put("composerCleared", result.composerCleared)

        // Only a fully confirmed submission carries the stronger read-back and
        // same-target revalidation claims. All ambiguous outcomes stay review-only.
        if (state == "submitted") {
            val composerDigest = result.composerIdentityDigest ?: return null
            val sendDigest = result.sendControlIdentityDigest ?: return null
            val providerConversationDigest = result.providerConversationIdentityDigest ?: return null
            if (!result.providerConversationIdentityRevalidated ||
                providerConversationDigest != handoff.providerConversationIdentityDigest
            ) return null
            evidence
                .put("promptReadbackVerified", true)
                .put("composerIdentityRevalidated", true)
                .put("sendControlIdentityRevalidated", true)
                .put("providerConversationIdentityRevalidated", true)
                .put("composerIdentityDigest", composerDigest)
                .put("sendControlIdentityDigest", sendDigest)
                .put("providerConversationIdentityDigest", providerConversationDigest)
        } else {
            evidence.put("reason", safeNativeWakeReason(result.reason))
        }
        return JSONObject()
            .put("commandId", commandId)
            .put("requestId", requestId)
            .put("sessionId", screenSessionId)
            .put("result", resultName)
            .put("nativeWakeResult", evidence)
    }

    private fun acknowledgeNativeWake(
        token: String,
        commandId: String,
        requestId: String,
        screenSessionId: String,
        handoff: ValidatedAndroidNativeWakeHandoff,
        result: NativeWakeSubmissionResult
    ) {
        val payload = createNativeWakeAckPayload(
            commandId, requestId, screenSessionId, handoff, result
        ) ?: return
        val store = AndroidNativeWakeConsentStore(this)
        // A failed disk commit must not be hidden by an HTTP attempt: the exact
        // receipt remains recoverable as PREPARED or is retried on the next poll.
        if (!store.savePendingNativeWakeAcknowledgement(
                commandId, requestId, screenSessionId, payload, NativeWakeAckOutboxStage.FINAL
            )
        ) return
        retryPendingNativeWakeAcknowledgements(token)
    }

    /**
     * Replays the same device-authenticated ACK until the server confirms the
     * Android command row is ACKed. PREPARED means the process may have died
     * during a provider effect, so it is promoted to an explicit needs_review
     * receipt before delivery. Raw device credentials never enter the outbox.
     *
     * null means corrupt/unreadable durable state; callers must skip all native
     * commands rather than risk a duplicate native action.
     */
    private fun retryPendingNativeWakeAcknowledgements(token: String): Set<String>? {
        val store = AndroidNativeWakeConsentStore(this)
        var pending = store.pendingNativeWakeAcknowledgements() ?: return null
        // Suppress commands that were in the durable outbox at the start of
        // this poll even when their ACK succeeds and removes them from disk.
        val attemptedCommandIds = pending.map { it.commandId }.toMutableSet()
        for (entry in pending.filter { it.stage == NativeWakeAckOutboxStage.PREPARED }) {
            val placeholder = runCatching { JSONObject(entry.payloadJson) }.getOrNull() ?: return null
            if (!store.savePendingNativeWakeAcknowledgement(
                    entry.commandId, entry.requestId, entry.sessionId,
                    placeholder, NativeWakeAckOutboxStage.FINAL
                )
            ) return null
        }

        pending = store.pendingNativeWakeAcknowledgements() ?: return null
        for (entry in pending) {
            if (entry.stage != NativeWakeAckOutboxStage.FINAL) continue
            try {
                val response = api?.post("android/ack", token, JSONObject(entry.payloadJson))
                if (response?.optBoolean("ok") == true && response.optBoolean("acked") == true) {
                    store.removePendingNativeWakeAcknowledgement(entry.commandId, entry.payloadJson)
                }
            } catch (_: Exception) {
                // Keep the exact receipt on disk. The next device poll retries it
                // before it is permitted to dispatch any matching command.
            }
        }
        val remaining = store.pendingNativeWakeAcknowledgements() ?: return null
        attemptedCommandIds += remaining.map { it.commandId }
        return attemptedCommandIds
    }

    private fun processCommand(token: String, command: JSONObject) {
        if (stopping) return
        val commandId = command.optString("commandId")
        val requestId = command.optString("requestId")
        val sessionId = command.optString("sessionId")
        val action = command.optString("action")
        val appPackage = command.optString("appPackageName")
        val roomId = command.optString("roomId")
        when (action) {
            "native_wake_trigger" -> processNativeWakeTrigger(
                token, commandId, requestId, sessionId, appPackage, roomId, command
            )
            "view_offer" -> {
                // If a phone ACK was lost after creating the peer, the same lease may
                // be delivered again. Reuse that peer and retry only the ACK.
                if (activeSessionId == sessionId && activeAppPackage == appPackage && peer != null) {
                    pendingOfferCommandId = commandId
                    pendingOfferRequestId = requestId
                    if (answerAlreadySent) acknowledgePendingOffer(sessionId, "answer_sent")
                    return
                }
                val offer = command.optJSONObject("offer")?.optString("sdp").orEmpty()
                pendingOfferCommandId = commandId
                pendingOfferRequestId = requestId
                activeRoomId = roomId
                val accepted = startPeerAnswer(sessionId, appPackage, offer, roomId)
                if (!accepted) {
                    acknowledge(token, commandId, requestId, sessionId, "app_or_offer_rejected")
                    pendingOfferCommandId = ""
                    pendingOfferRequestId = ""
                    try {
                        api?.post("android/session-close", token, JSONObject()
                            .put("roomId", roomId)
                            .put("sessionId", sessionId))
                    } catch (_: Exception) {
                        // The session expires on its short server heartbeat lease if close cannot be delivered.
                    }
                    stopCapture("android_offer_rejected")
                }
            }
            "request_control" -> {
                val sameSession = activeSessionId == sessionId && activeAppPackage == appPackage
                val granted = sameSession && RemoteTouchGate.isArmed(this) &&
                    AndroidTouchAccessibilityService.isServiceEnabled(this) &&
                    AndroidTouchAccessibilityService.currentForegroundPackage() == appPackage &&
                    AndroidTouchAccessibilityService.bindActiveSession(sessionId, appPackage)
                localControlGranted = granted
                acknowledge(token, commandId, requestId, sessionId, if (granted) "control_granted" else "control_denied", granted)
            }
            "stop_session" -> {
                if (activeSessionId == sessionId) {
                    acknowledge(token, commandId, requestId, sessionId, "session_stopped")
                    stopCapture("remote_stop")
                } else {
                    acknowledge(token, commandId, requestId, sessionId, "stale_session")
                }
            }
        }
    }

    private fun invalidatePeerDisconnectTimer() {
        synchronized(this) { peerDisconnectToken += 1L }
    }

    private fun schedulePeerDisconnectStop(sessionId: String, connection: PeerConnection) {
        val token = synchronized(this) {
            peerDisconnectToken += 1L
            peerDisconnectToken
        }
        try {
            executor.schedule({
                val stillDisconnected = connection.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED ||
                    connection.iceConnectionState() == PeerConnection.IceConnectionState.DISCONNECTED
                if (!stopping && peer === connection && peerDisconnectToken == token &&
                    activeSessionId == sessionId && stillDisconnected) {
                    stopCapture("webrtc_peer_disconnected")
                }
            }, PEER_DISCONNECT_GRACE_SECONDS, TimeUnit.SECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // Service shutdown already tears down the peer and projection.
        }
    }

    private fun startPeerAnswer(sessionId: String, appPackage: String, offerSdp: String, roomId: String): Boolean {
        if (!UUID_PATTERN.matches(sessionId) || !AppGrantPolicy.isValidPackageName(appPackage) ||
            appPackage != locallySelectedPackage || !UUID_PATTERN.matches(roomId) ||
            offerSdp.length !in 8..MAX_SDP_CHARS || !offerSdp.startsWith("v=0")
        ) return false
        val accessibilityEnabled = AndroidTouchAccessibilityService.isServiceEnabled(this)
        val foregroundPackage = AndroidTouchAccessibilityService.currentForegroundPackage()
        if (accessibilityEnabled && foregroundPackage != null && foregroundPackage != appPackage) return false
        val signer = AppIdentity.signingCertificateSha256(this, appPackage) ?: return false
        if (AppGrantStore(this).get(appPackage, signer) == null) return false

        closePeer()
        activeSessionId = sessionId
        activeAppPackage = appPackage
        activeRoomId = roomId
        DraftInputMethodService.bindRemoteSession(sessionId, appPackage)
        localControlGranted = false
        answerAlreadySent = false
        answeringSessionId = sessionId
        // Accessibility is not required for view-only capture. If the service is enabled,
        // bind it to this locally selected app so it can monitor app switches and later
        // authorise touch. If unavailable, the stream remains view-only.
        if (accessibilityEnabled) AndroidTouchAccessibilityService.bindActiveSession(sessionId, appPackage)

        val factory = peerFactory ?: run { closePeer(); return false }
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
        )
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        var observedConnection: PeerConnection? = null
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                when (newState) {
                    PeerConnection.IceConnectionState.DISCONNECTED ->
                        observedConnection?.takeIf { peer === it }?.let { schedulePeerDisconnectStop(sessionId, it) }
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        if (peer === observedConnection) invalidatePeerDisconnectTimer()
                    }
                    PeerConnection.IceConnectionState.FAILED,
                    PeerConnection.IceConnectionState.CLOSED -> {
                        if (peer === observedConnection && !stopping) stopCapture("webrtc_connection_failed")
                    }
                    else -> Unit
                }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {
                if (newState == PeerConnection.IceGatheringState.COMPLETE) sendLocalAnswer(sessionId)
            }
            override fun onIceCandidate(candidate: IceCandidate) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
            override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
            override fun onDataChannel(channel: DataChannel) {
                dataChannel = channel
                observeInputChannel(channel, sessionId, appPackage)
            }
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, mediaStreams: Array<out org.webrtc.MediaStream>) = Unit
            override fun onTrack(transceiver: org.webrtc.RtpTransceiver) = Unit
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                when (newState) {
                    PeerConnection.PeerConnectionState.DISCONNECTED ->
                        observedConnection?.takeIf { peer === it }?.let { schedulePeerDisconnectStop(sessionId, it) }
                    PeerConnection.PeerConnectionState.CONNECTED -> {
                        if (peer === observedConnection) invalidatePeerDisconnectTimer()
                    }
                    PeerConnection.PeerConnectionState.FAILED,
                    PeerConnection.PeerConnectionState.CLOSED -> {
                        if (peer === observedConnection && !stopping) stopCapture("webrtc_connection_failed")
                    }
                    else -> Unit
                }
            }
        }
        val connection = factory.createPeerConnection(rtcConfig, observer) ?: run { closePeer(); return false }
        observedConnection = connection
        peer = connection
        videoTrack?.let { connection.addTrack(it, listOf("backroom-android-screen")) }

        val offer = SessionDescription(SessionDescription.Type.OFFER, offerSdp)
        connection.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onSetSuccess() {
                connection.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        connection.setLocalDescription(object : SdpObserver {
                            override fun onCreateSuccess(value: SessionDescription) = Unit
                            override fun onSetSuccess() {
                                if (connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) {
                                    sendLocalAnswer(sessionId)
                                }
                            }
                            override fun onCreateFailure(error: String) = stopCapture("answer_create_failed")
                            override fun onSetFailure(error: String) = stopCapture("answer_set_failed")
                        }, description)
                        // If ICE was already complete before observer callback delivery, send now.
                        if (connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) {
                            sendLocalAnswer(sessionId)
                        }
                    }
                    override fun onSetSuccess() = Unit
                    override fun onCreateFailure(error: String) = stopCapture("answer_create_failed")
                    override fun onSetFailure(error: String) = stopCapture("answer_set_failed")
                }, MediaConstraints())
            }
            override fun onCreateFailure(error: String) = stopCapture("remote_offer_invalid")
            override fun onSetFailure(error: String) = stopCapture("remote_offer_invalid")
        }, offer)
        return true
    }

    private fun sendLocalAnswer(sessionId: String) {
        val activePeer = peer ?: return
        val description = activePeer.localDescription ?: return
        if (description.type != SessionDescription.Type.ANSWER || description.description.length !in 8..MAX_SDP_CHARS) return
        val claim = synchronized(this) {
            if (answerAlreadySent || answeringSessionId != sessionId || peer !== activePeer) {
                false
            } else {
                answerAlreadySent = true
                true
            }
        }
        if (!claim) return
        executor.execute {
            try {
                api?.post(
                    "android/signal",
                    deviceToken,
                    JSONObject()
                        .put("roomId", activeRoomId ?: return@execute)
                        .put("sessionId", sessionId)
                        .put("answer", JSONObject().put("type", "answer").put("sdp", description.description))
                        .put("canControl", false)
                )
                acknowledgePendingOffer(sessionId, "answer_sent")
            } catch (_: Exception) {
                stopCapture("webrtc_answer_delivery_failed")
            }
        }
    }

    private val remoteTextRequestIds = LinkedHashMap<String, Long>()

    private var pendingOfferCommandId = ""
    private var pendingOfferRequestId = ""

    private fun acknowledgePendingOffer(sessionId: String, result: String) {
        if (pendingOfferCommandId.isBlank() || pendingOfferRequestId.isBlank()) return
        acknowledge(deviceToken.orEmpty(), pendingOfferCommandId, pendingOfferRequestId, sessionId, result)
        pendingOfferCommandId = ""
        pendingOfferRequestId = ""
    }

    private fun acknowledge(
        token: String,
        commandId: String,
        requestId: String,
        sessionId: String,
        result: String,
        canControl: Boolean? = null
    ) {
        if (!UUID_PATTERN.matches(commandId) || !UUID_PATTERN.matches(requestId) || !UUID_PATTERN.matches(sessionId)) return
        try {
            val fields = JSONObject()
                .put("commandId", commandId)
                .put("requestId", requestId)
                .put("sessionId", sessionId)
                .put("result", result)
            if (canControl != null) fields.put("canControl", canControl)
            api?.post("android/ack", token, fields)
        } catch (_: Exception) { }
    }

    private fun sendTouchControlRevoked() {
        val channel = dataChannel ?: return
        val sessionId = activeSessionId ?: return
        if (channel.state() != DataChannel.State.OPEN || !UUID_PATTERN.matches(sessionId)) return
        val payload = JSONObject()
            .put("kind", "touch_control_revoked")
            .put("sessionId", sessionId)
            .toString()
            .toByteArray(Charsets.UTF_8)
        try { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
        catch (_: Exception) { /* Local gate remains authoritative if the peer is disconnected. */ }
    }

    private fun sendRemoteKeyboardRevoked() {
        val channel = dataChannel ?: return
        val sessionId = activeSessionId ?: return
        if (channel.state() != DataChannel.State.OPEN || !UUID_PATTERN.matches(sessionId)) return
        val payload = JSONObject()
            .put("kind", "remote_keyboard_revoked")
            .put("sessionId", sessionId)
            .toString()
            .toByteArray(Charsets.UTF_8)
        runCatching { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
    }

    private fun sendAppVisibility(channel: DataChannel, sessionId: String, visible: Boolean) {
        if (!UUID_PATTERN.matches(sessionId) || channel.state() != DataChannel.State.OPEN) return
        val payload = JSONObject()
            .put("kind", "app_visibility")
            .put("sessionId", sessionId)
            .put("visible", visible)
            .toString()
            .toByteArray(Charsets.UTF_8)
        try { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
        catch (_: Exception) { /* The video track remains the source of truth when available. */ }
    }

    private fun sendNavigationAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        navigationId: String,
        action: String,
        accepted: Boolean
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(navigationId) ||
            action != "back" || channel.state() != DataChannel.State.OPEN) return
        val payload = JSONObject()
            .put("kind", "navigation_ack")
            .put("sessionId", sessionId)
            .put("navigationId", navigationId)
            .put("action", action)
            .put("accepted", accepted)
            .toString()
            .toByteArray(Charsets.UTF_8)
        try { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
        catch (_: Exception) { /* The browser reports a missing navigation acknowledgement. */ }
    }

    private fun claimRemoteTextRequest(requestId: String): Boolean = synchronized(remoteTextRequestIds) {
        val cutoff = System.currentTimeMillis() - REMOTE_TEXT_REPLAY_WINDOW_MS
        val expired = remoteTextRequestIds.filterValues { it < cutoff }.keys.toList()
        expired.forEach { remoteTextRequestIds.remove(it) }
        if (remoteTextRequestIds.containsKey(requestId) ||
            remoteTextRequestIds.size >= MAX_REMOTE_TEXT_REQUEST_IDS
        ) return@synchronized false
        remoteTextRequestIds[requestId] = System.currentTimeMillis()
        true
    }

    private fun sendComposerTargetAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        selectionId: String,
        decision: ComposerSelectionDecision
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(selectionId) ||
            channel.state() != DataChannel.State.OPEN || activeSessionId != sessionId ||
            dataChannel !== channel
        ) return
        val payload = JSONObject()
            .put("kind", "composer_target_ack")
            .put("sessionId", sessionId)
            .put("selectionId", selectionId)
            .put("selected", decision.candidate != null)
            .put("reason", decision.reason)
            .put("sendAvailable", decision.sendControl != null)
            .put("sendReason", decision.sendReason)
            .put("providerConversationIdentityAvailable", decision.providerConversationIdentityDigest?.let {
                ProviderConversationIdentityPolicy.isValidDigest(it)
            } == true)
        decision.candidate?.let { payload.put("targetId", it.targetId) }
        decision.sendControl?.let { payload.put("sendTargetId", it.targetId) }
        runCatching { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload.toString().toByteArray(Charsets.UTF_8)), false)) }
    }

    private fun sendSendControlVerificationAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        requestId: String,
        decision: SendControlDecision
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(requestId) ||
            channel.state() != DataChannel.State.OPEN || activeSessionId != sessionId ||
            dataChannel !== channel
        ) return
        val payload = JSONObject()
            .put("kind", "send_control_ack")
            .put("sessionId", sessionId)
            .put("requestId", requestId)
            .put("available", decision.candidate != null)
            .put("reason", decision.reason)
            .put("providerConversationIdentityMatchesSelection", decision.providerConversationIdentityDigest?.let {
                ProviderConversationIdentityPolicy.isValidDigest(it)
            } == true)
        decision.candidate?.let { payload.put("sendTargetId", it.targetId) }
        runCatching {
            channel.send(DataChannel.Buffer(
                ByteBuffer.wrap(payload.toString().toByteArray(Charsets.UTF_8)), false
            ))
        }
    }

    private fun sendNativeBindingAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        requestId: String,
        bound: Boolean,
        reason: String
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(requestId) ||
            channel.state() != DataChannel.State.OPEN || activeSessionId != sessionId ||
            dataChannel !== channel
        ) return
        val allowedReasons = setOf(
            "bound", "native_identity_unavailable", "app_signer_unavailable",
            "session_not_active", "challenge_rejected", "binding_conflict",
            "device_service_unavailable", "invalid_request"
        )
        val payload = JSONObject()
            .put("kind", "native_binding_ack")
            .put("sessionId", sessionId)
            .put("requestId", requestId)
            .put("bound", bound)
            .put("reason", reason.takeIf { it in allowedReasons } ?: "device_service_unavailable")
            .toString()
            .toByteArray(Charsets.UTF_8)
        runCatching { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
    }

    private fun sendRemoteTextAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        requestId: String,
        result: String
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(requestId) ||
            channel.state() != DataChannel.State.OPEN || activeSessionId != sessionId ||
            dataChannel !== channel
        ) return
        val payload = JSONObject()
            .put("kind", "remote_text_ack")
            .put("sessionId", sessionId)
            .put("requestId", requestId)
            .put("accepted", result == "inserted")
            .put("result", result)
            .toString()
            .toByteArray(Charsets.UTF_8)
        runCatching { channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false)) }
    }

    private fun sendTouchAcknowledgement(
        channel: DataChannel,
        sessionId: String,
        gestureId: String,
        accepted: Boolean
    ) {
        if (!UUID_PATTERN.matches(sessionId) || !UUID_PATTERN.matches(gestureId) ||
            channel.state() != DataChannel.State.OPEN) return
        val payload = JSONObject()
            .put("kind", "touch_ack")
            .put("sessionId", sessionId)
            .put("gestureId", gestureId)
            .put("accepted", accepted)
            .toString()
            .toByteArray(Charsets.UTF_8)
        try {
            channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false))
        } catch (_: Exception) {
            // The browser reports a missing acknowledgement and can safely retry the gesture.
        }
    }

    private fun observeInputChannel(channel: DataChannel, sessionId: String, appPackage: String) {
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit
            override fun onStateChange() {
                when (channel.state()) {
                    DataChannel.State.OPEN -> {
                        if (dataChannel === channel) {
                            sendAppVisibility(channel, sessionId, capturedContentVisible && !stopping)
                        }
                    }
                    DataChannel.State.CLOSED -> if (dataChannel === channel) dataChannel = null
                    else -> Unit
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary || buffer.data.remaining() !in 1..16_384) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val input = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { return }
                if (input.optString("kind") == "clear_composer_target") {
                    val selectionId = input.optString("selectionId")
                    if (!UUID_PATTERN.matches(selectionId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage
                    ) return
                    val allowedClearKeys = setOf("kind", "selectionId", "sessionId", "appPackageName")
                    if (input.keys().asSequence().toSet() != allowedClearKeys) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "invalid_request")
                        )
                        return
                    }
                    if (!claimRemoteTextRequest(selectionId)) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "request_replayed_or_rate_limited")
                        )
                        return
                    }
                    AndroidTouchAccessibilityService.clearSelectedComposer()
                    sendComposerTargetAcknowledgement(
                        channel, sessionId, selectionId,
                        ComposerSelectionDecision(null, "cleared")
                    )
                    return
                }
                if (input.optString("kind") == "select_composer_target") {
                    val selectionId = input.optString("selectionId")
                    if (!UUID_PATTERN.matches(selectionId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage
                    ) return
                    val allowedSelectionKeys = setOf("kind", "selectionId", "sessionId", "appPackageName", "region")
                    if (input.keys().asSequence().toSet() != allowedSelectionKeys) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "invalid_request")
                        )
                        return
                    }
                    if (!claimRemoteTextRequest(selectionId)) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "request_replayed_or_rate_limited")
                        )
                        return
                    }
                    val region = input.optJSONObject("region")
                    if (region == null || region.keys().asSequence().toSet() != setOf("left", "top", "right", "bottom")) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "invalid_selection_region")
                        )
                        return
                    }
                    val values = listOf("left", "top", "right", "bottom").map { key ->
                        region.opt(key) as? Number
                    }
                    if (values.any { it == null || !it.toDouble().isFinite() }) {
                        sendComposerTargetAcknowledgement(
                            channel, sessionId, selectionId,
                            ComposerSelectionDecision(null, "invalid_selection_region")
                        )
                        return
                    }
                    val selection = NormalizedComposerSelection(
                        values[0]!!.toFloat(), values[1]!!.toFloat(),
                        values[2]!!.toFloat(), values[3]!!.toFloat()
                    )
                    mainHandler.post {
                        val decision = if (stopping || !capturedContentVisible ||
                            activeSessionId != sessionId || activeAppPackage != appPackage) {
                            ComposerSelectionDecision(null, "session_not_active")
                        } else {
                            AndroidTouchAccessibilityService.selectComposerTarget(sessionId, appPackage, selection)
                        }
                        sendComposerTargetAcknowledgement(channel, sessionId, selectionId, decision)
                    }
                    return
                }
                if (input.optString("kind") == "verify_composer_send") {
                    val requestId = input.optString("requestId")
                    val composerTargetId = input.optString("composerTargetId")
                    val sendTargetId = input.optString("sendTargetId")
                    if (!UUID_PATTERN.matches(requestId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage
                    ) return
                    val allowedKeys = setOf(
                        "kind", "requestId", "sessionId", "appPackageName",
                        "composerTargetId", "sendTargetId"
                    )
                    if (input.keys().asSequence().toSet() != allowedKeys ||
                        !Regex("^[a-f0-9]{64}$").matches(composerTargetId) ||
                        !Regex("^[a-f0-9]{64}$").matches(sendTargetId)
                    ) {
                        sendSendControlVerificationAcknowledgement(
                            channel, sessionId, requestId,
                            SendControlDecision(null, "invalid_request")
                        )
                        return
                    }
                    if (!claimRemoteTextRequest(requestId)) {
                        sendSendControlVerificationAcknowledgement(
                            channel, sessionId, requestId,
                            SendControlDecision(null, "request_replayed_or_rate_limited")
                        )
                        return
                    }
                    mainHandler.post {
                        val decision = if (stopping || !capturedContentVisible ||
                            activeSessionId != sessionId || activeAppPackage != appPackage) {
                            SendControlDecision(null, "session_not_active")
                        } else {
                            AndroidTouchAccessibilityService.revalidateSelectedSendControl(
                                sessionId, appPackage, composerTargetId, sendTargetId
                            )
                        }
                        sendSendControlVerificationAcknowledgement(channel, sessionId, requestId, decision)
                    }
                    return
                }
                if (input.optString("kind") == "bind_native_group_target") {
                    val requestId = input.optString("requestId")
                    val challengeId = input.optString("challengeId")
                    val nonce = input.optString("nonce")
                    if (!UUID_PATTERN.matches(requestId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage
                    ) return
                    val allowedKeys = setOf(
                        "kind", "requestId", "sessionId", "appPackageName", "challengeId", "nonce"
                    )
                    if (input.keys().asSequence().toSet() != allowedKeys ||
                        !UUID_PATTERN.matches(challengeId) ||
                        !Regex("^[a-f0-9]{64}$").matches(nonce)
                    ) {
                        sendNativeBindingAcknowledgement(channel, sessionId, requestId, false, "invalid_request")
                        return
                    }
                    if (!claimRemoteTextRequest(requestId)) {
                        sendNativeBindingAcknowledgement(channel, sessionId, requestId, false, "challenge_rejected")
                        return
                    }
                    mainHandler.post {
                        if (stopping || !capturedContentVisible ||
                            activeSessionId != sessionId || activeAppPackage != appPackage
                        ) {
                            sendNativeBindingAcknowledgement(channel, sessionId, requestId, false, "session_not_active")
                            return@post
                        }
                        val evidence = AndroidTouchAccessibilityService.nativeBindingEvidence(sessionId, appPackage)
                        if (evidence == null) {
                            sendNativeBindingAcknowledgement(
                                channel, sessionId, requestId, false, "native_identity_unavailable"
                            )
                            return@post
                        }
                        val signer = AppIdentity.signingCertificateSha256(this@AndroidScreenShareService, appPackage)
                        if (signer.isNullOrBlank()) {
                            sendNativeBindingAcknowledgement(channel, sessionId, requestId, false, "app_signer_unavailable")
                            return@post
                        }
                        val token = deviceToken
                        if (token.isNullOrBlank()) {
                            sendNativeBindingAcknowledgement(channel, sessionId, requestId, false, "device_service_unavailable")
                            return@post
                        }
                        try {
                            executor.execute {
                                val result = try {
                                    api?.completeNativeBinding(token, JSONObject()
                                        .put("challengeId", challengeId)
                                        .put("nonce", nonce)
                                        .put("screenSessionId", sessionId)
                                        .put("appPackageName", appPackage)
                                        .put("appSigningCertificateSha256", signer)
                                        .put("composerIdentityDigest", evidence.composerIdentityDigest)
                                        .put("sendControlIdentityDigest", evidence.sendControlIdentityDigest)
                                        .put("providerConversationIdentityDigest", evidence.providerConversationIdentityDigest)
                                    )
                                } catch (_: Exception) { null }
                                val bound = result?.optBoolean("ok", false) == true
                                val reason = if (bound) "bound" else when (result?.optString("reason")) {
                                    "native_binding_already_active", "group_binding_not_eligible" -> "binding_conflict"
                                    "challenge_invalid_or_expired", "challenge_already_consumed",
                                    "challenge_not_found" -> "challenge_rejected"
                                    else -> "device_service_unavailable"
                                }
                                sendNativeBindingAcknowledgement(channel, sessionId, requestId, bound, reason)
                            }
                        } catch (_: java.util.concurrent.RejectedExecutionException) {
                            sendNativeBindingAcknowledgement(
                                channel, sessionId, requestId, false, "device_service_unavailable"
                            )
                        }
                    }
                    return
                }
                if (input.optString("kind") == "remote_text") {
                    val requestId = input.optString("requestId")
                    if (!UUID_PATTERN.matches(requestId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage
                    ) return
                    val allowedTextKeys = setOf("kind", "requestId", "sessionId", "appPackageName", "targetId", "text")
                    if (input.keys().asSequence().toSet() != allowedTextKeys) {
                        sendRemoteTextAcknowledgement(channel, sessionId, requestId, "invalid_request")
                        return
                    }
                    if (!claimRemoteTextRequest(requestId)) {
                        sendRemoteTextAcknowledgement(channel, sessionId, requestId, "request_replayed_or_rate_limited")
                        return
                    }
                    val targetId = input.optString("targetId")
                    if (!Regex("^[a-f0-9]{64}$").matches(targetId)) {
                        sendRemoteTextAcknowledgement(channel, sessionId, requestId, "composer_target_required")
                        return
                    }
                    val text = input.opt("text") as? String
                    if (text == null || text.length > 4_000) {
                        sendRemoteTextAcknowledgement(channel, sessionId, requestId, "text_invalid_or_too_long")
                        return
                    }
                    mainHandler.post {
                        val result = if (stopping || !capturedContentVisible ||
                            activeSessionId != sessionId || activeAppPackage != appPackage) {
                            "session_not_active"
                        } else {
                            DraftInputMethodService.insertRemoteText(sessionId, appPackage, targetId, text)
                        }
                        sendRemoteTextAcknowledgement(channel, sessionId, requestId, result)
                    }
                    return
                }
                if (input.optString("kind") == "navigation") {
                    val allowedNavigationKeys = setOf("kind", "navigationId", "sessionId", "appPackageName", "action")
                    val navigationId = input.optString("navigationId")
                    val action = input.optString("action")
                    if (input.keys().asSequence().toSet() != allowedNavigationKeys ||
                        !UUID_PATTERN.matches(navigationId) ||
                        input.optString("sessionId") != sessionId ||
                        input.optString("appPackageName") != appPackage ||
                        action != "back"
                    ) return
                    val accepted = localControlGranted &&
                        RemoteTouchGate.isArmed(this@AndroidScreenShareService) &&
                        AndroidTouchAccessibilityService.performBack(sessionId, appPackage)
                    sendNavigationAcknowledgement(channel, sessionId, navigationId, action, accepted)
                    return
                }
                val gestureId = input.optString("gestureId")
                // Acknowledge only requests bound to this live session and app.
                // Once that identity is established, reject malformed payloads
                // explicitly so the frame can distinguish rejection from packet loss.
                if (input.optString("kind") != "touch" ||
                    !UUID_PATTERN.matches(gestureId) ||
                    input.optString("sessionId") != sessionId ||
                    input.optString("appPackageName") != appPackage
                ) return
                val rejectGesture = { sendTouchAcknowledgement(channel, sessionId, gestureId, false) }
                val allowedKeys = setOf("kind", "gestureId", "sessionId", "appPackageName", "gesture", "from", "to", "durationMs")
                if (input.keys().asSequence().toSet() != allowedKeys) {
                    rejectGesture()
                    return
                }
                if (!localControlGranted || !RemoteTouchGate.isArmed(this@AndroidScreenShareService)) {
                    rejectGesture()
                    return
                }
                val kind = when (input.optString("gesture")) {
                    "tap" -> RemoteGestureKind.TAP
                    "swipe" -> RemoteGestureKind.SWIPE
                    "long_press" -> RemoteGestureKind.LONG_PRESS
                    else -> {
                        rejectGesture()
                        return
                    }
                }
                val from = input.optJSONObject("from") ?: run { rejectGesture(); return }
                val to = input.optJSONObject("to") ?: run { rejectGesture(); return }
                if (from.keys().asSequence().toSet() != setOf("x", "y") ||
                    to.keys().asSequence().toSet() != setOf("x", "y")) {
                    rejectGesture()
                    return
                }
                val fromX = from.opt("x") as? Number ?: run { rejectGesture(); return }
                val fromY = from.opt("y") as? Number ?: run { rejectGesture(); return }
                val toX = to.opt("x") as? Number ?: run { rejectGesture(); return }
                val toY = to.opt("y") as? Number ?: run { rejectGesture(); return }
                val durationValue = input.opt("durationMs") as? Number ?: run { rejectGesture(); return }
                if (durationValue.toDouble() % 1.0 != 0.0) {
                    rejectGesture()
                    return
                }
                val durationMillis = durationValue.toInt()
                if (durationMillis !in 40..1_500) {
                    rejectGesture()
                    return
                }
                val gesture = RemoteTouchGesture(
                    sessionId = sessionId,
                    appPackageName = appPackage,
                    kind = kind,
                    from = NormalizedTouchPoint(fromX.toFloat(), fromY.toFloat()),
                    to = NormalizedTouchPoint(toX.toFloat(), toY.toFloat()),
                    durationMillis = durationMillis
                )
                val dispatched = AndroidTouchAccessibilityService.dispatch(
                    this@AndroidScreenShareService,
                    gesture
                ) { completed ->
                    sendTouchAcknowledgement(channel, sessionId, gestureId, completed)
                }
                if (!dispatched) sendTouchAcknowledgement(channel, sessionId, gestureId, false)
            }
        })
        sendAppVisibility(channel, sessionId, capturedContentVisible && !stopping)
    }

    @Synchronized
    private fun closePeer() {
        localControlGranted = false
        dataChannel?.unregisterObserver()
        dataChannel?.close()
        dataChannel = null
        invalidatePeerDisconnectTimer()
        val closingPeer = peer
        peer = null
        closingPeer?.close()
        closingPeer?.dispose()
        activeSessionId?.let(AndroidTouchAccessibilityService::clearActiveSession)
        DraftInputMethodService.clearRemoteSession(activeSessionId)
        synchronized(remoteTextRequestIds) { remoteTextRequestIds.clear() }
        activeSessionId = null
        activeAppPackage = null
        activeRoomId = null
        answeringSessionId = null
        answerAlreadySent = false
    }

    @Synchronized
    private fun notifyServerSessionClosed() {
        if (serverCloseSent) return
        val sessionId = activeSessionId ?: return
        val roomId = activeRoomId ?: return
        val token = deviceToken ?: return
        val client = api ?: return
        serverCloseSent = true
        Thread {
            try {
                client.post("android/session-close", token, JSONObject()
                    .put("roomId", roomId)
                    .put("sessionId", sessionId))
            } catch (_: Exception) { /* The session has a server-side expiry as a fallback. */ }
        }.start()
    }

    @Synchronized
    private fun stopCapture(reason: String) {
        if (stopping) return
        stopping = true
        runCatching { notifyServerSessionClosed() }

        // Invalidate the in-memory control binding before any disk or native
        // cleanup. A failed preference write must never leave a live target.
        localControlGranted = false
        AndroidTouchAccessibilityService.clearActiveSession(activeSessionId)
        RemoteTouchGate.disarm(this)
        RemoteKeyboardGate.disarm()

        // Native WebRTC/media teardown is best-effort per resource so one
        // failing dispose() cannot prevent the remaining capture resources
        // from being released or the foreground service from stopping.
        runCatching { closePeer() }
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }
        capturer = null
        runCatching { videoTrack?.dispose() }
        videoTrack = null
        runCatching { videoSource?.dispose() }
        videoSource = null
        runCatching { textureHelper?.dispose() }
        textureHelper = null
        runCatching { peerFactory?.dispose() }
        peerFactory = null
        runCatching { eglBase?.release() }
        eglBase = null
        pollingStarted = false
        runCatching { executor.shutdownNow() }
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        stopping = true
        runCatching { notifyServerSessionClosed() }
        localControlGranted = false
        AndroidTouchAccessibilityService.clearActiveSession(activeSessionId)
        RemoteTouchGate.disarm(this)
        RemoteKeyboardGate.disarm()
        runCatching { closePeer() }
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }
        capturer = null
        runCatching { textureHelper?.dispose() }
        textureHelper = null
        runCatching { videoTrack?.dispose() }
        videoTrack = null
        runCatching { videoSource?.dispose() }
        videoSource = null
        runCatching { peerFactory?.dispose() }
        peerFactory = null
        runCatching { eglBase?.release() }
        eglBase = null
        runCatching { executor.shutdownNow() }
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Backroom screen sharing", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val stopIntent = Intent(this, AndroidScreenShareService::class.java).setAction(ACTION_STOP)
        val stop = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Backroom screen sharing is active")
                .setContentText("The selected Android screen is available to your approved group session.")
                .setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Backroom screen sharing is active")
                .setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
                .build()
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopCapture("task_removed")
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        @Volatile private var instance: AndroidScreenShareService? = null

        fun revokeLocalTouch(context: Context) {
            // Clear the session binding even if persistent preference cleanup
            // fails; a later cloud request must obtain a fresh local grant.
            RemoteTouchGate.disarm(context)
            AndroidTouchAccessibilityService.clearActiveSession()
            instance?.let { service ->
                service.localControlGranted = false
                runCatching { service.sendTouchControlRevoked() }
            }
        }

        fun revokeRemoteKeyboard() {
            RemoteKeyboardGate.disarm()
            AndroidTouchAccessibilityService.clearSelectedComposer()
            instance?.let { service -> runCatching { service.sendRemoteKeyboardRevoked() } }
        }

        const val ACTION_START = "app.rubminds.companion.action.START_SCREEN_SHARE"
        const val ACTION_STOP = "app.rubminds.companion.action.STOP_SCREEN_SHARE"
        const val EXTRA_RESULT_CODE = "media_projection_result_code"
        const val EXTRA_RESULT_DATA = "media_projection_result_data"
        const val EXTRA_TARGET_PACKAGE = "media_projection_target_package"
        private const val CHANNEL_ID = "backroom-screen-share"
        private const val NOTIFICATION_ID = 7301
        private const val CAPTURE_FPS = 20
        private const val MAX_CAPTURE_DIMENSION = 1_440
        private const val POLL_INTERVAL_SECONDS = 8L
        private const val PEER_DISCONNECT_GRACE_SECONDS = 20L
        private const val MAX_POLL_FAILURES = 12
        private const val MAX_WAIT_WITHOUT_SESSION_MS = 5 * 60 * 1000L
        private const val MAX_SDP_CHARS = 65_536
        private const val MAX_REMOTE_TEXT_REQUEST_IDS = 128
        private const val REMOTE_TEXT_REPLAY_WINDOW_MS = 2 * 60 * 1000L
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

        fun requestStop(context: Context, reason: String) {
            // Do not start a new foreground service just to issue a local stop.
            context.stopService(Intent(context, AndroidScreenShareService::class.java))
        }
    }
}
