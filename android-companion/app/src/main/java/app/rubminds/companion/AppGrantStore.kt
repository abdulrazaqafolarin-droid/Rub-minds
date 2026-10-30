package app.rubminds.companion

import android.content.Context

/**
 * Stores only selected package names and their separate draft-insertion grants.
 * No app content, notification data, credentials, screenshots or file paths
 * are collected.
 */
class AppGrantStore(context: Context) {
    private val preferences = context.getSharedPreferences("app_grants_v1", Context.MODE_PRIVATE)

    fun all(): List<AppGrant> {
        val launch = preferences.getStringSet(KEY_LAUNCH, emptySet()).orEmpty()
        val draft = preferences.getStringSet(KEY_DRAFT, emptySet()).orEmpty()
        return launch.sorted().map { packageName ->
            AppGrant(packageName, allowLaunch = true, allowDraftInsertion = packageName in draft)
        }
    }

    fun get(packageName: String): AppGrant? = all().firstOrNull { it.packageName == packageName }

    fun save(grants: Collection<AppGrant>) {
        val launch = grants.filter { it.allowLaunch }.map { it.packageName }.toSet()
        val draft = grants.filter { it.allowLaunch && it.allowDraftInsertion }
            .map { it.packageName }.toSet()
        preferences.edit()
            .putStringSet(KEY_LAUNCH, launch)
            .putStringSet(KEY_DRAFT, draft)
            .apply()
    }

    fun clear() {
        preferences.edit().remove(KEY_LAUNCH).remove(KEY_DRAFT).apply()
    }

    private companion object {
        const val KEY_LAUNCH = "launch_packages"
        const val KEY_DRAFT = "draft_packages"
    }
}
