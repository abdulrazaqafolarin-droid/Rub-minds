
import com.android.build.api.artifact.SingleArtifact
import org.w3c.dom.Element
import javax.xml.parsers.DocumentBuilderFactory
import java.security.MessageDigest
import java.util.Locale

// Keep this record at script scope. A local data class inside Gradle's
// nested task action triggers a Kotlin DSL IR code-generation failure.
data class GuestManifestComponentRecord(
    val type: String,
    val className: String,
    val exported: Boolean,
    val permission: String,
    val element: Element
)

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val supabaseUrl = providers.gradleProperty("SUPABASE_URL")
    .orElse(providers.environmentVariable("SUPABASE_URL")).getOrElse("")
val supabasePublishableKey = providers.gradleProperty("SUPABASE_PUBLISHABLE_KEY")
    .orElse(providers.environmentVariable("SUPABASE_PUBLISHABLE_KEY")).getOrElse("")

android {
    namespace = "app.rubminds.companion"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "app.rubminds.companion"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
        buildConfigField("String", "SUPABASE_URL", buildConfigString(supabaseUrl))
        buildConfigField("String", "SUPABASE_PUBLISHABLE_KEY", buildConfigString(supabasePublishableKey))
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("io.github.webrtc-sdk:android:150.7871.01")
}


// Audit the final merged manifest, not just the app's source manifest. This
// catches permissions and exported components contributed by future libraries.
androidComponents {
    onVariants(selector().all()) { variant ->
        val variantTitle = variant.name.replaceFirstChar { it.titlecase(Locale.ROOT) }
        val mergedManifest = variant.artifacts.get(SingleArtifact.MERGED_MANIFEST)
        val appId = variant.applicationId
        val reportFile = layout.buildDirectory.file(
            "reports/guest-host-manifest/${variant.name}.txt"
        )
        val auditTask = tasks.register("audit${variantTitle}GuestHostManifest") {
            group = "verification"
            description = "Fail closed unless the merged Android host manifest matches the Rub Minds guest-runtime allowlist."
            inputs.file(mergedManifest)
            inputs.property("expectedApplicationId", appId)
            outputs.file(reportFile)

            doLast {
                val manifestFile = mergedManifest.get().asFile
                val expectedAppId = appId.get()
                require(manifestFile.isFile) {
                    "Merged manifest is missing: ${manifestFile.absolutePath}"
                }

                val factory = DocumentBuilderFactory.newInstance().apply {
                    isNamespaceAware = true
                    isXIncludeAware = false
                    isExpandEntityReferences = false
                    setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
                    setFeature("http://xml.org/sax/features/external-general-entities", false)
                    setFeature("http://xml.org/sax/features/external-parameter-entities", false)
                    setAttribute("http://javax.xml.XMLConstants/property/accessExternalDTD", "")
                    setAttribute("http://javax.xml.XMLConstants/property/accessExternalSchema", "")
                }
                val document = factory.newDocumentBuilder().parse(manifestFile)
                val root = document.documentElement
                require(root.tagName == "manifest") {
                    "Unexpected merged manifest root: ${root.tagName}"
                }

                val androidNamespace = "http://schemas.android.com/apk/res/android"
                fun Element.androidAttribute(name: String): String =
                    getAttributeNS(androidNamespace, name).ifBlank { getAttribute("android:$name") }

                fun childElements(parent: Element): List<Element> {
                    val result = mutableListOf<Element>()
                    val children = parent.childNodes
                    for (index in 0 until children.length) {
                        val node = children.item(index)
                        if (node is Element) result += node
                    }
                    return result
                }

                val permissions = childElements(root)
                    .filter { it.tagName.startsWith("uses-permission") }
                    .map { element ->
                        element.androidAttribute("name").also { name ->
                            require(name.isNotBlank()) {
                                "Merged manifest contains a permission declaration without android:name."
                            }
                        }
                    }
                    .toSet()
                val allowedPermissions = setOf(
                    "android.permission.INTERNET",
                    "android.permission.INTERACT_ACROSS_PROFILES",
                    "android.permission.FOREGROUND_SERVICE",
                    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
                    "android.permission.POST_NOTIFICATIONS"
                )
                require(permissions == allowedPermissions) {
                    "Guest host manifest permission allowlist mismatch. " +
                        "Expected ${allowedPermissions.sorted()}, found ${permissions.sorted()}."
                }

                val application = childElements(root).singleOrNull { it.tagName == "application" }
                    ?: error("Merged manifest must contain exactly one application element.")
                val componentTags = setOf("activity", "activity-alias", "service", "receiver", "provider")
                fun resolveClassName(rawName: String): String {
                    require(rawName.isNotBlank()) { "Merged component is missing android:name." }
                    val replaced = rawName.replace("\${applicationId}", expectedAppId)
                    return when {
                        replaced.startsWith(".") -> expectedAppId + replaced
                        '.' !in replaced -> "$expectedAppId.$replaced"
                        else -> replaced
                    }
                }

                val components = childElements(application)
                    .filter { it.tagName in componentTags }
                    .map { element ->
                        val className = resolveClassName(element.androidAttribute("name"))
                        val exportedValue = element.androidAttribute("exported")
                        require(exportedValue == "true" || exportedValue == "false") {
                            "Component $className must declare android:exported explicitly in the merged manifest."
                        }
                        GuestManifestComponentRecord(
                            type = element.tagName,
                            className = className,
                            exported = exportedValue == "true",
                            permission = element.androidAttribute("permission"),
                            element = element
                        )
                    }

                val duplicateComponents = components
                    .groupBy { it.type to it.className }
                    .filterValues { it.size != 1 }
                    .keys
                require(duplicateComponents.isEmpty()) {
                    "Duplicate component declarations: $duplicateComponents"
                }

                val exported = components.filter { it.exported }
                val expectedExported = setOf(
                    "activity:$expectedAppId.MainActivity",
                    "service:$expectedAppId.DraftInputMethodService",
                    "receiver:$expectedAppId.WorkProfileAdminReceiver",
                    "service:$expectedAppId.AndroidTouchAccessibilityService"
                )
                val actualExported = exported.map { "${it.type}:${it.className}" }.toSet()
                require(actualExported == expectedExported && exported.size == 4) {
                    "Guest host exported-component allowlist mismatch. " +
                        "Expected ${expectedExported.sorted()}, found ${actualExported.sorted()}."
                }

                fun hasIntent(
                    component: GuestManifestComponentRecord,
                    action: String,
                    category: String? = null
                ): Boolean = childElements(component.element)
                    .filter { it.tagName == "intent-filter" }
                    .any { filter ->
                        val entries = childElements(filter)
                        val hasAction = entries.any {
                            it.tagName == "action" && it.androidAttribute("name") == action
                        }
                        val hasCategory = category == null || entries.any {
                            it.tagName == "category" && it.androidAttribute("name") == category
                        }
                        hasAction && hasCategory
                    }

                val launcher = exported.single { it.type == "activity" }
                require(launcher.className == "$expectedAppId.MainActivity") {
                    "The only exported activity must be the exact Rub Minds launcher."
                }
                require(launcher.permission.isBlank()) {
                    "The launcher must not introduce an unexpected component permission."
                }
                require(hasIntent(launcher, "android.intent.action.MAIN", "android.intent.category.LAUNCHER")) {
                    "The approved launcher must retain MAIN/LAUNCHER intent filters."
                }

                val inputMethod = exported.single {
                    it.type == "service" && it.className == "$expectedAppId.DraftInputMethodService"
                }
                require(inputMethod.className == "$expectedAppId.DraftInputMethodService") {
                    "The only exported service must be the exact Rub Minds draft input method."
                }
                require(inputMethod.permission == "android.permission.BIND_INPUT_METHOD") {
                    "The draft input method must remain OS-bound by BIND_INPUT_METHOD."
                }
                require(hasIntent(inputMethod, "android.view.InputMethod")) {
                    "The approved input method must retain android.view.InputMethod."
                }

                val accessibilityService = exported.single {
                    it.type == "service" && it.className == "$expectedAppId.AndroidTouchAccessibilityService"
                }
                require(accessibilityService.permission == "android.permission.BIND_ACCESSIBILITY_SERVICE") {
                    "The touch service must remain OS-bound by BIND_ACCESSIBILITY_SERVICE."
                }
                require(hasIntent(accessibilityService, "android.accessibilityservice.AccessibilityService")) {
                    "The touch service must retain the Android AccessibilityService intent."
                }
                val hasTouchServiceMetadata = childElements(accessibilityService.element).any { metadata ->
                    metadata.tagName == "meta-data" &&
                        metadata.androidAttribute("name") == "android.accessibilityservice" &&
                        metadata.androidAttribute("resource") == "@xml/backroom_touch_accessibility"
                }
                require(hasTouchServiceMetadata) {
                    "The touch service must reference its explicit accessibility-service configuration."
                }

                val adminReceiver = exported.single { it.type == "receiver" }
                require(adminReceiver.className == "$expectedAppId.WorkProfileAdminReceiver") {
                    "The only exported receiver must be the exact Rub Minds Work Profile DPC receiver."
                }
                require(adminReceiver.permission == "android.permission.BIND_DEVICE_ADMIN") {
                    "The Work Profile DPC receiver must remain protected by BIND_DEVICE_ADMIN."
                }
                require(hasIntent(adminReceiver, "android.app.action.DEVICE_ADMIN_ENABLED")) {
                    "The Work Profile DPC receiver must retain DEVICE_ADMIN_ENABLED."
                }
                require(hasIntent(adminReceiver, "android.app.action.PROFILE_PROVISIONING_COMPLETE")) {
                    "The Work Profile DPC receiver must receive profile provisioning completion."
                }
                val hasDeviceAdminMetadata = childElements(adminReceiver.element).any { metadata ->
                    metadata.tagName == "meta-data" &&
                        metadata.androidAttribute("name") == "android.app.device_admin" &&
                        metadata.androidAttribute("resource") == "@xml/work_profile_admin"
                }
                require(hasDeviceAdminMetadata) {
                    "The Work Profile DPC receiver must reference its minimal device-admin policy metadata."
                }

                val digest = MessageDigest.getInstance("SHA-256")
                    .digest(manifestFile.readBytes())
                    .joinToString("") { byte -> "%02x".format(Locale.ROOT, byte.toInt() and 0xff) }
                val report = reportFile.get().asFile
                report.parentFile.mkdirs()
                report.writeText(
                    buildString {
                        appendLine("applicationId=$expectedAppId")
                        appendLine("manifestSha256=$digest")
                        appendLine("permissions=${permissions.sorted().joinToString()}")
                        appendLine("exportedComponents=${actualExported.sorted().joinToString()}")
                        appendLine("componentCount=${components.size}")
                    }
                )
                logger.lifecycle(
                    "Guest host manifest audit passed for ${variant.name}: " +
                        "sha256=$digest, components=${components.size}, exported=${exported.size}."
                )
            }
        }

        // Make an APK/AAB build impossible to complete without its merged
        // manifest passing this audit.
        tasks.matching {
            it.name == "assemble${variantTitle}" || it.name == "bundle${variantTitle}"
        }.configureEach {
            dependsOn(auditTask)
        }
    }
}
