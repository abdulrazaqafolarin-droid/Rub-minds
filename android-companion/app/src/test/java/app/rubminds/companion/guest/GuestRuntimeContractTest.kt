package app.rubminds.companion.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

class GuestRuntimeContractTest {
    private val device = GuestDeviceProfile(34, "arm64-v8a", "tecno-kl4-api34-arm64")
    private val artifactSha256 = "b".repeat(64)
    private val manifestSha256 = "c".repeat(64)
    private val descriptor = GuestRuntimeDescriptor(
        hostApplicationId = "app.rubminds.companion",
        engineId = "safe.guest.engine",
        engineVersion = "0.1.0",
        licenseId = "Apache-2.0",
        minApiLevel = 28,
        maxApiLevel = 36,
        supportedAbis = setOf("arm64-v8a"),
        targetSdk = 35,
        releaseArtifactSha256 = artifactSha256,
        mergedManifestSha256 = manifestSha256,
        capabilities = GuestRuntimeCapability.values().toSet(),
        mergedHostPermissions = setOf("android.permission.INTERNET", "android.permission.FOREGROUND_SERVICE"),
        mergedHostComponents = listOf(
            GuestHostComponent(
                className = "app.rubminds.companion.MainActivity",
                type = GuestHostComponentType.ACTIVITY,
                exported = true,
                isLauncherActivity = true
            ),
            GuestHostComponent(
                className = "app.rubminds.companion.DraftInputMethodService",
                type = GuestHostComponentType.SERVICE,
                exported = true,
                permission = "android.permission.BIND_INPUT_METHOD",
                permissionProtection = GuestPermissionProtection.SIGNATURE,
                isSystemBoundInputMethod = true
            )
        ),
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
        selectionId = selectionId(id),
        fieldId = "composer-1",
        selectedBounds = bounds,
        createdAtMillis = 10_000,
        expiresAtMillis = expiresAt
    )

    private fun selectionId(label: String) =
        java.util.UUID.nameUUIDFromBytes(label.toByteArray()).toString()

    private fun requestId(label: String) =
        java.util.UUID.nameUUIDFromBytes(label.toByteArray()).toString()

    private fun approval(
        lease: GuestSelectionLease,
        requestId: String,
        text: String,
        issuedAt: Long = 10_000,
        expiresAt: Long = 50_000
    ) = GuestLocalApprovalReceipt.issueAfterNativeConfirmation(
        lease.sessionId, lease.selectionId, requestId, text, issuedAt, expiresAt
    )!!

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
            releaseArtifactSha256 = artifactSha256,
            mergedManifestSha256 = manifestSha256,
            passedChecks = checks
        )
        val review = GuestRuntimeAdmissionPolicy.review(descriptor, device, evidence)
        assertEquals(GuestRuntimeDecision.READY, review.decision)
        assertEquals(emptyList<String>(), review.blockers)
        assertEquals(emptyList<GuestAcceptanceCheck>(), review.missingDeviceChecks)
    }



    @Test fun physicalAcceptanceCannotBeReusedForDifferentReleaseArtifactOrMergedManifest() {
        val evidence = GuestDeviceAcceptanceEvidence(
            engineId = descriptor.engineId, engineVersion = descriptor.engineVersion,
            deviceProfileId = device.localProfileId, apiLevel = device.apiLevel, abi = device.abi,
            testRunId = "poc-run-2026-10-31",
            releaseArtifactSha256 = artifactSha256,
            mergedManifestSha256 = manifestSha256,
            passedChecks = checks
        )
        assertEquals(
            GuestRuntimeDecision.DEVICE_POC_REQUIRED,
            GuestRuntimeAdmissionPolicy.review(
                descriptor.copy(releaseArtifactSha256 = "d".repeat(64)), device, evidence
            ).decision
        )
        assertEquals(
            GuestRuntimeDecision.DEVICE_POC_REQUIRED,
            GuestRuntimeAdmissionPolicy.review(
                descriptor.copy(mergedManifestSha256 = "e".repeat(64)), device, evidence
            ).decision
        )
        assertEquals(
            GuestRuntimeDecision.BLOCKED,
            GuestRuntimeAdmissionPolicy.review(
                descriptor.copy(releaseArtifactSha256 = "not-a-sha"), device
            ).decision
        )
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


    @Test fun onlyTheKnownLauncherAndSystemBoundInputMethodMayBeUnprotectedExportedComponents() {
        val bad = descriptor.copy(mergedHostComponents = descriptor.mergedHostComponents + GuestHostComponent(
            className = "com.blackbox.BridgeService",
            type = GuestHostComponentType.SERVICE,
            exported = true
        ))
        val review = GuestRuntimeAdmissionPolicy.review(bad, device)
        assertEquals(GuestRuntimeDecision.BLOCKED, review.decision)
        assertNotNull(review.blockers.firstOrNull { it.startsWith("unapproved_exported_components:") })
    }



    @Test fun launcherExceptionDoesNotApplyToThirdPartyClassWithSameSuffix() {
        val bad = descriptor.copy(mergedHostComponents = listOf(
            GuestHostComponent(
                className = "com.thirdparty.MainActivity",
                type = GuestHostComponentType.ACTIVITY,
                exported = true,
                isLauncherActivity = true
            ),
            descriptor.mergedHostComponents.last()
        ))
        assertEquals(GuestRuntimeDecision.BLOCKED, GuestRuntimeAdmissionPolicy.review(bad, device).decision)
    }

    @Test fun exportedAccessibilityServiceAndItsPermissionAreAlwaysRejected() {
        val bad = descriptor.copy(mergedHostComponents = descriptor.mergedHostComponents + GuestHostComponent(
            className = "com.engine.ObserverService",
            type = GuestHostComponentType.SERVICE,
            exported = true,
            permission = "android.permission.BIND_ACCESSIBILITY_SERVICE",
            permissionProtection = GuestPermissionProtection.SIGNATURE
        ))
        assertEquals(GuestRuntimeDecision.BLOCKED, GuestRuntimeAdmissionPolicy.review(bad, device).decision)
    }

    @Test fun exportedInternalComponentRequiresSignatureProtection() {
        val safe = descriptor.copy(mergedHostComponents = descriptor.mergedHostComponents + GuestHostComponent(
            className = "com.example.InternalProvider",
            type = GuestHostComponentType.PROVIDER,
            exported = true,
            permission = "com.example.INTERNAL_ACCESS",
            permissionProtection = GuestPermissionProtection.SIGNATURE
        ))
        assertEquals(GuestRuntimeDecision.DEVICE_POC_REQUIRED, GuestRuntimeAdmissionPolicy.review(safe, device).decision)
    }

    @Test fun accessibilityAndPrivilegedHostPermissionAtomsAreDenied() {
        val bad = descriptor.copy(mergedHostPermissions = setOf(
            "android.permission.INTERNET",
            "android.permission.WRITE_SECURE_SETTINGS",
            "android.permission.READ_LOGS"
        ))
        assertEquals(GuestRuntimeDecision.BLOCKED, GuestRuntimeAdmissionPolicy.review(bad, device).decision)
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
            testRunId = "run", releaseArtifactSha256 = artifactSha256,
            mergedManifestSha256 = manifestSha256, passedChecks = checks
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
        assertEquals("target_identity_invalid", GuestTargetPolicy.validateSelection(frame(), field(), selection().copy(selectionId = "not-a-uuid"), 10_000))
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
        val validRequestId = requestId("draft-1")
        val validText = "Review this answer"
        val valid = GuestDraftRequest(validRequestId, lease.selectionId, validText, approval(lease, validRequestId, validText))
        assertNull(GuestTargetPolicy.validateDraft(frame(), target, lease, valid, 10_000))
        assertEquals("local_approval_required", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(approval = null), 10_000
        ))
        assertEquals("local_approval_invalid_or_expired", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(approval = approval(lease, valid.requestId, valid.text, 0, 500)), 10_000
        ))
        assertEquals("draft_selection_mismatch", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(selectionId = "stale-selection"), 10_000
        ))
        assertEquals("local_approval_invalid_or_expired", GuestTargetPolicy.validateDraft(
            frame(), target, lease, valid.copy(text = "different text"), 10_000
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




    @Test fun touchSequenceRejectsOrphanedDuplicateAndOutOfOrderEvents() {
        val currentFrame = frame()
        val guard = GuestTouchSequenceGuard()
        val down = GuestTouchEvent(
            "session-1", "guest-instance-1", 12, 0, GuestTouchAction.DOWN, 0.5, 0.5, 10_000
        )
        assertEquals("touch_pointer_not_active", guard.accept(down.copy(action = GuestTouchAction.MOVE), currentFrame, 10_000))
        assertNull(guard.accept(down, currentFrame, 10_000))
        assertEquals("touch_pointer_already_active", guard.accept(down.copy(occurredAtMillis = 10_001), currentFrame, 10_001))
        assertEquals("touch_event_out_of_order", guard.accept(down.copy(action = GuestTouchAction.MOVE, occurredAtMillis = 9_999), currentFrame, 10_001))
        assertNull(guard.accept(down.copy(action = GuestTouchAction.MOVE, occurredAtMillis = 10_002), currentFrame, 10_002))
        assertNull(guard.accept(down.copy(action = GuestTouchAction.UP, occurredAtMillis = 10_003), currentFrame, 10_003))
        assertEquals("touch_pointer_not_active", guard.accept(down.copy(action = GuestTouchAction.UP, occurredAtMillis = 10_004), currentFrame, 10_004))
    }

    @Test fun touchSessionStopClearsAllActivePointers() {
        val currentFrame = frame()
        val guard = GuestTouchSequenceGuard()
        val down = GuestTouchEvent(
            "session-1", "guest-instance-1", 12, 1, GuestTouchAction.DOWN, 0.1, 0.1, 10_000
        )
        assertNull(guard.accept(down, currentFrame, 10_000))
        guard.clearSession("session-1")
        assertEquals("touch_pointer_not_active", guard.accept(
            down.copy(action = GuestTouchAction.MOVE, occurredAtMillis = 10_001), currentFrame, 10_001
        ))
        assertNull(guard.accept(down, currentFrame, 10_002))
        guard.clearAll()
        assertEquals("touch_pointer_not_active", guard.accept(
            down.copy(action = GuestTouchAction.CANCEL, occurredAtMillis = 10_003), currentFrame, 10_003
        ))
    }


    @Test fun touchGuardCapsConcurrentPointersPerGuestSession() {
        val guard = GuestTouchSequenceGuard()
        val currentFrame = frame()
        for (pointer in 0 until GuestTouchSequenceGuard.MAX_ACTIVE_POINTERS_PER_SESSION) {
            val event = GuestTouchEvent(
                "session-1", "guest-instance-1", 12, pointer,
                GuestTouchAction.DOWN, 0.1, 0.1, 10_000L + pointer
            )
            assertNull(guard.accept(event, currentFrame, 10_000L + pointer))
        }
        val extra = GuestTouchEvent(
            "session-1", "guest-instance-1", 12, 99,
            GuestTouchAction.DOWN, 0.2, 0.2, 10_100
        )
        assertEquals("touch_pointer_limit_reached", guard.accept(extra, currentFrame, 10_100))
        guard.clearSession("session-1")
        assertNull(guard.accept(extra, currentFrame, 10_101))
    }

    @Test fun guestInstanceRegistryCapsConcurrentContainers() {
        val registry = GuestInstanceIsolationRegistry()
        for (index in 0 until GuestInstanceIsolationRegistry.MAX_GUEST_INSTANCES) {
            val request = GuestAppInstallRequest(
                packageName = "com.example.app$index",
                signingCertificateSha256 = "a".repeat(64),
                sourceKind = GuestAppSourceKind.USER_SELECTED_APK_DOCUMENT,
                selectedApkDocumentUri = "content://com.android.providers.downloads.documents/document/app.apk"
            )
            val instance = GuestAppInstance(
                "instance-$index", request.packageName, request.signingCertificateSha256,
                "container-$index", true, false
            )
            assertNull(registry.register(instance, request))
        }
        val request = GuestAppInstallRequest(
            "com.example.extra", "a".repeat(64), GuestAppSourceKind.USER_SELECTED_APK_DOCUMENT,
            selectedApkDocumentUri = "content://com.android.providers.downloads.documents/document/extra.apk"
        )
        val extra = GuestAppInstance("instance-extra", request.packageName, request.signingCertificateSha256, "container-extra", true, false)
        assertEquals("guest_instance_limit_reached", registry.register(extra, request))
    }

    @Test fun retiredSelectionLedgerIsBoundedAndRequiresAFreshSessionAfterItsLimit() {
        val guard = GuestSelectionGuard()
        val currentFrame = frame()
        val currentField = field()
        for (index in 0 until GuestSelectionGuard.MAX_RETIRED_SELECTION_IDS_PER_SESSION) {
            val lease = selection(id = "bulk-$index")
            assertNull(guard.activate(currentFrame, currentField, lease, 10_000))
            val bulkRequestId = requestId("bulk-draft-$index")
            val bulkText = "draft"
            val draft = GuestDraftRequest(bulkRequestId, lease.selectionId, bulkText, approval(lease, bulkRequestId, bulkText))
            assertNull(guard.consumeForDraft(currentFrame, currentField, lease, draft, 10_000))
        }
        assertEquals(
            "target_selection_capacity_reached",
            guard.activate(currentFrame, currentField, selection(id = "after-limit"), 10_000)
        )
        guard.resetForNewSession()
        assertNull(guard.activate(currentFrame, currentField, selection(id = "new-session"), 10_000))
    }

    @Test fun localApprovalReceiptIsBoundToExactSessionAndSelectionAndCanBeConsumedOnlyOnce() {
        val lease = selection()
        val receiptRequestId = requestId("receipt-check")
        val approvedText = "Exact approved text"
        val receipt = approval(lease, receiptRequestId, approvedText)
        assertTrue(receipt.consume("session-1", lease.selectionId, receiptRequestId, approvedText, 10_000))
        assertFalse(receipt.consume("session-1", lease.selectionId, receiptRequestId, approvedText, 10_000))
        val otherLease = lease.copy(selectionId = selectionId("selection-other"))
        val otherRequestId = requestId("other-receipt")
        val other = approval(otherLease, otherRequestId, "Other exact text")
        assertFalse(other.consume("session-other", otherLease.selectionId, otherRequestId, "Other exact text", 10_000))
    }

    @Test fun guestInstallMustUseAValidSignerAndFreshEmptyDataContainer() {
        val request = GuestAppInstallRequest(
            packageName = "com.example.chat",
            signingCertificateSha256 = "a".repeat(64),
            sourceKind = GuestAppSourceKind.SELECTED_INSTALLED_APK
        )
        assertNull(GuestInstallPolicy.validate(request))
        assertNull(GuestInstallPolicy.validate(request.copy(signingCertificateSha256 = "a".repeat(64) + "." + "b".repeat(64))))
        assertEquals(
            "user_selected_apk_content_uri_required",
            GuestInstallPolicy.validate(request.copy(sourceKind = GuestAppSourceKind.USER_SELECTED_APK_DOCUMENT))
        )
        assertEquals(
            "installed_apk_must_not_supply_document_uri",
            GuestInstallPolicy.validate(request.copy(selectedApkDocumentUri = "content://invalid"))
        )
        assertNull(GuestInstallPolicy.validate(request.copy(
            sourceKind = GuestAppSourceKind.USER_SELECTED_APK_DOCUMENT,
            selectedApkDocumentUri = "content://com.android.providers.downloads.documents/document/app.apk"
        )))
        assertEquals(
            "private_app_data_import_forbidden",
            GuestInstallPolicy.validate(request.copy(importPrivateData = true))
        )
        assertEquals(
            "fresh_guest_data_required",
            GuestInstallPolicy.validate(request.copy(requireFreshDataContainer = false))
        )
        val instance = GuestAppInstance(
            instanceId = "guest-1",
            packageName = request.packageName,
            signingCertificateSha256 = request.signingCertificateSha256,
            dataContainerId = "container-1",
            freshDataContainer = true,
            privateDataImported = false
        )
        assertNull(GuestInstallPolicy.validate(instance, request))
        assertEquals(
            "guest_data_container_not_fresh",
            GuestInstallPolicy.validate(instance.copy(freshDataContainer = false), request)
        )
    }

    @Test fun touchEventsMustMatchTheCurrentGuestFrameAndNormalizedCoordinates() {
        val currentFrame = frame()
        val valid = GuestTouchEvent(
            sessionId = "session-1", guestInstanceId = "guest-instance-1",
            frameSequence = 12, pointerId = 0, action = GuestTouchAction.DOWN,
            x = 0.5, y = 0.7, occurredAtMillis = 10_000
        )
        assertNull(GuestTouchPolicy.validate(valid, currentFrame, 10_000))
        assertEquals(
            "touch_session_mismatch",
            GuestTouchPolicy.validate(valid.copy(sessionId = "other"), currentFrame, 10_000)
        )
        assertEquals(
            "touch_frame_is_stale",
            GuestTouchPolicy.validate(valid.copy(frameSequence = 11), currentFrame, 10_000)
        )
        assertEquals(
            "touch_coordinates_invalid",
            GuestTouchPolicy.validate(valid.copy(x = 1.01), currentFrame, 10_000)
        )
        assertEquals(
            "touch_event_stale",
            GuestTouchPolicy.validate(valid.copy(occurredAtMillis = 1_000), currentFrame, 10_000)
        )
    }

    @Test fun selectionLeaseIsConsumedBeforeWriteAndCannotBeReplayed() {
        val guard = GuestSelectionGuard()
        val currentFrame = frame()
        val currentField = field()
        val currentSelection = selection()
        val firstDraftId = requestId("draft-1")
        val firstDraftText = "one-shot draft"
        val draft = GuestDraftRequest(firstDraftId, currentSelection.selectionId, firstDraftText, approval(currentSelection, firstDraftId, firstDraftText))
        assertNull(guard.activate(currentFrame, currentField, currentSelection, 10_000))
        assertNull(guard.consumeForDraft(currentFrame, currentField, currentSelection, draft, 10_000))
        assertEquals(
            "target_selection_not_active",
            guard.consumeForDraft(currentFrame, currentField, currentSelection, draft, 10_000)
        )
        assertEquals(
            "target_selection_already_used",
            guard.activate(currentFrame, currentField, currentSelection, 10_000)
        )
        val nextSelection = selection(id = "selection-2")
        assertNull(guard.activate(currentFrame, currentField, nextSelection, 10_000))
        guard.clearActive()
        assertEquals(
            "target_selection_not_active",
            guard.consumeForDraft(
                currentFrame, currentField, nextSelection,
                GuestDraftRequest(
                    requestId("draft-2"), nextSelection.selectionId, "text",
                    approval(nextSelection, requestId("draft-2"), "text")
                ), 10_000
            )
        )
    }

    @Test fun invalidDraftDoesNotConsumeTheCurrentSelectionLease() {
        val guard = GuestSelectionGuard()
        val currentFrame = frame()
        val currentField = field()
        val currentSelection = selection()
        assertNull(guard.activate(currentFrame, currentField, currentSelection, 10_000))
        assertEquals(
            "local_approval_required",
            guard.consumeForDraft(
                currentFrame, currentField, currentSelection,
                GuestDraftRequest(requestId("draft-1"), currentSelection.selectionId, "draft", null), 10_000
            )
        )
        assertNull(guard.consumeForDraft(
            currentFrame, currentField, currentSelection,
            GuestDraftRequest(
                requestId("draft-2"), currentSelection.selectionId, "approved draft",
                approval(currentSelection, requestId("draft-2"), "approved draft")
            ), 10_000
        ))
    }


    @Test fun secondGuestInstanceCannotReuseTheFirstInstancesDataContainer() {
        val request = GuestAppInstallRequest(
            packageName = "com.example.chat",
            signingCertificateSha256 = "a".repeat(64),
            sourceKind = GuestAppSourceKind.SELECTED_INSTALLED_APK
        )
        val first = GuestAppInstance("instance-1", request.packageName, request.signingCertificateSha256, "data-1", true, false)
        val second = GuestAppInstance("instance-2", request.packageName, request.signingCertificateSha256, "data-1", true, false)
        val registry = GuestInstanceIsolationRegistry()
        assertNull(registry.register(first, request))
        assertEquals("guest_data_container_reused", registry.register(second, request))
        assertTrue(registry.unregister(first.instanceId))
        assertNull(registry.register(second, request))
    }

    @Test fun providerDraftResultMustAttestExactReadbackAndNoSubmit() {
        assertNull(GuestDraftResultPolicy.validate(GuestDraftResult(inserted = true, submitted = false, readBackMatches = true)))
        assertEquals(
            "guest_provider_submitted",
            GuestDraftResultPolicy.validate(GuestDraftResult(inserted = true, submitted = true, readBackMatches = true))
        )
        assertEquals(
            "guest_draft_readback_mismatch",
            GuestDraftResultPolicy.validate(GuestDraftResult(inserted = true, submitted = false, readBackMatches = false))
        )
        assertEquals(
            "guest_draft_not_inserted",
            GuestDraftResultPolicy.validate(GuestDraftResult(inserted = false, submitted = false, readBackMatches = false))
        )
    }

    @Test fun invalidNewSelectionRetiresThePreviouslyActiveTarget() {
        val guard = GuestSelectionGuard()
        val currentFrame = frame()
        val currentField = field()
        val oldSelection = selection()
        assertNull(guard.activate(currentFrame, currentField, oldSelection, 10_000))
        assertEquals(
            "target_frame_is_stale",
            guard.activate(currentFrame, currentField, selection(id = "new", sequence = 11), 10_000)
        )
        assertEquals(
            "target_selection_not_active",
            guard.consumeForDraft(
                currentFrame, currentField, oldSelection,
                GuestDraftRequest(
                    requestId("draft-old"), oldSelection.selectionId, "text",
                    approval(oldSelection, requestId("draft-old"), "text")
                ), 10_000
            )
        )
    }
