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
                val command = commands.optJSONObject(index) ?: continue
                processCommand(token, command)
            }
            if (System.currentTimeMillis() - projectionStartedAt > MAX_WAIT_WITHOUT_SESSION_MS &&
                activeSessionId == null
            ) stopCapture("stream_request_timeout")
        } catch (error: CloudDeviceApiException) {
            if (error.statusCode == 401 || error.statusCode == 403) stopCapture("device_access_revoked")
        } catch (_: Exception) {
            // Bound an offline device session: do not keep capturing indefinitely after
            // losing the server heartbeat that proves the group/device grant is current.
            consecutivePollFailures += 1
            if (consecutivePollFailures >= MAX_POLL_FAILURES) stopCapture("device_cloud_heartbeat_lost")
        }
    }

    private fun processCommand(token: String, command: JSONObject) {
        val commandId = command.optString("commandId")
        val requestId = command.optString("requestId")
        val sessionId = command.optString("sessionId")
        val action = command.optString("action")
        val appPackage = command.optString("appPackageName")
        val roomId = command.optString("roomId")
        when (action) {
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
                if (channel.state() == DataChannel.State.CLOSED && dataChannel === channel) dataChannel = null
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary || buffer.data.remaining() !in 1..4_096) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val input = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { return }
                val allowedKeys = setOf("kind", "gestureId", "sessionId", "appPackageName", "gesture", "from", "to", "durationMs")
                val gestureId = input.optString("gestureId")
                if (input.keys().asSequence().toSet() != allowedKeys ||
                    input.optString("kind") != "touch" ||
                    !UUID_PATTERN.matches(gestureId) ||
                    input.optString("sessionId") != sessionId ||
                    input.optString("appPackageName") != appPackage
                ) return
                if (!localControlGranted || !RemoteTouchGate.isArmed(this@AndroidScreenShareService)) {
                    sendTouchAcknowledgement(channel, sessionId, gestureId, false)
                    return
                }
                val kind = when (input.optString("gesture")) {
                    "tap" -> RemoteGestureKind.TAP
                    "swipe" -> RemoteGestureKind.SWIPE
                    "long_press" -> RemoteGestureKind.LONG_PRESS
                    else -> return
                }
                val from = input.optJSONObject("from") ?: return
                val to = input.optJSONObject("to") ?: return
                if (from.keys().asSequence().toSet() != setOf("x", "y") ||
                    to.keys().asSequence().toSet() != setOf("x", "y")) return
                val fromX = from.opt("x") as? Number ?: return
                val fromY = from.opt("y") as? Number ?: return
                val toX = to.opt("x") as? Number ?: return
                val toY = to.opt("y") as? Number ?: return
                val durationValue = input.opt("durationMs") as? Number ?: return
                if (durationValue.toDouble() % 1.0 != 0.0) return
                val durationMillis = durationValue.toInt()
                if (durationMillis !in 40..1_500) return
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
        notifyServerSessionClosed()
        RemoteTouchGate.disarm(this)
        closePeer()
        try { capturer?.stopCapture() } catch (_: Exception) { }
        capturer?.dispose()
        capturer = null
        videoTrack?.dispose()
        videoTrack = null
        videoSource?.dispose()
        videoSource = null
        textureHelper?.dispose()
        textureHelper = null
        peerFactory?.dispose()
        peerFactory = null
        eglBase?.release()
        eglBase = null
        pollingStarted = false
        executor.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        notifyServerSessionClosed()
        RemoteTouchGate.disarm(this)
        AndroidTouchAccessibilityService.clearActiveSession()
        closePeer()
        try { capturer?.stopCapture() } catch (_: Exception) { }
        capturer?.dispose()
        textureHelper?.dispose()
        videoTrack?.dispose()
        videoSource?.dispose()
        peerFactory?.dispose()
        eglBase?.release()
        executor.shutdownNow()
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

    private var stopping = false

    companion object {
        @Volatile private var instance: AndroidScreenShareService? = null

        fun revokeLocalTouch(context: Context) {
            RemoteTouchGate.disarm(context)
            instance?.localControlGranted = false
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
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

        fun requestStop(context: Context, reason: String) {
            // Do not start a new foreground service just to issue a local stop.
            context.stopService(Intent(context, AndroidScreenShareService::class.java))
        }
    }
}
