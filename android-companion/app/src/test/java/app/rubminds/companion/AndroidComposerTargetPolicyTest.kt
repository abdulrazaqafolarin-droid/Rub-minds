package app.rubminds.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidComposerTargetPolicyTest {
    private val window = TouchWindowBounds(20, 40, 1020, 1840)
    private val selection = ComposerScreenRect(100, 1500, 920, 1780)
    private fun candidate(
        id: String = "target-a",
        bounds: ComposerScreenRect = ComposerScreenRect(120, 1540, 900, 1740),
        editable: Boolean = true,
        enabled: Boolean = true,
        visible: Boolean = true,
        password: Boolean = false,
        packageName: String = "com.example.chat"
    ) = ComposerCandidate(id, packageName, bounds, editable, enabled, visible, password)

    @Test fun normalizedDragMapsToTheActualAppWindow() {
        assertEquals(ComposerScreenRect(120, 1540, 920, 1780),
            AndroidComposerTargetPolicy.mapRegion(
                NormalizedComposerSelection(0.1f, 0.9f, 0.9f, 0.98f), window
            ))
    }

    @Test fun tinyOutOfBoundsAndReversedSelectionsAreRejected() {
        assertNull(AndroidComposerTargetPolicy.mapRegion(
            NormalizedComposerSelection(0.2f, 0.2f, 0.2f, 0.5f), window
        ))
        assertNull(AndroidComposerTargetPolicy.mapRegion(
            NormalizedComposerSelection(-0.1f, 0.2f, 0.5f, 0.5f), window
        ))
        assertNull(AndroidComposerTargetPolicy.mapRegion(
            NormalizedComposerSelection(0.8f, 0.8f, 0.2f, 0.2f), window
        ))
    }

    @Test fun exactlyOneVisibleEditableNonPasswordFieldMustBeSelected() {
        val result = AndroidComposerTargetPolicy.choose(listOf(candidate()), "com.example.chat", selection)
        assertEquals("selected", result.reason)
        assertEquals("target-a", result.candidate?.targetId)
    }

    @Test fun passwordDisabledHiddenNonEditableAndWrongPackageNodesAreRejected() {
        val candidates = listOf(
            candidate(id = "password", password = true),
            candidate(id = "disabled", enabled = false),
            candidate(id = "hidden", visible = false),
            candidate(id = "static", editable = false),
            candidate(id = "other-app", packageName = "com.example.other")
        )
        assertEquals("no_single_editable_field_in_selection",
            AndroidComposerTargetPolicy.choose(candidates, "com.example.chat", selection).reason)
    }

    @Test fun ambiguousEditableFieldsFailClosed() {
        val first = candidate(id = "first")
        val second = candidate(id = "second", bounds = ComposerScreenRect(130, 1550, 890, 1730))
        val result = AndroidComposerTargetPolicy.choose(listOf(first, second), "com.example.chat", selection)
        assertNull(result.candidate)
        assertEquals("multiple_editable_fields_in_selection", result.reason)
    }

    @Test fun partiallyCoveredFieldsAreNotSelected() {
        val partial = candidate(bounds = ComposerScreenRect(50, 1540, 900, 1740))
        assertNull(AndroidComposerTargetPolicy.choose(listOf(partial), "com.example.chat", selection).candidate)
    }
}
