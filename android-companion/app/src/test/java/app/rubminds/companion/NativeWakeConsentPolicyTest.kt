package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class NativeWakeConsentPolicyTest {
    private val deviceId = "72000000-0000-4000-8000-000000000001"
    private val grantId = "75000000-0000-4000-8000-000000000001"
    private val sessionId = "74000000-0000-4000-8000-000000000001"
    private val jobId = "76000000-0000-4000-8000-000000000001"
    private val hostId = "77000000-0000-4000-8000-000000000001"
    private val roomId = "78000000-0000-4000-8000-000000000001"
    private val bindingId = "79000000-0000-4000-8000-000000000001"
    private val leaseTokenDigest = "d".repeat(64)
    private val packageName = "com.example.chat"
    private val signer = "a".repeat(64)
    private val now = 1_800_000_000_000L

    private fun grant(
        device: String = deviceId,
        app: String = packageName,
        signing: String = signer,
        expiresAt: Long = now + NativeWakeConsentPolicy.MAX_GRANT_TTL_MILLIS
    ) = NativeWakeGrant(grantId, device, app, signing, now, expiresAt)

    private fun request(
        event: String = "70000000-0000-4000-8000-000000000001",
        job: String = jobId,
        host: String = hostId,
        room: String = roomId,
        binding: String = bindingId,
        leaseDigest: String = leaseTokenDigest,
        device: String = deviceId,
        app: String = packageName,
        signing: String = signer,
        composer: String = "b".repeat(64),
        send: String = "c".repeat(64),
        revision: Int = 2
    ) = NativeWakeExecutionRequest(
        grantId, job, host, room, binding, leaseDigest,
        device, sessionId, app, signing, event, composer, send, revision
    )

    @Test fun canonicalWakePromptIsEventBoundAndCannotCarryGroupMessageText() {
        val prompt = NativeWakeConsentPolicy.canonicalWakePrompt("70000000-0000-4000-8000-000000000001")
        assertEquals(
            "@RMconnects\nEvent: 70000000-0000-4000-8000-000000000001\n" +
                "Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.",
            prompt
        )
        assertEquals(null, NativeWakeConsentPolicy.canonicalWakePrompt(""))
        assertEquals(null, NativeWakeConsentPolicy.canonicalWakePrompt("message body with spaces"))
        assertEquals(null, NativeWakeConsentPolicy.canonicalWakePrompt("x".repeat(129)))
    }

    @Test fun requiresExplicitLocalConfirmationAndCapsConsentAtTwentyFourHours() {
        assertEquals(null, NativeWakeConsentPolicy.createGrant(
            grantId, deviceId, packageName, signer, now, localConfirmation = false
        ))
        val created = NativeWakeConsentPolicy.createGrant(
            grantId, deviceId, packageName, signer, now, localConfirmation = true
        )
        assertEquals(now + NativeWakeConsentPolicy.MAX_GRANT_TTL_MILLIS, created?.expiresAtMillis)
        assertEquals(null, NativeWakeConsentPolicy.createGrant(
            grantId, deviceId, packageName, signer, now,
            ttlMillis = NativeWakeConsentPolicy.MAX_GRANT_TTL_MILLIS + 1,
            localConfirmation = true
        ))
        assertEquals(null, NativeWakeConsentPolicy.createGrant(
            grantId, deviceId, packageName, signer, now, ttlMillis = 10,
            localConfirmation = true
        ))
    }

    @Test fun consentIsBoundToDeviceAppAndCurrentSigner() {
        val saved = grant()
        assertTrue(NativeWakeConsentPolicy.isGrantActive(saved, deviceId, packageName, signer, now))
        assertFalse(NativeWakeConsentPolicy.isGrantActive(saved, "72000000-0000-4000-8000-000000000002", packageName, signer, now))
        assertFalse(NativeWakeConsentPolicy.isGrantActive(saved, deviceId, "com.example.other", signer, now))
        assertFalse(NativeWakeConsentPolicy.isGrantActive(saved, deviceId, packageName, "d".repeat(64), now))
    }

    @Test fun expiryAndCorruptGrantRecordsFailClosed() {
        assertFalse(NativeWakeConsentPolicy.isGrantActive(grant(expiresAt = now), deviceId, packageName, signer, now))
        assertFalse(NativeWakeConsentPolicy.isGrantActive(grant(expiresAt = now + NativeWakeConsentPolicy.MAX_GRANT_TTL_MILLIS + 1), deviceId, packageName, signer, now))
        assertFalse(NativeWakeConsentPolicy.isGrantActive(grant(device = "bad"), deviceId, packageName, signer, now))
    }

    @Test fun aGrantCreatedInTheFutureIsNotYetUsable() {
        val future = grant().copy(grantedAtMillis = now + 1L)
        assertFalse(NativeWakeConsentPolicy.isGrantActive(future, deviceId, packageName, signer, now))
    }

    @Test fun executionSealMustMatchGrantAndCurrentNativeTarget() {
        val result = NativeWakeConsentPolicy.reserveExecution(grant(), request(), emptyList(), now)
        assertTrue(result.allowed)
        assertEquals("native_wake_execution_sealed", result.reason)
        assertEquals(1, result.reservations.size)
        assertFalse(NativeWakeConsentPolicy.reserveExecution(grant(), request(device = "72000000-0000-4000-8000-000000000002"), emptyList(), now).allowed)
        assertFalse(NativeWakeConsentPolicy.reserveExecution(grant(), request(app = "com.example.other"), emptyList(), now).allowed)
        assertFalse(NativeWakeConsentPolicy.reserveExecution(grant(), request(signing = "d".repeat(64)), emptyList(), now).allowed)
        assertFalse(NativeWakeConsentPolicy.reserveExecution(grant(), request(revision = 0), emptyList(), now).allowed)
    }

    @Test fun eventReplayIsBlockedEvenWhenTargetSelectionChanges() {
        val first = NativeWakeConsentPolicy.reserveExecution(grant(), request(), emptyList(), now)
        assertTrue(first.allowed)
        val changedTarget = request(composer = "d".repeat(64), send = "e".repeat(64), revision = 3)
        val duplicate = NativeWakeConsentPolicy.reserveExecution(grant(), changedTarget, first.reservations, now + 1_000)
        assertFalse(duplicate.allowed)
        assertEquals("native_wake_event_already_reserved", duplicate.reason)
    }

    @Test fun rearmingLocalConsentCannotReplayTheSameDurableEventOrJob() {
        val first = NativeWakeConsentPolicy.reserveExecution(grant(), request(), emptyList(), now)
        assertTrue(first.allowed)
        val renewedGrant = grantId.replace("0001", "0002")
        val renewed = NativeWakeGrant(
            renewedGrant, deviceId, packageName, signer,
            now + 1_000L, now + 60L * 60L * 1000L
        )
        val duplicateEvent = NativeWakeConsentPolicy.reserveExecution(
            renewed, request(job = "76000000-0000-4000-8000-000000000002"),
            first.reservations, now + 2_000L
        )
        assertFalse(duplicateEvent.allowed)
        assertEquals("native_wake_event_already_reserved", duplicateEvent.reason)
        val duplicateJob = NativeWakeConsentPolicy.reserveExecution(
            renewed, request(event = "another_event"), first.reservations, now + 2_000L
        )
        assertFalse(duplicateJob.allowed)
        assertEquals("native_wake_event_already_reserved", duplicateJob.reason)
    }

    @Test fun corruptExistingReplayRowsFailClosed() {
        val corrupt = NativeWakeExecutionReservation(
            grantId, "bad event with spaces", jobId, hostId, roomId, bindingId,
            leaseTokenDigest, deviceId, sessionId, packageName, signer,
            "b".repeat(64), "c".repeat(64), 1, now, now + 60_000
        )
        val result = NativeWakeConsentPolicy.reserveExecution(grant(), request(), listOf(corrupt), now)
        assertFalse(result.allowed)
        assertEquals("native_wake_replay_ledger_corrupt", result.reason)
    }

    @Test fun aFutureDatedReplayRecordCorruptsTheJournalAndFailsClosed() {
        val future = NativeWakeExecutionReservation(
            grantId, "future_event", jobId, hostId, roomId, bindingId,
            leaseTokenDigest, deviceId, sessionId, packageName, signer,
            "b".repeat(64), "c".repeat(64), 1, now + 1L, now + 60_000
        )
        val result = NativeWakeConsentPolicy.reserveExecution(grant(), request(), listOf(future), now)
        assertFalse(result.allowed)
        assertEquals("native_wake_replay_ledger_corrupt", result.reason)
    }

    @Test fun sixWakesPerMinuteIsTheHardLocalCeiling() {
        var rows = emptyList<NativeWakeExecutionReservation>()
        repeat(NativeWakeConsentPolicy.MAX_WAKES_PER_MINUTE) { index ->
            val decision = NativeWakeConsentPolicy.reserveExecution(
                grant(), request(event = "event_$index"), rows, now + index * 1_000L
            )
            assertTrue(decision.allowed)
            rows = decision.reservations
        }
        val limited = NativeWakeConsentPolicy.reserveExecution(
            grant(), request(event = "event_seventh"), rows, now + 5_999L
        )
        assertFalse(limited.allowed)
        assertEquals("native_wake_rate_limited", limited.reason)
    }

    @Test fun expiredReplayRowsArePrunedButLiveJournalCapacityFailsClosed() {
        val expired = NativeWakeExecutionReservation(
            grantId, "old_event", jobId, hostId, roomId, bindingId,
            leaseTokenDigest, deviceId, sessionId, packageName, signer,
            "b".repeat(64), "c".repeat(64), 1,
            now - NativeWakeConsentPolicy.REPLAY_RETENTION_MILLIS - 1,
            now - 1
        )
        val result = NativeWakeConsentPolicy.reserveExecution(grant(), request(), listOf(expired), now)
        assertTrue(result.allowed)
        assertEquals(1, result.reservations.size)
        val full = List(NativeWakeConsentPolicy.MAX_REPLAY_RECORDS) { index ->
            expired.copy(eventId = "old_$index", grantExpiresAtMillis = now + 60_000, reservedAtMillis = now)
        }
        val blocked = NativeWakeConsentPolicy.reserveExecution(grant(), request(), full, now)
        assertFalse(blocked.allowed)
        assertEquals("native_wake_replay_ledger_full", blocked.reason)
    }

    @Test fun malformedEventOrTargetIdentitiesAreRejected() {
        val bad = listOf(
            request(event = ""),
            request(event = "x".repeat(129)),
            request(composer = "not-a-digest"),
            request(send = "not-a-digest")
        )
        bad.forEach { input ->
            assertFalse(NativeWakeConsentPolicy.reserveExecution(grant(), input, emptyList(), now).allowed)
        }
    }
}
