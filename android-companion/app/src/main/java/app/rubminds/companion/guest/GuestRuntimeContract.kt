package app.rubminds.companion.guest

/**
 * A provider-neutral contract for a genuinely isolated Android guest app.
 *
 * This module intentionally contains no BlackBox/VirtualApp dependency and does
 * not launch ordinary installed activities. A provider must be admitted by
 * GuestRuntimeAdmissionPolicy and implement these operations before the Phone
 * Frame may advertise a running guest.
 */

enum class GuestRuntimeCapability {
    ROOTLESS_EXECUTION,
    FRESH_PER_APP_DATA_CONTAINER,
    GUEST_PROCESS_ISOLATION,
    GUEST_ONLY_FRAME_CAPTURE,
    TOUCH_INPUT,
    ACCESSIBILITY_FIELD_TARGETING,
    DRAFT_ONLY_INSERTION,
    EMERGENCY_STOP,
    NO_PRIVATE_DATA_IMPORT,
    NO_INBOUND_NETWORK_LISTENER
}

enum class GuestRuntimeDecision {
    BLOCKED,
    DEVICE_POC_REQUIRED,
    READY
}

enum class GuestAcceptanceCheck {
    INSTALLS_WITHOUT_ROOT,
    FIRST_LAUNCH_CREATES_FRESH_DATA,
    SECOND_INSTANCE_HAS_SEPARATE_DATA,
    RESTART_PRESERVES_ONLY_OWN_GUEST_DATA,
    FRAME_CONTAINS_GUEST_APP_ONLY,
    TOUCH_COORDINATES_ROUND_TRIP,
    ACCESSIBILITY_TARGET_IS_BOUND_TO_GUEST_FRAME,
    PASSWORD_READ_ONLY_AND_OCCUPIED_FIELDS_REJECTED,
    DRAFT_INSERTION_READS_BACK_EXACT_TEXT,
    DRAFT_NEVER_SUBMITS_OR_PRESSES_ENTER,
    SESSION_REVOCATION_STOPS_GUEST,
    EMERGENCY_STOP_KILLS_GUEST,
    PROCESS_DEATH_RECOVERS_WITHOUT_CROSS_APP_DATA,
    NO_UNAPPROVED_HOST_PERMISSION_PROMPTS
}

data class GuestDeviceProfile(
    val apiLevel: Int,
    val abi: String,
    /** Local-only label such as "tecno-kl4-api34-arm64"; do not sync this to the cloud. */
    val localProfileId: String
)

data class GuestRuntimeDescriptor(
    val engineId: String,
    val engineVersion: String,
    val licenseId: String,
    val minApiLevel: Int,
    val maxApiLevel: Int,
    val supportedAbis: Set<String>,
    val targetSdk: Int,
    val capabilities: Set<GuestRuntimeCapability>,
    /** Permissions in the final merged host APK manifest, not just a library manifest. */
    val mergedHostPermissions: Set<String>,
    val mergedManifestAudited: Boolean,
    val releaseArtifactDebugSigned: Boolean
)

data class GuestDeviceAcceptanceEvidence(
    val engineId: String,
    val engineVersion: String,
    val deviceProfileId: String,
    val apiLevel: Int,
    val abi: String,
    val testRunId: String,
    val passedChecks: Set<GuestAcceptanceCheck>
)

data class GuestRuntimeReview(
    val decision: GuestRuntimeDecision,
    val blockers: List<String>,
    val missingDeviceChecks: List<GuestAcceptanceCheck>
)

object GuestRuntimeAdmissionPolicy {
    private const val MIN_TARGET_SDK = 35
    private const val MAX_FRAME_PIXELS = 33_554_432L

    private val allowedLicenses = setOf("Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause")

    // A guest engine should not add these permissions to the companion's host
    // manifest. Guest-app permissions must be mediated inside the guest instead.
    private val blockedPermissionAtoms = setOf(
        "QUERY_ALL_PACKAGES",
        "MANAGE_EXTERNAL_STORAGE",
        "SYSTEM_ALERT_WINDOW",
        "WRITE_EXTERNAL_STORAGE",
        "READ_EXTERNAL_STORAGE",
        "INSTALL_PACKAGES",
        "REQUEST_INSTALL_PACKAGES",
        "READ_CONTACTS",
        "WRITE_CONTACTS",
        "READ_CALL_LOG",
        "WRITE_CALL_LOG",
        "READ_SMS",
        "SEND_SMS",
        "RECEIVE_SMS",
        "CAMERA",
        "RECORD_AUDIO",
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "GET_ACCOUNTS",
        "MANAGE_ACCOUNTS",
        "AUTHENTICATE_ACCOUNTS",
        "USE_CREDENTIALS",
        "READ_PHONE_STATE",
        "READ_PHONE_NUMBERS",
        "READ_CALENDAR",
        "WRITE_CALENDAR",
        "BLUETOOTH_SCAN",
        "BLUETOOTH_ADVERTISE"
    )

    private val requiredCapabilities = GuestRuntimeCapability.values().toSet()
    private val requiredAcceptance = GuestAcceptanceCheck.values().toSet()

    fun review(
        descriptor: GuestRuntimeDescriptor,
        device: GuestDeviceProfile,
        evidence: GuestDeviceAcceptanceEvidence? = null
    ): GuestRuntimeReview {
        val blockers = linkedSetOf<String>()

        if (!descriptor.engineId.matches(Regex("^[a-z0-9][a-z0-9._-]{1,79}$"))) blockers += "invalid_engine_id"
        if (descriptor.engineVersion.isBlank()) blockers += "engine_version_missing"
        if (descriptor.licenseId !in allowedLicenses) blockers += "license_not_allowlisted"
        if (descriptor.minApiLevel < 26 || descriptor.maxApiLevel < descriptor.minApiLevel) blockers += "invalid_android_api_range"
        if (device.apiLevel !in descriptor.minApiLevel..descriptor.maxApiLevel) blockers += "device_api_not_supported"
        if (device.abi !in descriptor.supportedAbis) blockers += "device_abi_not_supported"
        if (device.localProfileId.isBlank()) blockers += "local_device_profile_missing"
        if (descriptor.targetSdk < MIN_TARGET_SDK) blockers += "host_target_sdk_too_old"
        if (!descriptor.mergedManifestAudited) blockers += "final_merged_manifest_not_audited"
        if (descriptor.releaseArtifactDebugSigned) blockers += "release_artifact_uses_debug_signing"

        val missingCapabilities = requiredCapabilities - descriptor.capabilities
        missingCapabilities.forEach { blockers += "capability_missing_${it.name.lowercase()}" }

        val blockedPermissions = descriptor.mergedHostPermissions.filter { permission ->
            permission.substringAfterLast('.').uppercase() in blockedPermissionAtoms
        }
        if (blockedPermissions.isNotEmpty()) blockers += "unapproved_host_permissions:${blockedPermissions.sorted().joinToString(",")}"

        if (blockers.isNotEmpty()) {
            return GuestRuntimeReview(GuestRuntimeDecision.BLOCKED, blockers.toList(), requiredAcceptance.toList())
        }

        val evidenceBlockers = linkedSetOf<String>()
        if (evidence == null) {
            evidenceBlockers += "physical_device_acceptance_missing"
        } else {
            if (evidence.engineId != descriptor.engineId || evidence.engineVersion != descriptor.engineVersion) {
                evidenceBlockers += "acceptance_engine_identity_mismatch"
            }
            if (evidence.deviceProfileId != device.localProfileId ||
                evidence.apiLevel != device.apiLevel || evidence.abi != device.abi) {
                evidenceBlockers += "acceptance_device_identity_mismatch"
            }
            if (evidence.testRunId.isBlank()) evidenceBlockers += "acceptance_test_run_id_missing"
        }
        val missingChecks = if (evidence == null) requiredAcceptance.toList()
        else (requiredAcceptance - evidence.passedChecks).toList()

        if (evidenceBlockers.isNotEmpty() || missingChecks.isNotEmpty()) {
            return GuestRuntimeReview(
                GuestRuntimeDecision.DEVICE_POC_REQUIRED,
                evidenceBlockers.toList(),
                missingChecks
            )
        }
        return GuestRuntimeReview(GuestRuntimeDecision.READY, emptyList(), emptyList())
    }
}

enum class GuestCaptureScope {
    GUEST_APP,
    WHOLE_DEVICE
}

data class GuestFrame(
    val sessionId: String,
    val guestInstanceId: String,
    val frameId: String,
    val sequence: Long,
    val capturedAtMillis: Long,
    val width: Int,
    val height: Int,
    val mimeType: String,
    val captureScope: GuestCaptureScope,
    val encodedBytes: ByteArray
)

data class NormalizedGuestRect(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double
) {
    fun isValid(): Boolean =
        listOf(x, y, width, height).all { it.isFinite() } &&
            x >= 0.0 && y >= 0.0 && width > 0.0 && height > 0.0 &&
            x + width <= 1.0 && y + height <= 1.0

    fun overlapCoverage(other: NormalizedGuestRect): Double {
        if (!isValid() || !other.isValid()) return 0.0
        val overlapWidth = (minOf(x + width, other.x + other.width) - maxOf(x, other.x)).coerceAtLeast(0.0)
        val overlapHeight = (minOf(y + height, other.y + other.height) - maxOf(y, other.y)).coerceAtLeast(0.0)
        return (overlapWidth * overlapHeight) / (width * height)
    }
}

data class GuestTextFieldTarget(
    val sessionId: String,
    val guestInstanceId: String,
    val frameSequence: Long,
    val fieldId: String,
    val bounds: NormalizedGuestRect,
    val enabled: Boolean,
    val editable: Boolean,
    val password: Boolean,
    val readOnly: Boolean,
    val currentText: String,
    val accessibilityBacked: Boolean
)

data class GuestSelectionLease(
    val sessionId: String,
    val guestInstanceId: String,
    val frameSequence: Long,
    val selectionId: String,
    val fieldId: String,
    val selectedBounds: NormalizedGuestRect,
    val createdAtMillis: Long,
    val expiresAtMillis: Long
)

data class GuestDraftRequest(
    val requestId: String,
    val selectionId: String,
    val text: String,
    val approvedLocally: Boolean,
    val submit: Boolean = false
)

object GuestFramePolicy {
    const val MAX_FRAME_BYTES = 4 * 1024 * 1024
    private const val MAX_EDGE = 8192
    private const val MAX_AGE_MILLIS = 5_000L
    private const val FUTURE_SKEW_MILLIS = 2_000L
    private val acceptedMimeTypes = setOf("image/jpeg", "image/png", "image/webp")

    fun validate(frame: GuestFrame, expectedSessionId: String, expectedInstanceId: String, nowMillis: Long): String? {
        if (frame.sessionId != expectedSessionId || frame.guestInstanceId != expectedInstanceId) return "frame_session_mismatch"
        if (frame.frameId.isBlank() || frame.sequence <= 0) return "frame_identity_invalid"
        if (frame.captureScope != GuestCaptureScope.GUEST_APP) return "frame_is_not_guest_only"
        if (frame.width !in 1..MAX_EDGE || frame.height !in 1..MAX_EDGE ||
            frame.width.toLong() * frame.height.toLong() > GuestRuntimeAdmissionPolicy.MAX_FRAME_PIXELS) return "frame_dimensions_invalid"
        if (frame.mimeType !in acceptedMimeTypes) return "frame_mime_type_unsupported"
        if (frame.encodedBytes.isEmpty() || frame.encodedBytes.size > MAX_FRAME_BYTES) return "frame_payload_size_invalid"
        if (frame.capturedAtMillis > nowMillis + FUTURE_SKEW_MILLIS ||
            nowMillis - frame.capturedAtMillis > MAX_AGE_MILLIS) return "frame_stale"
        return null
    }
}

object GuestTargetPolicy {
    private const val MIN_SELECTION_COVERAGE = 0.65
    private const val MAX_DRAFT_CHARS = 4_000
    private const val SELECTION_TTL_MILLIS = 60_000L

    fun validateSelection(
        frame: GuestFrame,
        field: GuestTextFieldTarget,
        selection: GuestSelectionLease,
        nowMillis: Long
    ): String? {
        if (selection.sessionId != frame.sessionId || field.sessionId != frame.sessionId) return "target_session_mismatch"
        if (selection.guestInstanceId != frame.guestInstanceId || field.guestInstanceId != frame.guestInstanceId) return "target_guest_instance_mismatch"
        if (selection.frameSequence != frame.sequence || field.frameSequence != frame.sequence) return "target_frame_is_stale"
        if (selection.selectionId.isBlank() || selection.fieldId.isBlank() || selection.fieldId != field.fieldId) return "target_identity_invalid"
        if (selection.expiresAtMillis <= nowMillis || selection.createdAtMillis > nowMillis + 2_000L ||
            selection.expiresAtMillis - selection.createdAtMillis > SELECTION_TTL_MILLIS) return "target_selection_expired"
        if (!field.enabled || !field.editable || !field.accessibilityBacked) return "target_not_accessible_editable"
        if (field.password) return "target_is_password"
        if (field.readOnly) return "target_is_read_only"
        if (field.currentText.isNotEmpty()) return "target_is_not_empty"
        if (!field.bounds.isValid() || !selection.selectedBounds.isValid()) return "target_bounds_invalid"
        if (selection.selectedBounds.overlapCoverage(field.bounds) < MIN_SELECTION_COVERAGE) return "selection_outside_target"
        return null
    }

    fun validateDraft(
        frame: GuestFrame,
        field: GuestTextFieldTarget,
        selection: GuestSelectionLease,
        request: GuestDraftRequest,
        nowMillis: Long
    ): String? {
        val selectionError = validateSelection(frame, field, selection, nowMillis)
        if (selectionError != null) return selectionError
        if (request.requestId.isBlank() || request.selectionId != selection.selectionId) return "draft_selection_mismatch"
        if (!request.approvedLocally) return "local_approval_required"
        if (request.submit) return "submit_not_supported"
        if (request.text.isBlank() || request.text.length > MAX_DRAFT_CHARS ||
            request.text.any { it.isISOControl() }) return "draft_text_invalid"
        return null
    }
}
