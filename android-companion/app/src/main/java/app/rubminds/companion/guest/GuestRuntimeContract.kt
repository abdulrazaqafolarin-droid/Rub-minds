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

enum class GuestHostComponentType {
    ACTIVITY,
    SERVICE,
    RECEIVER,
    PROVIDER
}

enum class GuestPermissionProtection {
    NONE,
    NORMAL,
    DANGEROUS,
    SIGNATURE,
    SYSTEM
}

/** Facts extracted from the final merged host manifest, not source library manifests. */
data class GuestHostComponent(
    val className: String,
    val type: GuestHostComponentType,
    val exported: Boolean,
    val permission: String? = null,
    val permissionProtection: GuestPermissionProtection = GuestPermissionProtection.NONE,
    val isLauncherActivity: Boolean = false,
    val isSystemBoundInputMethod: Boolean = false
)

data class GuestRuntimeDescriptor(
    val engineId: String,
    val engineVersion: String,
    val licenseId: String,
    val minApiLevel: Int,
    val maxApiLevel: Int,
    val supportedAbis: Set<String>,
    val targetSdk: Int,
    /** SHA-256 of the exact signed release artifact reviewed for this provider. */
    val releaseArtifactSha256: String,
    /** SHA-256 of the final merged host manifest that was audited. */
    val mergedManifestSha256: String,
    val capabilities: Set<GuestRuntimeCapability>,
    /** Permissions in the final merged host APK manifest, not just a library manifest. */
    val mergedHostPermissions: Set<String>,
    val mergedHostComponents: List<GuestHostComponent>,
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
    val releaseArtifactSha256: String,
    val mergedManifestSha256: String,
    val passedChecks: Set<GuestAcceptanceCheck>
)

data class GuestRuntimeReview(
    val decision: GuestRuntimeDecision,
    val blockers: List<String>,
    val missingDeviceChecks: List<GuestAcceptanceCheck>
)

object GuestRuntimeAdmissionPolicy {
    private const val MIN_TARGET_SDK = 35
    const val MAX_FRAME_PIXELS = 33_554_432L

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
        "BLUETOOTH_ADVERTISE",
        "FOREGROUND_SERVICE_CAMERA",
        "FOREGROUND_SERVICE_MICROPHONE",
        "WRITE_SECURE_SETTINGS",
        "READ_LOGS",
        "WRITE_SETTINGS",
        "PACKAGE_USAGE_STATS",
        "MANAGE_APP_OPS_MODES",
        "READ_PRIVILEGED_PHONE_STATE",
        "INTERACT_ACROSS_USERS",
        "INTERACT_ACROSS_USERS_FULL",
        "DUMP",
        "CAPTURE_VIDEO_OUTPUT",
        "CAPTURE_SECURE_VIDEO_OUTPUT",
        "BIND_ACCESSIBILITY_SERVICE"
    )

    private val requiredCapabilities = GuestRuntimeCapability.values().toSet()
    private val requiredAcceptance = GuestAcceptanceCheck.values().toSet()
    private val sha256Pattern = Regex("^[a-f0-9]{64}$")
    private val expectedLauncherClass = ".MainActivity"
    private val expectedImeClass = ".DraftInputMethodService"

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
        if (!sha256Pattern.matches(descriptor.releaseArtifactSha256)) blockers += "release_artifact_digest_invalid"
        if (!sha256Pattern.matches(descriptor.mergedManifestSha256)) blockers += "merged_manifest_digest_invalid"
        if (!descriptor.mergedManifestAudited) blockers += "final_merged_manifest_not_audited"
        if (descriptor.releaseArtifactDebugSigned) blockers += "release_artifact_uses_debug_signing"

        val missingCapabilities = requiredCapabilities - descriptor.capabilities
        missingCapabilities.forEach { blockers += "capability_missing_${it.name.lowercase()}" }

        val blockedPermissions = descriptor.mergedHostPermissions.filter { permission ->
            permission.substringAfterLast('.').uppercase() in blockedPermissionAtoms
        }
        if (blockedPermissions.isNotEmpty()) blockers += "unapproved_host_permissions:${blockedPermissions.sorted().joinToString(",")}"

        val unsafeComponents = descriptor.mergedHostComponents.filter { component ->
            if (!component.exported) return@filter false
            val isExpectedLauncher = component.type == GuestHostComponentType.ACTIVITY &&
                component.isLauncherActivity && component.className.endsWith(".MainActivity") &&
                component.permission == null
            val permissionAtom = component.permission?.substringAfterLast('.')?.uppercase()
            val permissionIsExplicitlyBlocked = permissionAtom in blockedPermissionAtoms
            val isExpectedInputMethod = component.type == GuestHostComponentType.SERVICE &&
                component.isSystemBoundInputMethod && component.className.endsWith(expectedImeClass) &&
                component.permission == "android.permission.BIND_INPUT_METHOD" &&
                component.permissionProtection == GuestPermissionProtection.SIGNATURE
            val protectedInternalComponent = component.permissionProtection == GuestPermissionProtection.SIGNATURE &&
                !component.permission.isNullOrBlank()
            permissionIsExplicitlyBlocked || !(isExpectedLauncher || isExpectedInputMethod || protectedInternalComponent)
        }
        if (unsafeComponents.isNotEmpty()) {
            blockers += "unapproved_exported_components:${unsafeComponents.map { it.className }.sorted().joinToString(",")}"
        }
        val launcherCount = descriptor.mergedHostComponents.count { it.exported && it.isLauncherActivity }
        if (launcherCount != 1 || descriptor.mergedHostComponents.count { it.exported && it.isSystemBoundInputMethod } > 1) {
            blockers += "unexpected_exported_entrypoint_count"
        }

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
            if (evidence.releaseArtifactSha256 != descriptor.releaseArtifactSha256) {
                evidenceBlockers += "acceptance_release_artifact_mismatch"
            }
            if (evidence.mergedManifestSha256 != descriptor.mergedManifestSha256) {
                evidenceBlockers += "acceptance_merged_manifest_mismatch"
            }
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

enum class GuestAppSourceKind {
    SELECTED_INSTALLED_APK,
    USER_SELECTED_APK_DOCUMENT
}

enum class GuestLifecycleState {
    PREPARING,
    RUNNING,
    PAUSED,
    STOPPING,
    STOPPED,
    FAILED
}

enum class GuestTouchAction {
    DOWN,
    MOVE,
    UP,
    CANCEL
}

data class GuestAppInstallRequest(
    val packageName: String,
    val signingCertificateSha256: String,
    val sourceKind: GuestAppSourceKind,
    /** Must create a new empty guest data container; never import the source app's private data. */
    val requireFreshDataContainer: Boolean = true,
    val importPrivateData: Boolean = false
)

data class GuestAppInstance(
    val instanceId: String,
    val packageName: String,
    val signingCertificateSha256: String,
    val dataContainerId: String,
    val freshDataContainer: Boolean,
    val privateDataImported: Boolean
)

data class GuestAppSession(
    val sessionId: String,
    val guestInstanceId: String,
    val packageName: String,
    val state: GuestLifecycleState
)

data class GuestTouchEvent(
    val sessionId: String,
    val guestInstanceId: String,
    val frameSequence: Long,
    val pointerId: Int,
    val action: GuestTouchAction,
    val x: Double,
    val y: Double,
    val occurredAtMillis: Long
)

data class GuestOperationResult(
    val accepted: Boolean,
    val reason: String? = null
)

data class GuestDraftResult(
    val inserted: Boolean,
    val submitted: Boolean,
    val readBackMatches: Boolean
)

/**
 * The future native engine adapter. Implementations must return only guest-app
 * frames and must not fall back to launching the ordinary host-installed app.
 */
interface GuestRuntimeProvider {
    val descriptor: GuestRuntimeDescriptor

    suspend fun prepare(request: GuestAppInstallRequest): GuestAppInstance
    suspend fun launch(instanceId: String): GuestAppSession
    suspend fun captureFrame(sessionId: String): GuestFrame?
    suspend fun dispatchTouch(event: GuestTouchEvent): GuestOperationResult
    suspend fun inspectTextTarget(sessionId: String, selection: GuestSelectionLease): GuestTextFieldTarget?
    suspend fun insertDraft(
        sessionId: String,
        selection: GuestSelectionLease,
        field: GuestTextFieldTarget,
        request: GuestDraftRequest
    ): GuestDraftResult
    suspend fun stop(sessionId: String): GuestOperationResult
}

object GuestInstallPolicy {
    private val packageNamePattern = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val digestPattern = Regex("^[a-f0-9]{64}(?:\\.[a-f0-9]{64})*$")

    fun validate(request: GuestAppInstallRequest): String? {
        if (!packageNamePattern.matches(request.packageName)) return "guest_package_name_invalid"
        if (!digestPattern.matches(request.signingCertificateSha256)) return "guest_signer_invalid"
        if (!request.requireFreshDataContainer) return "fresh_guest_data_required"
        if (request.importPrivateData) return "private_app_data_import_forbidden"
        return null
    }

    fun validate(instance: GuestAppInstance, request: GuestAppInstallRequest): String? {
        if (instance.instanceId.isBlank() || instance.dataContainerId.isBlank()) return "guest_instance_identity_invalid"
        if (instance.packageName != request.packageName ||
            instance.signingCertificateSha256 != request.signingCertificateSha256) return "guest_package_identity_mismatch"
        if (!instance.freshDataContainer) return "guest_data_container_not_fresh"
        if (instance.privateDataImported) return "private_app_data_import_forbidden"
        return null
    }
}

/**
 * Prevents two logical guest instances from sharing a private data directory.
 * The provider must register every prepared instance and unregister it only
 * after that guest container has been destroyed.
 */
/**
 * In-memory enforcement helper for one provider process. A production provider
 * must persist equivalent instance/container ownership across process death;
 * this map alone is not a durable isolation store.
 */
class GuestInstanceIsolationRegistry {
    private val containerOwners = linkedMapOf<String, String>()
    private val instanceContainers = linkedMapOf<String, String>()

    @Synchronized
    fun register(instance: GuestAppInstance, request: GuestAppInstallRequest): String? {
        val validation = GuestInstallPolicy.validate(instance, request)
        if (validation != null) return validation
        if (instance.instanceId in instanceContainers) return "guest_instance_id_already_registered"
        if (instance.dataContainerId in containerOwners) return "guest_data_container_reused"
        instanceContainers[instance.instanceId] = instance.dataContainerId
        containerOwners[instance.dataContainerId] = instance.instanceId
        return null
    }

    @Synchronized
    fun unregister(instanceId: String): Boolean {
        val containerId = instanceContainers.remove(instanceId) ?: return false
        containerOwners.remove(containerId)
        return true
    }

    @Synchronized
    fun clearAfterAllGuestContainersDestroyed() {
        instanceContainers.clear()
        containerOwners.clear()
    }
}

object GuestDraftResultPolicy {
    /** Never report success unless the provider attests to exact read-back and no submission. */
    fun validate(result: GuestDraftResult): String? {
        if (result.submitted) return "guest_provider_submitted"
        if (!result.inserted) return "guest_draft_not_inserted"
        if (!result.readBackMatches) return "guest_draft_readback_mismatch"
        return null
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

/**
 * Opaque receipt issued only after the local native confirmation dialog succeeds.
 * The private constructor prevents network/deserialized request data from setting
 * a trusted boolean. The provider must consume it exactly once.
 */
class GuestLocalApprovalReceipt private constructor(
    val sessionId: String,
    val selectionId: String,
    val issuedAtMillis: Long,
    val expiresAtMillis: Long,
    private val nonce: String
) {
    private var consumed = false

    @Synchronized
    internal fun consume(sessionId: String, selectionId: String, nowMillis: Long): Boolean {
        if (consumed || this.sessionId != sessionId || this.selectionId != selectionId) return false
        if (nowMillis >= expiresAtMillis || issuedAtMillis > nowMillis + 2_000L ||
            expiresAtMillis <= issuedAtMillis || expiresAtMillis - issuedAtMillis > 60_000L) return false
        consumed = true
        return true
    }

    @Synchronized
    internal fun isUsableFor(sessionId: String, selectionId: String, nowMillis: Long): Boolean =
        !consumed && this.sessionId == sessionId && this.selectionId == selectionId &&
            nowMillis < expiresAtMillis && issuedAtMillis <= nowMillis + 2_000L &&
            expiresAtMillis > issuedAtMillis && expiresAtMillis - issuedAtMillis <= 60_000L

    companion object {
        /** Call only on the affirmative result from an OS/native local confirmation UI. */
        internal fun issueAfterNativeConfirmation(
            sessionId: String,
            selectionId: String,
            issuedAtMillis: Long,
            expiresAtMillis: Long
        ): GuestLocalApprovalReceipt? {
            if (sessionId.isBlank() || selectionId.isBlank() || expiresAtMillis <= issuedAtMillis ||
                expiresAtMillis - issuedAtMillis > 60_000L) return null
            return GuestLocalApprovalReceipt(
                sessionId = sessionId,
                selectionId = selectionId,
                issuedAtMillis = issuedAtMillis,
                expiresAtMillis = expiresAtMillis,
                nonce = java.util.UUID.randomUUID().toString()
            )
        }
    }
}

data class GuestDraftRequest(
    val requestId: String,
    val selectionId: String,
    val text: String,
    val approval: GuestLocalApprovalReceipt?,
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

object GuestTouchPolicy {
    fun validate(event: GuestTouchEvent, frame: GuestFrame, nowMillis: Long): String? {
        if (event.sessionId != frame.sessionId || event.guestInstanceId != frame.guestInstanceId) return "touch_session_mismatch"
        if (event.frameSequence != frame.sequence || event.frameSequence <= 0) return "touch_frame_is_stale"
        if (event.pointerId < 0) return "touch_pointer_invalid"
        if (!event.x.isFinite() || !event.y.isFinite() || event.x !in 0.0..1.0 || event.y !in 0.0..1.0) return "touch_coordinates_invalid"
        if (event.occurredAtMillis > nowMillis + 2_000L || nowMillis - event.occurredAtMillis > 5_000L) return "touch_event_stale"
        return null
    }
}

/**
 * One-shot, session-local selection lease. The active lease is consumed before
 * the provider receives an insertion request. A failed/ambiguous write must
 * therefore require a fresh drag instead of a blind retry.
 */
class GuestSelectionGuard {
    private var activeSelectionId: String? = null
    private val consumedSelectionIds = linkedSetOf<String>()

    @Synchronized
    fun activate(
        frame: GuestFrame,
        field: GuestTextFieldTarget,
        selection: GuestSelectionLease,
        nowMillis: Long
    ): String? {
        // A new drag supersedes the previous target even when the new drag is invalid.
        activeSelectionId = null
        val error = GuestTargetPolicy.validateSelection(frame, field, selection, nowMillis)
        if (error != null) return error
        if (selection.selectionId in consumedSelectionIds) return "target_selection_already_used"
        activeSelectionId = selection.selectionId
        return null
    }

    /** Returns null only after atomically retiring the lease for this one draft. */
    @Synchronized
    fun consumeForDraft(
        frame: GuestFrame,
        field: GuestTextFieldTarget,
        selection: GuestSelectionLease,
        request: GuestDraftRequest,
        nowMillis: Long
    ): String? {
        if (activeSelectionId != selection.selectionId || selection.selectionId in consumedSelectionIds) {
            return "target_selection_not_active"
        }
        val error = GuestTargetPolicy.validateDraft(frame, field, selection, request, nowMillis)
        if (error != null) {
            if (error != "local_approval_required" && error != "draft_text_invalid" &&
                error != "draft_selection_mismatch") activeSelectionId = null
            return error
        }
        val approval = request.approval
        if (approval == null || !approval.consume(selection.sessionId, selection.selectionId, nowMillis)) {
            activeSelectionId = null
            return "local_approval_invalid_or_expired"
        }
        consumedSelectionIds += selection.selectionId
        activeSelectionId = null
        return null
    }

    @Synchronized
    fun clearActive() {
        activeSelectionId = null
    }

    /** Call only when the entire guest session is destroyed and a new session ID is issued. */
    @Synchronized
    fun resetForNewSession() {
        activeSelectionId = null
        consumedSelectionIds.clear()
    }
}

object GuestTargetPolicy {
    private const val MIN_SELECTION_COVERAGE = 0.65
    private const val MAX_DRAFT_CHARS = 4_000
    private const val SELECTION_TTL_MILLIS = 60_000L
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

    fun validateSelection(
        frame: GuestFrame,
        field: GuestTextFieldTarget,
        selection: GuestSelectionLease,
        nowMillis: Long
    ): String? {
        if (selection.sessionId != frame.sessionId || field.sessionId != frame.sessionId) return "target_session_mismatch"
        if (selection.guestInstanceId != frame.guestInstanceId || field.guestInstanceId != frame.guestInstanceId) return "target_guest_instance_mismatch"
        if (selection.frameSequence != frame.sequence || field.frameSequence != frame.sequence) return "target_frame_is_stale"
        if (!uuidPattern.matches(selection.selectionId) || selection.fieldId.isBlank() || selection.fieldId != field.fieldId) return "target_identity_invalid"
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
        if (!uuidPattern.matches(request.requestId) || request.selectionId != selection.selectionId) return "draft_selection_mismatch"
        val approval = request.approval ?: return "local_approval_required"
        if (!approval.isUsableFor(selection.sessionId, selection.selectionId, nowMillis)) return "local_approval_invalid_or_expired"
        if (request.submit) return "submit_not_supported"
        if (request.text.isBlank() || request.text.length > MAX_DRAFT_CHARS ||
            request.text.any { it.isISOControl() }) return "draft_text_invalid"
        return null
    }
}
