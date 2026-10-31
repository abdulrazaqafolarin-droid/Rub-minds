package app.rubminds.companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.CrossProfileApps
import android.os.Build

class WorkProfileAppLauncher(context: Context) {
    private val app = context.applicationContext
    private val secrets = WorkProfileBridgeSecretStore(app)

    fun launch(activity: Activity, packageName: String, signerSha256: String): String? {
        if (Build.VERSION.SDK_INT < 30) return "cross_profile_launch_requires_android_11"
        val crossProfiles = app.getSystemService(CrossProfileApps::class.java)
            ?: return "cross_profile_launch_service_unavailable"
        if (app.getSystemService(android.app.admin.DevicePolicyManager::class.java)
                .isProfileOwnerApp(app.packageName)
        ) return "already_running_in_work_profile"
        if (!crossProfiles.canInteractAcrossProfiles()) return "cross_profile_access_not_approved"

        val users = try { crossProfiles.targetUserProfiles } catch (_: SecurityException) { emptyList() }
        if (users.size != 1) {
            return if (users.isEmpty()) "managed_work_profile_not_found" else "multiple_profiles_found_target_ambiguous"
        }

        val secret = secrets.load() ?: return "work_profile_bridge_secret_unavailable"
        val command = try {
            WorkProfileLaunchAuthenticator.create(secret, packageName, signerSha256, System.currentTimeMillis())
        } finally {
            secret.fill(0)
        } ?: return "work_profile_launch_request_invalid"

        val intent = Intent(activity, MainActivity::class.java).apply {
            action = WorkProfileContract.ACTION_OPEN_APP
            putExtra(WorkProfileContract.EXTRA_PACKAGE, command.packageName)
            putExtra(WorkProfileContract.EXTRA_SIGNER, command.signerSha256)
            putExtra(WorkProfileContract.EXTRA_ISSUED_AT, command.issuedAtMillis)
            putExtra(WorkProfileContract.EXTRA_NONCE, command.nonce)
            putExtra(WorkProfileContract.EXTRA_MAC, command.macSha256)
        }
        return try {
            crossProfiles.startActivity(intent, users.single(), activity)
            null
        } catch (_: SecurityException) {
            "android_rejected_cross_profile_launch"
        } catch (_: Exception) {
            "work_profile_launch_failed"
        }
    }
}
