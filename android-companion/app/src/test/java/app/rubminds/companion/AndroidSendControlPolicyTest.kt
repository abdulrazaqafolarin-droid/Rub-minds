package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSendControlPolicyTest {
    private val root = ComposerScreenRect(0, 0, 1_000, 1_800)
    private val composer = ComposerScreenRect(100, 1_450, 900, 1_700)

    private fun candidate(
        id: String = "a".repeat(64),
        packageName: String = "com.example.chat",
        bounds: ComposerScreenRect = ComposerScreenRect(820, 1_630, 960, 1_700),
        label: String = "Send",
        resourceId: String = "com.example.chat:id/send_button",
        clickable: Boolean = true,
        enabled: Boolean = true,
        visible: Boolean = true
    ) = SendControlCandidate(
        id, packageName, bounds, label, resourceId, clickable, enabled, visible
    )

    @Test fun acceptsOneVisibleEnabledClickableSendControlBesideTheSelectedComposer() {
        val result = AndroidSendControlPolicy.choose(
            listOf(candidate()), "com.example.chat", root, composer
        )
        assertEquals("unique_send_control_verified", result.reason)
        assertNotNull(result.candidate)
    }

    @Test fun acceptsExactAccessibleSendLabelsAndAnUnlabelledSendResourceId() {
        for (label in listOf("Send", " send message ", "SEND PROMPT")) {
            val result = AndroidSendControlPolicy.choose(
                listOf(candidate(label = label)), "com.example.chat", root, composer
            )
            assertEquals("unique_send_control_verified", result.reason)
        }
        for (resourceId in listOf(
            "com.example.chat:id/composer_send",
            "com.example.chat:id/sendButton",
            "com.example.chat:id/buttonSend"
        )) {
            val recognized = candidate(label = "", resourceId = resourceId)
            assertTrue(
                AndroidSendControlPolicy.choose(
                    listOf(recognized), "com.example.chat", root, composer
                ).candidate != null
            )
        }
        for (resourceId in listOf(
            "com.example.chat:id/send_to_email",
            "com.example.chat:id/send_feedback_button",
            "com.example.chat:id/share_send_button",
            "com.example.chat:id/resend_button",
            "com.example.chat:id/reSendButton",
            "com.example.chat:id/sendToEmail",
            "com.example.chat:id/composerSendFeedback",
            "com.example.chat:id/sendToShare",
            "com.example.chat:id/sendEmailButton",
            "com.example.chat:id/sendFeedbackButton"
        )) {
            val misleading = candidate(label = "", resourceId = resourceId)
            assertNull(AndroidSendControlPolicy.choose(
                listOf(misleading), "com.example.chat", root, composer
            ).candidate)
        }
    }

    @Test fun rejectsGenericOrMisleadingAccessibleNames() {
        for (label in listOf("Send feedback", "Submit", "Share", "Send to email", "New message")) {
            val result = AndroidSendControlPolicy.choose(
                listOf(candidate(label = label, resourceId = "")), "com.example.chat", root, composer
            )
            assertNull(result.candidate)
        }
    }

    @Test fun requiresExactPackageAndLiveClickableEnabledVisibleControl() {
        val invalid = listOf(
            candidate(packageName = "com.example.other"),
            candidate(clickable = false),
            candidate(enabled = false),
            candidate(visible = false),
            candidate(id = "not-a-sha256")
        )
        val result = AndroidSendControlPolicy.choose(
            invalid, "com.example.chat", root, composer
        )
        assertNull(result.candidate)
        assertEquals("unique_nearby_send_control_not_found", result.reason)
    }

    @Test fun rejectsControlsOutsideTheAppWindowOrFarFromTheSelectedComposer() {
        val outside = candidate(bounds = ComposerScreenRect(1_010, 1_630, 1_080, 1_700))
        val distant = candidate(bounds = ComposerScreenRect(820, 100, 960, 160))
        val farAcrossRow = candidate(bounds = ComposerScreenRect(900, 1_630, 990, 1_700))
        val narrowComposer = ComposerScreenRect(100, 1_450, 400, 1_700)
        val result = AndroidSendControlPolicy.choose(
            listOf(outside, distant, farAcrossRow), "com.example.chat", root, narrowComposer
        )
        assertNull(result.candidate)
    }

    @Test fun rejectsSendControlsFarAcrossTheComposerRow() {
        val farRight = candidate(bounds = ComposerScreenRect(990, 1_630, 1_000, 1_700))
        val farLeft = candidate(bounds = ComposerScreenRect(0, 1_630, 10, 1_700))
        val result = AndroidSendControlPolicy.choose(
            listOf(farRight, farLeft), "com.example.chat", root, composer
        )
        assertNull(result.candidate)
        assertEquals("unique_nearby_send_control_not_found", result.reason)
    }

    @Test fun refusesMultipleMatchingSendControlsInsteadOfGuessing() {
        val result = AndroidSendControlPolicy.choose(
            listOf(candidate(id = "a".repeat(64)), candidate(id = "b".repeat(64))),
            "com.example.chat", root, composer
        )
        assertNull(result.candidate)
        assertEquals("multiple_send_controls_ambiguous", result.reason)
    }

    @Test fun malformedWindowOrComposerBoundsFailClosed() {
        val badRoot = ComposerScreenRect(0, 0, 0, 1_800)
        val result = AndroidSendControlPolicy.choose(
            listOf(candidate()), "com.example.chat", badRoot, composer
        )
        assertNull(result.candidate)
        assertEquals("invalid_app_or_composer_bounds", result.reason)
    }
}
