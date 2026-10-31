package app.rubminds.companion

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Local-only entry point for Android screen sharing. The system picker is always shown;
 * the companion cannot start capture from a cloud command or reuse an old projection token.
 */
class AndroidStreamSetupActivity : Activity() {
    private lateinit var status: TextView
    private var pendingTargetPackage = ""
    private lateinit var armButton: Button
    private val projectionManager by lazy {
        getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Backroom app streaming"
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(24), dp(20), dp(20))
        }
        root.addView(TextView(this).apply {
            text = "Share an app with Backroom"
            textSize = 22f
            setTextColor(0xff172033.toInt())
        })
        root.addView(TextView(this).apply {
            text = "1. Choose one of the apps saved in your local allowlist. 2. Approve Android's screen-sharing prompt and choose that same app window (not the whole display). 3. The companion brings that app to the foreground. 4. View streaming works without Accessibility; enable the optional touch service and arm touch locally only when you also want remote taps and swipes."
            textSize = 13f
            setTextColor(0xff405070.toInt())
            setPadding(0, dp(12), 0, dp(12))
        })
        val privacy = TextView(this).apply {
            text = "Screen capture is local-user approved by Android every time. Accessibility is a separate, optional permission used only to verify the foreground package and dispatch taps/swipes into the selected app window. Backroom does not upload the accessibility tree or app text. Remote touch remains off until you explicitly arm it here."
            textSize = 12f
            setTextColor(0xff334155.toInt())
            setBackgroundColor(0xfff0f3f8.toInt())
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        root.addView(privacy)
        root.addView(Button(this).apply {
            text = "Enable accessibility service"
            setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        })
        armButton = Button(this).apply {
            text = "Arm remote touch for 15 minutes"
            setOnClickListener { confirmTouchArm() }
        }
        root.addView(armButton)
        root.addView(TextView(this).apply {
            text = "Choose one of your saved apps to share"
            textSize = 14f
            setTextColor(0xff172033.toInt())
            setPadding(0, dp(16), 0, dp(6))
        })
        val approvedApps = AppGrantStore(this).all()
        if (approvedApps.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "No apps are saved yet. Return to Rub Minds Companion, select an installed app and tap Save and sync selected apps first."
                textSize = 12f
                setTextColor(0xff8a4750.toInt())
            })
        } else {
            approvedApps.forEach { grant ->
                val label = try {
                    packageManager.getApplicationLabel(packageManager.getApplicationInfo(grant.packageName, 0)).toString()
                } catch (_: Exception) { grant.packageName }
                root.addView(Button(this).apply {
                    text = "Share $label"
                    setOnClickListener { requestProjection(grant.packageName) }
                })
            }
        }
        root.addView(Button(this).apply {
            text = "Stop screen sharing"
            setOnClickListener {
                RemoteTouchGate.disarm(this@AndroidStreamSetupActivity)
                stopService(Intent(this@AndroidStreamSetupActivity, AndroidScreenShareService::class.java)
                    .setAction(AndroidScreenShareService.ACTION_STOP))
                refreshStatus()
            }
        })
        status = TextView(this).apply {
            textSize = 12f
            setTextColor(0xff405070.toInt())
            setPadding(0, dp(12), 0, 0)
        }
        root.addView(status)
        root.addView(Button(this).apply {
            text = "Close"
            setOnClickListener { finish() }
        })
        setContentView(root)
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun confirmTouchArm() {
        if (!AndroidTouchAccessibilityService.isServiceEnabled(this)) {
            Toast.makeText(this, "Enable the accessibility service first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Allow remote taps and swipes?")
            .setMessage("For the next 15 minutes, a group member may request touch control of the app you explicitly share. Every gesture is accepted only while that same selected app is foreground, is saved in your local app allowlist, and the screen-sharing session is active. Switching apps stops the session. You can stop sharing here or through Android's screen-sharing controls.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Arm touch for 15 minutes") { _, _ ->
                RemoteTouchGate.armFromLocalConfirmation(this)
                refreshStatus()
            }
            .show()
    }

    private fun requestProjection(targetPackageName: String) {
        if (Build.VERSION.SDK_INT < 34) {
            Toast.makeText(this, "App-window selection requires Android 14 or later on this companion path.", Toast.LENGTH_LONG).show()
            return
        }
        val accessibilityReady = AndroidTouchAccessibilityService.isServiceEnabled(this)
        if (!accessibilityReady) {
            Toast.makeText(this, "View-only sharing will work. Enable Accessibility and arm touch later if you also want remote taps and swipes.", Toast.LENGTH_LONG).show()
        }
        val signer = AppIdentity.signingCertificateSha256(this, targetPackageName)
        if (signer == null || AppGrantStore(this).get(targetPackageName, signer) == null) {
            Toast.makeText(this, "This app is no longer in your saved local allowlist. Refresh the app list and approve it again.", Toast.LENGTH_LONG).show()
            return
        }
        pendingTargetPackage = targetPackageName
        // Android 14+ shows the OS chooser for a single app window or the full display.
        // The user must choose the intended app window. The selected package is then
        // launched locally so Accessibility can re-check the foreground identity.
        startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    }

    @Deprecated("Uses the platform MediaProjection consent result.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "Screen sharing was not approved. Nothing was captured.", Toast.LENGTH_LONG).show()
            return
        }
        val targetPackage = pendingTargetPackage
        val signer = AppIdentity.signingCertificateSha256(this, targetPackage)
        val grant = signer?.let { AppGrantStore(this).get(targetPackage, it) }
        val launchIntent = packageManager.getLaunchIntentForPackage(targetPackage)
        if (targetPackage.isBlank() || grant == null || launchIntent == null) {
            Toast.makeText(this, "The approved app is no longer installed or launchable. No screen was shared.", Toast.LENGTH_LONG).show()
            pendingTargetPackage = ""
            return
        }
        val service = Intent(this, AndroidScreenShareService::class.java).apply {
            action = AndroidScreenShareService.ACTION_START
            putExtra(AndroidScreenShareService.EXTRA_RESULT_CODE, resultCode)
            putExtra(AndroidScreenShareService.EXTRA_RESULT_DATA, data)
            putExtra(AndroidScreenShareService.EXTRA_TARGET_PACKAGE, targetPackage)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service) else startService(service)
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(launchIntent)
            Toast.makeText(this, "Screen sharing started. Return to Backroom to request this app stream.", Toast.LENGTH_LONG).show()
            finish()
        } catch (error: Exception) {
            RemoteTouchGate.disarm(this)
            stopService(Intent(this, AndroidScreenShareService::class.java))
            Toast.makeText(this, error.message ?: "Could not start the screen-share service.", Toast.LENGTH_LONG).show()
        } finally {
            pendingTargetPackage = ""
        }
    }

    private fun refreshStatus() {
        if (!::status.isInitialized) return
        val enabled = AndroidTouchAccessibilityService.isServiceEnabled(this)
        val armed = RemoteTouchGate.isArmed(this)
        status.text = when {
            !enabled -> "Touch service: not enabled. Streaming stays unavailable until you enable it in Android Settings."
            armed -> "Touch service: enabled · remote touch is locally armed for up to 15 minutes."
            else -> "Touch service: enabled · screen sharing can be view-only. Remote touch is not armed."
        }
        armButton.isEnabled = enabled

    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val REQUEST_CAPTURE = 7401
    }
}
