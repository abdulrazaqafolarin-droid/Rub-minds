package app.rubminds.companion

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executors

private data class LaunchableApp(
    val packageName: String,
    val label: String,
    val icon: Drawable,
    val signingCertificateSha256: String?,
    val versionName: String,
    val storageLabel: String
)

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var store: AppGrantStore
    private lateinit var vault: DeviceCredentialVault
    private var cloudApi: CloudDeviceApi? = null
    private lateinit var appList: LinearLayout
    private lateinit var pairingCodeInput: EditText
    private lateinit var cloudStatus: TextView
    private lateinit var saveButton: Button
    private lateinit var pairButton: Button
    private lateinit var pairConsent: CheckBox
    private lateinit var consentPrefs: android.content.SharedPreferences
    private val launchGrants = linkedMapOf<String, String>()
    private val draftGrants = linkedSetOf<String>()
    private val appRows = mutableMapOf<String, Pair<CheckBox, CheckBox>>()
    private var apps: List<LaunchableApp> = emptyList()
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AppGrantStore(this)
        vault = DeviceCredentialVault(this)
        consentPrefs = getSharedPreferences("backroom_cloud_consent", MODE_PRIVATE)
        cloudApi = try { CloudDeviceApi() } catch (_: Exception) { null }
        store.all().forEach {
            launchGrants[it.packageName] = it.signingCertificateSha256
            if (it.allowDraftInsertion) draftGrants += it.packageName
        }
        render()
        discoverApps()
        refreshKeyboardStatus()
        checkExistingDevice()
    }

    override fun onResume() {
        super.onResume()
        if (::appList.isInitialized) discoverApps()
        refreshKeyboardStatus()
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    private fun render() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(22), dp(18), dp(14))
            setBackgroundColor(0xfff7f8fc.toInt())
        }
        root.addView(TextView(this).apply {
            text = "Rub Minds Backroom"
            textSize = 24f
            setTextColor(0xff172033.toInt())
        })
        root.addView(TextView(this).apply {
            text = "Select apps for your group's Backroom inventory. You can also open a saved, approved app locally on this phone. Remote app control and isolated virtualization are not enabled. Pairing uses outbound HTTPS; this phone opens no local network port."
            textSize = 13f
            setTextColor(0xff4b5563.toInt())
            setPadding(0, dp(7), 0, dp(12))
        })

        val cloudCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(0xffe9efff.toInt())
        }
        cloudCard.addView(TextView(this).apply {
            text = "Connect to a Rub Minds group"
            textSize = 16f
            setTextColor(0xff172033.toInt())
        })
        cloudCard.addView(TextView(this).apply {
            text = "Create a one-use pairing code in Backroom on the web, then enter it here. The phone remains pending until the group owner approves it."
            textSize = 12f
            setTextColor(0xff405070.toInt())
            setPadding(0, dp(5), 0, dp(8))
        })
        cloudCard.addView(TextView(this).apply {
            text = "Permission and data explanation"
            textSize = 13f
            setTextColor(0xff172033.toInt())
            setPadding(0, dp(12), 0, dp(3))
        })
        cloudCard.addView(TextView(this).apply {
            text = "Internet: connects to Rub Minds over encrypted HTTPS for pairing and selected-app metadata. App discovery: shows launchable apps Android exposes to this profile. All Files Access is not requested because this build does not clone app data; that permission would not unlock other apps' private data. Screen capture and Accessibility control are not requested and are not available in this build."
            textSize = 11f
            setTextColor(0xff405070.toInt())
        })
        pairConsent = CheckBox(this).apply {
            text = "I agree to share only the app entries I select with this Rub Minds group."
            isChecked = consentPrefs.getBoolean("selected_app_inventory", false)
            setOnCheckedChangeListener { _, checked ->
                consentPrefs.edit().putBoolean("selected_app_inventory", checked).apply()
                pairButton.isEnabled = checked && !busy && cloudApi != null
                if (!checked) cloudStatus.text = "Cloud pairing and app inventory sync are paused. Remove this phone in Backroom to revoke an existing cloud device."
            }
        }
        cloudCard.addView(pairConsent)
        val disagree = Button(this).apply {
            text = "Disagree and exit"
            setOnClickListener { finish() }
        }
        cloudCard.addView(disagree)
        pairingCodeInput = EditText(this).apply {
            hint = "Paste 64-character pairing code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
            textSize = 13f
        }
        cloudCard.addView(pairingCodeInput)
        val cloudActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        pairButton = Button(this).apply {
            text = "Pair phone"
            isEnabled = pairConsent.isChecked && cloudApi != null
            setOnClickListener { pairDevice() }
        }
        cloudActions.addView(pairButton, LinearLayout.LayoutParams(0, -2, 1f))
        cloudActions.addView(Button(this).apply {
            text = "Check approval"
            setOnClickListener { checkExistingDevice() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        cloudCard.addView(cloudActions)
        cloudStatus = TextView(this).apply {
            text = "Not paired"
            textSize = 12f
            setTextColor(0xff405070.toInt())
            setPadding(0, dp(4), 0, 0)
        }
        cloudCard.addView(cloudStatus)
        root.addView(cloudCard)

        val scopeNote = TextView(this).apply {
            text = "Privacy boundary: Backroom syncs only the apps you select, with their package names, labels, signer fingerprints and version names. It does not upload app data, login sessions, files, messages or passwords."
            textSize = 12f
            setTextColor(0xff374151.toInt())
            setBackgroundColor(0xfff0f2f7.toInt())
            setPadding(dp(11), dp(10), dp(11), dp(10))
        }
        val scopeParams = LinearLayout.LayoutParams(-1, -2)
        scopeParams.topMargin = dp(10)
        root.addView(scopeNote, scopeParams)

        root.addView(TextView(this).apply {
            text = "Installed apps"
            textSize = 18f
            setTextColor(0xff172033.toInt())
            setPadding(0, dp(16), 0, dp(8))
        })
        saveButton = Button(this).apply {
            text = "Save and sync selected apps"
            setOnClickListener { saveChoices() }
        }
        root.addView(saveButton)
        val scroll = ScrollView(this)
        appList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(appList)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        val keyboardNote = TextView(this).apply {
            text = "Optional draft keyboard: Android controls enable/select approval. Draft insertion is separate from app discovery and never presses Send. Some protected apps and fields may reject third-party keyboards."
            textSize = 11f
            setTextColor(0xff647087.toInt())
            setPadding(0, dp(10), 0, 0)
        }
        root.addView(keyboardNote)
        val keyboardActions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        keyboardActions.addView(Button(this).apply {
            text = "Keyboard settings"
            setOnClickListener { startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)) }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        keyboardActions.addView(Button(this).apply {
            text = "Choose keyboard"
            setOnClickListener {
                val manager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                manager.showInputMethodPicker()
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(keyboardActions)
        setContentView(root)
        if (cloudApi == null) cloudStatus.text = "Build this companion with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY."
    }

    private fun refreshKeyboardStatus() {
        if (cloudApi == null) return
        // System-owned IME enable/select screens are not replaced by app-controlled toggles.
        val manager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        val component = ComponentName(this, DraftInputMethodService::class.java).flattenToString()
        val enabled = manager.enabledInputMethodList.any { it.id == component }
        val selected = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) == component
        if (::cloudStatus.isInitialized && !busy) {
            val current = cloudStatus.text.toString()
            if (!current.startsWith("Paired") && !current.startsWith("Waiting") && !current.startsWith("Device approved")) {
                cloudStatus.text = if (selected) "Draft keyboard selected · cloud device status is separate."
                else if (enabled) "Draft keyboard enabled · cloud device status is separate."
                else "Not paired. Draft keyboard permission is separate from app discovery."
            }
        }
    }

    private fun discoverApps() {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        @Suppress("DEPRECATION")
        val resolved = packageManager.queryIntentActivities(intent, 0)
        apps = resolved.mapNotNull { info ->
            val applicationInfo = info.activityInfo?.applicationInfo ?: return@mapNotNull null
            val packageName = applicationInfo.packageName
            if (packageName == applicationContext.packageName) return@mapNotNull null
            val label = info.loadLabel(packageManager)?.toString()?.takeIf { it.isNotBlank() } ?: packageName
            val digest = AppIdentity.signingCertificateSha256(this, packageName)
            @Suppress("DEPRECATION")
            val version = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (_: Exception) { "" }
            val storageLabel = if ((applicationInfo.flags and ApplicationInfo.FLAG_EXTERNAL_STORAGE) != 0) "External storage" else "Internal storage"
            LaunchableApp(packageName, label, info.loadIcon(packageManager), digest, version.take(80), storageLabel)
        }.distinctBy { it.packageName }.sortedBy { it.label.lowercase() }
        drawAppRows()
    }

    private fun drawAppRows() {
        appList.removeAllViews()
        appRows.clear()
        if (apps.isEmpty()) {
            appList.addView(TextView(this).apply { text = "No launchable apps were discovered for this user profile." })
            return
        }
        val signerChanges = apps.filter { app ->
            val previous = launchGrants[app.packageName]
            previous != null && app.signingCertificateSha256 != null && previous != app.signingCertificateSha256
        }
        if (signerChanges.isNotEmpty()) {
            signerChanges.forEach { app ->
                launchGrants.remove(app.packageName)
                draftGrants.remove(app.packageName)
            }
            store.save(launchGrants.map { (packageName, digest) ->
                AppGrant(packageName, digest, allowLaunch = true, allowDraftInsertion = packageName in draftGrants)
            })
        }
        apps.forEach { app ->
            val digest = app.signingCertificateSha256
            val selected = digest != null && launchGrants[app.packageName] == digest
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), 0, dp(8))
            }
            val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            header.addView(ImageView(this).apply { setImageDrawable(app.icon) },
                LinearLayout.LayoutParams(dp(40), dp(40)))
            header.addView(TextView(this).apply {
                text = app.label + "\n" + app.packageName
                textSize = 12f
                setTextColor(0xff172033.toInt())
                setPadding(dp(9), 0, dp(5), 0)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            val add = CheckBox(this).apply {
                text = "Add"
                isChecked = selected
                isEnabled = digest != null
                setOnCheckedChangeListener { _, checked ->
                    if (checked && digest != null) {
                        launchGrants[app.packageName] = digest
                        appRows[app.packageName]?.second?.isEnabled = true
                    } else {
                        launchGrants.remove(app.packageName)
                        draftGrants.remove(app.packageName)
                        appRows[app.packageName]?.second?.isChecked = false
                        appRows[app.packageName]?.second?.isEnabled = false
                    }
                }
            }
            header.addView(add)
            row.addView(header)
            val draft = CheckBox(this).apply {
                text = "Allow separate draft insertion using Rub Minds keyboard"
                isChecked = selected && app.packageName in draftGrants
                isEnabled = selected
                setOnCheckedChangeListener { _, checked ->
                    if (checked && digest != null && launchGrants[app.packageName] == digest) draftGrants += app.packageName
                    else draftGrants -= app.packageName
                }
            }
            row.addView(draft)
            row.addView(Button(this).apply {
                text = "Open on this phone"
                // This is a deliberate local action, never a cloud-issued
                // remote launch. Saving app selections is a separate step.
                isEnabled = selected
                setOnClickListener { openSelectedAppLocally(app.packageName) }
            })
            row.addView(TextView(this).apply {
                text = "Version " + app.versionName + " · " + app.storageLabel + if (digest == null) " · signer unavailable" else ""
                textSize = 10f
                setTextColor(0xff68758d.toInt())
            })
            row.addView(android.view.View(this).apply { setBackgroundColor(0xffe2e6ef.toInt()) },
                LinearLayout.LayoutParams(-1, dp(1)))
            appList.addView(row)
            appRows[app.packageName] = add to draft
        }
    }

    private fun openSelectedAppLocally(packageName: String) {
        // Use only persisted (saved) grants. A checked box that has not been
        // saved cannot authorize opening an application.
        val digest = AppIdentity.signingCertificateSha256(this, packageName)
        val grant = digest?.let { store.get(packageName, it) }
        if (!AppGrantPolicy.canLaunch(grant, digest)) {
            Toast.makeText(this, "Save the selected app first. Its signing identity must still match.", Toast.LENGTH_LONG).show()
            return
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch == null) {
            Toast.makeText(this, "Android cannot open this app from this user profile.", Toast.LENGTH_LONG).show()
            return
        }
        // The launched application is a normal local Android activity. No
        // background service, remote intent, screen capture or guest VM.
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        android.app.AlertDialog.Builder(this)
            .setTitle("Open selected app?")
            .setMessage("Open ${packageName} locally on this phone? Rub Minds will not share or control its screen.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open") { _, _ ->
                // Recheck after the dialog in case the app was replaced while
                // approval was visible.
                val currentDigest = AppIdentity.signingCertificateSha256(this, packageName)
                val currentGrant = currentDigest?.let { store.get(packageName, it) }
                if (!AppGrantPolicy.canLaunch(currentGrant, currentDigest)) {
                    Toast.makeText(this, "App identity changed. Save the app again.", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                try {
                    startActivity(launch)
                } catch (_: Exception) {
                    Toast.makeText(this, "Android could not open this application.", Toast.LENGTH_LONG).show()
                }
            }
            .show()
    }

    private fun saveChoices() {
        val grants = launchGrants.map { (packageName, digest) ->
            AppGrant(packageName, digest, allowLaunch = true, allowDraftInsertion = packageName in draftGrants)
        }
        store.save(grants)
        appRows.forEach { (packageName, row) -> row.second.isEnabled = packageName in launchGrants }
        syncCloudInventory()
    }

    private fun pairDevice() {
        if (busy) return
        if (cloudApi == null) {
            cloudStatus.text = "This companion build needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY before pairing."
            return
        }
        if (!pairConsent.isChecked) {
            Toast.makeText(this, "Agree to the app-inventory data explanation before pairing.", Toast.LENGTH_LONG).show()
            return
        }
        val code = pairingCodeInput.text.toString().trim().lowercase()
        if (!code.matches(Regex("^[a-f0-9]{64}$"))) {
            Toast.makeText(this, "Enter the complete 64-character one-use code.", Toast.LENGTH_SHORT).show()
            return
        }
        if (vault.token() != null) {
            Toast.makeText(this, "This phone already has a device credential. Check approval or remove the saved credential first.", Toast.LENGTH_LONG).show()
            return
        }
        setBusy(true, "Connecting to Rub Minds over HTTPS…")
        executor.execute {
            try {
                val deviceToken = randomHex(32)
                val deviceId = UUID.randomUUID().toString()
                val label = Build.MODEL?.take(80)?.ifBlank { "Android phone" } ?: "Android phone"
                // Persist first: the server may consume the one-use code even if the
                // HTTPS response is lost. The same device token then recovers via status.
                vault.save(deviceToken, deviceId)
                val result = cloudClient().claim(code, deviceToken, deviceId, label)
                runOnUiThread {
                    pairingCodeInput.text.clear()
                    setBusy(false, if (result.optString("status") == "pending")
                        "Paired. Waiting for the Rub Minds group owner to approve this phone."
                    else "Paired. Check device status.")
                    Toast.makeText(this, "Pairing submitted. Approve this phone in Rub Minds Backroom.", Toast.LENGTH_LONG).show()
                }
            } catch (error: Exception) {
                // A definitive 400/409 means this one-use code did not register the device.
                // Keep the token on timeouts/5xx: the server may have consumed the code already.
                if (error is CloudDeviceApiException &&
                    error.action == "pair/claim" &&
                    (error.statusCode == 400 || error.statusCode == 409)
                ) vault.clear()
                runOnUiThread { setBusy(false, error.message ?: "Device pairing failed.") }
            }
        }
    }

    private fun checkExistingDevice() {
        if (!pairConsent.isChecked) {
            cloudStatus.text = "Cloud requests are paused until you consent. Existing access can be revoked in the Rub Minds web group."
            return
        }
        val token = vault.token()
        if (token == null) {
            if (::cloudStatus.isInitialized && !busy) cloudStatus.text = "Not paired. Create a code in Rub Minds Backroom first."
            return
        }
        if (busy) return
        val rows = selectedInventory()
        setBusy(true, "Checking cloud approval…")
        executor.execute {
            try {
                val status = cloudClient().status(token)
                val state = status.optString("status")
                if (state == "active") {
                    val count = syncInventoryBlocking(token, rows)
                    runOnUiThread { setBusy(false, "Device approved · $count selected app(s) synced to this group.") }
                } else if (state == "pending") {
                    runOnUiThread { setBusy(false, "Waiting for the Rub Minds group owner to approve this phone.") }
                } else {
                    vault.clear()
                    consentPrefs.edit().putBoolean("selected_app_inventory", false).apply()
                    runOnUiThread {
                        pairConsent.isChecked = false
                        setBusy(false, "Device access was revoked. Pair this phone again when invited.")
                    }
                }
            } catch (error: Exception) {
                val message = error.message ?: "Could not check the cloud device status."
                if (message.contains("authentication expired", ignoreCase = true)) {
                    vault.clear()
                    consentPrefs.edit().putBoolean("selected_app_inventory", false).apply()
                }
                runOnUiThread {
                    if (message.contains("authentication expired", ignoreCase = true)) pairConsent.isChecked = false
                    setBusy(false, message)
                }
            }
        }
    }

    private fun syncCloudInventory() {
        if (!pairConsent.isChecked) {
            cloudStatus.text = "Selected apps remain on this phone. Cloud inventory sync is paused until you consent."
            return
        }
        val token = vault.token()
        if (token == null) {
            if (::cloudStatus.isInitialized) cloudStatus.text = "App choices saved on phone. Pair to sync selected apps to the group."
            return
        }
        if (busy) return
        val rows = selectedInventory()
        setBusy(true, "Checking approval before syncing app choices…")
        executor.execute {
            try {
                val status = cloudClient().status(token)
                val state = status.optString("status")
                if (state == "revoked") {
                    vault.clear()
                    consentPrefs.edit().putBoolean("selected_app_inventory", false).apply()
                    runOnUiThread {
                        pairConsent.isChecked = false
                        setBusy(false, "Device access was revoked. Pair this phone again when invited.")
                    }
                    return@execute
                }
                if (state != "active") {
                    runOnUiThread {
                        setBusy(false, "App choices saved on phone. Group-owner approval is still required before sync.")
                    }
                    return@execute
                }
                val count = syncInventoryBlocking(token, rows)
                runOnUiThread { setBusy(false, "$count selected app(s) synced to Backroom.") }
            } catch (error: Exception) {
                runOnUiThread { setBusy(false, error.message ?: "App inventory sync failed.") }
            }
        }
    }

    private fun syncInventoryBlocking(token: String, rows: JSONArray): Int {
        val result = cloudClient().inventory(token, rows)
        return result.optInt("synced", -1).coerceAtLeast(0)
    }

    private fun selectedInventory(): JSONArray {
        val rows = JSONArray()
        apps.filter { app ->
            app.signingCertificateSha256 != null && launchGrants[app.packageName] == app.signingCertificateSha256
        }.forEach { app ->
            rows.put(JSONObject()
                .put("packageName", app.packageName)
                .put("label", app.label.take(120))
                .put("signingCertificateSha256", app.signingCertificateSha256)
                .put("versionName", app.versionName)
                .put("draftInsertionAllowed", app.packageName in draftGrants))
        }
        return rows
    }

    private fun cloudClient(): CloudDeviceApi =
        cloudApi ?: throw IllegalStateException("This companion build is missing the Rub Minds cloud URL or publishable key.")

    private fun setBusy(value: Boolean, message: String) {
        busy = value
        if (::pairButton.isInitialized) pairButton.isEnabled = !value && pairConsent.isChecked && cloudApi != null
        if (::saveButton.isInitialized) saveButton.isEnabled = !value
        if (::pairConsent.isInitialized) pairConsent.isEnabled = !value
        appRows.forEach { (packageName, row) ->
            val hasSigner = apps.any { it.packageName == packageName && it.signingCertificateSha256 != null }
            row.first.isEnabled = !value && hasSigner
            row.second.isEnabled = !value && row.first.isChecked
        }
        if (::cloudStatus.isInitialized) cloudStatus.text = message
    }

    private fun randomHex(size: Int): String {
        val bytes = ByteArray(size)
        SecureRandom().nextBytes(bytes)
        val alphabet = "0123456789abcdef"
        return buildString(bytes.size * 2) {
            bytes.forEach { byte ->
                val item = byte.toInt() and 0xff
                append(alphabet[item ushr 4])
                append(alphabet[item and 15])
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
