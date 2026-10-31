package app.rubminds.companion.guest

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.companion.virtual.VirtualDeviceManager

/**
 * Read-only probe for the platform app-streaming path.
 *
 * The public SDK exposes VirtualDeviceManager discovery, but creation is a
 * restricted SystemApi requiring an OEM/system role and a CDM association.
 * This probe intentionally never calls hidden APIs or requests that permission.
 */
enum class AndroidVirtualDevicePlatformState {
    ANDROID_VERSION_UNSUPPORTED,
    SECONDARY_DISPLAY_FEATURE_UNAVAILABLE,
    VIRTUAL_DEVICE_SERVICE_NOT_CONFIGURED,
    PLATFORM_PRESENT_BUT_SYSTEM_ROLE_REQUIRED
}

data class AndroidVirtualDeviceCapabilitySnapshot(
    val apiLevel: Int,
    val secondaryDisplayFeatureAvailable: Boolean,
    val virtualDeviceServiceAvailable: Boolean,
    val visibleVirtualDeviceCount: Int,
    val state: AndroidVirtualDevicePlatformState
)

object AndroidVirtualDeviceCapabilityProbe {
    fun assess(
        apiLevel: Int,
        secondaryDisplayFeatureAvailable: Boolean,
        virtualDeviceServiceAvailable: Boolean,
        visibleVirtualDeviceCount: Int
    ): AndroidVirtualDeviceCapabilitySnapshot {
        val safeCount = visibleVirtualDeviceCount.coerceAtLeast(0)
        val state = when {
            apiLevel < 34 -> AndroidVirtualDevicePlatformState.ANDROID_VERSION_UNSUPPORTED
            !secondaryDisplayFeatureAvailable ->
                AndroidVirtualDevicePlatformState.SECONDARY_DISPLAY_FEATURE_UNAVAILABLE
            !virtualDeviceServiceAvailable ->
                AndroidVirtualDevicePlatformState.VIRTUAL_DEVICE_SERVICE_NOT_CONFIGURED
            else -> AndroidVirtualDevicePlatformState.PLATFORM_PRESENT_BUT_SYSTEM_ROLE_REQUIRED
        }
        return AndroidVirtualDeviceCapabilitySnapshot(
            apiLevel = apiLevel,
            secondaryDisplayFeatureAvailable = secondaryDisplayFeatureAvailable,
            virtualDeviceServiceAvailable = virtualDeviceServiceAvailable,
            visibleVirtualDeviceCount = safeCount,
            state = state
        )
    }

    fun read(context: Context): AndroidVirtualDeviceCapabilitySnapshot {
        val apiLevel = Build.VERSION.SDK_INT
        val secondaryDisplays = context.packageManager.hasSystemFeature(
            PackageManager.FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS
        )
        if (apiLevel < 34) {
            return assess(apiLevel, secondaryDisplays, false, 0)
        }

        val manager = try {
            context.getSystemService(VirtualDeviceManager::class.java)
        } catch (_: SecurityException) {
            null
        } catch (_: UnsupportedOperationException) {
            null
        }
        val visibleCount = try {
            manager?.virtualDevices?.size ?: 0
        } catch (_: SecurityException) {
            0
        } catch (_: UnsupportedOperationException) {
            0
        }

        return assess(
            apiLevel = apiLevel,
            secondaryDisplayFeatureAvailable = secondaryDisplays,
            virtualDeviceServiceAvailable = manager != null,
            visibleVirtualDeviceCount = visibleCount
        )
    }
}
