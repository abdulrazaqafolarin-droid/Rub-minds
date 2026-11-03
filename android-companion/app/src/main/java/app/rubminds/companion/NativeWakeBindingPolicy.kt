package app.rubminds.companion

/**
 * Final native-wake binding check. A wake may send only while the exact
 * session/app/composer/Send binding captured at dispatch is still current.
 */
internal object NativeWakeBindingPolicy {
    fun isCurrent(
        expectedGeneration: Long,
        currentGeneration: Long,
        expectedSessionId: String,
        currentSessionId: String?,
        expectedPackageName: String,
        currentPackageName: String?,
        expectedComposerTargetId: String,
        currentComposerTargetId: String?,
        expectedSendTargetId: String,
        currentSendTargetId: String?,
        expectedProviderConversationDigest: String,
        currentProviderConversationDigest: String?
    ): Boolean =
        expectedGeneration == currentGeneration &&
            expectedSessionId.isNotBlank() &&
            currentSessionId == expectedSessionId &&
            expectedPackageName.isNotBlank() &&
            currentPackageName == expectedPackageName &&
            expectedComposerTargetId.isNotBlank() &&
            currentComposerTargetId == expectedComposerTargetId &&
            expectedSendTargetId.isNotBlank() &&
            currentSendTargetId == expectedSendTargetId &&
            ProviderConversationIdentityPolicy.matches(
                expectedProviderConversationDigest, currentProviderConversationDigest
            )
}
