package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidTouchPolicyTest {
    private val session = "123e4567-e89b-42d3-a456-426614174003"
    private val app = "com.example.notes"
    private fun tap() = RemoteTouchGesture(
        session, app, RemoteGestureKind.TAP,
        NormalizedTouchPoint(0.5f, 0.5f), NormalizedTouchPoint(0.5f, 0.5f), 120
    )

    @Test fun tapRequiresExactSessionAppLocalArmAndAccessibility() {
        assertTrue(AndroidTouchPolicy.validate(tap(), session, app, true, true))
        assertFalse(AndroidTouchPolicy.validate(tap(), session, app, false, true))
        assertFalse(AndroidTouchPolicy.validate(tap(), session, app, true, false))
        assertFalse(AndroidTouchPolicy.validate(tap(), "123e4567-e89b-42d3-a456-426614174004", app, true, true))
        assertFalse(AndroidTouchPolicy.validate(tap(), session, "com.other.app", true, true))
    }

    @Test fun swipeAndLongPressHaveDistinctGeometryAndDurationRules() {
        val swipe = tap().copy(kind = RemoteGestureKind.SWIPE, to = NormalizedTouchPoint(0.5f, 0.9f), durationMillis = 420)
        assertTrue(AndroidTouchPolicy.validate(swipe, session, app, true, true))
        assertFalse(AndroidTouchPolicy.validate(swipe.copy(to = swipe.from), session, app, true, true))
        val longPress = tap().copy(kind = RemoteGestureKind.LONG_PRESS, durationMillis = 800)
        assertTrue(AndroidTouchPolicy.validate(longPress, session, app, true, true))
        assertFalse(AndroidTouchPolicy.validate(longPress.copy(durationMillis = 100), session, app, true, true))
    }

    @Test fun pointsMustBeFiniteAndInsideTheNormalizedWindow() {
        assertFalse(AndroidTouchPolicy.validate(tap().copy(from = NormalizedTouchPoint(1.1f, 0.5f)), session, app, true, true))
        assertFalse(AndroidTouchPolicy.validate(tap().copy(to = NormalizedTouchPoint(Float.NaN, 0.5f)), session, app, true, true))
        assertFalse(AndroidTouchPolicy.validate(tap().copy(durationMillis = 2_000), session, app, true, true))
    }

    @Test fun normalizedCoordinatesMapToWindowBoundsWithoutDisplayOffsetGuessing() {
        val bounds = TouchWindowBounds(24, 80, 1024, 1880)
        assertEquals(24 to 80, AndroidTouchPolicy.map(NormalizedTouchPoint(0f, 0f), bounds))
        assertEquals(1024 to 1880, AndroidTouchPolicy.map(NormalizedTouchPoint(1f, 1f), bounds))
        assertEquals(524 to 980, AndroidTouchPolicy.map(NormalizedTouchPoint(0.5f, 0.5f), bounds))
        assertNull(AndroidTouchPolicy.map(NormalizedTouchPoint(0.5f, 0.5f), TouchWindowBounds(20, 20, 20, 100)))
    }
}
