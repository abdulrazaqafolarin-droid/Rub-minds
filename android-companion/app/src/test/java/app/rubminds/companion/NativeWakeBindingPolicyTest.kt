package app.rubminds.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeWakeBindingPolicyTest {
    private val sessionId = "72000000-0000-4000-8000-000000000001"
    private val packageName = "com.example.chat"
    private val composerId = "a".repeat(64)
    private val sendId = "b".repeat(64)

    private fun isCurrent(
        generation: Long = 7L,
        currentGeneration: Long = 7L,
        session: String? = sessionId,
        app: String? = packageName,
        composer: String? = composerId,
        send: String? = sendId
    ) = NativeWakeBindingPolicy.isCurrent(
        expectedGeneration = generation,
        currentGeneration = currentGeneration,
        expectedSessionId = sessionId,
        currentSessionId = session,
        expectedPackageName = packageName,
        currentPackageName = app,
        expectedComposerTargetId = composerId,
        currentComposerTargetId = composer,
        expectedSendTargetId = sendId,
        currentSendTargetId = send
    )

    @Test fun nativeWakeRequiresTheExactUninterruptedSessionAndTargetBinding() {
        assertTrue(isCurrent())
        assertFalse(isCurrent(currentGeneration = 8L))
        assertFalse(isCurrent(session = null))
        assertFalse(isCurrent(session = "72000000-0000-4000-8000-000000000002"))
        assertFalse(isCurrent(app = "com.example.other"))
        assertFalse(isCurrent(composer = "c".repeat(64)))
        assertFalse(isCurrent(send = "d".repeat(64)))
        assertFalse(isCurrent(composer = null))
        assertFalse(isCurrent(send = null))
    }

    @Test fun emptyExpectedBindingValuesCanNeverAuthorizeNativeSend() {
        assertFalse(NativeWakeBindingPolicy.isCurrent(
            expectedGeneration = 7L,
            currentGeneration = 7L,
            expectedSessionId = "",
            currentSessionId = "",
            expectedPackageName = packageName,
            currentPackageName = packageName,
            expectedComposerTargetId = composerId,
            currentComposerTargetId = composerId,
            expectedSendTargetId = sendId,
            currentSendTargetId = sendId
        ))
        assertFalse(NativeWakeBindingPolicy.isCurrent(
            expectedGeneration = 7L,
            currentGeneration = 7L,
            expectedSessionId = sessionId,
            currentSessionId = sessionId,
            expectedPackageName = packageName,
            currentPackageName = packageName,
            expectedComposerTargetId = composerId,
            currentComposerTargetId = composerId,
            expectedSendTargetId = "",
            currentSendTargetId = ""
        ))
    }
}
