package app.rubminds.companion

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** Outbound-only HTTPS client. There is no server socket or inbound port. */
class CloudDeviceApi {
    private val endpoint: String = endpointUrl()

    private fun endpointUrl(): String {
        val configured = BuildConfig.SUPABASE_URL.trimEnd('/')
        val parsed = try { URL(configured) } catch (_: Exception) { null }
            ?: throw IllegalStateException("Set SUPABASE_URL when building the companion.")
        if (parsed.protocol != "https" || !parsed.host.endsWith(".supabase.co") || parsed.path != "/" ||
            parsed.port != -1 && parsed.port != 443 || parsed.userInfo != null ||
            parsed.query != null || parsed.ref != null
        ) throw IllegalStateException("Backroom requires the official HTTPS Supabase endpoint.")
        if (BuildConfig.SUPABASE_PUBLISHABLE_KEY.isBlank()) {
            throw IllegalStateException("Set SUPABASE_PUBLISHABLE_KEY when building the companion.")
        }
        return "$configured/functions/v1/backroom-device"
    }

    fun post(action: String, token: String? = null, fields: JSONObject = JSONObject()): JSONObject {
        val body = JSONObject(fields.toString()).put("action", action)
        val connection = URL(endpoint).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY)
            if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw IllegalStateException(
                when (status) {
                    401 -> "Backroom device authentication expired. Pair this phone again."
                    403 -> "This device is not approved for this Rub Minds group."
                    409 -> "The pairing code expired or was already used."
                    else -> "Backroom cloud request failed ($status)."
                }
            )
            return JSONObject(response)
        } finally {
            connection.disconnect()
        }
    }

    fun claim(pairingCode: String, deviceToken: String, deviceId: String, label: String): JSONObject {
        val fields = JSONObject()
            .put("pairingCode", pairingCode)
            .put("deviceId", deviceId)
            .put("deviceLabel", label)
            .put("osVersion", Build.VERSION.RELEASE ?: "unknown")
            .put("appVersion", BuildConfig.VERSION_NAME)
        return post("pair/claim", deviceToken, fields)
    }

    fun inventory(deviceToken: String, apps: JSONArray): JSONObject =
        post("device/inventory", deviceToken, JSONObject().put("apps", apps))

    fun status(deviceToken: String): JSONObject =
        post("device/status", deviceToken)
}
