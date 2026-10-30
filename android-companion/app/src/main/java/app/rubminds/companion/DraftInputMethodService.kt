package app.rubminds.companion

import android.inputmethodservice.InputMethodService
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
    private val draftText = StringBuilder()
    private var preview: TextView? = null
    private var status: TextView? = null
    private var insert: Button? = null
    private val keyButtons = mutableListOf<Button>()

    override fun onCreateInputView(): View {
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

        addCharacterRow(panel, "qwertyuiop")
        addCharacterRow(panel, "asdfghjkl")
        addCharacterRow(panel, "zxcvbnm")

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
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

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
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
        draftText.clear()
        refreshPreview()
        updatePermissionState()
    }

    private fun updateEditorTarget(info: EditorInfo?) {
        val nextPackage = info?.packageName
        if (activePackage != nextPackage) {
            // Never carry a draft composed for one app into a different app.
            draftText.clear()
            refreshPreview()
        }
        activePackage = nextPackage
        activeInputType = info?.inputType ?: InputType.TYPE_NULL
        updatePermissionState()
    }

    private fun addCharacterRow(parent: LinearLayout, characters: String) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        characters.forEach { character ->
            row.addView(makeKey(character.toString()) {
                draftText.append(character)
                refreshPreview()
            }, LinearLayout.LayoutParams(0, dp(44), 1f))
        }
        parent.addView(row)
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

    private fun isInsertAllowed(): Boolean = AppGrantPolicy.canInsertDraft(
        AppGrantStore(this).get(activePackage.orEmpty()),
        currentInputEditorInfo?.packageName ?: activePackage,
        currentInputEditorInfo?.inputType ?: activeInputType
    )

    private fun updatePermissionState() {
        val allowed = isInsertAllowed()
        status?.text = when {
            allowed -> "Draft insertion is enabled for $activePackage."
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
        // Re-check the live editor immediately before the only write operation.
        if (!isInsertAllowed()) {
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

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
