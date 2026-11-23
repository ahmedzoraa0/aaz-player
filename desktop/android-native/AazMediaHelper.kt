package com.aaz.player

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Android Phase 1 & Phase 2 media, SAF, MediaStore, subtitle, and snapshot utilities.
 * Handles SAF document/tree scanning, optional MediaStore library scanning (R32),
 * UTF-8 / Windows-1256 (Arabic) subtitle decoding & nearby matching (R29-R31),
 * and scoped PNG snapshot saving (R25).
 */
class AazMediaHelper(
    private val context: Context,
    private val contentServer: AazContentServer
) {
    private val videoToSubSiblings = ConcurrentHashMap<String, List<SubtitleCandidate>>()

    data class SubtitleCandidate(
        val name: String,
        val uri: String
    )

    companion object {
        private val AUDIO_EXTS = setOf(
            "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif", "weba", "mka"
        )
        private val VIDEO_EXTS = setOf(
            "mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv", "3gp"
        )
        private val SUBTITLE_EXTS = setOf("srt", "vtt")
        private val PLAYLIST_EXTS = setOf("xspf", "m3u8", "m3u", "pls")
        private const val MAX_SCAN_DEPTH = 8
        private const val MAX_SCAN_ITEMS = 4000
        private const val MAX_TEXT_BYTES = 10 * 1024 * 1024

        fun extOf(name: String): String {
            val dot = name.lastIndexOf('.')
            if (dot < 0 || dot == name.length - 1) return ""
            return name.substring(dot + 1).lowercase(Locale.US)
        }

        fun stripExt(name: String): String {
            val dot = name.lastIndexOf('.')
            return if (dot > 0) name.substring(0, dot) else name
        }

        fun classifyKind(name: String, mime: String? = null): String? {
            val ext = extOf(name)
            return when {
                AUDIO_EXTS.contains(ext) -> "audio"
                VIDEO_EXTS.contains(ext) -> "video"
                SUBTITLE_EXTS.contains(ext) -> "subtitle"
                PLAYLIST_EXTS.contains(ext) -> "playlist"
                mime != null && mime.startsWith("audio/") -> "audio"
                mime != null && mime.startsWith("video/") -> "video"
                else -> null
            }
        }
    }

    fun inspectContentUris(uris: List<Uri>): JSONObject {
        val entries = JSONArray()
        val playlists = JSONArray()

        for (uri in uris) {
            val meta = queryUriMeta(uri) ?: continue
            val kind = classifyKind(meta.name, meta.mime) ?: continue
            if (kind == "playlist") {
                val text = readTextFromUri(uri)
                if (text != null) {
                    playlists.put(
                        JSONObject().apply {
                            put("name", meta.name)
                            put("fullPath", uri.toString())
                            put("content", text)
                        }
                    )
                }
                continue
            }
            entries.put(buildEntryJson(meta.name, meta.name, kind, meta.size, meta.mtimeMs, uri.toString(), ""))
        }

        return JSONObject().apply {
            put("entries", entries)
            put("playlists", playlists)
        }
    }

    fun scanSafTree(treeUri: Uri): JSONObject {
        val entries = JSONArray()
        val folderName = resolveTreeDisplayName(treeUri)
        val rootDocId = try {
            DocumentsContract.getTreeDocumentId(treeUri)
        } catch (_: Exception) {
            return JSONObject().apply {
                put("folderName", folderName)
                put("folderPath", treeUri.toString())
                put("entries", entries)
            }
        }

        val count = IntArray(1)
        scanTreeNode(treeUri, rootDocId, "", 0, count, entries)

        return JSONObject().apply {
            put("folderName", folderName)
            put("folderPath", treeUri.toString())
            put("entries", entries)
        }
    }

    private fun scanTreeNode(
        treeUri: Uri,
        parentDocId: String,
        relPrefix: String,
        depth: Int,
        count: IntArray,
        entries: JSONArray
    ) {
        if (depth > MAX_SCAN_DEPTH || count[0] >= MAX_SCAN_ITEMS) return
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        )

        val dirVideos = ArrayList<String>()
        val dirSubtitles = ArrayList<SubtitleCandidate>()
        val subDirs = ArrayList<Pair<String, String>>()

        try {
            context.contentResolver.query(childrenUri, projection, null, null, null)?.use { c ->
                val idIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                val sizeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                val modIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)

                while (c.moveToNext() && count[0] < MAX_SCAN_ITEMS) {
                    val docId = if (idIdx >= 0) c.getString(idIdx) else null
                    val name = if (nameIdx >= 0) c.getString(nameIdx) else null
                    val mime = if (mimeIdx >= 0) c.getString(mimeIdx) else null
                    if (docId.isNullOrBlank() || name.isNullOrBlank()) continue

                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        val nextPrefix = if (relPrefix.isEmpty()) name else "$relPrefix/$name"
                        subDirs.add(Pair(docId, nextPrefix))
                        continue
                    }

                    val kind = classifyKind(name, mime) ?: continue
                    if (kind == "playlist") continue

                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString()
                    val relKey = if (relPrefix.isEmpty()) name else "$relPrefix/$name"
                    val size = if (sizeIdx >= 0 && !c.isNull(sizeIdx)) c.getLong(sizeIdx) else 0L
                    val mtime = if (modIdx >= 0 && !c.isNull(modIdx)) c.getLong(modIdx) else 0L

                    entries.put(buildEntryJson(name, relKey, kind, size, mtime, docUri, relPrefix))
                    count[0]++

                    if (kind == "video") {
                        dirVideos.add(docUri)
                    } else if (kind == "subtitle") {
                        dirSubtitles.add(SubtitleCandidate(name, docUri))
                    }
                }
            }
        } catch (_: Exception) {
            return
        }

        if (dirVideos.isNotEmpty() && dirSubtitles.isNotEmpty()) {
            val frozenSubs = dirSubtitles.toList()
            for (vUri in dirVideos) {
                videoToSubSiblings[vUri] = frozenSubs
            }
        }

        for ((childDocId, nextPrefix) in subDirs) {
            if (count[0] >= MAX_SCAN_ITEMS) break
            scanTreeNode(treeUri, childDocId, nextPrefix, depth + 1, count, entries)
        }
    }

    /**
     * Phase 2 (R32): Optional MediaStore scan returning audio & video grouped by folder bucket.
     * Caller MUST obtain runtime permission before calling this method.
     */
    fun scanDeviceMediaStore(): JSONObject {
        val buckets = LinkedHashMap<String, MutableList<JSONObject>>()
        queryMediaStoreCollection(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video", buckets)
        queryMediaStoreCollection(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "audio", buckets)

        val foldersArr = JSONArray()
        for ((bucketName, list) in buckets) {
            if (list.isEmpty()) continue
            val entriesArr = JSONArray()
            for (item in list) entriesArr.put(item)
            foldersArr.put(
                JSONObject().apply {
                    put("folderPath", "mediastore://bucket/$bucketName")
                    put("folderName", bucketName)
                    put("entries", entriesArr)
                }
            )
        }
        return JSONObject().apply {
            put("folders", foldersArr)
        }
    }

    private fun queryMediaStoreCollection(
        collectionUri: Uri,
        kind: String,
        buckets: LinkedHashMap<String, MutableList<JSONObject>>
    ) {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.DURATION,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME
        )
        try {
            context.contentResolver.query(
                collectionUri,
                projection,
                null,
                null,
                "${MediaStore.MediaColumns.DATE_MODIFIED} DESC"
            )?.use { c ->
                val idIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameIdx = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                val sizeIdx = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
                val modIdx = c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED)
                val durIdx = c.getColumnIndex(MediaStore.MediaColumns.DURATION)
                val bucketIdx = c.getColumnIndex(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)

                var count = 0
                while (c.moveToNext() && count < MAX_SCAN_ITEMS) {
                    val id = c.getLong(idIdx)
                    val name = if (nameIdx >= 0) c.getString(nameIdx) else null
                    if (name.isNullOrBlank()) continue
                    val size = if (sizeIdx >= 0 && !c.isNull(sizeIdx)) c.getLong(sizeIdx) else 0L
                    val mtimeMs = if (modIdx >= 0 && !c.isNull(modIdx)) c.getLong(modIdx) * 1000L else 0L
                    val durMs = if (durIdx >= 0 && !c.isNull(durIdx)) c.getLong(durIdx) else 0L
                    val bucket = (if (bucketIdx >= 0) c.getString(bucketIdx) else null)?.takeIf { it.isNotBlank() }
                        ?: if (kind == "video") "Videos" else "Music"

                    val itemUri = ContentUris.withAppendedId(collectionUri, id).toString()
                    val obj = buildEntryJson(name, "$bucket/$name", kind, size, mtimeMs, itemUri, bucket)
                    if (durMs > 0L) {
                        obj.put("duration", durMs / 1000.0)
                    }
                    buckets.getOrPut(bucket) { ArrayList() }.add(obj)
                    count++
                }
            }
        } catch (_: Exception) {
        }
    }

    /**
     * Phase 2 (R29-R31): Smart subtitle/playlist text reader supporting UTF-8, UTF-16, and Windows-1256 (Arabic).
     */
    fun readTextFromUri(uri: Uri): String? {
        return try {
            val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(16384)
                var total = 0
                while (true) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    if (total + read > MAX_TEXT_BYTES) {
                        out.write(buf, 0, MAX_TEXT_BYTES - total)
                        break
                    }
                    out.write(buf, 0, read)
                    total += read
                }
                out.toByteArray()
            } ?: return null

            decodeTextSmart(bytes)
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeTextSmart(bytes: ByteArray): String {
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        }
        // Strict UTF-8 first
        try {
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            return decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
        }
        // Fallback to Windows-1256 (Arabic) if high-byte Arabic characters predominate, else Windows-1252
        return try {
            val cp1256 = Charset.forName("windows-1256")
            val arDecoded = String(bytes, cp1256)
            val arCount = arDecoded.count { it in '\u0600'..'\u06FF' }
            if (arCount >= 4) {
                arDecoded
            } else {
                String(bytes, Charset.forName("windows-1252"))
            }
        } catch (_: Exception) {
            String(bytes, Charsets.ISO_8859_1)
        }
    }

    /**
     * Phase 2 (R29-R31): Find best matching sibling .srt/.vtt subtitle for a SAF video URI.
     */
    fun findNearbySubtitle(videoUriStr: String, preferredLang: String, uiLang: String): JSONObject? {
        val candidates = videoToSubSiblings[videoUriStr] ?: return null
        if (candidates.isEmpty()) return null
        val videoMeta = queryUriMeta(Uri.parse(videoUriStr)) ?: return null
        val videoStem = stripExt(videoMeta.name).lowercase(Locale.US)
        val wantLang = when (preferredLang.lowercase(Locale.US)) {
            "ar", "en" -> preferredLang.lowercase(Locale.US)
            else -> if (uiLang.lowercase(Locale.US) == "ar") "ar" else "en"
        }

        var best: SubtitleCandidate? = null
        var bestScore = Int.MIN_VALUE

        for (cand in candidates) {
            val subStem = stripExt(cand.name).lowercase(Locale.US)
            var score = 0
            if (subStem == videoStem) {
                score += 100
            } else if (subStem.startsWith("$videoStem.") || subStem.startsWith("${videoStem}_") || subStem.startsWith("${videoStem}-")) {
                score += 80
            } else if (candidates.size == 1) {
                score += 20
            } else {
                continue
            }

            val isAr = subStem.contains(".ar") || subStem.contains("_ar") || subStem.contains("arab") || subStem.contains("عرب")
            val isEn = subStem.contains(".en") || subStem.contains("_en") || subStem.contains("eng")
            if (wantLang == "ar" && isAr) score += 25
            if (wantLang == "en" && isEn) score += 25
            if (cand.name.lowercase(Locale.US).endsWith(".vtt")) score += 2

            if (score > bestScore) {
                bestScore = score
                best = cand
            }
        }

        val chosen = best ?: return null
        val text = readTextFromUri(Uri.parse(chosen.uri)) ?: return null
        return JSONObject().apply {
            put("name", chosen.name)
            put("text", text)
            put("fullPath", chosen.uri)
        }
    }

    /**
     * Phase 1 (R25): Save video snapshot PNG into Pictures/AAZ Player using MediaStore (API 29+) or Pictures dir.
     */
    fun saveSnapshotPng(dataBase64: String, suggestedName: String): JSONObject {
        val cleanName = suggestedName.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifBlank { "aaz-snapshot.png" }
        val finalName = if (cleanName.lowercase(Locale.US).endsWith(".png")) cleanName else "$cleanName.png"
        val cleanB64 = dataBase64.substringAfter("base64,", dataBase64).trim()
        val bytes = try {
            Base64.decode(cleanB64, Base64.DEFAULT)
        } catch (_: Exception) {
            return JSONObject().apply { put("saved", false); put("error", "Invalid image data") }
        }

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, finalName)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/AAZ Player")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: return JSONObject().apply { put("saved", false); put("error", "Could not create image") }
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                JSONObject().apply {
                    put("saved", true)
                    put("path", "Pictures/AAZ Player/$finalName")
                }
            } else {
                @Suppress("DEPRECATION")
                val dir = File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                    "AAZ Player"
                )
                if (!dir.exists()) dir.mkdirs()
                val outFile = File(dir, finalName)
                FileOutputStream(outFile).use { it.write(bytes) }
                JSONObject().apply {
                    put("saved", true)
                    put("path", outFile.absolutePath)
                }
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("saved", false)
                put("error", e.message ?: "Failed to save snapshot")
            }
        }
    }

    private data class UriMeta(
        val name: String,
        val mime: String?,
        val size: Long,
        val mtimeMs: Long
    )

    private fun queryUriMeta(uri: Uri): UriMeta? {
        val resolver = context.contentResolver
        val mime = try { resolver.getType(uri) } catch (_: Exception) { null }
        var name: String? = null
        var size = 0L
        var mtime = 0L

        try {
            resolver.query(
                uri,
                arrayOf(
                    OpenableColumns.DISPLAY_NAME,
                    OpenableColumns.SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                ),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val nIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sIdx = c.getColumnIndex(OpenableColumns.SIZE)
                    val mIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    if (nIdx >= 0 && !c.isNull(nIdx)) name = c.getString(nIdx)
                    if (sIdx >= 0 && !c.isNull(sIdx)) size = c.getLong(sIdx)
                    if (mIdx >= 0 && !c.isNull(mIdx)) mtime = c.getLong(mIdx)
                }
            }
        } catch (_: Exception) {
        }

        val resolvedName = name?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')
            ?: return null

        return UriMeta(resolvedName, mime, size, mtime)
    }

    private fun resolveTreeDisplayName(treeUri: Uri): String {
        try {
            val docId = DocumentsContract.getTreeDocumentId(treeUri)
            val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
            val meta = queryUriMeta(docUri)
            if (meta != null && meta.name.isNotBlank()) return meta.name
            val tail = docId.substringAfterLast(':').substringAfterLast('/')
            if (tail.isNotBlank()) return tail
        } catch (_: Exception) {
        }
        return "Selected Folder"
    }

    private fun buildEntryJson(
        name: String,
        key: String,
        kind: String,
        size: Long,
        mtimeMs: Long,
        uriStr: String,
        folderLabel: String
    ): JSONObject {
        return JSONObject().apply {
            put("name", name)
            put("key", key)
            put("kind", kind)
            put("ext", extOf(name))
            put("size", size)
            put("mtimeMs", mtimeMs)
            put("fullPath", uriStr)
            put("folderPath", folderLabel)
            put("fileUrl", if (kind == "audio" || kind == "video") contentServer.buildMediaUrl(uriStr) else "")
        }
    }
}
