package app.rubminds.companion

import android.content.Context

/**
 * Stores only selected package IDs, current APK signer fingerprints, and
 * separate local draft-insertion grants. Package-only v1 grants are revoked
 * during this migration because their signer cannot be established safely.
 */
class AppGrantStore(context: Context) {
    private val preferences = context.getSharedPreferences("app_grants_v2", Context.MODE_PRIVATE)
    private val legacyPreferences = context.getSharedPreferences("app_grants_v1", Context.MODE_PRIVATE)

    init {
        legacyPreferences.edit()
            .remove(LEGACY_KEY_LAUNCH)
            .remove(LEGACY_KEY_DRAFT)
            .apply()
    }

    fun all(): List<AppGrant> {
        val draftRecords = preferences.getStringSet(KEY_DRAFT, emptySet()).orEmpty()
        return preferences.getStringSet(KEY_LAUNCH, emptySet()).orEmpty()
            .mapNotNull(::decode)
            .distinctBy { it.first }
            .map { (packageName, signingDigest) ->
                AppGrant(
                    packageName = packageName,
                    signingCertificateSha256 = signingDigest,
                    allowLaunch = true,
                    allowDraftInsertion = encode(packageName, signingDigest) in draftRecords
                )
            }
    }

    fun get(packageName: String, signingCertificateSha256: String): AppGrant? =
        all().firstOrNull {
            it.packageName == packageName &&
                it.signingCertificateSha256 == signingCertificateSha256
        }

    fun save(grants: Collection<AppGrant>) {
        val valid = grants.filter {
            AppGrantPolicy.isValidPackageName(it.packageName) &&
                AppGrantPolicy.isValidSigningCertificateSha256(it.signingCertificateSha256) &&
                it.allowLaunch
        }.distinctBy { it.packageName }
        val launch = valid.map {
            encode(it.packageName, it.signingCertificateSha256)
        }.toSet()
        val draft = valid.filter { it.allowDraftInsertion }.map {
            encode(it.packageName, it.signingCertificateSha256)
        }.toSet()
        preferences.edit()
            .putStringSet(KEY_LAUNCH, launch)
            .putStringSet(KEY_DRAFT, draft)
            .apply()
    }

    fun clear() {
        preferences.edit()
            .remove(KEY_LAUNCH)
            .remove(KEY_DRAFT)
            .apply()
        legacyPreferences.edit()
            .remove(LEGACY_KEY_LAUNCH)
            .remove(LEGACY_KEY_DRAFT)
            .apply()
    }

    private fun encode(packageName: String, signingDigest: String): String =
        "$packageName\t$signingDigest"

    private fun decode(value: String): Pair<String, String>? {
        val separator = value.indexOf('\t')
        if (separator <= 0 || separator == value.lastIndex) return null
        val packageName = value.substring(0, separator)
        val signingDigest = value.substring(separator + 1)
        if (!AppGrantPolicy.isValidPackageName(packageName) ||
            !AppGrantPolicy.isValidSigningCertificateSha256(signingDigest)
        ) return null
        return packageName to signingDigest
    }

    private companion object {
        const val KEY_LAUNCH = "launch_records"
        const val KEY_DRAFT = "draft_records"
        const val LEGACY_KEY_LAUNCH = "launch_packages"
        const val LEGACY_KEY_DRAFT = "draft_packages"
    }
}
