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
    private lateinit var startButton: Button
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
            text = "1. Enable the Rub Minds touch service below. 2. Open the app you intend to share. 3. Start sharing and choose that app window in Android's system picker (not the whole display). 4. Return to Backroom and start the stream. The app must remain in the foreground while streamed."
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
        startButton = Button(this).apply {
            text = "Start app screen sharing"
            setOnClickListener { requestProjection() }
        }
        root.addView(startButton)
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

    private fun requestProjection() {
        if (Build.VERSION.SDK_INT < 34) {
            Toast.makeText(this, "App-window selection requires Android 14 or later on this companion path.", Toast.LENGTH_LONG).show()
            return
        }
        if (!AndroidTouchAccessibilityService.isServiceEnabled(this)) {
            Toast.makeText(this, "Enable the Rub Minds accessibility service first so Backroom can verify which app is in the foreground.", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        // Android 14+ shows the OS chooser for a single app window or the full display.
        // The user must choose only the intended app window for the app-stream workflow.
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
        val service = Intent(this, AndroidScreenShareService::class.java).apply {
            action = AndroidScreenShareService.ACTION_START
            putExtra(AndroidScreenShareService.EXTRA_RESULT_CODE, resultCode)
            putExtra(AndroidScreenShareService.EXTRA_RESULT_DATA, data)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service) else startService(service)
            Toast.makeText(this, "Screen sharing started. Open Backroom to request the selected app stream.", Toast.LENGTH_LONG).show()
            // Return to the app the user had open before the consent/setup activity.
            finish()
        } catch (error: Exception) {
            RemoteTouchGate.disarm(this)
            Toast.makeText(this, error.message ?: "Could not start the screen-share service.", Toast.LENGTH_LONG).show()
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
        startButton.isEnabled = Build.VERSION.SDK_INT >= 34 && enabled
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val REQUEST_CAPTURE = 7401
    }
}
