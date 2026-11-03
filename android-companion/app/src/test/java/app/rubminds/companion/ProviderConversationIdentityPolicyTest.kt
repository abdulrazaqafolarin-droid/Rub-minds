package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderConversationIdentityPolicyTest {
    @Test fun providerAndConversationIdentityAreHashedLocallyAndDifferentThreadsDoNotMatch() {
        val first = ProviderConversationIdentityPolicy.digest("com.example.ai", "conversation-A")
        val same = ProviderConversationIdentityPolicy.digest("com.example.ai", "conversation-A")
        val second = ProviderConversationIdentityPolicy.digest("com.example.ai", "conversation-B")

        assertNotNull(first)
        assertEquals(first, same)
        assertNotEquals(first, second)
        assertTrue(ProviderConversationIdentityPolicy.matches(first, same))
        assertFalse(ProviderConversationIdentityPolicy.matches(first, second))
        assertFalse(first!!.contains("conversation-A"))
    }

    @Test fun missingOrMalformedProviderConversationIdentityFailsClosed() {
        assertNull(ProviderConversationIdentityPolicy.digest("com.example.ai", null))
        assertNull(ProviderConversationIdentityPolicy.digest("com.example.ai", ""))
        assertNull(ProviderConversationIdentityPolicy.digest("", "conversation-A"))
        assertNull(ProviderConversationIdentityPolicy.digest("com.example.ai", "bad\nidentity"))
        assertFalse(ProviderConversationIdentityPolicy.matches(null, "a".repeat(64)))
        assertFalse(ProviderConversationIdentityPolicy.matches("not-a-digest", "not-a-digest"))
        assertFalse(ProviderConversationIdentityPolicy.matches("a".repeat(64), null))
    }

    @Test fun noUnverifiedProviderAdapterIsReportedAsConversationCapable() {
        assertFalse(ProviderConversationIdentityResolver.supports("com.example.ai"))
        assertNull(ProviderConversationIdentityResolver.resolve("com.example.ai", null))
    }
}
