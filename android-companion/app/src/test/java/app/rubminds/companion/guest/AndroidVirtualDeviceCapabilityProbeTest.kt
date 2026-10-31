package app.rubminds.companion.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVirtualDeviceCapabilityProbeTest {
    @Test fun olderAndroidVersionsCannotUseVirtualDeviceManager() {
        val snapshot = AndroidVirtualDeviceCapabilityProbe.assess(
            apiLevel = 33,
            secondaryDisplayFeatureAvailable = true,
            virtualDeviceServiceAvailable = true,
            visibleVirtualDeviceCount = 1
        )
        assertEquals(AndroidVirtualDevicePlatformState.ANDROID_VERSION_UNSUPPORTED, snapshot.state)
    }

    @Test fun missingSecondaryDisplayFeatureIsReportedBeforeAnyRoleCheck() {
        val snapshot = AndroidVirtualDeviceCapabilityProbe.assess(
            apiLevel = 34,
            secondaryDisplayFeatureAvailable = false,
            virtualDeviceServiceAvailable = true,
            visibleVirtualDeviceCount = 0
        )
        assertEquals(
            AndroidVirtualDevicePlatformState.SECONDARY_DISPLAY_FEATURE_UNAVAILABLE,
            snapshot.state
        )
    }

    @Test fun absentVirtualDeviceServiceMeansFirmwareHasNotEnabledIt() {
        val snapshot = AndroidVirtualDeviceCapabilityProbe.assess(
            apiLevel = 34,
            secondaryDisplayFeatureAvailable = true,
            virtualDeviceServiceAvailable = false,
            visibleVirtualDeviceCount = 0
        )
        assertEquals(
            AndroidVirtualDevicePlatformState.VIRTUAL_DEVICE_SERVICE_NOT_CONFIGURED,
            snapshot.state
        )
    }

    @Test fun exposedPlatformDoesNotMeanAnOrdinaryCompanionCanCreateDevices() {
        val snapshot = AndroidVirtualDeviceCapabilityProbe.assess(
            apiLevel = 35,
            secondaryDisplayFeatureAvailable = true,
            virtualDeviceServiceAvailable = true,
            visibleVirtualDeviceCount = 2
        )
        assertEquals(
            AndroidVirtualDevicePlatformState.PLATFORM_PRESENT_BUT_SYSTEM_ROLE_REQUIRED,
            snapshot.state
        )
        assertEquals(2, snapshot.visibleVirtualDeviceCount)
    }

    @Test fun invalidVisibleDeviceCountIsClampedToZero() {
        val snapshot = AndroidVirtualDeviceCapabilityProbe.assess(
            apiLevel = 35,
            secondaryDisplayFeatureAvailable = true,
            virtualDeviceServiceAvailable = true,
            visibleVirtualDeviceCount = -1
        )
        assertEquals(0, snapshot.visibleVirtualDeviceCount)
    }
}
