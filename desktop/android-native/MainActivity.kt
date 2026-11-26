package com.aaz.player

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.OrientationEventListener
import android.view.Surface
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
    private lateinit var castHelper: AazCastHelper
    private lateinit var updater: AazUpdater
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val netExecutor = Executors.newCachedThreadPool()

    @Volatile
    private var activeWebView: WebView? = null

    @Volatile
    private var isVideoActive = false

    @Volatile
    private var isPlaybackActive = false

    @Volatile
    private var orientationLocked = false

    @Volatile
    private var currentForcedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    private var orientationListener: OrientationEventListener? = null
    private var pendingSensorTarget = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var pendingSensorSinceMs = 0L
    private var askedNotificationPermission = false

    private val pendingLaunchUris = ArrayList<String>()
    private var pendingFilesCallbackId: String? = null
    private var pendingFolderCallbackId: String? = null
    private var pendingFolderShallow: Boolean = false
    private var pendingSaveTextCallbackId: String? = null
    private var pendingSaveTextContent: String? = null
    private var pendingScanCallbackId: String? = null

    private lateinit var openFilesLauncher: ActivityResultLauncher<Intent>
    private lateinit var openFolderLauncher: ActivityResultLauncher<Intent>
    private lateinit var createDocLauncher: ActivityResultLauncher<Intent>
    private lateinit var mediaPermLauncher: ActivityResultLauncher<Array<String>>
    private lateinit var notifPermLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        contentServer = AazContentServer(applicationContext)
        contentServer.start()
        mediaHelper = AazMediaHelper(applicationContext, contentServer)
        castHelper = AazCastHelper(applicationContext)
        updater = AazUpdater(this) { payload ->
            emitJsEvent("update-status", payload)
        }

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
            val shallow = pendingFolderShallow
            pendingFolderShallow = false
            if (cbId == null) return@registerForActivityResult
            val treeUri = if (result.resultCode == RESULT_OK) result.data?.data else null
            if (treeUri == null) {
                resolveJsCallback(cbId, "null")
                return@registerForActivityResult
            }
            // Persisted grant so the folder survives app restarts.
            try {
                contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
            ioExecutor.execute {
                // Shallow grants skip the recursive scan: the hierarchical
                // library browser lists one level at a time instead.
                val payload = if (shallow) mediaHelper.describeSafTree(treeUri) else mediaHelper.scanSafTree(treeUri)
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

        notifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
            // Playback works whether or not notification permission is granted
        }

        super.onCreate(savedInstanceState)

        applyDarkSystemBars()
        setupSensorOrientationListener()
        AazPlaybackService.actionDispatch = { action ->
            emitJsEvent("media-action", JSONObject.quote(action))
        }
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

    override fun onResume() {
        super.onResume()
        try {
            orientationListener?.enable()
        } catch (_: Exception) {
        }
    }

    override fun onPause() {
        try {
            orientationListener?.disable()
        } catch (_: Exception) {
        }
        super.onPause()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Auto-enter Picture-in-Picture when user leaves app while video is actively playing (API 26+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isVideoActive && isPlaybackActive) {
            try {
                val params = PictureInPictureParams.Builder()
                    .setAspectRatio(Rational(16, 9))
                    .build()
                enterPictureInPictureMode(params)
            } catch (_: Exception) {
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        emitJsEvent("pip-change", if (isInPictureInPictureMode) "true" else "false")
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
            orientationListener?.disable()
        } catch (_: Exception) {
        }
        AazPlaybackService.actionDispatch = null
        try {
            stopService(Intent(this, AazPlaybackService::class.java))
        } catch (_: Exception) {
        }
        castHelper.shutdown()
        contentServer.stop()
        ioExecutor.shutdownNow()
        netExecutor.shutdownNow()
        super.onDestroy()
    }

    /**
     * VLC-style physical orientation sensor listener:
     * Forces portrait/landscape rotation when tilting the phone during video playback EVEN IF
     * Android's system Auto-Rotate is turned OFF — unless the user taps the Rotation Lock button.
     */
    private fun setupSensorOrientationListener() {
        orientationListener = object : OrientationEventListener(this, SensorManager.SENSOR_DELAY_NORMAL) {
            override fun onOrientationChanged(orientation: Int) {
                if (orientation == ORIENTATION_UNKNOWN) return
                if (!isVideoActive || orientationLocked) return

                val desired = when {
                    orientation in 65..115 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
                    orientation in 245..295 -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                    orientation <= 25 || orientation >= 335 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    else -> return
                }

                if (desired == currentForcedOrientation) {
                    pendingSensorTarget = desired
                    pendingSensorSinceMs = 0L
                    return
                }

                val now = System.currentTimeMillis()
                if (pendingSensorTarget != desired) {
                    pendingSensorTarget = desired
                    pendingSensorSinceMs = now
                    return
                }
                if (now - pendingSensorSinceMs < 320L) return

                currentForcedOrientation = desired
                pendingSensorSinceMs = 0L
                runOnUiThread {
                    requestedOrientation = desired
                    emitOrientationEvent()
                }
            }
        }
    }

    private fun resolveCurrentScreenOrientationConstant(): Int {
        val rotation = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                display?.rotation ?: Surface.ROTATION_0
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay.rotation
            }
        } catch (_: Exception) {
            Surface.ROTATION_0
        }
        val isLand = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        return when {
            isLand && rotation == Surface.ROTATION_270 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            isLand -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    private fun emitOrientationEvent() {
        val isLand = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE ||
            currentForcedOrientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE ||
            currentForcedOrientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
        val payload = JSONObject()
            .put("locked", orientationLocked)
            .put("landscape", isLand)
        emitJsEvent("orientation-change", payload)
    }

    private fun applyDarkSystemBars() {
        applySystemBarStyle("#060b08", false)
    }

    private fun applySystemBarStyle(bgHex: String, isLight: Boolean) {
        val parsedColor = try {
            Color.parseColor(bgHex.trim())
        } catch (_: Exception) {
            Color.parseColor(if (isLight) "#f2f7f3" else "#060b08")
        }
        runOnUiThread {
            try {
                @Suppress("DEPRECATION")
                window.statusBarColor = parsedColor
                @Suppress("DEPRECATION")
                window.navigationBarColor = parsedColor
                activeWebView?.setBackgroundColor(parsedColor)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val lightMask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                        WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                    window.insetsController?.setSystemBarsAppearance(
                        if (isLight) lightMask else 0,
                        lightMask
                    )
                } else {
                    @Suppress("DEPRECATION")
                    var flags = window.decorView.systemUiVisibility
                    @Suppress("DEPRECATION")
                    flags = if (isLight) {
                        flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    } else {
                        flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        @Suppress("DEPRECATION")
                        flags = if (isLight) {
                            flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                        } else {
                            flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                        }
                    }
                    @Suppress("DEPRECATION")
                    window.decorView.systemUiVisibility = flags
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun maybeRequestNotificationPermission() {
        if (askedNotificationPermission) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        askedNotificationPermission = true
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            runOnUiThread {
                try {
                    notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                } catch (_: Exception) {
                }
            }
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
        fun selectFolder(callbackId: String) = launchFolderPicker(callbackId, shallow = false)

        @JavascriptInterface
        fun selectFolderShallow(callbackId: String) = launchFolderPicker(callbackId, shallow = true)

        private fun launchFolderPicker(callbackId: String, shallow: Boolean) {
            runOnUiThread {
                pendingFolderCallbackId = callbackId
                pendingFolderShallow = shallow
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
                    pendingFolderShallow = false
                    resolveJsCallback(callbackId, "null")
                }
            }
        }

        @JavascriptInterface
        fun listSafChildren(callbackId: String, treeUriStr: String, parentDocId: String) {
            ioExecutor.execute {
                val res = if (treeUriStr.startsWith("content://")) {
                    mediaHelper.listSafChildren(Uri.parse(treeUriStr), parentDocId).toString()
                } else {
                    "null"
                }
                resolveJsCallback(callbackId, res)
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
        fun setVideoMode(active: Boolean) {
            isVideoActive = active
            if (!active && !orientationLocked && currentForcedOrientation != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) {
                currentForcedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                runOnUiThread {
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    emitOrientationEvent()
                }
            }
        }

        @JavascriptInterface
        fun toggleOrientationLock(): Boolean {
            val nextLocked = !orientationLocked
            orientationLocked = nextLocked
            runOnUiThread {
                if (nextLocked) {
                    val lockedConst = resolveCurrentScreenOrientationConstant()
                    currentForcedOrientation = lockedConst
                    requestedOrientation = lockedConst
                } else {
                    currentForcedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    if (!isVideoActive) {
                        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    }
                }
                emitOrientationEvent()
            }
            return nextLocked
        }

        @JavascriptInterface
        fun isOrientationLocked(): Boolean = orientationLocked

        @JavascriptInterface
        fun rotateScreenNow(): Boolean {
            val currentlyLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            val target = if (currentlyLandscape) {
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            } else {
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            currentForcedOrientation = target
            runOnUiThread {
                requestedOrientation = target
                emitOrientationEvent()
            }
            return !currentlyLandscape
        }

        @JavascriptInterface
        fun setOrientation(mode: String) {
            runOnUiThread {
                val target = when (mode) {
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
                currentForcedOrientation = target
                requestedOrientation = target
                emitOrientationEvent()
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
            isPlaybackActive = isPlaying
            if (isPlaying) {
                maybeRequestNotificationPermission()
            }
            val svcIntent = Intent(this@MainActivity, AazPlaybackService::class.java).apply {
                action = AazPlaybackService.ACTION_UPDATE
                putExtra(AazPlaybackService.EXTRA_TITLE, title.ifBlank { "همزة" })
                putExtra(AazPlaybackService.EXTRA_ARTIST, artist.ifBlank { "همزة" })
                putExtra(AazPlaybackService.EXTRA_PLAYING, isPlaying)
                putExtra(AazPlaybackService.EXTRA_POSITION, positionMs.coerceAtLeast(0L))
                putExtra(AazPlaybackService.EXTRA_DURATION, durationMs.coerceAtLeast(0L))
            }
            try {
                if (isPlaying && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ContextCompat.startForegroundService(this@MainActivity, svcIntent)
                } else {
                    startService(svcIntent)
                }
            } catch (_: Exception) {
            }
        }

        // Phase 4: Dynamic System Bar Styling for All 16 Dark/Light Themes (R42)
        @JavascriptInterface
        fun setSystemBarStyle(bgHex: String, isLight: Boolean) {
            applySystemBarStyle(bgHex, isLight)
        }

        // Phase 4: Native Android LAN / DLNA Cast & Wi-Fi Receiver (R43-R46)
        @JavascriptInterface
        fun castStartServer(callbackId: String, mediaPath: String, title: String, subtitleVtt: String) {
            netExecutor.execute {
                val res = try {
                    castHelper.startServer(mediaPath, title, subtitleVtt.ifBlank { null })
                } catch (e: Exception) {
                    JSONObject().put("__aazError", e.message ?: "Failed to start LAN cast server.")
                }
                resolveJsCallback(callbackId, res.toString())
            }
        }

        @JavascriptInterface
        fun castStopServer() {
            netExecutor.execute {
                castHelper.stopServer()
            }
        }

        @JavascriptInterface
        fun castDiscoverDevices(callbackId: String) {
            netExecutor.execute {
                val res = try {
                    castHelper.discoverDevices().toString()
                } catch (e: Exception) {
                    JSONObject().put("__aazError", e.message ?: "Failed to scan Wi-Fi for DLNA devices.").toString()
                }
                resolveJsCallback(callbackId, res)
            }
        }

        @JavascriptInterface
        fun castToDlna(callbackId: String, controlUrl: String, mediaUrl: String, title: String, mimeType: String) {
            netExecutor.execute {
                val res = try {
                    castHelper.castToDlna(controlUrl, mediaUrl, title, mimeType)
                } catch (e: Exception) {
                    JSONObject().put("__aazError", e.message ?: "Failed to cast to DLNA TV.")
                }
                resolveJsCallback(callbackId, res.toString())
            }
        }

        @JavascriptInterface
        fun castDlnaControl(callbackId: String, controlUrl: String, action: String) {
            netExecutor.execute {
                val res = try {
                    castHelper.dlnaControl(controlUrl, action)
                } catch (e: Exception) {
                    JSONObject().put("__aazError", e.message ?: "DLNA control failed.")
                }
                resolveJsCallback(callbackId, res.toString())
            }
        }

        // Phase 4: Direct Signed APK Self-Updater via GitHub Releases (R48-R50)
        @JavascriptInterface
        fun getAppVersion(): String = updater.getAppVersion()

        @JavascriptInterface
        fun checkForUpdates(callbackId: String) {
            netExecutor.execute {
                val res = updater.checkForUpdates()
                resolveJsCallback(callbackId, res.toString())
            }
        }

        @JavascriptInterface
        fun downloadUpdate(callbackId: String) {
            netExecutor.execute {
                val res = updater.downloadUpdate()
                resolveJsCallback(callbackId, res.toString())
            }
        }

        @JavascriptInterface
        fun installUpdate(callbackId: String) {
            netExecutor.execute {
                val res = updater.installUpdate()
                resolveJsCallback(callbackId, res.toString())
            }
        }
    }
}
