package app.rubminds.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object WorkProfileContract {
    const val ACTION_OPEN_APP = "app.rubminds.companion.action.OPEN_WORK_PROFILE_APP"
    const val EXTRA_PACKAGE = "app.rubminds.companion.extra.PROFILE_PACKAGE"
    const val EXTRA_SIGNER = "app.rubminds.companion.extra.PROFILE_SIGNER"
    const val EXTRA_ISSUED_AT = "app.rubminds.companion.extra.PROFILE_ISSUED_AT"
    const val EXTRA_NONCE = "app.rubminds.companion.extra.PROFILE_NONCE"
    const val EXTRA_MAC = "app.rubminds.companion.extra.PROFILE_MAC"
    const val ADMIN_EXTRA_SECRET = "rubminds_work_profile_bridge_secret_v1"
}

class WorkProfileBridgeSecretStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("work_profile_bridge_secret", Context.MODE_PRIVATE)

    @Synchronized
    fun createAndSave(): String? {
        val secret = ByteArray(WorkProfileLaunchAuthenticator.SECRET_BYTES)
        SecureRandom().nextBytes(secret)
        val encoded = Base64.encodeToString(secret, Base64.NO_WRAP)
        return if (saveEncoded(encoded)) encoded else null
    }

    @Synchronized
    fun saveEncoded(encoded: String?): Boolean {
        if (encoded.isNullOrBlank()) return false
        val secret = try { Base64.decode(encoded, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { return false }
        if (secret.size != WorkProfileLaunchAuthenticator.SECRET_BYTES) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            cipher.updateAAD(aad())
            val encrypted = cipher.doFinal(secret)
            val stored = cipher.iv + encrypted
            prefs.edit().putString("secret_ciphertext", Base64.encodeToString(stored, Base64.NO_WRAP)).commit()
        } catch (_: Exception) {
            false
        } finally {
            secret.fill(0)
        }
    }

    @Synchronized
    fun load(): ByteArray? {
        val encoded = prefs.getString("secret_ciphertext", null) ?: return null
        return try {
            val stored = Base64.decode(encoded, Base64.NO_WRAP)
            if (stored.size <= GCM_IV_BYTES + GCM_TAG_BYTES) return null
            val iv = stored.copyOfRange(0, GCM_IV_BYTES)
            val ciphertext = stored.copyOfRange(GCM_IV_BYTES, stored.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(aad())
            cipher.doFinal(ciphertext).takeIf { it.size == WorkProfileLaunchAuthenticator.SECRET_BYTES }
        } catch (_: Exception) {
            clear()
            null
        }
    }

    @Synchronized
    fun clear() {
        prefs.edit().clear().commit()
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            keyStore.deleteEntry(KEY_ALIAS)
        } catch (_: Exception) {
            // Missing aliases are already cleared; the encrypted value is gone.
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
        keyStore.load(null)
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun aad(): ByteArray = ("rub-minds-work-profile-bridge-v1:" + appContext.packageName).toByteArray(Charsets.UTF_8)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "rubminds_work_profile_bridge_aes_gcm_v1"
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private const val GCM_TAG_BYTES = GCM_TAG_BITS / 8
    }
}
