package app.rubminds.companion

import android.text.InputType

/**
 * Local authorization policy for the Android companion.
 *
 * Selecting an app does not grant access to its private data or screen.
 * Draft insertion is a separate capability and is checked against both the
 * exact foreground package and the editor's input type.
 */
data class AppGrant(
    val packageName: String,
    val allowLaunch: Boolean,
    val allowDraftInsertion: Boolean
)

object AppGrantPolicy {
    private val packageNamePattern =
        Regex("^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+$")

    fun isValidPackageName(packageName: String): Boolean =
        packageNamePattern.matches(packageName)

    fun canLaunch(grant: AppGrant?): Boolean =
        grant != null && isValidPackageName(grant.packageName) && grant.allowLaunch

    fun isSensitiveInput(inputType: Int): Boolean {
        val inputClass = inputType and InputType.TYPE_MASK_CLASS
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (inputClass) {
            InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    fun isSupportedInputType(inputType: Int): Boolean {
        val inputClass = inputType and InputType.TYPE_MASK_CLASS
        return inputClass == InputType.TYPE_CLASS_TEXT || inputClass == InputType.TYPE_CLASS_NUMBER
    }

    fun canInsertDraft(
        grant: AppGrant?,
        foregroundPackage: String?,
        inputType: Int
    ): Boolean =
        grant != null &&
            isValidPackageName(grant.packageName) &&
            grant.allowLaunch &&
            grant.allowDraftInsertion &&
            !foregroundPackage.isNullOrBlank() &&
            grant.packageName == foregroundPackage &&
            isSupportedInputType(inputType) &&
            !isSensitiveInput(inputType)
}
