package app.rubminds.companion

import android.text.InputType

/**
 * Local authorization policy for the Android companion.
 *
 * A package grant is also bound to the current APK signing-certificate
 * fingerprint. A different signer reusing the same package name cannot inherit
 * an earlier launch or draft-insertion approval.
 */
data class AppGrant(
    val packageName: String,
    val signingCertificateSha256: String,
    val allowLaunch: Boolean,
    val allowDraftInsertion: Boolean
)

object AppGrantPolicy {
    private val packageNamePattern =
        Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val signingCertificatePattern =
        Regex("^[a-f0-9]{64}(?:\\.[a-f0-9]{64})*$")

    fun isValidPackageName(packageName: String): Boolean =
        packageNamePattern.matches(packageName)

    fun isValidSigningCertificateSha256(value: String): Boolean =
        signingCertificatePattern.matches(value)

    fun canLaunch(
        grant: AppGrant?,
        currentSigningCertificateSha256: String?
    ): Boolean =
        grant != null &&
            isValidPackageName(grant.packageName) &&
            isValidSigningCertificateSha256(grant.signingCertificateSha256) &&
            !currentSigningCertificateSha256.isNullOrBlank() &&
            grant.signingCertificateSha256 == currentSigningCertificateSha256 &&
            grant.allowLaunch

    fun canSelectComposerTarget(
        grant: AppGrant?,
        currentSigningCertificateSha256: String?,
        hasActiveNativeWakeConsent: Boolean
    ): Boolean =
        canLaunch(grant, currentSigningCertificateSha256) &&
            (grant?.allowDraftInsertion == true || hasActiveNativeWakeConsent)

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
        // The companion keyboard has digits and punctuation, so ordinary text,
        // numeric and phone editors are supported. Sensitive numeric passwords
        // remain blocked by isSensitiveInput(); date/time and unknown classes fail closed.
        return when (inputType and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_TEXT,
            InputType.TYPE_CLASS_NUMBER,
            InputType.TYPE_CLASS_PHONE -> true
            else -> false
        }
    }

    fun canInsertDraft(
        grant: AppGrant?,
        foregroundPackage: String?,
        currentSigningCertificateSha256: String?,
        inputType: Int
    ): Boolean {
        if (!canLaunch(grant, currentSigningCertificateSha256)) return false
        val selectedGrant = grant ?: return false
        return selectedGrant.allowDraftInsertion &&
            !foregroundPackage.isNullOrBlank() &&
            selectedGrant.packageName == foregroundPackage &&
            isSupportedInputType(inputType) &&
            !isSensitiveInput(inputType)
    }
}
