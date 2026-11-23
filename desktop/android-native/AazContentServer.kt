package com.aaz.player

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.FileInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Embedded loopback-only (127.0.0.1) HTTP/1.1 Range streaming server for Android content:// URIs.
 * Streams SAF and MediaStore files directly from ContentResolver file descriptors without copying
 * into RAM, supporting instant Range seeking (206 Partial Content) for multi-GB audio/video files.
 */
class AazContentServer(private val context: Context) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var workerPool: ExecutorService? = null
    private val sessionToken: String = generateSessionToken()

    @Volatile
    var port: Int = 0
        private set

    fun start(): Int {
        if (running.get() && port > 0) return port
        val socket = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        serverSocket = socket
        port = socket.localPort
        running.set(true)
        workerPool = Executors.newCachedThreadPool()
        acceptThread = Thread({
            while (running.get()) {
                try {
                    val client = socket.accept()
                    workerPool?.execute { handleClient(client) }
                } catch (_: IOException) {
                    if (!running.get()) break
                }
            }
        }, "aaz-content-server-accept").apply {
            isDaemon = true
            start()
        }
        return port
    }

    fun stop() {
        running.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        workerPool?.shutdownNow()
        workerPool = null
    }

    fun buildMediaUrl(contentUri: String): String {
        val activePort = if (port > 0) port else start()
        val encodedUri = URLEncoder.encode(contentUri, "UTF-8")
        return "http://127.0.0.1:$activePort/media?token=$sessionToken&uri=$encodedUri"
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            try {
                client.soTimeout = 15_000
                val input = BufferedInputStream(client.getInputStream(), 8192)
                val output = BufferedOutputStream(client.getOutputStream(), 65536)

                val requestLine = readAsciiLine(input, 8192) ?: return
                val parts = requestLine.split(' ')
                if (parts.size < 2) {
                    writeSimpleError(output, 400, "Bad Request")
                    return
                }
                val method = parts[0].uppercase(Locale.US)
                val target = parts[1]

                var rangeHeader: String? = null
                var originHeader: String? = null
                var headerCount = 0
                while (headerCount < 64) {
                    val line = readAsciiLine(input, 8192) ?: break
                    if (line.isEmpty()) break
                    headerCount++
                    val colon = line.indexOf(':')
                    if (colon > 0) {
                        val name = line.substring(0, colon).trim().lowercase(Locale.US)
                        val value = line.substring(colon + 1).trim()
                        when (name) {
                            "range" -> rangeHeader = value
                            "origin" -> originHeader = value
                        }
                    }
                }

                val corsOrigin = sanitizeAllowedOrigin(originHeader)
                if (method == "OPTIONS") {
                    writeOptions(output, corsOrigin)
                    return
                }
                if (method != "GET" && method != "HEAD") {
                    writeSimpleError(output, 405, "Method Not Allowed", corsOrigin)
                    return
                }

                val qIdx = target.indexOf('?')
                val pathOnly = if (qIdx >= 0) target.substring(0, qIdx) else target
                if (pathOnly != "/media") {
                    writeSimpleError(output, 404, "Not Found", corsOrigin)
                    return
                }

                val query = if (qIdx >= 0) target.substring(qIdx + 1) else ""
                val params = parseQuery(query)
                val providedToken = params["token"] ?: ""
                if (!constantTimeEquals(providedToken, sessionToken)) {
                    writeSimpleError(output, 403, "Forbidden", corsOrigin)
                    return
                }

                val uriStr = params["uri"] ?: ""
                if (!uriStr.startsWith("content://")) {
                    writeSimpleError(output, 400, "Invalid URI", corsOrigin)
                    return
                }

                val uri = Uri.parse(uriStr)
                serveContentUri(uri, method == "HEAD", rangeHeader, corsOrigin, output)
            } catch (_: Exception) {
                // Client disconnected or aborted seek; ignore cleanly
            }
        }
    }

    private fun serveContentUri(
        uri: Uri,
        headOnly: Boolean,
        rangeHeader: String?,
        corsOrigin: String?,
        output: BufferedOutputStream
    ) {
        val resolver = context.contentResolver
        val pfd = try {
            resolver.openFileDescriptor(uri, "r")
        } catch (_: Exception) {
            null
        }
        if (pfd == null) {
            writeSimpleError(output, 404, "File Not Accessible", corsOrigin)
            return
        }

        pfd.use { descriptor ->
            val fileSize = resolveFileSize(uri, descriptor.statSize)
            val mimeType = resolveMimeType(uri)

            if (fileSize <= 0L) {
                val headers = buildString {
                    append("HTTP/1.1 200 OK\r\n")
                    append("Content-Type: $mimeType\r\n")
                    append("Accept-Ranges: none\r\n")
                    append("Cache-Control: no-store\r\n")
                    if (corsOrigin != null) {
                        append("Access-Control-Allow-Origin: $corsOrigin\r\n")
                        append("Vary: Origin\r\n")
                    }
                    append("Connection: close\r\n\r\n")
                }
                output.write(headers.toByteArray(Charsets.US_ASCII))
                if (!headOnly) {
                    FileInputStream(descriptor.fileDescriptor).use { fis ->
                        copyStream(fis, output, Long.MAX_VALUE)
                    }
                }
                output.flush()
                return
            }

            var start = 0L
            var end = fileSize - 1L
            var isPartial = false

            if (!rangeHeader.isNullOrBlank()) {
                val parsed = parseByteRange(rangeHeader, fileSize)
                if (parsed == null) {
                    val err = buildString {
                        append("HTTP/1.1 416 Range Not Satisfiable\r\n")
                        append("Content-Range: bytes */$fileSize\r\n")
                        append("Content-Length: 0\r\n")
                        if (corsOrigin != null) {
                            append("Access-Control-Allow-Origin: $corsOrigin\r\n")
                            append("Vary: Origin\r\n")
                        }
                        append("Connection: close\r\n\r\n")
                    }
                    output.write(err.toByteArray(Charsets.US_ASCII))
                    output.flush()
                    return
                }
                start = parsed.first
                end = parsed.second
                isPartial = true
            }

            val contentLength = end - start + 1L
            val headers = buildString {
                if (isPartial) {
                    append("HTTP/1.1 206 Partial Content\r\n")
                    append("Content-Range: bytes $start-$end/$fileSize\r\n")
                } else {
                    append("HTTP/1.1 200 OK\r\n")
                }
                append("Content-Type: $mimeType\r\n")
                append("Content-Length: $contentLength\r\n")
                append("Accept-Ranges: bytes\r\n")
                append("Cache-Control: no-store\r\n")
                if (corsOrigin != null) {
                    append("Access-Control-Allow-Origin: $corsOrigin\r\n")
                    append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                    append("Vary: Origin\r\n")
                }
                append("Connection: close\r\n\r\n")
            }
            output.write(headers.toByteArray(Charsets.US_ASCII))
            output.flush()

            if (!headOnly && contentLength > 0L) {
                FileInputStream(descriptor.fileDescriptor).use { fis ->
                    if (start > 0L) {
                        try {
                            fis.channel.position(start)
                        } catch (_: Exception) {
                            var remainingSkip = start
                            while (remainingSkip > 0L) {
                                val skipped = fis.skip(remainingSkip)
                                if (skipped <= 0L) break
                                remainingSkip -= skipped
                            }
                        }
                    }
                    copyStream(fis, output, contentLength)
                }
                output.flush()
            }
        }
    }

    private fun copyStream(input: FileInputStream, output: OutputStream, maxBytes: Long) {
        val buf = ByteArray(65536)
        var remaining = maxBytes
        while (remaining > 0L) {
            val toRead = if (remaining < buf.size) remaining.toInt() else buf.size
            val read = input.read(buf, 0, toRead)
            if (read <= 0) break
            output.write(buf, 0, read)
            remaining -= read
        }
    }

    private fun resolveFileSize(uri: Uri, statSize: Long): Long {
        if (statSize > 0L) return statSize
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (idx >= 0 && !c.isNull(idx)) {
                        val size = c.getLong(idx)
                        if (size > 0L) return size
                    }
                }
            }
        } catch (_: Exception) {
        }
        return -1L
    }

    private fun resolveMimeType(uri: Uri): String {
        val raw = try {
            context.contentResolver.getType(uri)
        } catch (_: Exception) {
            null
        }
        if (!raw.isNullOrBlank() && raw != "application/octet-stream") return raw

        val name = queryDisplayName(uri).lowercase(Locale.US)
        return when {
            name.endsWith(".mp4") || name.endsWith(".m4v") -> "video/mp4"
            name.endsWith(".webm") -> "video/webm"
            name.endsWith(".mkv") -> "video/x-matroska"
            name.endsWith(".mov") -> "video/quicktime"
            name.endsWith(".avi") -> "video/x-msvideo"
            name.endsWith(".3gp") -> "video/3gpp"
            name.endsWith(".ogv") -> "video/ogg"
            name.endsWith(".mp3") -> "audio/mpeg"
            name.endsWith(".m4a") -> "audio/mp4"
            name.endsWith(".aac") -> "audio/aac"
            name.endsWith(".flac") -> "audio/flac"
            name.endsWith(".wav") -> "audio/wav"
            name.endsWith(".ogg") || name.endsWith(".oga") -> "audio/ogg"
            name.endsWith(".opus") -> "audio/opus"
            name.endsWith(".weba") -> "audio/webm"
            else -> "application/octet-stream"
        }
    }

    private fun queryDisplayName(uri: Uri): String {
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && !c.isNull(idx)) return c.getString(idx) ?: ""
                }
            }
        } catch (_: Exception) {
        }
        return uri.lastPathSegment ?: ""
    }

    private fun parseByteRange(header: String, totalSize: Long): Pair<Long, Long>? {
        val trimmed = header.trim()
        if (!trimmed.startsWith("bytes=", ignoreCase = true)) return null
        val spec = trimmed.substring(6).trim()
        if (spec.isEmpty() || spec.contains(',')) return null
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val startStr = spec.substring(0, dash).trim()
        val endStr = spec.substring(dash + 1).trim()

        if (startStr.isEmpty()) {
            val suffix = endStr.toLongOrNull() ?: return null
            if (suffix <= 0L) return null
            val start = (totalSize - suffix).coerceAtLeast(0L)
            return Pair(start, totalSize - 1L)
        }

        val start = startStr.toLongOrNull() ?: return null
        if (start < 0L || start >= totalSize) return null
        val end = if (endStr.isEmpty()) {
            totalSize - 1L
        } else {
            val parsedEnd = endStr.toLongOrNull() ?: return null
            if (parsedEnd < start) return null
            parsedEnd.coerceAtMost(totalSize - 1L)
        }
        return Pair(start, end)
    }

    private fun parseQuery(query: String): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        if (query.isEmpty()) return map
        for (pair in query.split('&')) {
            val eq = pair.indexOf('=')
            if (eq > 0) {
                val k = URLDecoder.decode(pair.substring(0, eq), "UTF-8")
                val v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
                map[k] = v
            }
        }
        return map
    }

    private fun readAsciiLine(input: BufferedInputStream, maxBytes: Int): String? {
        val sb = StringBuilder()
        var count = 0
        while (count < maxBytes) {
            val b = input.read()
            if (b == -1) {
                return if (sb.isEmpty()) null else sb.toString()
            }
            if (b == '\n'.code) {
                if (sb.isNotEmpty() && sb[sb.length - 1] == '\r') {
                    sb.setLength(sb.length - 1)
                }
                return sb.toString()
            }
            sb.append(b.toChar())
            count++
        }
        return null
    }

    private fun sanitizeAllowedOrigin(origin: String?): String? {
        if (origin.isNullOrBlank()) return null
        val clean = origin.trim()
        return if (
            clean == "http://tauri.localhost" ||
            clean == "https://tauri.localhost" ||
            clean.startsWith("http://127.0.0.1:") ||
            clean.startsWith("http://localhost:")
        ) {
            clean
        } else {
            null
        }
    }

    private fun writeOptions(output: OutputStream, corsOrigin: String?) {
        val resp = buildString {
            append("HTTP/1.1 204 No Content\r\n")
            if (corsOrigin != null) {
                append("Access-Control-Allow-Origin: $corsOrigin\r\n")
                append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
                append("Access-Control-Allow-Headers: Range\r\n")
                append("Vary: Origin\r\n")
            }
            append("Connection: close\r\n\r\n")
        }
        output.write(resp.toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun writeSimpleError(output: OutputStream, code: Int, reason: String, corsOrigin: String? = null) {
        val resp = buildString {
            append("HTTP/1.1 $code $reason\r\n")
            append("Content-Length: 0\r\n")
            if (corsOrigin != null) {
                append("Access-Control-Allow-Origin: $corsOrigin\r\n")
            }
            append("Connection: close\r\n\r\n")
        }
        output.write(resp.toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        return MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
    }

    companion object {
        private fun generateSessionToken(): String {
            val bytes = ByteArray(24)
            SecureRandom().nextBytes(bytes)
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                sb.append(String.format(Locale.US, "%02x", b))
            }
            return sb.toString()
        }
    }
}
