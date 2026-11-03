package app.rubminds.companion

import android.text.InputType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppGrantPolicyTest {
    private val normalTextInput = InputType.TYPE_CLASS_TEXT
    private val normalNumberInput = InputType.TYPE_CLASS_NUMBER
    private val signingDigest = "a".repeat(64)
    private val selectedGrant = AppGrant(
        packageName = "com.example.chat",
        signingCertificateSha256 = signingDigest,
        allowLaunch = true,
        allowDraftInsertion = true
    )

    @Test fun cannotLaunchWithoutAnExplicitGrantOrMatchingSigner() {
        assertFalse(AppGrantPolicy.canLaunch(null, signingDigest))
        assertFalse(AppGrantPolicy.canLaunch(selectedGrant.copy(allowLaunch = false), signingDigest))
        assertFalse(AppGrantPolicy.canLaunch(selectedGrant, null))
        assertFalse(AppGrantPolicy.canLaunch(selectedGrant, "b".repeat(64)))
        assertTrue(AppGrantPolicy.canLaunch(selectedGrant, signingDigest))
        assertTrue(AppGrantPolicy.canLaunch(selectedGrant.copy(allowDraftInsertion = false), signingDigest))
    }

    @Test fun draftInsertionRequiresSeparateGrantExactPackageAndMatchingSigner() {
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.other", signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, null, signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", "b".repeat(64), normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant.copy(allowDraftInsertion = false), "com.example.chat", signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant.copy(allowLaunch = false), "com.example.chat", signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant.copy(packageName = ""), "", signingDigest, normalTextInput))
    }

    @Test fun composerSelectionRequiresEitherDraftGrantOrSeparateNativeWakeConsent() {
        assertTrue(AppGrantPolicy.canSelectComposerTarget(selectedGrant, signingDigest, false))
        assertTrue(AppGrantPolicy.canSelectComposerTarget(
            selectedGrant.copy(allowDraftInsertion = false), signingDigest, true
        ))
        assertFalse(AppGrantPolicy.canSelectComposerTarget(
            selectedGrant.copy(allowDraftInsertion = false), signingDigest, false
        ))
        assertFalse(AppGrantPolicy.canSelectComposerTarget(
            selectedGrant.copy(allowLaunch = false, allowDraftInsertion = false), signingDigest, true
        ))
        assertFalse(AppGrantPolicy.canSelectComposerTarget(
            selectedGrant.copy(allowDraftInsertion = false), "b".repeat(64), true
        ))
    }

    @Test fun sensitiveTextVariationsAreAlwaysDenied() {
        val passwordTypes = listOf(
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        )
        passwordTypes.forEach { inputType ->
            assertTrue("Expected sensitive input type $inputType", AppGrantPolicy.isSensitiveInput(inputType))
            assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, inputType))
        }
    }

    @Test fun ordinaryTextNumericAndPhoneEditorsAreAllowed() {
        val phoneInput = InputType.TYPE_CLASS_PHONE
        assertFalse(AppGrantPolicy.isSensitiveInput(normalTextInput))
        assertFalse(AppGrantPolicy.isSensitiveInput(normalNumberInput))
        assertTrue(AppGrantPolicy.isSupportedInputType(normalTextInput))
        assertTrue(AppGrantPolicy.isSupportedInputType(normalNumberInput))
        assertTrue(AppGrantPolicy.isSupportedInputType(phoneInput))
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, normalTextInput))
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, normalNumberInput))
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, phoneInput))
    }

    @Test fun packageAndSigningIdentifiersMustBeWellFormed() {
        assertTrue(AppGrantPolicy.isValidPackageName("com.example.chat"))
        assertTrue(AppGrantPolicy.isValidPackageName("org.example_2.mobile"))
        assertFalse(AppGrantPolicy.isValidPackageName(""))
        assertFalse(AppGrantPolicy.isValidPackageName("com"))
        assertFalse(AppGrantPolicy.isValidPackageName("com..chat"))
        assertFalse(AppGrantPolicy.isValidPackageName("com._hidden.mobile"))
        assertFalse(AppGrantPolicy.isValidPackageName("_org.example"))
        assertFalse(AppGrantPolicy.isValidPackageName("com.example;rm"))
        assertTrue(AppGrantPolicy.isValidSigningCertificateSha256(signingDigest))
        assertTrue(AppGrantPolicy.isValidSigningCertificateSha256(signingDigest + "." + "b".repeat(64)))
        assertFalse(AppGrantPolicy.isValidSigningCertificateSha256("not-a-digest"))
        assertFalse(AppGrantPolicy.isValidSigningCertificateSha256(signingDigest.uppercase()))
    }

    @Test fun unsupportedAndUnknownEditorsFailClosed() {
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "", signingDigest, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", null, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, InputType.TYPE_NULL))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", signingDigest, InputType.TYPE_CLASS_DATETIME))
        assertFalse(AppGrantPolicy.isSupportedInputType(InputType.TYPE_NULL))
        assertFalse(AppGrantPolicy.isSupportedInputType(InputType.TYPE_CLASS_DATETIME))
    }
}
