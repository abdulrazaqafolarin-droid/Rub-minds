package app.rubminds.companion

enum class NativeWakeAckOutboxStage { PREPARED, FINAL }

data class PendingNativeWakeAcknowledgement(
    val commandId: String,
    val requestId: String,
    val sessionId: String,
    val payloadJson: String,
    val stage: NativeWakeAckOutboxStage,
    val savedAtMillis: Long
)

/**
 * Durable, idempotent Android native-wake ACK outbox policy.
 * PREPARED is committed before a provider effect; FINAL replaces it only
 * with the exact result. A crash is settled as needs-review, never replayed.
 */
object NativeWakeAckOutboxPolicy {
    const val MAX_PENDING_ACKS = 64
    const val MAX_ACK_PAYLOAD_CHARS = 16_384
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    fun isValid(entry: PendingNativeWakeAcknowledgement): Boolean =
        uuid.matches(entry.commandId) &&
            uuid.matches(entry.requestId) &&
            uuid.matches(entry.sessionId) &&
            entry.payloadJson.isNotBlank() &&
            entry.payloadJson.length <= MAX_ACK_PAYLOAD_CHARS &&
            entry.savedAtMillis > 0L

    fun upsert(
        existing: Collection<PendingNativeWakeAcknowledgement>,
        incoming: PendingNativeWakeAcknowledgement
    ): List<PendingNativeWakeAcknowledgement>? {
        if (!isValid(incoming) || existing.size > MAX_PENDING_ACKS ||
            existing.any { !isValid(it) } ||
            existing.map { it.commandId }.toSet().size != existing.size
        ) return null

        val rows = existing.toMutableList()
        val index = rows.indexOfFirst { it.commandId == incoming.commandId }
        if (index >= 0) {
            val prior = rows[index]
            if (prior.requestId != incoming.requestId || prior.sessionId != incoming.sessionId) return null
            if (prior.payloadJson == incoming.payloadJson && prior.stage == incoming.stage) return rows
            if (prior.stage != NativeWakeAckOutboxStage.PREPARED ||
                incoming.stage != NativeWakeAckOutboxStage.FINAL
            ) return null
            rows[index] = incoming
            return rows
        }

        if (rows.size >= MAX_PENDING_ACKS) return null
        rows += incoming
        return rows
    }

    fun removeExact(
        existing: Collection<PendingNativeWakeAcknowledgement>,
        commandId: String,
        expectedPayloadJson: String
    ): List<PendingNativeWakeAcknowledgement>? {
        if (existing.size > MAX_PENDING_ACKS || existing.any { !isValid(it) } ||
            existing.map { it.commandId }.toSet().size != existing.size ||
            !uuid.matches(commandId) || expectedPayloadJson.isBlank()
        ) return null
        val prior = existing.singleOrNull { it.commandId == commandId } ?: return null
        if (prior.payloadJson != expectedPayloadJson || prior.stage != NativeWakeAckOutboxStage.FINAL) return null
        return existing.filterNot { it.commandId == commandId }
    }
}
