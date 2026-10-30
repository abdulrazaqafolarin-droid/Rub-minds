package app.rubminds.companion

/**
 * Local authorization policy for the Android companion.
 *
 * Selecting an app does not grant access to its private data or screen.
 * Draft insertion is a separate capability and is checked again against
 * the foreground editor package whenever the keyboard inserts text.
 */
data class AppGrant(
    val packageName: String,
    val allowLaunch: Boolean,
    val allowDraftInsertion: Boolean
)

object AppGrantPolicy {
    fun canLaunch(grant: AppGrant?): Boolean =
        grant != null && grant.packageName.isNotBlank() && grant.allowLaunch

    fun canInsertDraft(grant: AppGrant?, foregroundPackage: String?): Boolean =
        grant != null &&
            grant.packageName.isNotBlank() &&
            grant.allowLaunch &&
            grant.allowDraftInsertion &&
            !foregroundPackage.isNullOrBlank() &&
            grant.packageName == foregroundPackage
}
