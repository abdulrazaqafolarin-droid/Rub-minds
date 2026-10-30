package app.rubminds.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppGrantPolicyTest {
    @Test fun cannotLaunchWithoutAnExplicitGrant() {
        assertFalse(AppGrantPolicy.canLaunch(null))
        assertFalse(AppGrantPolicy.canLaunch(AppGrant("com.example.app", false, true)))
        assertTrue(AppGrantPolicy.canLaunch(AppGrant("com.example.app", true, false)))
    }

    @Test fun draftInsertionRequiresSeparateGrantAndExactForegroundPackage() {
        val grant = AppGrant("com.example.chat", allowLaunch = true, allowDraftInsertion = true)
        assertTrue(AppGrantPolicy.canInsertDraft(grant, "com.example.chat"))
        assertFalse(AppGrantPolicy.canInsertDraft(grant, "com.example.other"))
        assertFalse(AppGrantPolicy.canInsertDraft(grant, null))
        assertFalse(AppGrantPolicy.canInsertDraft(grant.copy(allowDraftInsertion = false), "com.example.chat"))
        assertFalse(AppGrantPolicy.canInsertDraft(grant.copy(allowLaunch = false), "com.example.chat"))
    }

    @Test fun blankOrMismatchedPackagesAreDenied() {
        assertFalse(AppGrantPolicy.canInsertDraft(AppGrant("", true, true), ""))
        assertFalse(AppGrantPolicy.canInsertDraft(AppGrant("com.example.chat", true, true), ""))
    }
}
