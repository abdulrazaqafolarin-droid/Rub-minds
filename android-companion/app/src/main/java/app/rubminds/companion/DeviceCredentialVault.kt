package app.rubminds.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores the revocable per-device bearer encrypted by a non-exportable Android Keystore key. */
class DeviceCredentialVault(context: Context) {
    private val preferences = context.getSharedPreferences("backroom_device_v1", Context.MODE_PRIVATE)

    fun save(token: String, deviceId: String) {
        require(token.matches(Regex("^[a-f0-9]{64}$")))
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        preferences.edit()
            .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(KEY_TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(KEY_DEVICE_ID, deviceId)
            .apply()
    }

    fun token(): String? {
        val iv = preferences.getString(KEY_IV, null) ?: return null
        val value = preferences.getString(KEY_TOKEN, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(value, Base64.NO_WRAP)), Charsets.UTF_8)
                .takeIf { it.matches(Regex("^[a-f0-9]{64}$")) }
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun deviceId(): String? = preferences.getString(KEY_DEVICE_ID, null)

    fun clear() {
        preferences.edit().remove(KEY_IV).remove(KEY_TOKEN).remove(KEY_DEVICE_ID).apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "rub-minds-backroom-device-v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_IV = "credential_iv"
        const val KEY_TOKEN = "credential_ciphertext"
        const val KEY_DEVICE_ID = "device_id"
    }
}
