package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceFrameBindingPolicyTest {
    private val deviceId = "123e4567-e89b-42d3-a456-426614174000"
    private val runtimeId = "123e4567-e89b-42d3-a456-426614174001"
    private val challengeId = "123e4567-e89b-42d3-a456-426614174002"
    private val packageName = "com.example.ai"
    private val signer = "a".repeat(64)

    private fun valid(now:Long=1_000_000L)=DeviceFrameBindingPolicy.isValidAndroidChallenge(
        deviceId,runtimeId,packageName,challengeId,"b".repeat(64),
        "android_app",packageName,signer,now+60_000L,now
    )

    @Test fun acceptsExactLiveAndroidFrameChallenge() {
        assertTrue(valid())
    }

    @Test fun rejectsWrongSurfaceAppOrFrameIdentity() {
        assertFalse(DeviceFrameBindingPolicy.isValidAndroidChallenge(
            deviceId,runtimeId,packageName,challengeId,"b".repeat(64),
            "terminal",packageName,signer,1_060_000L,1_000_000L
        ))
        assertFalse(DeviceFrameBindingPolicy.isValidAndroidChallenge(
            deviceId,runtimeId,packageName,challengeId,"b".repeat(64),
            "android_app","com.other.ai",signer,1_060_000L,1_000_000L
        ))
    }

    @Test fun rejectsInvalidNonceSignerIdsAndExpiredChallenges() {
        assertFalse(DeviceFrameBindingPolicy.isValidAndroidChallenge(
            deviceId,runtimeId,packageName,challengeId,"bad",
            "android_app",packageName,signer,1_060_000L,1_000_000L
        ))
        assertFalse(DeviceFrameBindingPolicy.isValidAndroidChallenge(
            deviceId,runtimeId,packageName,challengeId,"b".repeat(64),
            "android_app",packageName,"bad",1_060_000L,1_000_000L
        ))
        assertFalse(DeviceFrameBindingPolicy.isValidAndroidChallenge(
            deviceId,runtimeId,packageName,challengeId,"b".repeat(64),
            "android_app",packageName,signer,999_999L,1_000_000L
        ))
    }

    @Test fun runtimeDigestIsStableAndScopedToTheSelectedFrame() {
        val digest=DeviceFrameBindingPolicy.runtimeIdentityDigest(deviceId,runtimeId,packageName,signer)
        assertEquals(64,digest.length)
        assertEquals(digest,DeviceFrameBindingPolicy.runtimeIdentityDigest(deviceId,runtimeId,packageName,signer))
        assertFalse(digest==DeviceFrameBindingPolicy.runtimeIdentityDigest(deviceId,runtimeId,packageName,"c".repeat(64)))
    }
}
