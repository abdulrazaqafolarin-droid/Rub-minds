package app.rubminds.companion

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.content.pm.Signature
import java.security.MessageDigest

/**
 * Resolves the current installed APK signer identity for a visible package.
 *
 * Fingerprints the certificates that signed the currently installed APK,
 * not its historical rotation chain. For multiple simultaneous signers,
 * fingerprints are sorted so their order is irrelevant.
 */
object AppIdentity {
    @Suppress("DEPRECATION")
    fun signingCertificateSha256(context: Context, packageName: String): String? {
        if (!AppGrantPolicy.isValidPackageName(packageName)) return null
        return try {
            val packageManager = context.packageManager
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                PackageManager.GET_SIGNATURES
            }
            val packageInfo = packageManager.getPackageInfo(packageName, flags)
            val signers: List<Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // apkContentsSigners reports actual signers for this APK. Using
                // signingCertificateHistory would mix old and new trust identities
                // across certificate rotation, depending on history ordering.
                val signingInfo = packageInfo.signingInfo ?: return null
                signingInfo.apkContentsSigners?.toList().orEmpty()
            } else {
                packageInfo.signatures?.toList().orEmpty()
            }
            if (signers.isEmpty()) return null
            signers.map(::fingerprint).sorted().joinToString(".")
                .takeIf(AppGrantPolicy::isValidSigningCertificateSha256)
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: SecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun fingerprint(signature: Signature): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
        val hex = "0123456789abcdef"
        return buildString(digest.size * 2) {
            digest.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(hex[value ushr 4])
                append(hex[value and 0x0f])
            }
        }
    }
}
