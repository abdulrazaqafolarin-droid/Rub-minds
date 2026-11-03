package app.rubminds.companion

/**
 * Pure local authorization policy for autonomous native @RMconnects wake sends.
 * This is deliberately independent from touch and draft-typing permissions.
 */
data class NativeWakeGrant(
    val grantId: String,
    val deviceId: String,
    val packageName: String,
    val signingCertificateSha256: String,
    val grantedAtMillis: Long,
    val expiresAtMillis: Long
)

data class NativeWakeExecutionRequest(
    val grantId: String,
    val jobId: String,
    val hostId: String,
    val roomId: String,
    val bindingId: String,
    val leaseTokenDigest: String,
    val deviceId: String,
    val sessionId: String,
    val packageName: String,
    val signingCertificateSha256: String,
    val eventId: String,
    val composerTargetId: String,
    val sendTargetId: String,
    val targetRevision: Int,
    val handoffIssuedAtMillis: Long,
    val handoffExpiresAtMillis: Long,
    val providerConversationIdentityDigest: String
)

data class NativeWakeExecutionReservation(
    val grantId: String,
    val eventId: String,
    val jobId: String,
    val hostId: String,
    val roomId: String,
    val bindingId: String,
    val leaseTokenDigest: String,
    val deviceId: String,
    val sessionId: String,
    val packageName: String,
    val signingCertificateSha256: String,
    val composerTargetId: String,
    val sendTargetId: String,
    val targetRevision: Int,
    val reservedAtMillis: Long,
    val grantExpiresAtMillis: Long,
    // Legacy rows are accepted only for replay-ledger preservation; new requests never accept this sentinel.
    val providerConversationIdentityDigest: String = NativeWakeConsentPolicy.LEGACY_CONVERSATION_SCOPE
)

data class NativeWakeReservationDecision(
    val allowed: Boolean,
    val reason: String,
    val reservations: List<NativeWakeExecutionReservation>
)

enum class NativeWakeSubmissionState {
    PRECHECK_DENIED,
    SUBMITTED,
    NEEDS_REVIEW
}

data class NativeWakeSubmissionResult(
    val state: NativeWakeSubmissionState,
    val reason: String,
    val promptInserted: Boolean = false,
    val sendInvoked: Boolean = false,
    val composerCleared: Boolean = false,
    val promptReadbackVerified: Boolean = false,
    val composerIdentityRevalidated: Boolean = false,
    val sendControlIdentityRevalidated: Boolean = false,
    val composerIdentityDigest: String? = null,
    val sendControlIdentityDigest: String? = null,
    val providerConversationIdentityRevalidated: Boolean = false,
    val providerConversationIdentityDigest: String? = null
)

enum class NativeWakeInsertState {
    PRECHECK_DENIED,
    INSERTED,
    NEEDS_REVIEW
}

data class NativeWakeInsertResult(
    val state: NativeWakeInsertState,
    val reason: String
)

internal object NativeWakeJournalLock {
    val monitor = Any()
}

object NativeWakeConsentPolicy {
    const val MAX_GRANT_TTL_MILLIS = 24L * 60L * 60L * 1000L
    const val MIN_GRANT_TTL_MILLIS = 60L * 1000L
    const val MAX_HANDOFF_TTL_MILLIS = 20_000L
    const val LEGACY_CONVERSATION_SCOPE = "legacy_unscoped"
    const val MAX_HANDOFF_CLOCK_SKEW_MILLIS = 3_000L
    const val MAX_WAKES_PER_MINUTE = 6
    const val MAX_REPLAY_RECORDS = 4096
    const val REPLAY_RETENTION_MILLIS = MAX_GRANT_TTL_MILLIS

    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val eventId = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    private val targetId = Regex("^[a-f0-9]{64}$")
    private val eventIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

    fun canonicalWakePrompt(eventId: String): String? {
        if (!eventId.matches(eventIdPattern)) return null
        return "@RMconnects\nEvent: $eventId\nRetrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP."
    }

    fun createGrant(
        grantId: String,
        deviceId: String,
        packageName: String,
        signer: String,
        nowMillis: Long,
        ttlMillis: Long = MAX_GRANT_TTL_MILLIS,
        localConfirmation: Boolean
    ): NativeWakeGrant? {
        if (!localConfirmation || !uuid.matches(grantId) || !uuid.matches(deviceId) ||
            !AppGrantPolicy.isValidPackageName(packageName) ||
            !AppGrantPolicy.isValidSigningCertificateSha256(signer) ||
            nowMillis <= 0L || ttlMillis !in MIN_GRANT_TTL_MILLIS..MAX_GRANT_TTL_MILLIS ||
            nowMillis > Long.MAX_VALUE - ttlMillis
        ) return null
        return NativeWakeGrant(
            grantId = grantId,
            deviceId = deviceId,
            packageName = packageName,
            signingCertificateSha256 = signer,
            grantedAtMillis = nowMillis,
            expiresAtMillis = nowMillis + ttlMillis
        )
    }

    fun isGrantActive(
        grant: NativeWakeGrant?,
        deviceId: String?,
        packageName: String?,
        signer: String?,
        nowMillis: Long
    ): Boolean {
        if (grant == null || deviceId.isNullOrBlank() || packageName.isNullOrBlank() ||
            signer.isNullOrBlank() || nowMillis <= 0L
        ) return false
        return uuid.matches(grant.grantId) &&
            uuid.matches(grant.deviceId) &&
            uuid.matches(deviceId) &&
            grant.deviceId == deviceId &&
            grant.packageName == packageName &&
            grant.signingCertificateSha256 == signer &&
            AppGrantPolicy.isValidPackageName(grant.packageName) &&
            AppGrantPolicy.isValidSigningCertificateSha256(grant.signingCertificateSha256) &&
            grant.grantedAtMillis > 0L &&
            grant.grantedAtMillis <= nowMillis &&
            grant.expiresAtMillis > nowMillis &&
            grant.expiresAtMillis > grant.grantedAtMillis &&
            grant.expiresAtMillis - grant.grantedAtMillis <= MAX_GRANT_TTL_MILLIS
    }

    fun isValidReservation(row: NativeWakeExecutionReservation): Boolean =
        uuid.matches(row.grantId) &&
            uuid.matches(row.jobId) &&
            uuid.matches(row.hostId) &&
            uuid.matches(row.roomId) &&
            uuid.matches(row.bindingId) &&
            Regex("^[a-f0-9]{64}$").matches(row.leaseTokenDigest) &&
            uuid.matches(row.deviceId) &&
            uuid.matches(row.sessionId) &&
            eventId.matches(row.eventId) &&
            AppGrantPolicy.isValidPackageName(row.packageName) &&
            AppGrantPolicy.isValidSigningCertificateSha256(row.signingCertificateSha256) &&
            targetId.matches(row.composerTargetId) &&
            targetId.matches(row.sendTargetId) &&
            (row.providerConversationIdentityDigest == LEGACY_CONVERSATION_SCOPE ||
                targetId.matches(row.providerConversationIdentityDigest)) &&
            row.targetRevision > 0 &&
            row.reservedAtMillis > 0L &&
            row.grantExpiresAtMillis > row.reservedAtMillis &&
            row.grantExpiresAtMillis - row.reservedAtMillis <= MAX_GRANT_TTL_MILLIS

    /**
     * Re-seeing an existing event/job/lease seal is not a fresh preflight
     * denial: the prior device action may have happened and its ACK may have
     * been lost. Treat it as terminal review rather than opening a retry.
     */
    fun isTerminalReservationDenial(reason: String): Boolean = reason in setOf(
        "native_wake_event_already_reserved",
        "native_wake_replay_ledger_corrupt",
        "native_wake_replay_ledger_full",
        "native_wake_seal_persistence_failed"
    )

    fun reserveExecution(
        grant: NativeWakeGrant?,
        request: NativeWakeExecutionRequest,
        existing: Collection<NativeWakeExecutionReservation>,
        nowMillis: Long
    ): NativeWakeReservationDecision {
        fun denied(reason: String, rows: List<NativeWakeExecutionReservation> = existing.toList()) =
            NativeWakeReservationDecision(false, reason, rows)

        if (!isGrantActive(
                grant, request.deviceId, request.packageName,
                request.signingCertificateSha256, nowMillis
            )) return denied("native_wake_grant_inactive")
        val handoffIssuedAt = request.handoffIssuedAtMillis
        val handoffExpiresAt = request.handoffExpiresAtMillis
        val issuedAtTooFarInFuture = handoffIssuedAt > nowMillis &&
            handoffIssuedAt - nowMillis > MAX_HANDOFF_CLOCK_SKEW_MILLIS
        if (handoffIssuedAt <= 0L || issuedAtTooFarInFuture ||
            handoffExpiresAt <= nowMillis || handoffExpiresAt <= handoffIssuedAt ||
            handoffExpiresAt - handoffIssuedAt > MAX_HANDOFF_TTL_MILLIS ||
            handoffExpiresAt > (grant?.expiresAtMillis ?: 0L)
        ) return denied("native_wake_handoff_expired")
        if (request.grantId != grant?.grantId ||
            !uuid.matches(request.jobId) ||
            !uuid.matches(request.hostId) ||
            !uuid.matches(request.roomId) ||
            !uuid.matches(request.bindingId) ||
            !Regex("^[a-f0-9]{64}$").matches(request.leaseTokenDigest) ||
            !uuid.matches(request.sessionId) ||
            !eventId.matches(request.eventId) ||
            !targetId.matches(request.composerTargetId) ||
            !targetId.matches(request.sendTargetId) ||
            !targetId.matches(request.providerConversationIdentityDigest) ||
            request.targetRevision < 1
        ) return denied("native_wake_scope_invalid")

        if (existing.any { !isValidReservation(it) || it.reservedAtMillis > nowMillis }) {
            return denied("native_wake_replay_ledger_corrupt")
        }
        val retained = existing.filter { row ->
            row.grantExpiresAtMillis > nowMillis &&
                nowMillis >= row.reservedAtMillis &&
                nowMillis - row.reservedAtMillis <= REPLAY_RETENTION_MILLIS
        }
        // The same durable queue event/job/lease remains spent even if the
        // owner revokes and re-arms local consent with a new grant ID.
        if (retained.any {
            it.deviceId == request.deviceId &&
                it.roomId == request.roomId &&
                it.bindingId == request.bindingId &&
                (it.jobId == request.jobId || it.eventId == request.eventId ||
                    it.leaseTokenDigest == request.leaseTokenDigest)
        }) {
            return denied("native_wake_event_already_reserved", retained)
        }
        val recent = retained.count {
            it.deviceId == request.deviceId && it.roomId == request.roomId &&
                it.bindingId == request.bindingId &&
                it.reservedAtMillis > nowMillis - 60_000L &&
                it.reservedAtMillis <= nowMillis
        }
        if (recent >= MAX_WAKES_PER_MINUTE) return denied("native_wake_rate_limited", retained)
        if (retained.size >= MAX_REPLAY_RECORDS) return denied("native_wake_replay_ledger_full", retained)

        val reservation = NativeWakeExecutionReservation(
            grantId = grant.grantId,
            eventId = request.eventId,
            jobId = request.jobId,
            hostId = request.hostId,
            roomId = request.roomId,
            bindingId = request.bindingId,
            leaseTokenDigest = request.leaseTokenDigest,
            deviceId = request.deviceId,
            sessionId = request.sessionId,
            packageName = request.packageName,
            signingCertificateSha256 = request.signingCertificateSha256,
            composerTargetId = request.composerTargetId,
            sendTargetId = request.sendTargetId,
            targetRevision = request.targetRevision,
            reservedAtMillis = nowMillis,
            grantExpiresAtMillis = grant.expiresAtMillis,
            providerConversationIdentityDigest = request.providerConversationIdentityDigest
        )
        return NativeWakeReservationDecision(
            true, "native_wake_execution_sealed", retained + reservation
        )
    }
}
