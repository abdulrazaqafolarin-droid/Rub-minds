package app.rubminds.companion

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.CrossProfileApps
import android.os.Build
import android.os.PersistableBundle

data class WorkProfileSnapshot(
    val isProfileOwner: Boolean,
    val profileCount: Int,
    val canProvision: Boolean,
    val canRequestAccess: Boolean,
    val canInteract: Boolean,
    val hasBridgeSecret: Boolean,
    val profileOwnerConfirmed: Boolean,
    val crossProfileAllowlistReady: Boolean?
)

class WorkProfileCoordinator(context: Context) {
    private val app = context.applicationContext
    private val dpm = app.getSystemService(DevicePolicyManager::class.java)
    private fun crossProfileService(): CrossProfileApps? =
        if (Build.VERSION.SDK_INT >= 30) app.getSystemService(CrossProfileApps::class.java) else null
    private val secrets = WorkProfileBridgeSecretStore(app)

    fun snapshot(): WorkProfileSnapshot {
        val owner = dpm.isProfileOwnerApp(app.packageName)
        val profiles = if (Build.VERSION.SDK_INT >= 30) try { crossProfileService()?.targetUserProfiles?.size ?: 0 } catch (_: Exception) { 0 } else 0
        val canInteract = if (Build.VERSION.SDK_INT >= 30 && !owner) try { crossProfileService()?.canInteractAcrossProfiles() == true } catch (_: Exception) { false } else false
        val canRequest = if (Build.VERSION.SDK_INT >= 30 && !owner) try { crossProfileService()?.canRequestInteractAcrossProfiles() == true } catch (_: Exception) { false } else false
        val setup = Intent(DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE).addCategory(Intent.CATEGORY_DEFAULT)
        val canProvision = !owner &&
            dpm.isProvisioningAllowed(DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE) &&
            setup.resolveActivity(app.packageManager) != null
        val adminState = app.getSharedPreferences("work_profile_admin_state", Context.MODE_PRIVATE)
        val profileOwnerConfirmed = owner && adminState.getBoolean("profile_owner_confirmed", false)
        val crossProfileAllowlistReady = if (owner) {
            adminState.getBoolean("cross_profile_allowlist_ready", false)
        } else null
        return WorkProfileSnapshot(
            isProfileOwner = owner,
            profileCount = profiles,
            canProvision = canProvision,
            canRequestAccess = canRequest,
            canInteract = canInteract,
            hasBridgeSecret = secrets.hasSecret(),
            profileOwnerConfirmed = profileOwnerConfirmed,
            crossProfileAllowlistReady = crossProfileAllowlistReady
        )
    }

    fun startProvisioning(activity: Activity): String? {
        if (Build.VERSION.SDK_INT < 24) return "Android version does not support the managed-profile check."
        if (dpm.isProfileOwnerApp(app.packageName)) return "This companion is already running as the Work Profile owner."
        if (!dpm.isProvisioningAllowed(DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE)) {
            return "Android or the device administrator does not allow Work Profile provisioning."
        }
        val intent = Intent(DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE).addCategory(Intent.CATEGORY_DEFAULT)
        if (intent.resolveActivity(activity.packageManager) == null) return "Android Work Profile setup is unavailable."
        val encodedSecret = secrets.createAndSave() ?: return "Could not prepare the local Work Profile link."
        val admin = ComponentName(activity, WorkProfileAdminReceiver::class.java)
        intent.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME, admin)
        intent.putExtra(
            DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE,
            PersistableBundle().apply { putString(WorkProfileContract.ADMIN_EXTRA_SECRET, encodedSecret) }
        )
        return try {
            activity.startActivityForResult(intent, REQUEST_MANAGED_PROFILE)
            null
        } catch (_: Exception) {
            secrets.clear()
            "Android could not start Work Profile setup."
        }
    }

    fun requestAccess(activity: Activity): String? {
        if (Build.VERSION.SDK_INT < 30) return "Cross-profile launch requires Android 11 or later."
        return try {
            when {
                crossProfileService()?.canInteractAcrossProfiles() == true -> null
                crossProfileService()?.canRequestInteractAcrossProfiles() == true -> {
                    activity.startActivityForResult(
                        crossProfileService()!!.createRequestInteractAcrossProfilesIntent(),
                        REQUEST_CROSS_PROFILE_ACCESS
                    )
                    null
                }
                else -> "The Work Profile administrator does not allow this app to request cross-profile access."
            }
        } catch (_: Exception) {
            "Android did not allow cross-profile access to be requested."
        }
    }

    fun onActivityResult(requestCode: Int, resultCode: Int) {
        if (requestCode == REQUEST_MANAGED_PROFILE && resultCode != Activity.RESULT_OK) secrets.clear()
    }

    companion object {
        const val REQUEST_MANAGED_PROFILE = 7301
        const val REQUEST_CROSS_PROFILE_ACCESS = 7302
    }
}
