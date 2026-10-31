package app.rubminds.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
    @Volatile private var localControlGranted = false
    @Volatile private var answeringSessionId: String? = null
    @Volatile private var answerAlreadySent = false
    private var projectionStartedAt = 0L
    private var pollingStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture("local_stop")
                return START_NOT_STICKY
            }
            ACTION_START -> {
                if (pollingStarted) return START_NOT_STICKY
                startForeground(NOTIFICATION_ID, buildNotification())
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
                if (resultCode != RESULT_OK || resultData == null) {
                    stopCapture("missing_projection_consent")
                    return START_NOT_STICKY
                }
                startCapture(resultData)
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture(resultData: Intent) {
        try {
            val vault = DeviceCredentialVault(this)
            deviceToken = vault.token() ?: error("Pair and obtain group-owner approval before streaming.")
            api = CloudDeviceApi()
            projectionStartedAt = System.currentTimeMillis()
            initializeWebRtc(resultData)
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
        val screenCapturer = ScreenCapturerAndroid(resultData, object : MediaProjection.Callback() {
            override fun onStop() {
                stopCapture("android_projection_revoked")
            }
        })
        capturer = screenCapturer
        screenCapturer.initialize(helper, applicationContext, source.capturerObserver)
        val metrics = captureMetrics()
        screenCapturer.startCapture(metrics.widthPixels, metrics.heightPixels, CAPTURE_FPS)
        val track = factory.createVideoTrack("backroom-android-screen", source)
        track.setEnabled(true)
        videoTrack = track
    }

    private fun captureMetrics(): DisplayMetrics {
        val metrics = resources.displayMetrics
        val width = metrics.widthPixels.coerceAtLeast(320)
        val height = metrics.heightPixels.coerceAtLeast(320)
        val scale = minOf(1f, MAX_CAPTURE_DIMENSION.toFloat() / maxOf(width, height))
        val result = DisplayMetrics()
        result.setTo(metrics)
        result.widthPixels = (width * scale).toInt().coerceAtLeast(320)
        result.heightPixels = (height * scale).toInt().coerceAtLeast(320)
        // Preserve even dimensions for common hardware encoders.
        result.widthPixels -= result.widthPixels % 2
        result.heightPixels -= result.heightPixels % 2
        return result
    }

    private fun pollDeviceCommands() {
        val token = deviceToken ?: return stopCapture("device_credential_missing")
        try {
            val result = api?.post("android/commands", token) ?: return
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
            // Temporary network failure does not tear down an active peer immediately.
        }
    }

    private fun processCommand(token: String, command: JSONObject) {
        val commandId = command.optString("commandId")
        val requestId = command.optString("requestId")
        val sessionId = command.optString("sessionId")
        val action = command.optString("action")
        val appPackage = command.optString("appPackageName")
        when (action) {
            "view_offer" -> {
                val offer = command.optJSONObject("offer")?.optString("sdp").orEmpty()
                val accepted = startPeerAnswer(sessionId, appPackage, offer)
                if (!accepted) acknowledge(token, commandId, requestId, sessionId, "app_or_offer_rejected")
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

    private fun startPeerAnswer(sessionId: String, appPackage: String, offerSdp: String): Boolean {
        if (!UUID_PATTERN.matches(sessionId) || !APP_PACKAGE_PATTERN.matches(appPackage) ||
            offerSdp.length !in 8..MAX_SDP_CHARS || !offerSdp.startsWith("v=0") ||
            AndroidTouchAccessibilityService.currentForegroundPackage() != appPackage
        ) return false
        val signer = AppIdentity.signingCertificateSha256(this, appPackage) ?: return false
        if (AppGrantStore(this).get(appPackage, signer) == null) return false

        closePeer()
        activeSessionId = sessionId
        activeAppPackage = appPackage
        localControlGranted = false
        answerAlreadySent = false
        answeringSessionId = sessionId
        if (!AndroidTouchAccessibilityService.bindActiveSession(sessionId, appPackage)) {
            // The accessibility service is the foreground-package verifier even for view-only mode.
            activeSessionId = null
            activeAppPackage = null
            return false
        }

        val factory = peerFactory ?: return false
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
        )
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                if (newState == PeerConnection.IceConnectionState.FAILED ||
                    newState == PeerConnection.IceConnectionState.CLOSED
                ) stopCapture("webrtc_connection_failed")
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
                if (newState == PeerConnection.PeerConnectionState.FAILED ||
                    newState == PeerConnection.PeerConnectionState.CLOSED
                ) stopCapture("webrtc_connection_failed")
            }
        }
        val connection = factory.createPeerConnection(rtcConfig, observer) ?: return false
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
                            override fun onSetSuccess() = Unit
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
        if (answerAlreadySent || answeringSessionId != sessionId) return
        val description = peer?.localDescription ?: return
        if (description.type != SessionDescription.Type.ANSWER || description.description.length !in 8..MAX_SDP_CHARS) return
        answerAlreadySent = true
        executor.execute {
            try {
                api?.post(
                    "android/signal",
                    deviceToken,
                    JSONObject()
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
                if (input.optString("kind") != "touch" ||
                    input.optString("sessionId") != sessionId ||
                    input.optString("appPackageName") != appPackage ||
                    !localControlGranted || !RemoteTouchGate.isArmed(this@AndroidScreenShareService)
                ) return
                val kind = when (input.optString("gesture")) {
                    "tap" -> RemoteGestureKind.TAP
                    "swipe" -> RemoteGestureKind.SWIPE
                    "long_press" -> RemoteGestureKind.LONG_PRESS
                    else -> return
                }
                val from = input.optJSONObject("from") ?: return
                val to = input.optJSONObject("to") ?: return
                val gesture = RemoteTouchGesture(
                    sessionId = sessionId,
                    appPackageName = appPackage,
                    kind = kind,
                    from = NormalizedTouchPoint(from.optDouble("x", Double.NaN).toFloat(), from.optDouble("y", Double.NaN).toFloat()),
                    to = NormalizedTouchPoint(to.optDouble("x", Double.NaN).toFloat(), to.optDouble("y", Double.NaN).toFloat()),
                    durationMillis = input.optInt("durationMs", 0)
                )
                AndroidTouchAccessibilityService.dispatch(this@AndroidScreenShareService, gesture)
            }
        })
    }

    private fun closePeer() {
        localControlGranted = false
        dataChannel?.unregisterObserver()
        dataChannel?.close()
        dataChannel = null
        peer?.close()
        peer?.dispose()
        peer = null
        activeSessionId?.let(AndroidTouchAccessibilityService::clearActiveSession)
        activeSessionId = null
        activeAppPackage = null
        answeringSessionId = null
        answerAlreadySent = false
    }

    private fun stopCapture(reason: String) {
        if (stopping) return
        stopping = true
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
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setContentTitle("Backroom screen sharing is active")
                .setContentText("The selected Android screen is available to your approved group session.")
                .setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.presence_video_online)
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
        const val ACTION_START = "app.rubminds.companion.action.START_SCREEN_SHARE"
        const val ACTION_STOP = "app.rubminds.companion.action.STOP_SCREEN_SHARE"
        const val EXTRA_RESULT_CODE = "media_projection_result_code"
        const val EXTRA_RESULT_DATA = "media_projection_result_data"
        private const val CHANNEL_ID = "backroom-screen-share"
        private const val NOTIFICATION_ID = 7301
        private const val CAPTURE_FPS = 20
        private const val MAX_CAPTURE_DIMENSION = 1_440
        private const val POLL_INTERVAL_SECONDS = 3L
        private const val MAX_WAIT_WITHOUT_SESSION_MS = 5 * 60 * 1000L
        private const val MAX_SDP_CHARS = 65_536
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
        private val APP_PACKAGE_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\\\.[A-Za-z][A-Za-z0-9_]*)+$")

        fun requestStop(context: Context, reason: String) {
            val intent = Intent(context, AndroidScreenShareService::class.java).setAction(ACTION_STOP)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (_: Exception) {
                context.stopService(Intent(context, AndroidScreenShareService::class.java))
            }
        }
    }
}
