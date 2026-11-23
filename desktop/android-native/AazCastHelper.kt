package com.aaz.player

import android.content.Context
import android.net.Uri
import android.net.wifi.WifiManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phase 4 Android LAN / DLNA Cast Helper (R43-R46):
 * - Acquires WifiManager.MulticastLock strictly during SSDP M-SEARCH and releases in finally.
 * - Enforces strict RFC1918 / link-local LAN-only SSRF validation on all DLNA device URLs.
 * - Uses raw TCP HTTP/1.1 sockets for local LAN DLNA device XML & AVTransport SOAP so
 *   network_security_config.xml remains locked to cleartextTrafficPermitted="false" globally.
 * - Hosts a token-protected LAN HTTP Range streaming server (/media, /subtitle.vtt, /receiver)
 *   streaming directly from SAF/MediaStore ContentResolver without RAM buffering.
 */
class AazCastHelper(private val context: Context) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val clientPool = Executors.newFixedThreadPool(6)

    @Volatile
    private var sessionToken: String = ""

    @Volatile
    private var activeMediaPath: String = ""

    @Volatile
    private var activeTitle: String = "AAZ Player"

    @Volatile
    private var activeSubtitleVtt: String? = null

    @Volatile
    private var boundPort: Int = 0

    @Synchronized
    fun startServer(mediaPath: String, title: String, subtitleVtt: String?): JSONObject {
        val cleanPath = mediaPath.trim()
        require(cleanPath.isNotEmpty()) { "No media path provided for LAN cast." }

        val host = findLocalLanIpv4()
            ?: throw IllegalStateException("Connect to a local Wi-Fi network to cast media.")

        if (!running.get() || serverSocket == null || serverSocket!!.isClosed) {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress("0.0.0.0", 0), 16)
            serverSocket = ss
            boundPort = ss.localPort
            running.set(true)
            acceptThread = Thread({ acceptLoop(ss) }, "AazCastServer").apply {
                isDaemon = true
                start()
            }
        }

        if (sessionToken.isEmpty()) {
            sessionToken = generateHexToken(16)
        }
        activeMediaPath = cleanPath
        activeTitle = title.ifBlank { "AAZ Player" }
        activeSubtitleVtt = subtitleVtt?.takeIf { it.isNotBlank() }

        val encodedToken = URLEncoder.encode(sessionToken, "UTF-8")
        val baseUrl = "http://$host:$boundPort"
        val mediaUrl = "$baseUrl/media?token=$encodedToken"
        val receiverUrl = "$baseUrl/receiver?token=$encodedToken"
        val subtitleUrl = if (activeSubtitleVtt != null) "$baseUrl/subtitle.vtt?token=$encodedToken" else JSONObject.NULL

        return JSONObject().apply {
            put("host", host)
            put("port", boundPort)
            put("token", sessionToken)
            put("mediaUrl", mediaUrl)
            put("receiverUrl", receiverUrl)
            put("subtitleUrl", subtitleUrl)
        }
    }

    @Synchronized
    fun stopServer() {
        running.set(false)
        activeMediaPath = ""
        activeSubtitleVtt = null
        sessionToken = ""
        boundPort = 0
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
    }

    fun shutdown() {
        stopServer()
        try {
            clientPool.shutdownNow()
        } catch (_: Exception) {
        }
    }

    /**
     * Discovers DLNA / UPnP MediaRenderer devices on the local Wi-Fi network.
     * Acquires WifiManager.MulticastLock strictly inside try/finally so battery is never drained.
     */
    fun discoverDevices(): JSONArray {
        val result = JSONArray()
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val multicastLock = try {
            wifi?.createMulticastLock("aaz_player_dlna_ssdp")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            null
        }

        val locations = LinkedHashSet<String>()
        try {
            val targets = listOf(
                "urn:schemas-upnp-org:service:AVTransport:1",
                "urn:schemas-upnp-org:device:MediaRenderer:1"
            )
            DatagramSocket().use { socket ->
                socket.soTimeout = 450
                socket.broadcast = true
                val ssdpAddr = InetAddress.getByName("239.255.255.250")
                for (st in targets) {
                    val req = (
                        "M-SEARCH * HTTP/1.1\r\n" +
                            "HOST: 239.255.255.250:1900\r\n" +
                            "MAN: \"ssdp:discover\"\r\n" +
                            "MX: 2\r\n" +
                            "ST: $st\r\n\r\n"
                        ).toByteArray(Charsets.UTF_8)
                    val packet = DatagramPacket(req, req.size, ssdpAddr, 1900)
                    try {
                        socket.send(packet)
                    } catch (_: Exception) {
                    }
                }

                val buf = ByteArray(4096)
                val deadline = System.currentTimeMillis() + 2200L
                while (System.currentTimeMillis() < deadline && locations.size < 24) {
                    try {
                        val recv = DatagramPacket(buf, buf.size)
                        socket.receive(recv)
                        val text = String(recv.data, 0, recv.length, Charsets.UTF_8)
                        val loc = extractHeaderValue(text, "LOCATION")
                        if (!loc.isNullOrBlank() && isPrivateLanUrl(loc)) {
                            locations.add(loc.trim())
                        }
                    } catch (_: SocketTimeoutException) {
                        // Continue until deadline
                    } catch (_: Exception) {
                        break
                    }
                }
            }
        } finally {
            try {
                if (multicastLock != null && multicastLock.isHeld) {
                    multicastLock.release()
                }
            } catch (_: Exception) {
            }
        }

        val seenControlUrls = HashSet<String>()
        for (loc in locations) {
            val dev = fetchDeviceDescription(loc) ?: continue
            val ctrl = dev.optString("controlUrl", "")
            if (ctrl.isNotEmpty() && seenControlUrls.add(ctrl)) {
                result.put(dev)
            }
        }
        return result
    }

    fun castToDlna(controlUrl: String, mediaUrl: String, title: String, mimeType: String): JSONObject {
        if (!isPrivateLanUrl(controlUrl)) {
            throw SecurityException("Blocked non-LAN DLNA control URL.")
        }
        if (!isPrivateLanUrl(mediaUrl)) {
            throw SecurityException("Blocked non-LAN media URL.")
        }
        val safeTitle = escapeXml(title.ifBlank { "AAZ Media" })
        val safeMediaUrl = escapeXml(mediaUrl)
        val safeMime = escapeXml(mimeType.ifBlank { "video/mp4" })
        val upnpClass = if (mimeType.startsWith("audio/", ignoreCase = true)) {
            "object.item.audioItem.musicTrack"
        } else {
            "object.item.videoItem"
        }

        val didl = """<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>$safeTitle</dc:title><upnp:class>$upnpClass</upnp:class><res protocolInfo="http-get:*:$safeMime:*">$safeMediaUrl</res></item></DIDL-Lite>"""

        val setUriBody = """<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>$safeMediaUrl</CurrentURI><CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>"""

        val setRes = sendLanHttpRequest(
            method = "POST",
            urlStr = controlUrl,
            headers = mapOf(
                "Content-Type" to "text/xml; charset=\"utf-8\"",
                "SOAPACTION" to "\"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\""
            ),
            bodyBytes = setUriBody.toByteArray(Charsets.UTF_8)
        )
        if (setRes.statusCode !in 200..299) {
            throw IllegalStateException("DLNA SetAVTransportURI failed (HTTP ${setRes.statusCode}).")
        }

        val playBody = """<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>"""
        val playRes = sendLanHttpRequest(
            method = "POST",
            urlStr = controlUrl,
            headers = mapOf(
                "Content-Type" to "text/xml; charset=\"utf-8\"",
                "SOAPACTION" to "\"urn:schemas-upnp-org:service:AVTransport:1#Play\""
            ),
            bodyBytes = playBody.toByteArray(Charsets.UTF_8)
        )
        if (playRes.statusCode !in 200..299) {
            throw IllegalStateException("DLNA Play failed (HTTP ${playRes.statusCode}).")
        }
        return JSONObject().put("ok", true)
    }

    fun dlnaControl(controlUrl: String, action: String): JSONObject {
        if (!isPrivateLanUrl(controlUrl)) {
            throw SecurityException("Blocked non-LAN DLNA control URL.")
        }
        val (soapAction, innerXml) = when (action.lowercase(Locale.ROOT)) {
            "play" -> "Play" to "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"
            "pause" -> "Pause" to "<u:Pause xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:Pause>"
            "stop" -> "Stop" to "<u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:Stop>"
            else -> throw IllegalArgumentException("Unsupported DLNA control action: $action")
        }
        val envelope = """<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>$innerXml</s:Body></s:Envelope>"""
        val res = sendLanHttpRequest(
            method = "POST",
            urlStr = controlUrl,
            headers = mapOf(
                "Content-Type" to "text/xml; charset=\"utf-8\"",
                "SOAPACTION" to "\"urn:schemas-upnp-org:service:AVTransport:1#$soapAction\""
            ),
            bodyBytes = envelope.toByteArray(Charsets.UTF_8)
        )
        if (res.statusCode !in 200..299) {
            throw IllegalStateException("DLNA $soapAction failed (HTTP ${res.statusCode}).")
        }
        return JSONObject().put("ok", true)
    }

    // -------------------------------------------------------------------------
    // Embedded LAN HTTP Range & Receiver Server
    // -------------------------------------------------------------------------

    private fun acceptLoop(ss: ServerSocket) {
        while (running.get() && !ss.isClosed) {
            try {
                val client = ss.accept()
                client.soTimeout = 15000
                clientPool.execute { handleClient(client) }
            } catch (_: Exception) {
                if (!running.get()) break
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { sock ->
            try {
                val input = BufferedInputStream(sock.getInputStream())
                val output = BufferedOutputStream(sock.getOutputStream())
                val requestLine = readLineCrLf(input) ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0].uppercase(Locale.ROOT)
                val rawTarget = parts[1]

                var rangeHeader: String? = null
                while (true) {
                    val line = readLineCrLf(input) ?: break
                    if (line.isEmpty()) break
                    val idx = line.indexOf(':')
                    if (idx > 0) {
                        val key = line.substring(0, idx).trim().lowercase(Locale.ROOT)
                        if (key == "range") {
                            rangeHeader = line.substring(idx + 1).trim()
                        }
                    }
                }

                if (method != "GET" && method != "HEAD") {
                    sendSimpleError(output, 405, "Method Not Allowed")
                    return
                }

                val qIdx = rawTarget.indexOf('?')
                val path = if (qIdx >= 0) rawTarget.substring(0, qIdx) else rawTarget
                val query = if (qIdx >= 0) rawTarget.substring(qIdx + 1) else ""
                val token = extractQueryParam(query, "token")
                if (!constantTimeEquals(token, sessionToken)) {
                    sendSimpleError(output, 403, "Forbidden")
                    return
                }

                when (path) {
                    "/media" -> serveMedia(output, method, rangeHeader)
                    "/subtitle.vtt" -> serveSubtitle(output, method)
                    "/receiver" -> serveReceiverHtml(output, method)
                    else -> sendSimpleError(output, 404, "Not Found")
                }
            } catch (_: Exception) {
                // Client disconnected mid-stream
            }
        }
    }

    private fun serveMedia(output: OutputStream, method: String, rangeHeader: String?) {
        val path = activeMediaPath
        if (path.isEmpty()) {
            sendSimpleError(output, 404, "No Active Media")
            return
        }

        if (path.startsWith("content://")) {
            val uri = Uri.parse(path)
            val mime = context.contentResolver.getType(uri) ?: guessMimeFromName(activeTitle)
            val afd = try {
                context.contentResolver.openAssetFileDescriptor(uri, "r")
            } catch (_: Exception) {
                null
            }
            if (afd == null) {
                sendSimpleError(output, 404, "Media Unavailable")
                return
            }
            afd.use { descriptor ->
                val totalLength = descriptor.length
                val fis = descriptor.createInputStream()
                fis.use { stream ->
                    streamRangeResponse(output, method, rangeHeader, mime, totalLength, stream)
                }
            }
        } else {
            val file = File(path)
            if (!file.exists() || !file.isFile) {
                sendSimpleError(output, 404, "File Not Found")
                return
            }
            val mime = guessMimeFromName(file.name)
            FileInputStream(file).use { fis ->
                streamRangeResponse(output, method, rangeHeader, mime, file.length(), fis)
            }
        }
    }

    private fun streamRangeResponse(
        output: OutputStream,
        method: String,
        rangeHeader: String?,
        mime: String,
        totalLength: Long,
        fis: FileInputStream
    ) {
        if (totalLength <= 0L) {
            val headers = buildString {
                append("HTTP/1.1 200 OK\r\n")
                append("Content-Type: ").append(mime).append("\r\n")
                append("Access-Control-Allow-Origin: *\r\n")
                append("Connection: close\r\n\r\n")
            }
            output.write(headers.toByteArray(Charsets.US_ASCII))
            if (method != "HEAD") {
                val buf = ByteArray(65536)
                while (true) {
                    val read = fis.read(buf)
                    if (read <= 0) break
                    output.write(buf, 0, read)
                }
            }
            output.flush()
            return
        }

        var start = 0L
        var end = totalLength - 1L
        var isPartial = false

        if (!rangeHeader.isNullOrBlank() && rangeHeader.startsWith("bytes=", ignoreCase = true)) {
            val spec = rangeHeader.substring(6).split(",")[0].trim()
            val dash = spec.indexOf('-')
            if (dash >= 0) {
                val startPart = spec.substring(0, dash).trim()
                val endPart = spec.substring(dash + 1).trim()
                if (startPart.isEmpty() && endPart.isNotEmpty()) {
                    val suffix = endPart.toLongOrNull() ?: 0L
                    start = (totalLength - suffix).coerceAtLeast(0L)
                    end = totalLength - 1L
                    isPartial = true
                } else {
                    val parsedStart = startPart.toLongOrNull()
                    if (parsedStart != null) {
                        start = parsedStart
                        end = endPart.toLongOrNull()?.coerceAtMost(totalLength - 1L) ?: (totalLength - 1L)
                        isPartial = true
                    }
                }
            }
        }

        if (start < 0L || start >= totalLength || start > end) {
            val resp = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$totalLength\r\nConnection: close\r\n\r\n"
            output.write(resp.toByteArray(Charsets.US_ASCII))
            output.flush()
            return
        }

        val contentLen = end - start + 1L
        val statusLine = if (isPartial) "HTTP/1.1 206 Partial Content" else "HTTP/1.1 200 OK"
        val headers = buildString {
            append(statusLine).append("\r\n")
            append("Content-Type: ").append(mime).append("\r\n")
            append("Accept-Ranges: bytes\r\n")
            append("Content-Length: ").append(contentLen).append("\r\n")
            if (isPartial) {
                append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(totalLength).append("\r\n")
            }
            append("Access-Control-Allow-Origin: *\r\n")
            append("transferMode.dlna.org: Streaming\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))

        if (method != "HEAD") {
            try {
                fis.channel.position(start)
            } catch (_: Exception) {
                var skipped = 0L
                while (skipped < start) {
                    val s = fis.skip(start - skipped)
                    if (s <= 0L) break
                    skipped += s
                }
            }
            val buf = ByteArray(65536)
            var remaining = contentLen
            while (remaining > 0L) {
                val toRead = minOf(buf.size.toLong(), remaining).toInt()
                val read = fis.read(buf, 0, toRead)
                if (read <= 0) break
                output.write(buf, 0, read)
                remaining -= read
            }
        }
        output.flush()
    }

    private fun serveSubtitle(output: OutputStream, method: String) {
        val vtt = activeSubtitleVtt
        if (vtt.isNullOrBlank()) {
            sendSimpleError(output, 404, "No Subtitle")
            return
        }
        val bytes = vtt.toByteArray(Charsets.UTF_8)
        val headers = buildString {
            append("HTTP/1.1 200 OK\r\n")
            append("Content-Type: text/vtt; charset=utf-8\r\n")
            append("Content-Length: ").append(bytes.size).append("\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))
        if (method != "HEAD") output.write(bytes)
        output.flush()
    }

    private fun serveReceiverHtml(output: OutputStream, method: String) {
        val encodedToken = URLEncoder.encode(sessionToken, "UTF-8")
        val safeTitle = escapeHtml(activeTitle)
        val trackTag = if (!activeSubtitleVtt.isNullOrBlank()) {
            """<track kind="subtitles" srclang="ar" label="Subtitles" src="/subtitle.vtt?token=$encodedToken" default />"""
        } else {
            ""
        }
        val html = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>$safeTitle — AAZ Player Wi-Fi Receiver</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#060b08;color:#eef7f1;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
  .bar{width:100%;max-width:1200px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;color:#3dc479}
  .title{font-size:14px;color:#cfe2d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  video{width:100%;max-width:1200px;max-height:82vh;background:#000;border-radius:12px;border:1px solid #1e3b2a;outline:none}
</style>
</head>
<body>
  <div class="bar">
    <div class="brand">AAZ Player · Wi-Fi Cast</div>
    <div class="title">$safeTitle</div>
  </div>
  <video controls autoplay playsinline src="/media?token=$encodedToken">$trackTag</video>
</body>
</html>"""
        val bytes = html.toByteArray(Charsets.UTF_8)
        val headers = buildString {
            append("HTTP/1.1 200 OK\r\n")
            append("Content-Type: text/html; charset=utf-8\r\n")
            append("Content-Length: ").append(bytes.size).append("\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))
        if (method != "HEAD") output.write(bytes)
        output.flush()
    }

    // -------------------------------------------------------------------------
    // LAN-Only HTTP/1.1 Client & DLNA XML Parser (Strict RFC1918 SSRF Guard)
    // -------------------------------------------------------------------------

    private data class LanHttpResponse(val statusCode: Int, val body: String)

    private fun fetchDeviceDescription(locationUrl: String): JSONObject? {
        if (!isPrivateLanUrl(locationUrl)) return null
        return try {
            val res = sendLanHttpRequest("GET", locationUrl, emptyMap(), null)
            if (res.statusCode !in 200..299 || res.body.isBlank()) return null
            val xml = res.body
            val controlRel = extractAvTransportControlUrl(xml) ?: return null
            val resolvedControl = URI(locationUrl).resolve(controlRel).toString()
            if (!isPrivateLanUrl(resolvedControl)) return null

            val friendlyName = extractXmlTag(xml, "friendlyName") ?: "Smart TV"
            val manufacturer = extractXmlTag(xml, "manufacturer") ?: ""
            val udn = extractXmlTag(xml, "UDN") ?: resolvedControl

            JSONObject().apply {
                put("id", udn)
                put("name", friendlyName)
                put("manufacturer", manufacturer)
                put("controlUrl", resolvedControl)
                put("location", locationUrl)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun sendLanHttpRequest(
        method: String,
        urlStr: String,
        headers: Map<String, String>,
        bodyBytes: ByteArray?
    ): LanHttpResponse {
        val uri = URI(urlStr)
        val host = uri.host ?: throw SecurityException("Missing host")
        if (!isPrivateLanIp(host)) {
            throw SecurityException("Non-LAN host blocked: $host")
        }
        val port = if (uri.port > 0) uri.port else 80
        val pathAndQuery = buildString {
            append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
            if (!uri.rawQuery.isNullOrEmpty()) {
                append('?').append(uri.rawQuery)
            }
        }

        Socket().use { sock ->
            sock.connect(InetSocketAddress(InetAddress.getByName(host), port), 3500)
            sock.soTimeout = 5000
            val out = sock.getOutputStream()
            val req = StringBuilder()
            req.append(method).append(' ').append(pathAndQuery).append(" HTTP/1.1\r\n")
            req.append("Host: ").append(host).append(':').append(port).append("\r\n")
            req.append("User-Agent: AAZPlayer/1.7 UPnP/1.1\r\n")
            req.append("Connection: close\r\n")
            if (bodyBytes != null) {
                req.append("Content-Length: ").append(bodyBytes.size).append("\r\n")
            }
            for ((k, v) in headers) {
                req.append(k).append(": ").append(v).append("\r\n")
            }
            req.append("\r\n")
            out.write(req.toString().toByteArray(Charsets.UTF_8))
            if (bodyBytes != null) out.write(bodyBytes)
            out.flush()

            val input = BufferedInputStream(sock.getInputStream())
            val statusLine = readLineCrLf(input) ?: return LanHttpResponse(0, "")
            val statusCode = statusLine.split(" ").getOrNull(1)?.toIntOrNull() ?: 0
            var isChunked = false
            while (true) {
                val line = readLineCrLf(input) ?: break
                if (line.isEmpty()) break
                if (line.lowercase(Locale.ROOT).startsWith("transfer-encoding:") &&
                    line.lowercase(Locale.ROOT).contains("chunked")
                ) {
                    isChunked = true
                }
            }
            val rawBody = readBoundedBytes(input, 512 * 1024)
            val bodyStr = if (isChunked) decodeChunked(rawBody) else String(rawBody, Charsets.UTF_8)
            return LanHttpResponse(statusCode, bodyStr)
        }
    }

    private fun extractAvTransportControlUrl(xml: String): String? {
        val serviceRegex = Regex("<service\\b[^>]*>(.*?)</service>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
        for (match in serviceRegex.findAll(xml)) {
            val block = match.groupValues[1]
            if (block.contains("AVTransport", ignoreCase = true)) {
                val ctrl = extractXmlTag(block, "controlURL")
                if (!ctrl.isNullOrBlank()) return ctrl.trim()
            }
        }
        return null
    }

    private fun extractXmlTag(xml: String, tagName: String): String? {
        val regex = Regex("<(?:[A-Za-z0-9_]+:)?$tagName\\b[^>]*>(.*?)</(?:[A-Za-z0-9_]+:)?$tagName>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
        val raw = regex.find(xml)?.groupValues?.getOrNull(1)?.trim() ?: return null
        return raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
    }

    private fun isPrivateLanUrl(urlStr: String): Boolean {
        return try {
            val uri = URI(urlStr)
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
            if (scheme != "http") return false
            val host = uri.host ?: return false
            isPrivateLanIp(host)
        } catch (_: Exception) {
            false
        }
    }

    private fun isPrivateLanIp(host: String): Boolean {
        val parts = host.split(".")
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        if (octets.any { it !in 0..255 }) return false
        val a = octets[0]
        val b = octets[1]
        return when {
            a == 10 -> true
            a == 172 && b in 16..31 -> true
            a == 192 && b == 168 -> true
            a == 169 && b == 254 -> true
            else -> false
        }
    }

    private fun findLocalLanIpv4(): String? {
        var fallback: String? = null
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            for (iface in interfaces) {
                if (!iface.isUp || iface.isLoopback || iface.isVirtual) continue
                val name = iface.name.lowercase(Locale.ROOT)
                val addrs = iface.inetAddresses
                for (addr in addrs) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val ip = addr.hostAddress ?: continue
                        if (!isPrivateLanIp(ip)) continue
                        if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap")) {
                            return ip
                        }
                        if (fallback == null) fallback = ip
                    }
                }
            }
        } catch (_: Exception) {
        }
        return fallback
    }

    private fun sendSimpleError(output: OutputStream, code: Int, message: String) {
        val body = message.toByteArray(Charsets.UTF_8)
        val headers = "HTTP/1.1 $code $message\r\nContent-Type: text/plain\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
        output.write(headers.toByteArray(Charsets.US_ASCII))
        output.write(body)
        output.flush()
    }

    private fun readLineCrLf(input: InputStream): String? {
        val sb = StringBuilder()
        var b = input.read()
        if (b == -1) return null
        while (b != -1) {
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
            if (sb.length > 8192) break
            b = input.read()
        }
        return sb.toString()
    }

    private fun readBoundedBytes(input: InputStream, maxBytes: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (total < maxBytes) {
            val read = input.read(buf, 0, minOf(buf.size, maxBytes - total))
            if (read <= 0) break
            out.write(buf, 0, read)
            total += read
        }
        return out.toByteArray()
    }

    private fun decodeChunked(raw: ByteArray): String {
        val text = String(raw, Charsets.UTF_8)
        val out = StringBuilder()
        var idx = 0
        while (idx < text.length) {
            val lineEnd = text.indexOf("\r\n", idx)
            if (lineEnd < 0) break
            val sizeHex = text.substring(idx, lineEnd).substringBefore(';').trim()
            val size = sizeHex.toIntOrNull(16) ?: break
            if (size == 0) break
            val dataStart = lineEnd + 2
            val dataEnd = (dataStart + size).coerceAtMost(text.length)
            out.append(text, dataStart, dataEnd)
            idx = (dataEnd + 2).coerceAtMost(text.length)
        }
        return out.toString()
    }

    private fun extractHeaderValue(rawHeaders: String, name: String): String? {
        for (line in rawHeaders.split("\r\n", "\n")) {
            val idx = line.indexOf(':')
            if (idx > 0 && line.substring(0, idx).trim().equals(name, ignoreCase = true)) {
                return line.substring(idx + 1).trim()
            }
        }
        return null
    }

    private fun extractQueryParam(query: String, key: String): String {
        for (pair in query.split("&")) {
            val eq = pair.indexOf('=')
            if (eq > 0 && pair.substring(0, eq) == key) {
                return try {
                    URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
                } catch (_: Exception) {
                    pair.substring(eq + 1)
                }
            }
        }
        return ""
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        return MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
    }

    private fun generateHexToken(numBytes: Int): String {
        val bytes = ByteArray(numBytes)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun escapeXml(s: String): String = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")

    private fun escapeHtml(s: String): String = escapeXml(s)

    private fun guessMimeFromName(name: String): String {
        return when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "mp4", "m4v" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "avi" -> "video/x-msvideo"
            "mp3" -> "audio/mpeg"
            "flac" -> "audio/flac"
            "wav" -> "audio/wav"
            "m4a", "aac" -> "audio/mp4"
            "ogg", "opus" -> "audio/ogg"
            else -> "application/octet-stream"
        }
    }
}
