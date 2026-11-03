package app.rubminds.companion

import android.view.accessibility.AccessibilityNodeInfo
import java.security.MessageDigest

/**
 * A provider-specific adapter must return a stable identifier for the exact
 * active chat/thread—not a composer hash, title, app ID, or Rub Minds session.
 * The raw identifier remains local and is never persisted or transmitted.
 */
internal fun interface ProviderConversationIdentityAdapter {
    fun activeConversationStableId(root: AccessibilityNodeInfo): String?
}

internal object ProviderConversationIdentityPolicy {
    private val digestPattern = Regex("^[a-f0-9]{64}$")
    private val forbidden = Regex("[\\u0000-\\u001f\\u007f-\\u009f]")

    fun digest(packageName: String, stableConversationId: String?): String? {
        if (!AppGrantPolicy.isValidPackageName(packageName) || packageName.length > 255 ||
            stableConversationId.isNullOrBlank() || stableConversationId.length > 1_024 ||
            forbidden.containsMatchIn(stableConversationId)
        ) return null
        val value = "${packageName.length}:$packageName${stableConversationId.length}:$stableConversationId"
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }

    fun isValidDigest(value: String?): Boolean =
        value != null && digestPattern.matches(value)

    fun matches(expectedDigest: String?, currentDigest: String?): Boolean =
        isValidDigest(expectedDigest) && currentDigest == expectedDigest
}

/**
 * No provider adapter is registered yet. Unknown providers therefore fail
 * closed for autonomous native Send while drag-select draft insertion remains
 * available. Add an adapter only after conversation-switch acceptance tests
 * prove it distinguishes adjacent chats when accessibility nodes are reused.
 */
internal object ProviderConversationIdentityResolver {
    private val adapters: Map<String, ProviderConversationIdentityAdapter> = emptyMap()

    fun supports(packageName: String): Boolean = adapters.containsKey(packageName)

    fun resolve(packageName: String, root: AccessibilityNodeInfo?): String? {
        if (root == null || !AppGrantPolicy.isValidPackageName(packageName) ||
            !root.isVisibleToUser || root.packageName?.toString() != packageName
        ) return null
        val adapter = adapters[packageName] ?: return null
        val stableId = runCatching { adapter.activeConversationStableId(root) }.getOrNull()
        return ProviderConversationIdentityPolicy.digest(packageName, stableId)
    }
}
