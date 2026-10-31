package app.rubminds.companion

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle

/**
 * Minimal DPC entry point used only when the device owner explicitly provisions
 * a Rub Minds managed Work Profile. It does not wipe, lock, or restrict the device.
 */
class WorkProfileAdminReceiver : DeviceAdminReceiver() {
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        val admin = ComponentName(context, WorkProfileAdminReceiver::class.java)
        val manager = context.getSystemService(DevicePolicyManager::class.java)
        val extras = intent.getParcelableExtra<PersistableBundle>(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        val encodedSecret = extras?.getString(WorkProfileContract.ADMIN_EXTRA_SECRET)
        val secretSaved = WorkProfileBridgeSecretStore(context).saveEncoded(encodedSecret)

        var crossProfileAllowlistReady = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && secretSaved &&
            manager.isProfileOwnerApp(context.packageName)
        ) {
            try {
                manager.setCrossProfilePackages(admin, setOf(context.packageName))
                crossProfileAllowlistReady = context.packageName in manager.getCrossProfilePackages(admin)
            } catch (_: SecurityException) {
                crossProfileAllowlistReady = false
            } catch (_: IllegalStateException) {
                crossProfileAllowlistReady = false
            }
        }

        try {
            manager.setOrganizationName(admin, "Rub Minds")
        } catch (_: SecurityException) {
            // The profile can still function without organization branding.
        }
        try {
            manager.setProfileEnabled(admin)
        } catch (_: SecurityException) {
            // The companion reports the profile state and never assumes it is enabled.
        }

        context.getSharedPreferences("work_profile_admin_state", Context.MODE_PRIVATE)
            .edit()
            .putBoolean("profile_owner_confirmed", manager.isProfileOwnerApp(context.packageName))
            .putBoolean("bridge_secret_saved", secretSaved)
            .putBoolean("cross_profile_allowlist_ready", crossProfileAllowlistReady)
            .commit()
    }
}
