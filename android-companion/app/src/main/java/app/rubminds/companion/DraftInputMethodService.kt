package app.rubminds.companion

import android.inputmethodservice.InputMethodService
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Optional user-enabled draft keyboard.
 *
 * Text is composed inside this keyboard. A local user must tap Insert draft.
 * The insertion is restricted to the exact selected foreground app package.
 * This service never presses Send, submits a form or reads existing field text.
 */
class DraftInputMethodService : InputMethodService() {
    private var activePackage: String? = null
    private var status: TextView? = null
    private var draft: EditText? = null
    private var insert: Button? = null
    private val keyButtons = mutableListOf<Button>()

    override fun onCreateInputView(): View {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(12, 8, 12, 8)
        }
        status = TextView(this).apply { textSize = 12f }
        draft = EditText(this).apply {
            hint = "Compose a draft here"
            setSingleLine(false)
            setMinLines(2)
            setShowSoftInputOnFocus(false)
        }
        panel.addView(status)
        panel.addView(draft, LinearLayout.LayoutParams(-1, -2))

        addCharacterRow(panel, "qwertyuiop")
        addCharacterRow(panel, "asdfghjkl")
        addCharacterRow(panel, "zxcvbnm")

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        controls.addView(makeKey("Space") { draft?.append(" ") }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(makeKey("Delete") {
            val value = draft?.text
            if (value != null && value.isNotEmpty()) value.delete(value.length - 1, value.length)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(makeKey("Clear") { draft?.text?.clear() }, LinearLayout.LayoutParams(0, -2, 1f))
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
        activePackage = attribute?.packageName
        updatePermissionState()
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        activePackage = info?.packageName ?: currentInputEditorInfo?.packageName
        updatePermissionState()
    }

    private fun addCharacterRow(parent: LinearLayout, characters: String) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        characters.forEach { character ->
            row.addView(makeKey(character.toString()) { draft?.append(character) },
                LinearLayout.LayoutParams(0, dp(44), 1f))
        }
        parent.addView(row)
    }

    private fun makeKey(label: String, action: () -> Unit): Button =
        Button(this).apply {
            text = label
            minWidth = 0
            setPadding(0, 0, 0, 0)
            setOnClickListener {
                if (insert?.isEnabled == false) return@setOnClickListener
                action()
            }.also { keyButtons += this }
        }

    private fun updatePermissionState() {
        val allowed = AppGrantPolicy.canInsertDraft(
            AppGrantStore(this).get(activePackage.orEmpty()),
            activePackage
        )
        status?.text = if (allowed) {
            "Draft permission enabled for ${activePackage}."
        } else {
            "Draft insertion is not approved for this app. Change app choices in Rub Minds Companion."
        }
        insert?.isEnabled = allowed
        draft?.isEnabled = allowed
        keyButtons.forEach { it.isEnabled = allowed }
    }

    private fun insertDraft() {
        val targetPackage = activePackage
        val grant = AppGrantStore(this).get(targetPackage.orEmpty())
        if (!AppGrantPolicy.canInsertDraft(grant, currentInputEditorInfo?.packageName)) {
            updatePermissionState()
            Toast.makeText(this, "This app has not been approved for draft insertion.", Toast.LENGTH_SHORT).show()
            return
        }
        val text = draft?.text?.toString().orEmpty()
        if (text.isBlank()) {
            Toast.makeText(this, "Enter a draft first.", Toast.LENGTH_SHORT).show()
            return
        }
        val connection = currentInputConnection
        if (connection == null || !connection.commitText(text, 1)) {
            Toast.makeText(this, "The target app rejected text insertion.", Toast.LENGTH_SHORT).show()
            return
        }
        draft?.text?.clear()
        Toast.makeText(this, "Draft inserted. Nothing was sent.", Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
