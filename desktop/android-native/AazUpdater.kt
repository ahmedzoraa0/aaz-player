package com.aaz.player

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import javax.net.ssl.HttpsURLConnection

/**
 * Phase 4 Direct Signed APK Self-Updater (R48-R50):
 * - Strictly HTTPS against an explicit GitHub Releases host allowlist (including redirects).
 * - Semantic version comparison against PackageInfo.versionName.
 * - Fail-closed SHA-256 verification against the release's .sha256 or SHA256SUMS.txt asset.
 * - Downloads into app cache (`cacheDir/updates/aaz-update.apk`) and invokes the Android
 *   package installer via FileProvider (zero broad storage permissions required).
 */
class AazUpdater(
    private val activity: Activity,
    private val onStatusEvent: (JSONObject) -> Unit
) {
    private data class PendingUpdate(
        val version: String,
        val apkName: String,
        val apkUrl: String,
        val checksumUrl: String,
        var verifiedSha256: String? = null
    )

    @Volatile
    private var pending: PendingUpdate? = null

    private val allowedHosts = setOf(
        "api.github.com",
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com"
    )

    fun getAppVersion(): String {
        return try {
            val pm = activity.packageManager
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(activity.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(activity.packageName, 0)
            }
            info.versionName?.takeIf { it.isNotBlank() } ?: "1.7.0"
        } catch (_: Exception) {
            "1.7.0"
        }
    }

    private fun getConfiguredRepo(): String {
        return try {
            val resId = activity.resources.getIdentifier("aaz_github_repo", "string", activity.packageName)
            if (resId == 0) return ""
            activity.getString(resId).trim()
        } catch (_: Exception) {
            ""
        }
    }

    fun checkForUpdates(): JSONObject {
        val repo = getConfiguredRepo()
        if (!Regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").matches(repo)) {
            return JSONObject().put("status", "dev-mode")
        }

        emitStatus("checking")
        return try {
            val currentVer = getAppVersion()
            val apiUrl = "https://api.github.com/repos/$repo/releases/latest"
            val jsonText = fetchHttpsText(apiUrl, currentVer)
            val release = JSONObject(jsonText)

            if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) {
                emitStatus("not-available", version = currentVer)
                return JSONObject().put("status", "not-available").put("version", currentVer)
            }

            val tagName = release.optString("tag_name", "").trim()
            val latestVer = tagName.removePrefix("v").removePrefix("V")
            if (latestVer.isEmpty() || compareSemver(latestVer, currentVer) <= 0) {
                pending = null
                emitStatus("not-available", version = currentVer)
                return JSONObject().put("status", "not-available").put("version", currentVer)
            }

            val assets = release.optJSONArray("assets") ?: JSONArray()
            var apkName: String? = null
            var apkUrl: String? = null
            var exactChecksumUrl: String? = null
            var sumsUrl: String? = null

            for (i in 0 until assets.length()) {
                val asset = assets.optJSONObject(i) ?: continue
                val name = asset.optString("name", "")
                val url = asset.optString("browser_download_url", "")
                if (name.isBlank() || url.isBlank() || !isAllowedHttpsUrl(url)) continue
                val lower = name.lowercase(Locale.ROOT)
                if (lower.endsWith(".apk")) {
                    val isPreferred = lower.contains("arm64") || lower.contains("aarch64")
                    if (apkUrl == null || isPreferred) {
                        apkName = name
                        apkUrl = url
                    }
                } else if (lower == "sha256sums.txt") {
                    sumsUrl = url
                }
            }

            if (apkName != null) {
                val targetShaFile = "$apkName.sha256".lowercase(Locale.ROOT)
                for (i in 0 until assets.length()) {
                    val asset = assets.optJSONObject(i) ?: continue
                    val name = asset.optString("name", "").lowercase(Locale.ROOT)
                    val url = asset.optString("browser_download_url", "")
                    if (name == targetShaFile && isAllowedHttpsUrl(url)) {
                        exactChecksumUrl = url
                        break
                    }
                }
            }

            val checksumUrl = exactChecksumUrl ?: sumsUrl
            if (apkName == null || apkUrl == null) {
                val msg = "Release v$latestVer does not include an Android APK package."
                emitStatus("error", message = msg)
                return JSONObject().put("status", "error").put("message", msg)
            }
            if (checksumUrl == null) {
                val msg = "Release v$latestVer is missing a SHA-256 verification checksum and was blocked."
                emitStatus("error", message = msg)
                return JSONObject().put("status", "error").put("message", msg)
            }

            pending = PendingUpdate(
                version = latestVer,
                apkName = apkName,
                apkUrl = apkUrl,
                checksumUrl = checksumUrl
            )
            emitStatus("available", version = latestVer)
            JSONObject().put("status", "available").put("version", latestVer)
        } catch (e: Exception) {
            val msg = e.message ?: "Could not check for updates."
            emitStatus("error", message = msg)
            JSONObject().put("status", "error").put("message", msg)
        }
    }

    fun downloadUpdate(): JSONObject {
        val target = pending
            ?: return JSONObject().put("status", "error").put("message", "No pending update to download.")

        return try {
            val currentVer = getAppVersion()
            val checksumText = fetchHttpsText(target.checksumUrl, currentVer)
            val expectedHash = parseExpectedSha256(checksumText, target.apkName)
                ?: throw SecurityException("SHA-256 checksum for ${target.apkName} not found — update blocked.")

            val updateDir = File(activity.cacheDir, "updates").apply { mkdirs() }
            val partFile = File(updateDir, "aaz-update.apk.part")
            val finalFile = File(updateDir, "aaz-update.apk")
            if (partFile.exists()) partFile.delete()

            emitStatus("downloading", version = target.version, percent = 0)
            val digest = MessageDigest.getInstance("SHA-256")

            val conn = openAllowedHttpsConnection(target.apkUrl, currentVer)
            try {
                val code = conn.responseCode
                if (code !in 200..299) {
                    throw IllegalStateException("APK download failed (HTTP $code).")
                }
                val totalBytes = conn.contentLengthLong
                var downloaded = 0L
                var lastPct = -1

                BufferedInputStream(conn.inputStream).use { input ->
                    FileOutputStream(partFile).use { fos ->
                        val buf = ByteArray(32768)
                        while (true) {
                            val read = input.read(buf)
                            if (read <= 0) break
                            fos.write(buf, 0, read)
                            digest.update(buf, 0, read)
                            downloaded += read
                            if (totalBytes > 0L) {
                                val pct = ((downloaded * 100L) / totalBytes).toInt().coerceIn(0, 100)
                                if (pct != lastPct && (pct == 100 || pct - lastPct >= 2)) {
                                    lastPct = pct
                                    emitStatus("downloading", version = target.version, percent = pct)
                                }
                            }
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }

            val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
            val hashMatches = MessageDigest.isEqual(
                actualHash.lowercase(Locale.ROOT).toByteArray(Charsets.US_ASCII),
                expectedHash.lowercase(Locale.ROOT).toByteArray(Charsets.US_ASCII)
            )
            if (!hashMatches) {
                partFile.delete()
                throw SecurityException("SHA-256 verification failed for downloaded APK — file discarded.")
            }

            if (finalFile.exists()) finalFile.delete()
            if (!partFile.renameTo(finalFile)) {
                partFile.copyTo(finalFile, overwrite = true)
                partFile.delete()
            }
            target.verifiedSha256 = expectedHash
            emitStatus("downloaded", version = target.version, percent = 100)
            JSONObject().put("status", "downloaded").put("version", target.version)
        } catch (e: Exception) {
            val msg = e.message ?: "Update download failed."
            emitStatus("error", message = msg)
            JSONObject().put("status", "error").put("message", msg)
        }
    }

    fun installUpdate(): JSONObject {
        val target = pending
        val apkFile = File(File(activity.cacheDir, "updates"), "aaz-update.apk")
        if (target == null || target.verifiedSha256.isNullOrBlank() || !apkFile.exists()) {
            return JSONObject().put("status", "error").put("message", "No verified update APK ready to install.")
        }

        // Re-verify SHA-256 immediately before handing APK to system installer (fail-closed)
        val actualHash = sha256File(apkFile)
        val ok = MessageDigest.isEqual(
            actualHash.lowercase(Locale.ROOT).toByteArray(Charsets.US_ASCII),
            target.verifiedSha256!!.lowercase(Locale.ROOT).toByteArray(Charsets.US_ASCII)
        )
        if (!ok) {
            apkFile.delete()
            val msg = "Update APK integrity check failed before install — file removed."
            emitStatus("error", message = msg)
            return JSONObject().put("status", "error").put("message", msg)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            activity.runOnUiThread {
                try {
                    val permIntent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(permIntent)
                } catch (_: Exception) {
                }
            }
            return JSONObject()
                .put("status", "permission-required")
                .put("message", "Allow 'Install unknown apps' for AZ0, then tap Install again.")
        }

        return try {
            val contentUri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                apkFile
            )
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.runOnUiThread {
                activity.startActivity(installIntent)
            }
            JSONObject().put("status", "installing").put("version", target.version)
        } catch (e: Exception) {
            val msg = e.message ?: "Could not launch Android package installer."
            emitStatus("error", message = msg)
            JSONObject().put("status", "error").put("message", msg)
        }
    }

    private fun emitStatus(status: String, version: String? = null, percent: Int? = null, message: String? = null) {
        val obj = JSONObject().put("status", status)
        if (version != null) obj.put("version", version)
        if (percent != null) obj.put("percent", percent)
        if (message != null) obj.put("message", message)
        onStatusEvent(obj)
    }

    private fun isAllowedHttpsUrl(urlStr: String): Boolean {
        return try {
            val uri = URI(urlStr)
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
            val host = uri.host?.lowercase(Locale.ROOT) ?: return false
            scheme == "https" && allowedHosts.contains(host)
        } catch (_: Exception) {
            false
        }
    }

    private fun openAllowedHttpsConnection(initialUrl: String, currentVer: String): HttpsURLConnection {
        var urlStr = initialUrl
        for (hop in 0 until 5) {
            if (!isAllowedHttpsUrl(urlStr)) {
                throw SecurityException("Blocked untrusted update URL host.")
            }
            val conn = (URL(urlStr).openConnection() as? HttpsURLConnection)
                ?: throw SecurityException("HTTPS connection required for updates.")
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 10000
            conn.readTimeout = 20000
            conn.setRequestProperty("User-Agent", "AAZ-Player-Android/$currentVer")
            if (urlStr.startsWith("https://api.github.com/")) {
                conn.setRequestProperty("Accept", "application/vnd.github+json")
            }
            val code = conn.responseCode
            if (code in 301..308) {
                val loc = conn.getHeaderField("Location")
                conn.disconnect()
                if (loc.isNullOrBlank()) throw IllegalStateException("Invalid redirect without Location.")
                urlStr = URI(urlStr).resolve(loc).toString()
                continue
            }
            return conn
        }
        throw IllegalStateException("Too many redirects while contacting GitHub Releases.")
    }

    private fun fetchHttpsText(urlStr: String, currentVer: String): String {
        val conn = openAllowedHttpsConnection(urlStr, currentVer)
        return try {
            val code = conn.responseCode
            if (code !in 200..299) {
                throw IllegalStateException("GitHub Releases request failed (HTTP $code).")
            }
            conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun parseExpectedSha256(checksumText: String, apkFileName: String): String? {
        val lines = checksumText.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val hexRegex = Regex("^[a-fA-F0-9]{64}$")
        // Format 1: `<hash>  <filename>` or `<hash> *<filename>`
        for (line in lines) {
            val parts = line.split(Regex("\\s+"), limit = 2)
            if (parts.size == 2 && hexRegex.matches(parts[0])) {
                val name = parts[1].trim().removePrefix("*")
                if (name.equals(apkFileName, ignoreCase = true)) {
                    return parts[0].lowercase(Locale.ROOT)
                }
            }
        }
        // Format 2: Single-file `.sha256` containing only `<hash>`
        if (lines.size == 1 && hexRegex.matches(lines[0])) {
            return lines[0].lowercase(Locale.ROOT)
        }
        return null
    }

    private fun sha256File(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { fis ->
            val buf = ByteArray(32768)
            while (true) {
                val read = fis.read(buf)
                if (read <= 0) break
                digest.update(buf, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun compareSemver(a: String, b: String): Int {
        val pa = a.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val max = maxOf(pa.size, pb.size)
        for (i in 0 until max) {
            val va = pa.getOrElse(i) { 0 }
            val vb = pb.getOrElse(i) { 0 }
            if (va != vb) return va.compareTo(vb)
        }
        return 0
    }
}
