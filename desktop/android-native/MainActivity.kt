package com.aaz.player

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
    private lateinit var contentServer: AazContentServer
    private lateinit var mediaHelper: AazMediaHelper
    private val ioExecutor = Executors.newSingleThreadExecutor()

    @Volatile
    private var activeWebView: WebView? = null
    private var mediaSession: MediaSession? = null

    private val pendingLaunchUris = ArrayList<String>()
    private var pendingFilesCallbackId: String? = null
    private var pendingFolderCallbackId: String? = null
    private var pendingSaveTextCallbackId: String? = null
    private var pendingSaveTextContent: String? = null
    private var pendingScanCallbackId: String? = null

    private lateinit var openFilesLauncher: ActivityResultLauncher<Intent>
    private lateinit var openFolderLauncher: ActivityResultLauncher<Intent>
    private lateinit var createDocLauncher: ActivityResultLauncher<Intent>
    private lateinit var mediaPermLauncher: ActivityResultLauncher<Array<String>>

    override fun onCreate(savedInstanceState: Bundle?) {
        contentServer = AazContentServer(applicationContext)
        contentServer.start()
        mediaHelper = AazMediaHelper(applicationContext, contentServer)

        openFilesLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cbId = pendingFilesCallbackId
            pendingFilesCallbackId = null
            if (cbId == null) return@registerForActivityResult
            val data = result.data
            if (result.resultCode != RESULT_OK || data == null) {
                resolveJsCallback(cbId, "null")
                return@registerForActivityResult
            }
            val uris = extractUrisFromIntent(data)
            persistReadPermissions(uris)
            ioExecutor.execute {
                val payload = mediaHelper.inspectContentUris(uris)
                resolveJsCallback(cbId, payload.toString())
            }
        }

        openFolderLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cbId = pendingFolderCallbackId
            pendingFolderCallbackId = null
            if (cbId == null) return@registerForActivityResult
            val treeUri = if (result.resultCode == RESULT_OK) result.data?.data else null
            if (treeUri == null) {
                resolveJsCallback(cbId, "null")
                return@registerForActivityResult
            }
            try {
                contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
            ioExecutor.execute {
                val payload = mediaHelper.scanSafTree(treeUri)
                resolveJsCallback(cbId, payload.toString())
            }
        }

        createDocLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cbId = pendingSaveTextCallbackId
            val content = pendingSaveTextContent
            pendingSaveTextCallbackId = null
            pendingSaveTextContent = null
            if (cbId == null) return@registerForActivityResult
            val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
            if (uri == null || content == null) {
                resolveJsCallback(cbId, JSONObject().put("saved", false).put("canceled", true).toString())
                return@registerForActivityResult
            }
            ioExecutor.execute {
                val res = try {
                    contentResolver.openOutputStream(uri, "wt")?.use { out ->
                        out.write(content.toByteArray(Charsets.UTF_8))
                    }
                    JSONObject().put("saved", true).put("uri", uri.toString())
                } catch (e: Exception) {
                    JSONObject().put("saved", false).put("error", e.message ?: "Write error")
                }
                resolveJsCallback(cbId, res.toString())
            }
        }

        mediaPermLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val cbId = pendingScanCallbackId
            pendingScanCallbackId = null
            if (cbId == null) return@registerForActivityResult
            val granted = grants.values.any { it }
            if (!granted) {
                resolveJsCallback(cbId, JSONObject().put("permissionDenied", true).toString())
                return@registerForActivityResult
            }
            ioExecutor.execute {
                val payload = mediaHelper.scanDeviceMediaStore()
                resolveJsCallback(cbId, payload.toString())
            }
        }

        super.onCreate(savedInstanceState)

        applyDarkSystemBars()
        setupMediaSession()
        collectIncomingIntent(intent, deliverImmediately = false)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = activeWebView
                if (wv == null) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    return
                }
                wv.evaluateJavascript("(function(){ return window.__aazHandleAndroidBack ? Boolean(window.__aazHandleAndroidBack()) : false; })()") { res ->
                    if (res != "true") {
                        runOnUiThread {
                            isEnabled = false
                            onBackPressedDispatcher.onBackPressed()
                            isEnabled = true
                        }
                    }
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        activeWebView = webView
        webView.setBackgroundColor(Color.parseColor("#060b08"))
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.domStorageEnabled = true
        webView.addJavascriptInterface(AazAndroidBridge(), "AAZAndroid")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        collectIncomingIntent(intent, deliverImmediately = true)
    }

    override fun onDestroy() {
        try {
            mediaSession?.isActive = false
            mediaSession?.release()
        } catch (_: Exception) {
        }
        contentServer.stop()
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun applyDarkSystemBars() {
        try {
            @Suppress("DEPRECATION")
            window.statusBarColor = Color.parseColor("#060b08")
            @Suppress("DEPRECATION")
            window.navigationBarColor = Color.parseColor("#060b08")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.insetsController?.setSystemBarsAppearance(
                    0,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                        WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                )
            }
        } catch (_: Exception) {
        }
    }

    private fun setupMediaSession() {
        try {
            val session = MediaSession(this, "AAZPlayerSession")
            session.setCallback(object : MediaSession.Callback() {
                override fun onPlay() = emitJsEvent("media-action", JSONObject().put("action", "play"))
                override fun onPause() = emitJsEvent("media-action", JSONObject().put("action", "pause"))
                override fun onSkipToNext() = emitJsEvent("media-action", JSONObject().put("action", "next"))
                override fun onSkipToPrevious() = emitJsEvent("media-action", JSONObject().put("action", "prev"))
                override fun onStop() = emitJsEvent("media-action", JSONObject().put("action", "pause"))
            })
            session.isActive = true
            mediaSession = session
        } catch (_: Exception) {
        }
    }

    private fun collectIncomingIntent(intent: Intent?, deliverImmediately: Boolean) {
        if (intent == null) return
        val action = intent.action ?: return
        val uris = ArrayList<Uri>()
        when (action) {
            Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val extra = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (extra != null) uris.add(extra)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                if (list != null) uris.addAll(list)
            }
        }
        if (uris.isEmpty()) return
        persistReadPermissions(uris)
        val uriStrings = uris.map { it.toString() }
        if (deliverImmediately && activeWebView != null) {
            val arr = JSONArray()
            uriStrings.forEach { arr.put(it) }
            emitJsEvent("open-external", arr)
        } else {
            synchronized(pendingLaunchUris) {
                pendingLaunchUris.addAll(uriStrings)
            }
        }
    }

    private fun extractUrisFromIntent(data: Intent): List<Uri> {
        val result = ArrayList<Uri>()
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { result.add(it) }
            }
        } else {
            data.data?.let { result.add(it) }
        }
        return result
    }

    private fun persistReadPermissions(uris: List<Uri>) {
        for (uri in uris) {
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
        }
    }

    private fun resolveJsCallback(callbackId: String, jsonLiteral: String) {
        val wv = activeWebView ?: return
        val safeId = JSONObject.quote(callbackId)
        runOnUiThread {
            wv.evaluateJavascript(
                "window.__aazResolveAndroidCallback && window.__aazResolveAndroidCallback($safeId, $jsonLiteral);",
                null
            )
        }
    }

    private fun emitJsEvent(name: String, payload: Any) {
        val wv = activeWebView ?: return
        val safeName = JSONObject.quote(name)
        val payloadJson = payload.toString()
        runOnUiThread {
            wv.evaluateJavascript(
                "window.__aazOnAndroidEvent && window.__aazOnAndroidEvent($safeName, $payloadJson);",
                null
            )
        }
    }

    private fun requiredMediaPermissions(): Array<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasMediaPermissions(): Boolean {
        return requiredMediaPermissions().any { perm ->
            ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
        }
    }

    inner class AazAndroidBridge {
        @JavascriptInterface
        fun isAvailable(): Boolean = true

        @JavascriptInterface
        fun getLaunchFilesJson(): String {
            val arr = JSONArray()
            synchronized(pendingLaunchUris) {
                pendingLaunchUris.forEach { arr.put(it) }
                pendingLaunchUris.clear()
            }
            return arr.toString()
        }

        @JavascriptInterface
        fun selectFiles(callbackId: String) {
            runOnUiThread {
                pendingFilesCallbackId = callbackId
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf("audio/*", "video/*", "application/x-subrip", "text/vtt", "application/xspf+xml", "audio/x-mpegurl", "text/plain")
                    )
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }
                try {
                    openFilesLauncher.launch(intent)
                } catch (_: Exception) {
                    pendingFilesCallbackId = null
                    resolveJsCallback(callbackId, "null")
                }
            }
        }

        @JavascriptInterface
        fun selectFolder(callbackId: String) {
            runOnUiThread {
                pendingFolderCallbackId = callbackId
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                    )
                }
                try {
                    openFolderLauncher.launch(intent)
                } catch (_: Exception) {
                    pendingFolderCallbackId = null
                    resolveJsCallback(callbackId, "null")
                }
            }
        }

        @JavascriptInterface
        fun readFolder(callbackId: String, treeUriStr: String) {
            ioExecutor.execute {
                val res = if (treeUriStr.startsWith("content://")) {
                    mediaHelper.scanSafTree(Uri.parse(treeUriStr)).toString()
                } else {
                    "null"
                }
                resolveJsCallback(callbackId, res)
            }
        }

        @JavascriptInterface
        fun inspectPaths(callbackId: String, pathsJson: String) {
            ioExecutor.execute {
                val uris = ArrayList<Uri>()
                try {
                    val arr = JSONArray(pathsJson)
                    for (i in 0 until arr.length()) {
                        val s = arr.optString(i, "")
                        if (s.startsWith("content://")) uris.add(Uri.parse(s))
                    }
                } catch (_: Exception) {
                }
                val payload = mediaHelper.inspectContentUris(uris)
                resolveJsCallback(callbackId, payload.toString())
            }
        }

        @JavascriptInterface
        fun scanDeviceMedia(callbackId: String) {
            runOnUiThread {
                if (hasMediaPermissions()) {
                    ioExecutor.execute {
                        val payload = mediaHelper.scanDeviceMediaStore()
                        resolveJsCallback(callbackId, payload.toString())
                    }
                } else {
                    pendingScanCallbackId = callbackId
                    mediaPermLauncher.launch(requiredMediaPermissions())
                }
            }
        }

        @JavascriptInterface
        fun readTextFile(callbackId: String, uriStr: String) {
            ioExecutor.execute {
                val text = if (uriStr.startsWith("content://")) {
                    mediaHelper.readTextFromUri(Uri.parse(uriStr))
                } else {
                    null
                }
                val literal = if (text != null) JSONObject.quote(text) else "null"
                resolveJsCallback(callbackId, literal)
            }
        }

        @JavascriptInterface
        fun findNearbySubtitle(callbackId: String, videoUriStr: String, preferredLang: String, uiLang: String) {
            ioExecutor.execute {
                val found = mediaHelper.findNearbySubtitle(videoUriStr, preferredLang, uiLang)
                resolveJsCallback(callbackId, found?.toString() ?: "null")
            }
        }

        @JavascriptInterface
        fun saveTextFile(callbackId: String, filename: String, content: String, mimeType: String) {
            runOnUiThread {
                pendingSaveTextCallbackId = callbackId
                pendingSaveTextContent = content
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mimeType.ifBlank { "text/plain" }
                    putExtra(Intent.EXTRA_TITLE, filename.ifBlank { "aaz-playlist.m3u8" })
                }
                try {
                    createDocLauncher.launch(intent)
                } catch (_: Exception) {
                    pendingSaveTextCallbackId = null
                    pendingSaveTextContent = null
                    resolveJsCallback(callbackId, JSONObject().put("saved", false).toString())
                }
            }
        }

        @JavascriptInterface
        fun saveSnapshot(callbackId: String, dataBase64: String, suggestedName: String) {
            ioExecutor.execute {
                val res = mediaHelper.saveSnapshotPng(dataBase64, suggestedName)
                resolveJsCallback(callbackId, res.toString())
            }
        }

        @JavascriptInterface
        fun setBrightness(level: Float) {
            runOnUiThread {
                val lp = window.attributes
                lp.screenBrightness = level.coerceIn(0.05f, 1.0f)
                window.attributes = lp
            }
        }

        @JavascriptInterface
        fun setOrientation(mode: String) {
            runOnUiThread {
                requestedOrientation = when (mode) {
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
            }
        }

        @JavascriptInterface
        fun setImmersiveFullscreen(enabled: Boolean) {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val controller = window.insetsController ?: return@runOnUiThread
                    if (enabled) {
                        controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                        controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    } else {
                        controller.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                    }
                } else {
                    @Suppress("DEPRECATION")
                    window.decorView.systemUiVisibility = if (enabled) {
                        (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            or View.SYSTEM_UI_FLAG_FULLSCREEN
                            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
                    } else {
                        View.SYSTEM_UI_FLAG_VISIBLE
                    }
                }
            }
        }

        @JavascriptInterface
        fun enterPictureInPicture(): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
            return try {
                runOnUiThread {
                    val params = PictureInPictureParams.Builder()
                        .setAspectRatio(Rational(16, 9))
                        .build()
                    enterPictureInPictureMode(params)
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun updateMediaSession(title: String, artist: String, isPlaying: Boolean, positionMs: Long, durationMs: Long) {
            val session = mediaSession ?: return
            runOnUiThread {
                try {
                    val meta = MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { "AAZ Player" })
                        .putString(MediaMetadata.METADATA_KEY_ARTIST, artist.ifBlank { "AAZ Player" })
                        .apply {
                            if (durationMs > 0L) putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                        }
                        .build()
                    session.setMetadata(meta)

                    val actions = PlaybackState.ACTION_PLAY or
                        PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or
                        PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    val pbState = PlaybackState.Builder()
                        .setActions(actions)
                        .setState(
                            if (isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                            positionMs.coerceAtLeast(0L),
                            if (isPlaying) 1.0f else 0.0f
                        )
                        .build()
                    session.setPlaybackState(pbState)
                } catch (_: Exception) {
                }
            }
        }
    }
}
