package app.rubminds.companion

/** Normalized coordinates are relative to the active app window, not the whole phone display. */
data class NormalizedTouchPoint(val x: Float, val y: Float)
data class TouchWindowBounds(val left: Int, val top: Int, val right: Int, val bottom: Int)
enum class RemoteGestureKind { TAP, SWIPE, LONG_PRESS }

data class RemoteTouchGesture(
    val sessionId: String,
    val appPackageName: String,
    val kind: RemoteGestureKind,
    val from: NormalizedTouchPoint,
    val to: NormalizedTouchPoint,
    val durationMillis: Int
)

object AndroidTouchPolicy {
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

    fun validate(
        gesture: RemoteTouchGesture,
        activeSessionId: String?,
        activePackageName: String?,
        localTouchArmed: Boolean,
        accessibilityEnabled: Boolean
    ): Boolean {
        if (!localTouchArmed || !accessibilityEnabled) return false
        if (activeSessionId == null || !uuid.matches(activeSessionId) || gesture.sessionId != activeSessionId) return false
        if (!AppGrantPolicy.isValidPackageName(gesture.appPackageName) || activePackageName != gesture.appPackageName) return false
        if (!validPoint(gesture.from) || !validPoint(gesture.to)) return false
        if (gesture.durationMillis !in 40..1_500) return false
        return when (gesture.kind) {
            RemoteGestureKind.TAP -> distance(gesture.from, gesture.to) <= 0.01f
            RemoteGestureKind.SWIPE -> distance(gesture.from, gesture.to) >= 0.02f
            RemoteGestureKind.LONG_PRESS -> distance(gesture.from, gesture.to) <= 0.01f &&
                gesture.durationMillis >= 500
        }
    }

    fun map(point: NormalizedTouchPoint, bounds: TouchWindowBounds): Pair<Int, Int>? {
        if (!validPoint(point) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null
        val maxX = bounds.right - 1
        val maxY = bounds.bottom - 1
        if (maxX < bounds.left || maxY < bounds.top) return null
        val x = (bounds.left + point.x * (maxX - bounds.left)).toInt()
        val y = (bounds.top + point.y * (maxY - bounds.top)).toInt()
        if (x !in bounds.left..maxX || y !in bounds.top..maxY) return null
        return x to y
    }

    private fun validPoint(point: NormalizedTouchPoint): Boolean =
        point.x.isFinite() && point.y.isFinite() &&
            point.x in 0f..1f && point.y in 0f..1f

    private fun distance(a: NormalizedTouchPoint, b: NormalizedTouchPoint): Float =
        kotlin.math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
}
