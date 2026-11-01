package app.rubminds.companion

/** A drag selection expressed in normalized coordinates of the captured app window. */
data class NormalizedComposerSelection(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float
)

data class ComposerScreenRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val area: Long get() = width.toLong() * height.toLong()
}

data class ComposerCandidate(
    val targetId: String,
    val packageName: String,
    val bounds: ComposerScreenRect,
    val editable: Boolean,
    val enabled: Boolean,
    val visible: Boolean,
    val password: Boolean
)

data class ComposerSelectionDecision(
    val candidate: ComposerCandidate?,
    val reason: String
)

/**
 * Selects only one visible, enabled, editable, non-password node whose bounds
 * are substantially contained by the user's drag rectangle. It deliberately
 * has no API for reading editor text, labels, hints or conversation content.
 */
object AndroidComposerTargetPolicy {
    private const val MIN_SELECTION_WIDTH = 0.008f
    private const val MIN_SELECTION_HEIGHT = 0.004f
    private const val MIN_NODE_COVERAGE = 0.80

    fun mapRegion(
        region: NormalizedComposerSelection,
        window: TouchWindowBounds
    ): ComposerScreenRect? {
        val values = listOf(region.left, region.top, region.right, region.bottom)
        if (values.any { !it.isFinite() || it !in 0f..1f }) return null
        if (region.right - region.left < MIN_SELECTION_WIDTH ||
            region.bottom - region.top < MIN_SELECTION_HEIGHT ||
            region.right <= region.left || region.bottom <= region.top ||
            window.right <= window.left || window.bottom <= window.top
        ) return null

        val width = window.right - window.left
        val height = window.bottom - window.top
        val left = window.left + (region.left * width).toInt()
        val top = window.top + (region.top * height).toInt()
        val right = window.left + (region.right * width).toInt()
        val bottom = window.top + (region.bottom * height).toInt()
        if (right <= left || bottom <= top) return null
        return ComposerScreenRect(left, top, right, bottom)
    }

    fun choose(
        candidates: List<ComposerCandidate>,
        packageName: String,
        selection: ComposerScreenRect
    ): ComposerSelectionDecision {
        if (selection.width <= 0 || selection.height <= 0 || selection.area <= 0) {
            return ComposerSelectionDecision(null, "invalid_selection_region")
        }
        val matches = candidates.filter { candidate ->
            if (candidate.packageName != packageName ||
                !candidate.editable || !candidate.enabled ||
                !candidate.visible || candidate.password ||
                candidate.targetId.isBlank() || candidate.bounds.area <= 0
            ) return@filter false

            val left = maxOf(selection.left, candidate.bounds.left)
            val top = maxOf(selection.top, candidate.bounds.top)
            val right = minOf(selection.right, candidate.bounds.right)
            val bottom = minOf(selection.bottom, candidate.bounds.bottom)
            if (right <= left || bottom <= top) return@filter false

            val intersection = (right - left).toLong() * (bottom - top).toLong()
            intersection.toDouble() / candidate.bounds.area.toDouble() >= MIN_NODE_COVERAGE
        }
        return when (matches.size) {
            0 -> ComposerSelectionDecision(null, "no_single_editable_field_in_selection")
            1 -> ComposerSelectionDecision(matches.single(), "selected")
            else -> ComposerSelectionDecision(null, "multiple_editable_fields_in_selection")
        }
    }
}
