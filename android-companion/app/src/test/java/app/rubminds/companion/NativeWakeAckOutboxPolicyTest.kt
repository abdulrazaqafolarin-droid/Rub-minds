package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeWakeAckOutboxPolicyTest {
    private val commandId = "76000000-0000-4000-8000-000000000001"
    private val requestId = "75000000-0000-4000-8000-000000000001"
    private val sessionId = "74000000-0000-4000-8000-000000000001"

    private fun entry(
        payload: String = """{"result":"native_wake_needs_review"}""",
        stage: NativeWakeAckOutboxStage = NativeWakeAckOutboxStage.PREPARED,
        savedAt: Long = 100L,
        command: String = commandId,
        request: String = requestId,
        session: String = sessionId
    ) = PendingNativeWakeAcknowledgement(command, request, session, payload, stage, savedAt)

    @Test fun preparedPlaceholderIsPromotedToOneExactFinalReceipt() {
        val prepared = entry()
        val final = entry(
            payload = """{"result":"native_wake_submitted","nativeWakeResult":{"state":"submitted"}}""",
            stage = NativeWakeAckOutboxStage.FINAL,
            savedAt = 200L
        )
        val inserted = NativeWakeAckOutboxPolicy.upsert(emptyList(), prepared)
        assertEquals(listOf(prepared), inserted)
        val promoted = NativeWakeAckOutboxPolicy.upsert(inserted!!, final)
        assertEquals(listOf(final), promoted)
        assertEquals(listOf(final), NativeWakeAckOutboxPolicy.upsert(promoted!!, final))
        assertNull(NativeWakeAckOutboxPolicy.upsert(
            promoted, final.copy(payloadJson = """{"result":"native_wake_needs_review"}""")
        ))
        assertNull(NativeWakeAckOutboxPolicy.upsert(
            promoted, final.copy(requestId = "75000000-0000-4000-8000-000000000002")
        ))
    }

    @Test fun outboxIsBoundedAndMalformedEntriesFailClosed() {
        val rows = (1..NativeWakeAckOutboxPolicy.MAX_PENDING_ACKS).map { index ->
            entry(
                command = "76000000-0000-4000-8000-${index.toString().padStart(12, '0')}",
                request = "75000000-0000-4000-8000-${index.toString().padStart(12, '0')}"
            )
        }
        assertEquals(NativeWakeAckOutboxPolicy.MAX_PENDING_ACKS, rows.size)
        assertNull(NativeWakeAckOutboxPolicy.upsert(rows, entry(
            command = "76000000-0000-4000-8000-000000000999",
            request = "75000000-0000-4000-8000-000000000999"
        )))
        assertFalse(NativeWakeAckOutboxPolicy.isValid(entry(command = "not-a-uuid")))
        assertFalse(NativeWakeAckOutboxPolicy.isValid(entry(payload = "x".repeat(
            NativeWakeAckOutboxPolicy.MAX_ACK_PAYLOAD_CHARS + 1
        ))))
        assertFalse(NativeWakeAckOutboxPolicy.isValid(entry(savedAt = 0L)))
        assertNull(NativeWakeAckOutboxPolicy.upsert(listOf(entry(), entry()), entry(
            command = "76000000-0000-4000-8000-000000000999",
            request = "75000000-0000-4000-8000-000000000999"
        )))
    }

    @Test fun targetIdsFollowTheOpaqueProtocolIdentifierContract() {
        assertTrue(NativeWakeAckOutboxPolicy.isValidTargetId("target-native-draft"))
        assertTrue(NativeWakeAckOutboxPolicy.isValidTargetId("composer:provider/session"))
        assertFalse(NativeWakeAckOutboxPolicy.isValidTargetId(""))
        assertFalse(NativeWakeAckOutboxPolicy.isValidTargetId("   "))
        assertFalse(NativeWakeAckOutboxPolicy.isValidTargetId("target\u0000native"))
        assertFalse(NativeWakeAckOutboxPolicy.isValidTargetId("x".repeat(129)))
    }

    @Test fun receiptRemainsPendingUntilTheExactFinalPayloadIsConfirmed() {
        val final = entry(
            payload = """{"result":"native_wake_submitted","nativeWakeResult":{"state":"submitted"}}""",
            stage = NativeWakeAckOutboxStage.FINAL
        )
        assertNull(NativeWakeAckOutboxPolicy.removeExact(listOf(final), commandId, "different"))
        assertNull(NativeWakeAckOutboxPolicy.removeExact(listOf(final), commandId, ""))
        assertNull(NativeWakeAckOutboxPolicy.removeExact(listOf(entry()), commandId, entry().payloadJson))
        assertEquals(emptyList<PendingNativeWakeAcknowledgement>(),
            NativeWakeAckOutboxPolicy.removeExact(listOf(final), commandId, final.payloadJson))
    }
}
