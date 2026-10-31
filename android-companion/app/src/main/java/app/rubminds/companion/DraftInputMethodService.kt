package app.rubminds.companion

import android.content.ComponentName
import android.content.Context
import android.inputmethodservice.InputMethodService
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Optional user-enabled draft keyboard.
 *
 * Text is composed inside this keyboard. A local user must tap Insert draft.
 * Insertion is restricted to the exact selected foreground app package and
 * password/credential fields are rejected. The keyboard never submits a form,
 * sends a message, or reads existing editor content.
 */
class DraftInputMethodService : InputMethodService() {
    private var activePackage: String? = null
    private var activeInputType: Int = InputType.TYPE_NULL
    private var activeSigningCertificateSha256: String? = null
    private val draftText = StringBuilder()
    private var shiftEnabled = false
    private var preview: TextView? = null
    private var status: TextView? = null
    private var insert: Button? = null
    private val keyButtons = mutableListOf<Button>()
    private val characterKeys = mutableListOf<Pair<Button, Char>>()

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
    }

    override fun onDestroy() {
        if (activeInstance === this) activeInstance = null
        super.onDestroy()
    }

    override fun onCreateInputView(): View {
        keyButtons.clear()
        characterKeys.clear()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        status = TextView(this).apply { textSize = 12f }
        preview = TextView(this).apply {
            textSize = 16f
            minHeight = dp(48)
            setPadding(dp(8), dp(8), dp(8), dp(8))
            text = "Your draft appears here"
        }
        panel.addView(status)
        panel.addView(preview)

        addCharacterRow(panel, "1234567890")
        addCharacterRow(panel, "qwertyuiop")
        addCharacterRow(panel, "asdfghjkl")
        addCharacterRow(panel, "zxcvbnm")

        val punctuation = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        ".,?!'-@".forEach { character ->
            punctuation.addView(makeKey(character.toString()) {
                draftText.append(character)
                refreshPreview()
            }, LinearLayout.LayoutParams(0, dp(40), 1f))
        }
        panel.addView(punctuation)

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        controls.addView(makeKey("Shift") {
            shiftEnabled = !shiftEnabled
            refreshCharacterKeys()
        }, LinearLayout.LayoutParams(0, dp(44), 1f))
        controls.addView(makeKey("Space") { draftText.append(' '); refreshPreview() },
            LinearLayout.LayoutParams(0, dp(44), 1f))
        controls.addView(makeKey("Delete") {
            if (draftText.isNotEmpty()) draftText.deleteCharAt(draftText.length - 1)
            refreshPreview()
        }, LinearLayout.LayoutParams(0, dp(44), 1f))
        controls.addView(makeKey("Clear") {
            draftText.clear()
            refreshPreview()
        }, LinearLayout.LayoutParams(0, dp(44), 1f))
        panel.addView(controls)

        insert = Button(this).apply {
            text = "Insert draft"
            setOnClickListener { insertDraft() }
        }
        panel.addView(insert)
        updatePermissionState()
        return panel
    }

    @Suppress("UNUSED_PARAMETER")
    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        // Clear every editor-start session so text cannot carry into another field.
        clearDraft()
        updateEditorTarget(attribute)
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        updateEditorTarget(info ?: currentInputEditorInfo)
    }

    override fun onFinishInput() {
        super.onFinishInput()
        activePackage = null
        activeInputType = InputType.TYPE_NULL
        activeSigningCertificateSha256 = null
        clearDraft()
        updatePermissionState()
    }

    private fun updateEditorTarget(info: EditorInfo?) {
        val nextPackage = info?.packageName
        if (activePackage != nextPackage) clearDraft()
        activePackage = nextPackage
        activeInputType = info?.inputType ?: InputType.TYPE_NULL
        activeSigningCertificateSha256 = nextPackage?.let {
            AppIdentity.signingCertificateSha256(this, it)
        }
        updatePermissionState()
    }

    private fun addCharacterRow(parent: LinearLayout, characters: String) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        characters.forEach { character ->
            val key = makeKey(character.toString()) {
                draftText.append(if (shiftEnabled) character.uppercaseChar() else character)
                shiftEnabled = false
                refreshCharacterKeys()
                refreshPreview()
            }
            characterKeys += key to character
            row.addView(key, LinearLayout.LayoutParams(0, dp(44), 1f))
        }
        parent.addView(row)
    }

    private fun clearDraft() {
        draftText.clear()
        shiftEnabled = false
        refreshCharacterKeys()
        refreshPreview()
    }

    private fun refreshCharacterKeys() {
        characterKeys.forEach { (button, character) ->
            button.text = if (shiftEnabled) character.uppercaseChar().toString() else character.toString()
        }
    }

    private fun makeKey(label: String, action: () -> Unit): Button =
        Button(this).apply {
            text = label
            minWidth = 0
            setPadding(0, 0, 0, 0)
            setOnClickListener {
                if (isInsertAllowed()) action()
            }
            keyButtons += this
        }

    private fun isInsertAllowed(verifyCurrentSigner: Boolean = false): Boolean {
        val liveEditor = currentInputEditorInfo ?: return false
        val packageName = activePackage ?: return false
        // Fail closed if the editor changed without the service observing a new input event.
        if (packageName.isBlank() ||
            liveEditor.packageName != packageName ||
            liveEditor.inputType != activeInputType
        ) return false
        val activeDigest = activeSigningCertificateSha256 ?: return false
        if (verifyCurrentSigner) {
            val currentDigest = AppIdentity.signingCertificateSha256(this, packageName) ?: return false
            if (currentDigest != activeDigest) return false
        }
        val grant = AppGrantStore(this).get(packageName, activeDigest) ?: return false
        return AppGrantPolicy.canInsertDraft(
            grant,
            liveEditor.packageName,
            activeDigest,
            liveEditor.inputType
        )
    }

    private fun updatePermissionState() {
        val allowed = isInsertAllowed()
        status?.text = when {
            allowed -> "Draft insertion is enabled for $activePackage."
            activeSigningCertificateSha256 == null -> "Draft insertion is unavailable because this app's signing identity could not be verified."
            AppGrantPolicy.isSensitiveInput(activeInputType) -> "Draft insertion is disabled in password fields."
            else -> "Draft insertion is not approved for this app. Change app choices in Rub Minds Companion."
        }
        insert?.isEnabled = allowed
        keyButtons.forEach { it.isEnabled = allowed }
    }

    private fun refreshPreview() {
        preview?.text = draftText.toString().ifEmpty { "Your draft appears here" }
    }

    private fun insertDraft() {
        // Re-check the live editor and current APK signer immediately before the only write operation.
        if (!isInsertAllowed(verifyCurrentSigner = true)) {
            updatePermissionState()
            Toast.makeText(this, "This app or field is not approved for draft insertion.", Toast.LENGTH_SHORT).show()
            return
        }
        val text = draftText.toString()
        if (text.isBlank()) {
            Toast.makeText(this, "Enter a draft first.", Toast.LENGTH_SHORT).show()
            return
        }
        val connection = currentInputConnection
        if (connection == null || !connection.commitText(text, 1)) {
            Toast.makeText(this, "The target app rejected text insertion.", Toast.LENGTH_SHORT).show()
            return
        }
        draftText.clear()
        refreshPreview()
        Toast.makeText(this, "Draft inserted. Nothing was sent.", Toast.LENGTH_SHORT).show()
    }

    /**
     * Insert text received from the active, locally consented Backroom session.
     * This deliberately exposes commitText only: no editor reads, key events,
     * IME actions, Enter key, or submit operation are available to the caller.
     */
    private fun insertRemoteText(sessionId: String, packageName: String, text: String): String {
        if (!RemoteKeyboardGate.isArmed()) return "local_typing_permission_not_armed"
        if (boundSessionId != sessionId || boundPackageName != packageName) return "session_or_app_mismatch"
        if (text.isBlank() || text.length > MAX_REMOTE_TEXT_CHARS || text.any { Character.isISOControl(it) }) {
            return "text_invalid_or_too_long"
        }
        val liveEditor = currentInputEditorInfo ?: return "phone_text_field_not_focused"
        if (activePackage != packageName || liveEditor.packageName != packageName) return "phone_text_field_wrong_app"
        if (AppGrantPolicy.isSensitiveInput(liveEditor.inputType)) return "sensitive_field_blocked"
        if (!isInsertAllowed(verifyCurrentSigner = true)) return "app_or_field_not_approved"
        val connection = currentInputConnection ?: return "phone_keyboard_not_active"
        return if (connection.commitText(text, 1)) "inserted" else "phone_editor_rejected_text"
    }

    companion object {
        private const val MAX_REMOTE_TEXT_CHARS = 4_000

        @Volatile private var activeInstance: DraftInputMethodService? = null
        @Volatile private var boundSessionId: String? = null
        @Volatile private var boundPackageName: String? = null

        fun isEnabledAndSelected(context: Context): Boolean {
            val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return false
            val component = ComponentName(context, DraftInputMethodService::class.java).flattenToString()
            val enabled = manager.enabledInputMethodList.any { it.id == component }
            val selected = Settings.Secure.getString(
                context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD
            ) == component
            return enabled && selected
        }

        fun bindRemoteSession(sessionId: String, packageName: String) {
            boundSessionId = sessionId
            boundPackageName = packageName
        }

        fun clearRemoteSession(sessionId: String? = null) {
            if (sessionId == null || boundSessionId == sessionId) {
                boundSessionId = null
                boundPackageName = null
            }
        }

        fun insertRemoteText(sessionId: String, packageName: String, text: String): String =
            activeInstance?.insertRemoteText(sessionId, packageName, text) ?: "phone_keyboard_not_active"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
