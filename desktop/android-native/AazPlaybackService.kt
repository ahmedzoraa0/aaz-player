package com.aaz.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Android Phase 3 (R35-R38): Foreground Media Playback Service.
 * Owns MediaSession, rich MediaStyle lock-screen/shade notification controls,
 * WakeLock during active playback, AudioFocus management, and headphone-unplug
 * (ACTION_AUDIO_BECOMING_NOISY) auto-pause — built purely on Android platform APIs
 * to keep APK footprint lightweight.
 */
class AazPlaybackService : Service() {
    companion object {
        const val CHANNEL_ID = "aaz_playback_channel"
        const val NOTIFICATION_ID = 4107

        const val ACTION_UPDATE = "com.aaz.player.action.UPDATE"
        const val ACTION_PLAY = "com.aaz.player.action.PLAY"
        const val ACTION_PAUSE = "com.aaz.player.action.PAUSE"
        const val ACTION_NEXT = "com.aaz.player.action.NEXT"
        const val ACTION_PREV = "com.aaz.player.action.PREV"
        const val ACTION_STOP = "com.aaz.player.action.STOP"

        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "isPlaying"
        const val EXTRA_POSITION = "positionMs"
        const val EXTRA_DURATION = "durationMs"

        @Volatile
        var actionDispatch: ((String) -> Unit)? = null
    }

    private var mediaSession: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private var isForegroundStarted = false
    private var noisyReceiverRegistered = false

    private var currentTitle = "همزة"
    private var currentArtist = "همزة"
    private var currentPlaying = false
    private var currentPositionMs = 0L
    private var currentDurationMs = 0L

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && currentPlaying) {
                actionDispatch?.invoke("pause")
            }
        }
    }

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (currentPlaying) {
                    actionDispatch?.invoke("pause")
                }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        createNotificationChannel()

        try {
            val session = MediaSession(this, "AAZPlayerServiceSession")
            session.setCallback(object : MediaSession.Callback() {
                override fun onPlay() { actionDispatch?.invoke("play") }
                override fun onPause() { actionDispatch?.invoke("pause") }
                override fun onSkipToNext() { actionDispatch?.invoke("next") }
                override fun onSkipToPrevious() { actionDispatch?.invoke("prev") }
                override fun onStop() {
                    actionDispatch?.invoke("stop")
                    stopPlaybackForeground()
                }
            })
            session.isActive = true
            mediaSession = session
        } catch (_: Exception) {
        }

        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AAZPlayer::PlaybackWakeLock")?.apply {
                setReferenceCounted(false)
            }
        } catch (_: Exception) {
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> actionDispatch?.invoke("play")
            ACTION_PAUSE -> actionDispatch?.invoke("pause")
            ACTION_NEXT -> actionDispatch?.invoke("next")
            ACTION_PREV -> actionDispatch?.invoke("prev")
            ACTION_STOP -> {
                actionDispatch?.invoke("stop")
                stopPlaybackForeground()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_UPDATE -> {
                currentTitle = intent.getStringExtra(EXTRA_TITLE)?.ifBlank { "همزة" } ?: "همزة"
                currentArtist = intent.getStringExtra(EXTRA_ARTIST)?.ifBlank { "همزة" } ?: "همزة"
                currentPlaying = intent.getBooleanExtra(EXTRA_PLAYING, false)
                currentPositionMs = intent.getLongExtra(EXTRA_POSITION, 0L).coerceAtLeast(0L)
                currentDurationMs = intent.getLongExtra(EXTRA_DURATION, 0L).coerceAtLeast(0L)
                syncSessionAndNotification()
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        unregisterNoisyReceiver()
        abandonAudioFocus()
        releaseWakeLock()
        try {
            mediaSession?.isActive = false
            mediaSession?.release()
        } catch (_: Exception) {
        }
        mediaSession = null
        super.onDestroy()
    }

    private fun syncSessionAndNotification() {
        updateMediaSessionState()

        if (currentPlaying) {
            requestAudioFocus()
            registerNoisyReceiver()
            acquireWakeLock()
        } else {
            unregisterNoisyReceiver()
            releaseWakeLock()
        }

        val notification = buildNotification()
        try {
            if (currentPlaying || isForegroundStarted) {
                if (!isForegroundStarted) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        startForeground(
                            NOTIFICATION_ID,
                            notification,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                        )
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                    isForegroundStarted = true
                } else {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                    nm?.notify(NOTIFICATION_ID, notification)
                }
            }
            if (!currentPlaying && isForegroundStarted) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_DETACH)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(false)
                }
                isForegroundStarted = false
            }
        } catch (_: Exception) {
        }
    }

    private fun stopPlaybackForeground() {
        unregisterNoisyReceiver()
        abandonAudioFocus()
        releaseWakeLock()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {
        }
        isForegroundStarted = false
    }

    private fun updateMediaSessionState() {
        val session = mediaSession ?: return
        try {
            val meta = MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
                .apply {
                    if (currentDurationMs > 0L) {
                        putLong(MediaMetadata.METADATA_KEY_DURATION, currentDurationMs)
                    }
                }
                .build()
            session.setMetadata(meta)

            val actions = PlaybackState.ACTION_PLAY or
                PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or
                PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                PlaybackState.ACTION_STOP

            val state = PlaybackState.Builder()
                .setActions(actions)
                .setState(
                    if (currentPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    currentPositionMs,
                    if (currentPlaying) 1.0f else 0.0f
                )
                .build()
            session.setPlaybackState(state)
        } catch (_: Exception) {
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPending = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevPending = serviceActionPendingIntent(ACTION_PREV, 1)
        val playPauseAction = if (currentPlaying) ACTION_PAUSE else ACTION_PLAY
        val playPausePending = serviceActionPendingIntent(playPauseAction, 2)
        val nextPending = serviceActionPendingIntent(ACTION_NEXT, 3)

        val playPauseIcon = if (currentPlaying) {
            android.R.drawable.ic_media_pause
        } else {
            android.R.drawable.ic_media_play
        }
        val playPauseLabel = if (currentPlaying) "Pause" else "Play"

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setContentIntent(contentPending)
            .setOngoing(currentPlaying)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(
                Notification.Action.Builder(android.R.drawable.ic_media_previous, "Previous", prevPending).build()
            )
            .addAction(
                Notification.Action.Builder(playPauseIcon, playPauseLabel, playPausePending).build()
            )
            .addAction(
                Notification.Action.Builder(android.R.drawable.ic_media_next, "Next", nextPending).build()
            )

        val style = Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2)
        mediaSession?.sessionToken?.let { style.setMediaSession(it) }
        builder.setStyle(style)

        return builder.build()
    }

    private fun serviceActionPendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, AazPlaybackService::class.java).apply { this.action = action }
        return PendingIntent.getService(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "همزة Playback",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Media playback controls and now playing status"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(channel)
    }

    private fun requestAudioFocus() {
        if (hasAudioFocus) return
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(audioFocusListener)
                    .build()
                audioFocusRequest = req
                hasAudioFocus = am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                hasAudioFocus = am.requestAudioFocus(
                    audioFocusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
                ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            }
        } catch (_: Exception) {
        }
    }

    private fun abandonAudioFocus() {
        if (!hasAudioFocus) return
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(audioFocusListener)
            }
        } catch (_: Exception) {
        }
        hasAudioFocus = false
    }

    private fun registerNoisyReceiver() {
        if (noisyReceiverRegistered) return
        try {
            val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(noisyReceiver, filter)
            }
            noisyReceiverRegistered = true
        } catch (_: Exception) {
        }
    }

    private fun unregisterNoisyReceiver() {
        if (!noisyReceiverRegistered) return
        try {
            unregisterReceiver(noisyReceiver)
        } catch (_: Exception) {
        }
        noisyReceiverRegistered = false
    }

    private fun acquireWakeLock() {
        try {
            val wl = wakeLock ?: return
            if (!wl.isHeld) wl.acquire(4 * 60 * 60 * 1000L)
        } catch (_: Exception) {
        }
    }

    private fun releaseWakeLock() {
        try {
            val wl = wakeLock ?: return
            if (wl.isHeld) wl.release()
        } catch (_: Exception) {
        }
    }
}
