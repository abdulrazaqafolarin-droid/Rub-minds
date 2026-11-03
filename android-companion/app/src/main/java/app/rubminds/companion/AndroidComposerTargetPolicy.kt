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

data class SendControlCandidate(
    val targetId: String,
    val packageName: String,
    val bounds: ComposerScreenRect,
    val label: String,
    val resourceId: String,
    val clickable: Boolean,
    val enabled: Boolean,
    val visible: Boolean
)

data class SendControlDecision(
    val candidate: SendControlCandidate?,
    val reason: String
)

data class ComposerSelectionDecision(
    val candidate: ComposerCandidate?,
    val reason: String,
    val sendControl: SendControlCandidate? = null,
    val sendReason: String = "not_checked"
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


/**
 * Finds a single, explicitly labelled Send control adjacent to the selected
 * composer. All labels and resource identifiers are inspected locally and are
 * never returned to the web client. Ambiguous or generic submit-like controls
 * are rejected rather than guessed.
 */
object AndroidSendControlPolicy {
    private val acceptedLabels = setOf("send", "send message", "send prompt")
    private val sendResourceId = Regex("(^|[_-])send([_-]|$)", RegexOption.IGNORE_CASE)
    private val rejectedResourceTokens = setOf("resend", "email", "feedback", "share", "forward", "reply")
    private val targetIdPattern = Regex("^[a-f0-9]{64}$")

    fun isRecognizedLabel(label: String): Boolean =
        label.trim().lowercase().replace(Regex("\\s+"), " ") in acceptedLabels

    fun isRecognizedResourceId(resourceId: String): Boolean {
        val resourceName = resourceId.substringAfterLast('/').lowercase()
        return sendResourceId.containsMatchIn(resourceName) &&
            rejectedResourceTokens.none { token -> resourceName.contains(token) }
    }

    fun choose(
        candidates: List<SendControlCandidate>,
        packageName: String,
        rootBounds: ComposerScreenRect,
        composerBounds: ComposerScreenRect
    ): SendControlDecision {
        if (!validBounds(rootBounds) || !validBounds(composerBounds)) {
            return SendControlDecision(null, "invalid_app_or_composer_bounds")
        }
        val maxVerticalGap = maxOf(96, composerBounds.height * 3, rootBounds.height / 10)
        val maxHorizontalGap = maxOf(96, composerBounds.width / 2, rootBounds.width / 10)
        val matches = candidates.filter { candidate ->
            if (candidate.packageName != packageName ||
                !candidate.clickable || !candidate.enabled || !candidate.visible ||
                !targetIdPattern.matches(candidate.targetId) ||
                !validBounds(candidate.bounds) ||
                candidate.bounds.left < rootBounds.left ||
                candidate.bounds.top < rootBounds.top ||
                candidate.bounds.right > rootBounds.right ||
                candidate.bounds.bottom > rootBounds.bottom
            ) return@filter false

            val accessibleNameMatches = isRecognizedLabel(candidate.label)
            val resourceNameMatches = candidate.label.isBlank() &&
                isRecognizedResourceId(candidate.resourceId)
            if (!accessibleNameMatches && !resourceNameMatches) return@filter false

            val verticalGap = when {
                candidate.bounds.bottom < composerBounds.top ->
                    composerBounds.top - candidate.bounds.bottom
                candidate.bounds.top > composerBounds.bottom ->
                    candidate.bounds.top - composerBounds.bottom
                else -> 0
            }
            val horizontalGap = when {
                candidate.bounds.right < composerBounds.left ->
                    composerBounds.left - candidate.bounds.right
                candidate.bounds.left > composerBounds.right ->
                    candidate.bounds.left - composerBounds.right
                else -> 0
            }
            verticalGap <= maxVerticalGap && horizontalGap <= maxHorizontalGap
        }
        return when (matches.size) {
            0 -> SendControlDecision(null, "unique_nearby_send_control_not_found")
            1 -> SendControlDecision(matches.single(), "unique_send_control_verified")
            else -> SendControlDecision(null, "multiple_send_controls_ambiguous")
        }
    }

    private fun validBounds(bounds: ComposerScreenRect): Boolean =
        bounds.right > bounds.left && bounds.bottom > bounds.top && bounds.area > 0
}
