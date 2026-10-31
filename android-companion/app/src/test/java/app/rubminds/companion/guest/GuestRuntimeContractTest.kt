package app.rubminds.companion.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

class GuestRuntimeContractTest {
    private val device = GuestDeviceProfile(34, "arm64-v8a", "tecno-kl4-api34-arm64")
    private val descriptor = GuestRuntimeDescriptor(
        engineId = "safe.guest.engine",
        engineVersion = "0.1.0",
        licenseId = "Apache-2.0",
        minApiLevel = 28,
        maxApiLevel = 36,
        supportedAbis = setOf("arm64-v8a"),
        targetSdk = 35,
        capabilities = GuestRuntimeCapability.values().toSet(),
        mergedHostPermissions = setOf("android.permission.INTERNET", "android.permission.FOREGROUND_SERVICE"),
        mergedManifestAudited = true,
        releaseArtifactDebugSigned = false
    )
    private val checks = GuestAcceptanceCheck.values().toSet()

    private fun frame(
        sequence: Long = 12,
        scope: GuestCaptureScope = GuestCaptureScope.GUEST_APP,
        sessionId: String = "session-1",
        instanceId: String = "guest-instance-1",
        capturedAt: Long = 9_900
    ) = GuestFrame(
        sessionId = sessionId,
        guestInstanceId = instanceId,
        frameId = "frame-$sequence",
        sequence = sequence,
        capturedAtMillis = capturedAt,
        width = 1080,
        height = 1920,
        mimeType = "image/jpeg",
        captureScope = scope,
        encodedBytes = byteArrayOf(1, 2, 3, 4)
    )

    private fun field(
        currentText: String = "",
        password: Boolean = false,
        readOnly: Boolean = false,
        editable: Boolean = true,
        enabled: Boolean = true,
        frameSequence: Long = 12
    ) = GuestTextFieldTarget(
        sessionId = "session-1",
        guestInstanceId = "guest-instance-1",
        frameSequence = frameSequence,
        fieldId = "composer-1",
        bounds = NormalizedGuestRect(0.1, 0.7, 0.8, 0.2),
        enabled = enabled,
        editable = editable,
        password = password,
        readOnly = readOnly,
        currentText = currentText,
        accessibilityBacked = true
    )

    private fun selection(
        id: String = "selection-1",
        bounds: NormalizedGuestRect = NormalizedGuestRect(0.15, 0.72, 0.7, 0.15),
        sequence: Long = 12,
        expiresAt: Long = 50_000
    ) = GuestSelectionLease(
        sessionId = "session-1",
        guestInstanceId = "guest-instance-1",
        frameSequence = sequence,
        selectionId = id,
        fieldId = "composer-1",
        selectedBounds = bounds,
        createdAtMillis = 10_000,
        expiresAtMillis = expiresAt
    )

    @Test fun safeCandidateStillRequiresDeviceAcceptanceEvidence() {
        val review = GuestRuntimeAdmissionPolicy.review(descriptor, device)
        assertEquals(GuestRuntimeDecision.DEVICE_POC_REQUIRED, review.decision)
        assertEquals(checks, review.missingDeviceChecks.toSet())
    }

    @Test fun matchingCompleteDeviceEvidenceIsTheOnlyPathToReady() {
        val evidence = GuestDeviceAcceptanceEvidence(
            engineId = descriptor.engineId,
            engineVersion = descriptor.engineVersion,
            deviceProfileId = device.localProfileId,
            apiLevel = device.apiLevel,
            abi = device.abi,
            testRunId = "poc-run-2026-10-31",
            passedChecks = checks
        )
        val review = GuestRuntimeAdmissionPolicy.review(descriptor, device, evidence)
        assertEquals(GuestRuntimeDecision.READY, review.decision)
        assertEquals(emptyList<String>(), review.blockers)
        assertEquals(emptyList<GuestAcceptanceCheck>(), review.missingDeviceChecks)
    }

    @Test fun broadHostPermissionsBlockTheEngineEvenWhenTheLibraryClaimsTheyAreOptional() {
        val candidate = descriptor.copy(mergedHostPermissions = setOf(
            "android.permission.INTERNET",
            "android.permission.QUERY_ALL_PACKAGES",
            "com.google.android.gms.permission.READ_CONTACTS",
            "android.permission.MANAGE_EXTERNAL_STORAGE"
        ))
        val review = GuestRuntimeAdmissionPolicy.review(candidate, device)
        assertEquals(GuestRuntimeDecision.BLOCKED, review.decision)
        assertNotNull(review.blockers.firstOrNull { it.startsWith("unapproved_host_permissions:") })
    }

    @Test fun rootDebugSigningLicenseAndManifestFailuresBlockAdmission() {
        val candidates = listOf(
            descriptor.copy(capabilities = descriptor.capabilities - GuestRuntimeCapability.ROOTLESS_EXECUTION),
            descriptor.copy(releaseArtifactDebugSigned = true),
            descriptor.copy(licenseId = "UNKNOWN"),
            descriptor.copy(mergedManifestAudited = false),
            descriptor.copy(targetSdk = 28)
        )
        candidates.forEach { candidate ->
            assertEquals(GuestRuntimeDecision.BLOCKED, GuestRuntimeAdmissionPolicy.review(candidate, device).decision)
        }
    }

    @Test fun unsupportedApiAndAbiBlockAdmission() {
        assertEquals(
            GuestRuntimeDecision.BLOCKED,
            GuestRuntimeAdmissionPolicy.review(descriptor, device.copy(apiLevel = 27)).decision
        )
        assertEquals(
            GuestRuntimeDecision.BLOCKED,
            GuestRuntimeAdmissionPolicy.review(descriptor, device.copy(abi = "armeabi-v7a")).decision
        )
    }

    @Test fun acceptanceEvidenceMustMatchTheExactEngineVersionAndDeviceProfile() {
        val wrongEngine = GuestDeviceAcceptanceEvidence(
            engineId = "other.engine", engineVersion = "0.1.0",
            deviceProfileId = device.localProfileId, apiLevel = 34, abi = "arm64-v8a",
            testRunId = "run", passedChecks = checks
        )
        assertEquals(
            GuestRuntimeDecision.DEVICE_POC_REQUIRED,
            GuestRuntimeAdmissionPolicy.review(descriptor, device, wrongEngine).decision
        )
        val wrongDevice = wrongEngine.copy(
            engineId = descriptor.engineId, deviceProfileId = "different-device"
        )
        assertEquals(
            GuestRuntimeDecision.DEVICE_POC_REQUIRED,
            GuestRuntimeAdmissionPolicy.review(descriptor, device, wrongDevice).decision
        )
    }

    @Test fun guestFrameMustBelongToTheCurrentSessionAndBeGuestOnly() {
        assertNull(GuestFramePolicy.validate(frame(), "session-1", "guest-instance-1", 10_000))
        assertEquals("frame_session_mismatch", GuestFramePolicy.validate(frame(), "other", "guest-instance-1", 10_000))
        assertEquals(
            "frame_is_not_guest_only",
            GuestFramePolicy.validate(frame(scope = GuestCaptureScope.WHOLE_DEVICE), "session-1", "guest-instance-1", 10_000)
        )
    }

    @Test fun frameSequencePayloadDimensionsMimeAndFreshnessAreValidated() {
        assertEquals("frame_identity_invalid", GuestFramePolicy.validate(frame(sequence = 0), "session-1", "guest-instance-1", 10_000))
        assertEquals("frame_dimensions_invalid", GuestFramePolicy.validate(frame().copy(width = 9000), "session-1", "guest-instance-1", 10_000))
        assertEquals("frame_mime_type_unsupported", GuestFramePolicy.validate(frame().copy(mimeType = "text/html"), "session-1", "guest-instance-1", 10_000))
        assertEquals("frame_payload_size_invalid", GuestFramePolicy.validate(frame().copy(encodedBytes = ByteArray(GuestFramePolicy.MAX_FRAME_BYTES + 1)), "session-1", "guest-instance-1", 10_000))
        assertEquals("frame_stale", GuestFramePolicy.validate(frame(capturedAt = 1_000), "session-1", "guest-instance-1", 10_000))
    }

    @Test fun normalizedRectanglesRejectOutOfFrameAndNonFiniteValues() {
        assertTrue(NormalizedGuestRect(0.1, 0.1, 0.5, 0.5).isValid())
        assertFalse(NormalizedGuestRect(-0.1, 0.1, 0.5, 0.5).isValid())
        assertFalse(NormalizedGuestRect(0.9, 0.1, 0.5, 0.5).isValid())
        assertFalse(NormalizedGuestRect(0.1, 0.1, Double.NaN, 0.5).isValid())
    }

    @Test fun freshAccessibleEmptyFieldCanBeSelectedWhenDragMostlyCoversIt() {
        assertNull(GuestTargetPolicy.validateSelection(frame(), field(), selection(), 10_000))
    }

    @Test fun wrongFrameInstanceOrFieldCannotInheritTheSelection() {
        assertEquals("target_frame_is_stale", GuestTargetPolicy.validateSelection(frame(sequence = 13), field(), selection(), 10_000))
        assertEquals("target_guest_instance_mismatch", GuestTargetPolicy.validateSelection(frame(), field(), selection().copy(guestInstanceId = "other-instance"), 10_000))
        assertEquals("target_identity_invalid", GuestTargetPolicy.validateSelection(frame(), field(), selection().copy(fieldId = "other-field"), 10_000))
    }

    @Test fun passwordReadOnlyOccupiedDisabledAndUnverifiedControlsAreRejected() {
        val variants = listOf(
            field(password = true),
            field(readOnly = true),
            field(currentText = "human text"),
            field(enabled = false),
            field(editable = false),
            field().copy(accessibilityBacked = false)
        )
        variants.forEach { target ->
            assertNotNull(GuestTargetPolicy.validateSelection(frame(), target, selection(), 10_000))
        }
    }

    @Test fun dragMustCoverAtLeastSixtyFivePercentOfOneField() {
        val selectionTooWide = selection(bounds = NormalizedGuestRect(0.0, 0.0, 1.0, 1.0))
        assertEquals("selection_outside_target", GuestTargetPolicy.validateSelection(frame(), field(), selectionTooWide, 10_000))
    }

    @Test fun expiredOrMalformedSelectionCannotBeUsed() {
        assertEquals("target_selection_expired", GuestTargetPolicy.validateSelection(frame(), field(), selection(expiresAt = 10_000), 10_000))
        assertEquals("target_bounds_invalid", GuestTargetPolicy.validateSelection(
            frame(), field(), selection(bounds = NormalizedGuestRect(0.1, 0.1, 2.0, 0.2)), 10_000
        ))
    }

    @Test fun draftRequiresMatchingSelectionLocalApprovalAndPlainTextWithoutSubmit() {
        val lease = selection()
        val target = field()
        val valid = GuestDraftRequest("draft-1", lease.selectionId, "Review this answer", approvedLocally = true)
        assertNull(GuestTargetPolicy.validateDraft(frame(), target, lease, valid, 10_000))
        assertEquals("local_approval_required", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(approvedLocally = false), 10_000
        ))
        assertEquals("draft_selection_mismatch", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(selectionId = "stale-selection"), 10_000
        ))
        assertEquals("submit_not_supported", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(submit = true), 10_000
        ))
        assertEquals("draft_text_invalid", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(text = "first\nsecond"), 10_000
        ))
        assertEquals("draft_text_invalid", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(text = " ".repeat(4_001)), 10_000
        ))
    }
}
