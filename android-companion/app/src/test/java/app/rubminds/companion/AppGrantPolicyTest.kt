package app.rubminds.companion

import android.text.InputType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppGrantPolicyTest {
    private val normalTextInput = InputType.TYPE_CLASS_TEXT
    private val normalNumberInput = InputType.TYPE_CLASS_NUMBER
    private val selectedGrant = AppGrant(
        packageName = "com.example.chat",
        allowLaunch = true,
        allowDraftInsertion = true
    )

    @Test fun cannotLaunchWithoutAnExplicitGrant() {
        assertFalse(AppGrantPolicy.canLaunch(null))
        assertFalse(AppGrantPolicy.canLaunch(AppGrant("com.example.app", false, true)))
        assertTrue(AppGrantPolicy.canLaunch(AppGrant("com.example.app", true, false)))
        assertFalse(AppGrantPolicy.canLaunch(AppGrant("", true, true)))
    }

    @Test fun draftInsertionRequiresSeparateGrantAndExactForegroundPackage() {
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.other", normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, null, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant.copy(allowDraftInsertion = false), "com.example.chat", normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant.copy(allowLaunch = false), "com.example.chat", normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(AppGrant("", true, true), "", normalTextInput))
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
            assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", inputType))
        }
    }

    @Test fun ordinaryTextAndNumberFieldsAreNotMistakenForPasswordFields() {
        assertFalse(AppGrantPolicy.isSensitiveInput(normalTextInput))
        assertFalse(AppGrantPolicy.isSensitiveInput(normalNumberInput))
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", normalTextInput))
        assertTrue(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", normalNumberInput))
    }

    @Test fun packageAndCapabilityMismatchesFailClosed() {
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "", normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, null, normalTextInput))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", InputType.TYPE_NULL))
        assertFalse(AppGrantPolicy.canInsertDraft(selectedGrant, "com.example.chat", InputType.TYPE_CLASS_DATETIME))
        assertFalse(AppGrantPolicy.isSupportedInputType(InputType.TYPE_NULL))
        assertFalse(AppGrantPolicy.isSupportedInputType(InputType.TYPE_CLASS_DATETIME))
    }
}
