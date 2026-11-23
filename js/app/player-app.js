/**
 * AAZ Player Core Tab Player Application Module.
 * Refactored from monolithic inline script into clean ES module architecture.
 */
import { sendSafeMessage, receiveShellMessage } from '../core/messaging.js';
import {
  createStorageManager,
  STORAGE_KEY,
  LEGACY_KEYS,
  sanitizeBookmarkList,
} from '../modules/storage-manager.js';
import { SUBTITLE_STYLE_DEFAULTS, sanitizeSubtitleStyle } from '../modules/subtitle-style.js';
import {
  normalizeWindowsPath,
  extractParentFolderLabel,
  buildCanonicalTrackKey,
  findTrackSafely,
  deduplicateTracksSafely,
  lookupLegacyKeyFallback,
} from '../modules/track-identity.js';
import {
  buildPlaylistExport,
  parsePlaylistText,
  filterTracksBySavedPlaylist,
} from '../modules/playlist-io.js';
import { selectBestSubtitleCandidate } from '../modules/subtitle-matcher.js';
import {
  srtToWebVtt as convertSrtToWebVtt,
  shiftWebVtt,
} from '../utils/time-utils.js';
import { appendQueryParam } from '../utils/file-utils.js';
import { createErrorHandler, ErrorCategory } from '../utils/error-handler.js';
import { createPhase3Controller } from '../ui/phase3-controller.js';
import {
  DEFAULT_SKIN,
  SKIN_STORAGE_KEY,
  SKINS,
  sanitizeSkin,
  getSkinMeta,
} from '../modules/themes-catalog.js';
import {
  createMobileGestureController,
  decideGestureAxis,
  TOUCH_SLOP_PX,
} from '../modules/mobile-gestures.js';

export function initPlayerApp({ currentTabId, isInitialTab, isTabFrame }) {
  const CURRENT_TAB_ID = currentTabId;
  const IS_INITIAL_TAB = Boolean(isInitialTab);
  const IS_TAB_FRAME = Boolean(isTabFrame);
  const storageManager = createStorageManager();
  let phase3 = null;
  let trackLoadGen = 0;
  let subtitleOpGen = 0;

      /* =======================================================================
         1. Configuration, Extensions & Storage Keys (Tab Player Mode)
         ======================================================================= */
      if (IS_TAB_FRAME) {
        document.documentElement.classList.add('in-tab-frame');
      }
      const SUBTITLE_STYLE_KEY = 'aaz_subtitle_style_v1';
      const IDB_NAME = 'AAZMediaPlayerDB';
      const IDB_VERSION = 1;
      const IDB_STORE = 'handles';
      const IDB_LAST_DIR_KEY = 'lastDirectoryHandle';
      const AUTOSAVE_INTERVAL_MS = 2000;
      const SKIP_SECONDS = 5;
      const FULLSCREEN_IDLE_MS = 2000;

      const desktopBridge =
        (window.aazDesktop && window.aazDesktop.isElectron)
          ? window.aazDesktop
          : (IS_TAB_FRAME && window.parent.aazDesktop && window.parent.aazDesktop.isElectron
            ? window.parent.aazDesktop
            : null);

      function postToShell(type, extra = {}) {
        if (!IS_TAB_FRAME) return;
        sendSafeMessage(window.parent, { type, tabId: CURRENT_TAB_ID, ...extra });
      }

      const FALLBACK_FONTS = [
        'Cairo', 'Plus Jakarta Sans', 'Segoe UI', 'Tahoma', 'Arial',
        'Traditional Arabic', 'Amiri', 'Noto Sans Arabic', 'Arabic Typesetting',
        'Verdana', 'Calibri', 'Georgia', 'Times New Roman', 'Trebuchet MS',
        'Consolas', 'JetBrains Mono', 'Impact', 'Comic Sans MS'
      ];

      const AUDIO_EXTENSIONS = new Set([
        'mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus',
        'wma', 'aiff', 'aif', 'aifc', 'alac', 'weba', 'mka', 'mp2',
        'amr', 'caf', 'ac3', 'dts', 'wv', 'ape'
      ]);
      const VIDEO_EXTENSIONS = new Set([
        'mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'ogv', '3gp',
        '3g2', 'ts', 'mts', 'm2ts', 'flv', 'wmv', 'mpg', 'mpeg'
      ]);
      const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt']);
      const PLAYLIST_EXTENSIONS = new Set(['xspf', 'm3u8', 'm3u', 'pls']);

      const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2];
      const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];
      const EQ_PRESETS = {
        flat:     [0, 0, 0, 0, 0],
        bass:     [6, 4, 0, -1, 1],
        vocal:    [-2, 1, 5, 4, 1],
        acoustic: [3, 2, 1, 3, 2],
        night:    [-4, 1, 3, 2, -3],
        cinema:   [5, 2, -1, 3, 4]
      };

      const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

      /* =======================================================================
         2. DOM References
         ======================================================================= */
      const el = {
        shell: document.getElementById('appShell'),
        workspace: document.querySelector('.workspace'),
        sidebarResizer: document.getElementById('sidebarResizer'),
        sidebarPane: document.getElementById('sidebarPane'),
        media: document.getElementById('mediaEngine'),
        mobileBottomNav: document.getElementById('mobileBottomNav'),
        mobileNavBtns: document.querySelectorAll('[data-mobile-nav]'),
        mobileMiniNowBar: document.getElementById('mobileMiniNowBar'),
        mobileMiniOpenPlayerBtn: document.getElementById('mobileMiniOpenPlayerBtn'),
        mobileMiniTitle: document.getElementById('mobileMiniTitle'),
        mobileMiniSub: document.getElementById('mobileMiniSub'),
        mobileMiniPlayBtn: document.getElementById('mobileMiniPlayBtn'),
        mobileMiniPlayIcon: document.getElementById('mobileMiniPlayIcon'),
        mobileMiniPauseIcon: document.getElementById('mobileMiniPauseIcon'),
        mobileMiniNextBtn: document.getElementById('mobileMiniNextBtn'),

        menuBar: document.getElementById('menuBar'),
        contextMenu: document.getElementById('aazContextMenu'),
        menuPinItem: document.getElementById('menuPinItem'),
        menuVersionLabel: document.getElementById('menuVersionLabel'),
        langToggleBtn: document.getElementById('langToggleBtn'),
        themeToggleBtn: document.getElementById('themeToggleBtn'),
        themeSunIcon: document.getElementById('themeSunIcon'),
        themeMoonIcon: document.getElementById('themeMoonIcon'),
        themeGalleryModal: document.getElementById('themeGalleryModal'),
        closeThemeGalleryBtn: document.getElementById('closeThemeGalleryBtn'),
        themeGalleryDarkBtn: document.getElementById('themeGalleryDarkBtn'),
        themeGalleryLightBtn: document.getElementById('themeGalleryLightBtn'),
        themeGalleryGrid: document.getElementById('themeGalleryGrid'),
        setActiveSkinName: document.getElementById('setActiveSkinName'),
        pinWindowBtn: document.getElementById('pinWindowBtn'),
        openFolderBtn: document.getElementById('openFolderBtn'),
        openFilesBtn: document.getElementById('openFilesBtn'),
        toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),

        dirInput: document.getElementById('dirInput'),
        filesInput: document.getElementById('filesInput'),
        subtitleInput: document.getElementById('subtitleInput'),
        playlistImportInput: document.getElementById('playlistImportInput'),

        updateBanner: document.getElementById('updateBanner'),
        updateBannerText: document.getElementById('updateBannerText'),
        updateProgressTrack: document.getElementById('updateProgressTrack'),
        updateProgressFill: document.getElementById('updateProgressFill'),
        updateActionBtn: document.getElementById('updateActionBtn'),
        dismissUpdateBtn: document.getElementById('dismissUpdateBtn'),

        resumeBanner: document.getElementById('resumeBanner'),
        resumeTrackLabel: document.getElementById('resumeTrackLabel'),
        resumeDetailLabel: document.getElementById('resumeDetailLabel'),
        resumeSessionBtn: document.getElementById('resumeSessionBtn'),
        dismissResumeBtn: document.getElementById('dismissResumeBtn'),

        statusNotice: document.getElementById('statusNotice'),
        statusNoticeText: document.getElementById('statusNoticeText'),
        noticeUndoBtn: document.getElementById('noticeUndoBtn'),
        closeNoticeBtn: document.getElementById('closeNoticeBtn'),

        mediaStage: document.getElementById('mediaStage'),
        videoFrame: document.getElementById('videoFrame'),
        videoViewportStage: document.getElementById('videoViewportStage'),
        videoSnapshotFlash: document.getElementById('videoSnapshotFlash'),
        subtitleOverlay: document.getElementById('subtitleOverlay'),
        subtitleCueStack: document.getElementById('subtitleCueStack'),
        videoToolbar: document.getElementById('videoToolbar'),
        prevFrameBtn: document.getElementById('prevFrameBtn'),
        nextFrameBtn: document.getElementById('nextFrameBtn'),
        snapshotBtn: document.getElementById('snapshotBtn'),
        audioOnlyViewBtn: document.getElementById('audioOnlyViewBtn'),
        subtitleBtn: document.getElementById('subtitleBtn'),
        videoCastBtn: document.getElementById('videoCastBtn'),
        pipBtn: document.getElementById('pipBtn'),

        subtitleModal: document.getElementById('subtitleModal'),
        closeSubtitleModalBtn: document.getElementById('closeSubtitleModalBtn'),
        subPreviewBox: document.getElementById('subPreviewBox'),
        subLoadSysFontsBtn: document.getElementById('subLoadSysFontsBtn'),
        subFontSearchInput: document.getElementById('subFontSearchInput'),
        subFontCountLabel: document.getElementById('subFontCountLabel'),
        subFontList: document.getElementById('subFontList'),
        subFontSizeRange: document.getElementById('subFontSizeRange'),
        subFontSizeVal: document.getElementById('subFontSizeVal'),
        subFontWeightSelect: document.getElementById('subFontWeightSelect'),
        subItalicBtn: document.getElementById('subItalicBtn'),
        subTextColorInput: document.getElementById('subTextColorInput'),
        subTextColorVal: document.getElementById('subTextColorVal'),
        subSwatches: Array.from(document.querySelectorAll('[data-sub-swatch]')),
        subOutlineColorInput: document.getElementById('subOutlineColorInput'),
        subOutlineWidthRange: document.getElementById('subOutlineWidthRange'),
        subOutlineVal: document.getElementById('subOutlineVal'),
        subBgColorInput: document.getElementById('subBgColorInput'),
        subBgOpacityRange: document.getElementById('subBgOpacityRange'),
        subBgOpacityVal: document.getElementById('subBgOpacityVal'),
        subBorderColorInput: document.getElementById('subBorderColorInput'),
        subBorderWidthRange: document.getElementById('subBorderWidthRange'),
        subBorderVal: document.getElementById('subBorderVal'),
        subRadiusRange: document.getElementById('subRadiusRange'),
        subRadiusVal: document.getElementById('subRadiusVal'),
        subShadowRange: document.getElementById('subShadowRange'),
        subShadowVal: document.getElementById('subShadowVal'),
        subPositionRange: document.getElementById('subPositionRange'),
        subPositionVal: document.getElementById('subPositionVal'),
        subOffsetBtns: Array.from(document.querySelectorAll('[data-sub-offset]')),
        subOffsetReadout: document.getElementById('subOffsetReadout'),
        subOffsetResetBtn: document.getElementById('subOffsetResetBtn'),
        subResetBtn: document.getElementById('subResetBtn'),
        subDoneBtn: document.getElementById('subDoneBtn'),

        fsSeekBar: document.getElementById('fsSeekBar'),
        fsPlayBtn: document.getElementById('fsPlayBtn'),
        fsPlayIcon: document.getElementById('fsPlayIcon'),
        fsPauseIcon: document.getElementById('fsPauseIcon'),
        fsPrevFrameBtn: document.getElementById('fsPrevFrameBtn'),
        fsNextFrameBtn: document.getElementById('fsNextFrameBtn'),
        fsSnapshotBtn: document.getElementById('fsSnapshotBtn'),
        fsTimeLabel: document.getElementById('fsTimeLabel'),
        fsTitleLabel: document.getElementById('fsTitleLabel'),
        fsExitBtn: document.getElementById('fsExitBtn'),

        audioStage: document.getElementById('audioStage'),
        audioExitFsBtn: document.getElementById('audioExitFsBtn'),
        nowPlayingKicker: document.getElementById('nowPlayingKicker'),
        trackTitle: document.getElementById('trackTitle'),
        trackSubpath: document.getElementById('trackSubpath'),
        showVideoBtn: document.getElementById('showVideoBtn'),
        visualizerCanvas: document.getElementById('visualizerCanvas'),
        vizModeBtns: Array.from(document.querySelectorAll('.viz-mode-btn')),

        eqDrawer: document.getElementById('eqDrawer'),
        eqToggleBtn: document.getElementById('eqToggleBtn'),
        eqPresetBtns: Array.from(document.querySelectorAll('.eq-preset-btn')),
        eqResetBtn: document.getElementById('eqResetBtn'),
        eqBandSliders: Array.from(document.querySelectorAll('.eq-band-slider[data-band]')),
        eqBandVals: Array.from(document.querySelectorAll('.eq-band-val[data-val-idx]')),
        preampSlider: document.getElementById('preampSlider'),
        preampVal: document.getElementById('preampVal'),

        bookmarksStrip: document.getElementById('bookmarksStrip'),

        // Sidebar tabs & panels
        tabQueueBtn: document.getElementById('tabQueueBtn'),
        tabSavedBtn: document.getElementById('tabSavedBtn'),
        tabLibraryBtn: document.getElementById('tabLibraryBtn'),
        panelLibrary: document.getElementById('panelLibrary'),
        queueTabCount: document.getElementById('queueTabCount'),
        savedTabCount: document.getElementById('savedTabCount'),
        panelQueue: document.getElementById('panelQueue'),
        panelSaved: document.getElementById('panelSaved'),

        playlistTitle: document.getElementById('playlistTitle'),
        playlistMeta: document.getElementById('playlistMeta'),
        playlistToolsBtn: document.getElementById('playlistToolsBtn'),
        playlistToolsMenu: document.getElementById('playlistToolsMenu'),
        openSavePlBarBtn: document.getElementById('openSavePlBarBtn'),
        clearQueueBtn: document.getElementById('clearQueueBtn'),
        savePlBar: document.getElementById('savePlBar'),
        savePlNameInput: document.getElementById('savePlNameInput'),
        confirmSavePlBtn: document.getElementById('confirmSavePlBtn'),
        cancelSavePlBtn: document.getElementById('cancelSavePlBtn'),
        playlistContextMenu: document.getElementById('playlistContextMenu'),
        savedPlContextMenu: document.getElementById('savedPlContextMenu'),
        plCtxPlayNextLbl: document.getElementById('plCtxPlayNextLbl'),
        plCtxStopAfterLbl: document.getElementById('plCtxStopAfterLbl'),
        plCtxStarLbl: document.getElementById('plCtxStarLbl'),
        plCtxWatchedLbl: document.getElementById('plCtxWatchedLbl'),

        modeTabs: Array.from(document.querySelectorAll('.mode-tab')),
        countAll: document.getElementById('countAll'),
        countAudio: document.getElementById('countAudio'),
        countVideo: document.getElementById('countVideo'),
        countStarred: document.getElementById('countStarred'),
        searchInput: document.getElementById('searchInput'),
        sortBtn: document.getElementById('sortBtn'),
        playlistList: document.getElementById('playlistList'),
        emptyState: document.getElementById('emptyState'),
        emptyOpenFolderBtn: document.getElementById('emptyOpenFolderBtn'),
        emptyOpenFilesBtn: document.getElementById('emptyOpenFilesBtn'),

        savedImportBtn: document.getElementById('savedImportBtn'),
        savedPlaylistsContainer: document.getElementById('savedPlaylistsContainer'),

        // Bottom Dock
        seekBar: document.getElementById('seekBar'),
        abLoopRegion: document.getElementById('abLoopRegion'),
        bookmarkTicks: document.getElementById('bookmarkTicks'),
        currentTimeLabel: document.getElementById('currentTimeLabel'),
        durationLabel: document.getElementById('durationLabel'),

        starCurrentBtn: document.getElementById('starCurrentBtn'),
        dockNowTitle: document.getElementById('dockNowTitle'),
        dockNowMeta: document.getElementById('dockNowMeta'),

        shuffleBtn: document.getElementById('shuffleBtn'),
        abLoopBtn: document.getElementById('abLoopBtn'),
        prevBtn: document.getElementById('prevBtn'),
        skipBackBtn: document.getElementById('skipBackBtn'),
        playPauseBtn: document.getElementById('playPauseBtn'),
        playIcon: document.getElementById('playIcon'),
        pauseIcon: document.getElementById('pauseIcon'),
        skipForwardBtn: document.getElementById('skipForwardBtn'),
        nextBtn: document.getElementById('nextBtn'),
        repeatBtn: document.getElementById('repeatBtn'),
        repeatOneBadge: document.getElementById('repeatOneBadge'),

        sleepBadge: document.getElementById('sleepBadge'),
        speedCycleBtn: document.getElementById('speedCycleBtn'),
        addBookmarkBtn: document.getElementById('addBookmarkBtn'),
        audioOutputBtn: document.getElementById('audioOutputBtn'),
        audioOutputPopover: document.getElementById('audioOutputPopover'),
        audioOutputList: document.getElementById('audioOutputList'),
        audioOutputFooter: document.getElementById('audioOutputFooter'),
        refreshOutputsBtn: document.getElementById('refreshOutputsBtn'),
        chooseOutputNativeBtn: document.getElementById('chooseOutputNativeBtn'),
        muteBtn: document.getElementById('muteBtn'),
        volHighIcon: document.getElementById('volHighIcon'),
        volMuteIcon: document.getElementById('volMuteIcon'),
        volumeSlider: document.getElementById('volumeSlider'),
        volumeReadout: document.getElementById('volumeReadout'),
        dockFullscreenBtn: document.getElementById('dockFullscreenBtn'),
        dockFsEnterIcon: document.getElementById('dockFsEnterIcon'),
        dockFsExitIcon: document.getElementById('dockFsExitIcon'),

        castModal: document.getElementById('castModal'),
        closeCastModalBtn: document.getElementById('closeCastModalBtn'),
        castRemoteBar: document.getElementById('castRemoteBar'),
        castConnectedName: document.getElementById('castConnectedName'),
        castConnectedTrack: document.getElementById('castConnectedTrack'),
        castRemotePlayBtn: document.getElementById('castRemotePlayBtn'),
        castRemotePauseBtn: document.getElementById('castRemotePauseBtn'),
        castRemoteStopBtn: document.getElementById('castRemoteStopBtn'),
        castScanBtn: document.getElementById('castScanBtn'),
        castDeviceList: document.getElementById('castDeviceList'),
        castLanToggleBtn: document.getElementById('castLanToggleBtn'),
        castLanUrlBox: document.getElementById('castLanUrlBox'),
        castLanUrlText: document.getElementById('castLanUrlText'),
        castCopyUrlBtn: document.getElementById('castCopyUrlBtn'),
        castWindowsBtn: document.getElementById('castWindowsBtn'),
        castBrowserBtn: document.getElementById('castBrowserBtn'),

        shortcutsModal: document.getElementById('shortcutsModal'),
        closeShortcutsBtn: document.getElementById('closeShortcutsBtn')
      };

      /* =======================================================================
         3. Application State
         ======================================================================= */
      const state = {
        allTracks: [],
        subtitlesByBaseKey: new Map(),
        currentKey: '',
        folderName: '',
        nativeFolderPath: '',
        currentDirHandle: null,       // Active FileSystemDirectoryHandle (browser)
        activeSavedPlaylistId: null,  // ID of currently loaded Saved Playlist (updates its resume point!)
        sourceMode: 'none',

        sidebarTab: 'queue',          // 'queue' | 'saved'
        sidebarHidden: false,
        playlistMode: 'all',          // 'all' | 'audio' | 'video' | 'starred'
        videoDisplayMode: 'video',    // 'video' | 'audio'
        sortMode: 'asc',              // 'asc' | 'desc' | 'type'
        shuffle: false,
        repeatMode: 'off',            // 'off' | 'all' | 'one'
        showRemainingTime: false,
        isPinnedOnTop: false,
        searchQuery: '',

        // Saved Playlists Library (Persisted in localStorage + per-playlist IndexedDB handles)
        savedPlaylists: [],

        // A–B Section Loop
        abPointA: null,
        abPointB: null,

        // EQ & Preamp
        eqPreset: 'flat',
        eqGains: [0, 0, 0, 0, 0],
        preampGain: 1,

        // Favorites, Bookmarks & Playlist Powerhouse State
        starredKeys: new Set(),
        bookmarksByKey: {},
        upNextKeys: [],
        stopAfterKey: '',
        watchedKeys: new Set(),
        progressByKey: {},
        lastRemovedUndo: null,
        lastDeletedSavedPlUndo: null,
        activeContextTrackKey: '',
        activeContextSavedPlId: '',
        dragTrackKey: '',
        lastProgressSaveTs: 0,
        appendModePending: null,
        noticeUndoHandler: null,

        // Runtime Media State
        activeObjectUrl: null,
        activeSubtitleUrl: null,
        activeSubtitleVtt: null,
        subtitlesEnabled: true,
        pendingSeekTime: null,
        isSeeking: false,
        autosaveTimer: null,
        savedDirHandle: null,
        savedSession: null,
        resumeAutoPlayPending: false,

        // Cast to TV State
        castServerInfo: null,
        castDevices: [],
        activeCastDevice: null,
        castScanning: false,

        // Fullscreen 2-Second Auto-Hide Timer
        fsIdleTimer: null,
        electronFsFallback: false,

        // Subtitle Style Studio & Timing Sync State
        subtitleStyle: { ...SUBTITLE_STYLE_DEFAULTS },
        subtitleOffsetSec: 0,
        systemFonts: [...FALLBACK_FONTS],
        systemFontsLoaded: false,

        // Theme, Visual Skin, Language, Visualizer & Per-Window Audio Output Channel
        theme: 'dark',                // 'dark' | 'light'
        skin: DEFAULT_SKIN,           // 12 green-identity visual skins
        lang: 'en',                   // 'en' | 'ar'
        vizMode: 'spectrum',          // 'spectrum' | 'wave' | 'orb' | 'led'
        videoAspect: 'default',       // 'default' | '16:9' | '4:3' | '21:9' | '16:10' | '1:1' | 'fill'
        videoZoom: 1,                 // 0.25 | 0.5 | 1 | 1.5 | 2
        videoCrop: 'default',         // 'default' | '16:9' | '21:9' | '4:3' | '1:1' | 'fill'
        appVersion: '1.6.0',
        updateState: 'idle',          // 'idle' | 'available' | 'downloading' | 'downloaded'
        audioSinkId: '',              // '' = System Default, or specific audiooutput deviceId
        audioSinkLabel: '',
        audioDevices: [],
        defaultAudioDevice: null,     // Concrete Windows hardware device backing 'default'
        audioDevicesLoaded: false,

        // Sleep Timer
        sleepEndAt: null,
        sleepInterval: null
      };

      /* =======================================================================
         3B. Bilingual Arabic / English Dictionary & Theme Engine
         ======================================================================= */
      const I18N = {
        en: {
          dropTitle: 'Drop media files, a folder, subtitles, or a playlist',
          dropSub: 'Audio, Video, .SRT/.VTT Subtitles, or .XSPF / .M3U8 / .PLS Playlists',
          menuMedia: 'Media',
          menuPlayback: 'Playback',
          menuAudio: 'Audio',
          menuVideo: 'Video',
          menuView: 'View',
          menuHelp: 'Help',
          cmdOpenFolder: 'Open Folder...',
          cmdOpenFiles: 'Open Files...',
          cmdResume: 'Resume Last Session',
          cmdSaveToLibrary: 'Save Playlist to Library...',
          cmdImportPl: 'Import Playlist (.xspf / .m3u8 / .pls)',
          headingExport: 'Export Current Playlist',
          cmdExportXspf: 'Export as .XSPF (VLC)',
          cmdExportM3u8: 'Export as .M3U8',
          cmdExportPls: 'Export as .PLS',
          cmdClearQueue: 'Clear Queue',
          cmdPlayPause: 'Play / Pause',
          cmdPrev: 'Previous Track',
          cmdNext: 'Next Track',
          cmdShuffle: 'Shuffle',
          cmdRepeat: 'Cycle Repeat Mode',
          cmdAbLoop: 'A–B Section Loop',
          cmdAddBookmark: 'Add Timestamp Bookmark',
          headingSpeed: 'Playback Speed',
          speedNormal: '1.0x (Normal)',
          headingSleep: 'Sleep Timer',
          sleepOff: 'Off',
          sleep15: '15 Minutes',
          sleep30: '30 Minutes',
          sleep60: '60 Minutes',
          sleepTrack: 'End of Current Track',
          cmdEq: 'Studio 5-Band Equalizer',
          cmdMute: 'Mute / Unmute',
          headingEqPresets: 'Equalizer Presets',
          eqFlat: 'Flat',
          eqBass: 'Deep Bass',
          eqVocal: 'Vocal Clarity',
          eqVocalShort: 'Vocal',
          eqAcoustic: 'Acoustic',
          eqNight: 'Night Mode',
          eqNightShort: 'Night',
          eqCinema: 'Cinema',
          eqBoost: 'Boost',
          btnReset: 'Reset',
          cmdToggleVideoView: 'Toggle Video / Audio-Only View',
          cmdLoadSubs: 'Load Subtitles (.srt / .vtt)...',
          cmdToggleSubs: 'Show / Hide Subtitles',
          cmdPip: 'Picture-in-Picture',
          cmdFullscreen: 'Fullscreen',
          cmdToggleTheme: 'Switch Light / Dark Mode',
          cmdThemes: 'Theme Styles (16)...',
          themesBtnTitle: 'Theme Studio (16 Styles)',
          themesModalTitle: 'Theme Studio (16 Styles)',
          themesModalSub: 'Choose from 16 distinct visual styles — including Minecraft, LEGO, Roblox, Arcade, Retro 95 & more — every style keeps AAZ Player\'s signature green identity with Dark and Light modes.',
          modeDark: 'Dark',
          modeLight: 'Light',
          setSkinLabel: 'Interface Style & Theme',
          setSkinBtn: 'Choose Theme Style (16)...',
          skinAppliedNotice: 'Theme style: {name}',
          cmdToggleLang: 'Switch Language (عربي / EN)',
          cmdToggleSidebar: 'Show / Hide Playlist Sidebar',
          cmdSavedLibrary: 'Saved Playlists Library',
          cmdPinWindow: 'Pin Window on Top',
          cmdCheckUpdates: 'Check for Updates...',
          cmdShortcuts: 'Keyboard Shortcuts',
          btnOpenFolder: 'Open Folder',
          btnOpenFiles: 'Open Files',
          resumeReady: 'Saved Session Ready',
          btnResumeLast: 'Resume Last Session',
          btnAudioView: 'Audio View',
          btnFull: 'Full',
          btnExitFull: 'Exit Full',
          stageEmptyTitle: 'Open a folder or drop audio & video files',
          stageEmptySub: 'Audio, video, subtitles & playlists (.xspf, .m3u8, .pls)',
          btnShowVideo: 'Switch to Video View',
          vizSpectrum: 'Spectrum',
          vizWave: 'Aurora Wave',
          vizOrb: 'Pulse Orb',
          vizLed: 'Studio LED',
          tabQueue: 'Queue',
          tabSaved: 'Saved Playlists',
          tabSavedShort: 'Saved',
          resumeFilesMissing: 'Could not find the previous session files on disk. They may have been moved or deleted.',
          currentQueue: 'Current Queue',
          btnSavePl: '+ Save',
          btnClear: 'Clear',
          btnSaveConfirm: 'Save',
          filterAll: 'All',
          filterAudio: 'Audio',
          filterVideo: 'Video',
          filterStarred: 'Starred',
          emptyTitle: 'No media loaded',
          emptyDesc: 'Open a folder, choose media or playlist files, or drag & drop them anywhere.',
          savedSubtitle: 'Each playlist remembers its last track & second',
          btnImport: 'Import',
          nothingPlaying: 'Nothing playing',
          idle: 'Idle',
          searchPlaceholder: 'Filter tracks...',
          playlistNamePlaceholder: 'Playlist name...',
          scPlay: 'Play / Pause',
          scSeek: 'Skip backward / forward 5 seconds',
          scVol: 'Volume up / down 5%',
          scMute: 'Mute / Unmute',
          scFull: 'Fullscreen video',
          scPip: 'Picture-in-Picture',
          scAb: 'A–B Section Loop',
          scBookmark: 'Save timestamp bookmark',
          scStar: 'Star / Favorite current track',
          scOpen: 'Open local folder',
          scSavePl: 'Save playlist to Library',
          itemsWord: 'items',
          audioWord: 'audio',
          videoWord: 'video',
          showingWord: 'Showing',
          ofWord: 'of',
          kindVideo: 'Video',
          kindAudio: 'Audio',
          savedEmptyHtml: 'No saved playlists yet.<br/>Open a folder and click <strong>+ Save</strong> to build your personal playlist library.',
          resumePrefix: 'Resume',
          readyFromStart: 'Ready to play from start',
          deleteWord: 'Delete',
          sortType: 'Type',
          repeatOff: 'Repeat: Off',
          repeatAll: 'Repeat: All',
          repeatOne: 'Repeat: One',
          reselectHint: 'Re-select folder to resume',
          updateChecking: 'Checking for updates...',
          updateAvailable: 'Update v{v} is ready to download.',
          updateDownloading: 'Downloading update... {p}%',
          updateDownloaded: 'Update v{v} downloaded — restart to install.',
          updateLatest: 'You are already using the latest version of AAZ Player.',
          updateDevHint: 'Auto-updates work inside the installed Windows AAZ Player app.',
          updateBtnDownload: 'Download',
          updateBtnRestart: 'Restart & Install',
          updateError: 'Could not check for updates right now.',
          cmdNewWindow: 'New Window',
          cmdAudioOutput: 'Audio Output Device...',
          outputTitle: 'Audio Output Channel',
          outputSub: 'Independent for this window / tab',
          outputDefault: 'System Default Output',
          outputUnlock: 'Select / Show Device Names...',
          outputUnsupported: 'Audio output switching requires Chrome, Edge, or the Windows AAZ Player app.',
          outputSwitched: 'Audio output for this window: {name}',
          outputFailed: 'Could not switch audio output device.',
          outputNoExtra: 'No extra output devices detected.',
          newWindowBrowserHint: 'In browser mode, open another tab of AAZ Player to assign a separate audio output.',
          cmdNewTab: 'New Tab',
          scNewTab: 'Open new tab',
          scCloseTab: 'Close current tab',
          scSwitchTab: 'Switch to next tab',
          cmdSubStyle: 'Subtitle Style & Font...',
          subModalTitle: 'Subtitle Style & Font',
          subFontFamily: 'Font Family (Installed System Fonts)',
          subLoadSysFonts: 'Load System Fonts',
          subFontSearchPlaceholder: 'Search or type any font name...',
          subTypography: 'Typography & Text Color',
          subFontSize: 'Font Size',
          subFontWeight: 'Weight & Style',
          subWeightNormal: 'Regular (400)',
          subWeightSemi: 'SemiBold (600)',
          subWeightBold: 'Bold (700)',
          subWeightExtra: 'ExtraBold (800)',
          subItalic: 'Italic',
          subTextColor: 'Text Color',
          subOutline: 'Text Outline (Stroke)',
          subBgBox: 'Background, Border & Position',
          subBgColor: 'Background & Opacity',
          subBorder: 'Box Border',
          subRadius: 'Corner Radius',
          subShadow: 'Drop Shadow',
          subPosition: 'Bottom Position',
          subReset: 'Reset Defaults',
          subDone: 'Done',
          subPreviewSample: 'AAZ Player — Subtitle Live Preview\nمعاينة مباشرة لشكل وخط الترجمة',
          menuSubtitles: 'Subtitles',
          headingSubSync: 'Subtitle Timing Sync',
          cmdSubEarlier: 'Earlier (-0.25s)',
          cmdSubLater: 'Later (+0.25s)',
          cmdSubSyncReset: 'Reset Timing (0.0s)',
          scSubSync: 'Subtitle timing earlier / later',
          subSyncHint: 'Shortcuts: G (Earlier) / H (Later)',
          subSyncNotice: 'Subtitle timing: {offset}',
          subAutoLoaded: 'Auto-loaded subtitle: {name}',
          cmdPrevFrame: 'Previous Frame',
          cmdNextFrame: 'Next Frame',
          cmdSnapshot: 'Take Snapshot',
          headingAspect: 'Aspect Ratio',
          aspectDefault: 'Default',
          aspectFill: 'Fill / Stretch',
          headingZoom: 'Zoom',
          zoomQuarter: '1:4 Quarter (0.25x)',
          zoomHalf: '1:2 Half (0.5x)',
          zoomOriginal: '1:1 Original',
          zoomLarge: '1.5:1 Large (1.5x)',
          zoomDouble: '2:1 Double (2.0x)',
          headingCrop: 'Crop',
          cropDefault: 'Default (No Crop)',
          cropFill: 'Fill Screen',
          cmdResetVideo: 'Reset Video Adjustments',
          scFrameStep: 'Step backward / forward 1 frame',
          scSnapshot: 'Take video snapshot',
          snapshotSaved: 'Snapshot saved: {name}',
          snapshotFailed: 'Could not capture video snapshot.',
          snapshotNoVideo: 'Play a video first to take a snapshot.',
          aspectChanged: 'Aspect Ratio: {val}',
          zoomChanged: 'Video Zoom: {val}',
          cropChanged: 'Video Crop: {val}',
          videoResetNotice: 'Video aspect ratio, zoom & crop reset to default.',
          btnUndo: 'Undo',
          sortCustom: 'Manual',
          sortDuration: 'Length',
          watchedWord: 'watched',
          upNextBadge: 'Next #{n}',
          stopAfterBadge: 'Stop After',
          plAppendFiles: 'Add Files to Queue...',
          plAppendFolder: 'Add Folder to Queue...',
          plShuffleOrder: 'Shuffle Queue Order',
          plRemoveDupes: 'Remove Duplicates',
          plRemoveWatched: 'Remove Watched Items',
          plClearUpNext: 'Clear Up Next Queue',
          plCtxPlay: 'Play Now',
          plCtxPlayNext: 'Play Next (Up Next)',
          plCtxRemoveUpNext: 'Remove from Up Next',
          plCtxStopAfter: 'Stop After This Track',
          plCtxClearStopAfter: 'Cancel Stop After',
          plCtxMoveTop: 'Move to Top',
          plCtxMoveUp: 'Move Up',
          plCtxMoveDown: 'Move Down',
          plCtxMoveBottom: 'Move to Bottom',
          plCtxStar: 'Star / Favorite',
          plCtxUnstar: 'Remove Star',
          plCtxWatched: 'Mark as Watched',
          plCtxUnwatched: 'Mark as Unwatched',
          plCtxResetProg: 'Reset Resume Position',
          plCtxCopyName: 'Copy File Name',
          plCtxRemove: 'Remove from Playlist',
          plRemovedNotice: 'Removed "{name}" from playlist.',
          plRestoredNotice: 'Restored "{name}" to playlist.',
          plDupesRemoved: 'Removed {n} duplicate item(s).',
          plNoDupes: 'No duplicate items found in playlist.',
          plWatchedRemoved: 'Removed {n} watched item(s).',
          plNoWatched: 'No watched items to remove.',
          plShuffledNotice: 'Playlist queue order shuffled.',
          plAppendedNotice: 'Added {n} item(s) to current playlist.',
          plStopAfterSet: 'Playback will stop after "{name}".',
          plStopAfterCleared: 'Stop-after-track cleared.',
          plStoppedAfterNotice: 'Playback stopped after "{name}".',
          plUpNextAdded: 'Queued "{name}" to play next.',
          plCopiedName: 'Copied "{name}".',
          savedCtxOpen: 'Open / Play Playlist',
          savedCtxRename: 'Rename Playlist',
          savedCtxDelete: 'Delete Saved Playlist',
          savedDeletedNotice: 'Deleted saved playlist "{name}".',
          savedRestoredNotice: 'Restored saved playlist "{name}".',
          savedRenamedNotice: 'Renamed playlist to "{name}".',
          savedFilesMissing: 'Could not find the files for "{name}" on disk (they may have been moved or deleted).',
          savedUpdatedNotice: 'Saved "{name}" ({n} items).',
          savedDragHint: 'Drag to reorder',
          cmdCast: 'Cast to TV / Screen...',
          scCast: 'Cast to TV / Smart Screen',
          scReorder: 'Move focused playlist track up / down',
          scRemoveTrack: 'Remove focused track from playlist',
          castModalTitle: 'Cast to TV / Smart Screen',
          castDlnaHeading: 'Smart TVs on Local Wi-Fi (DLNA / UPnP)',
          castScan: 'Scan Network',
          castScanning: 'Scanning Wi-Fi...',
          castScanningHint: 'Click "Scan Network" to discover Samsung, LG, Sony, Android TV, Xbox, or DLNA screens on the same Wi-Fi.',
          castNoneFound: 'No DLNA Smart TVs responded yet. Make sure your TV and PC are on the same Wi-Fi, or use Wi-Fi TV Browser Stream / Windows Cast below.',
          castDesktopOnly: 'Automatic DLNA TV discovery and LAN streaming require the AAZ Player Windows desktop app.',
          castBtnSend: 'Cast Here',
          castBtnConnected: 'Casting',
          castLanHeading: 'Wi-Fi TV Browser & Phone Stream',
          castStartLan: 'Start Wi-Fi Stream',
          castStopLan: 'Stop Stream',
          castLanDesc: 'Streams your local video & subtitles directly over home Wi-Fi. Open this link in any Smart TV browser or phone on the same Wi-Fi.',
          castCopyUrl: 'Copy',
          castUrlCopied: 'Cast link copied! Open it on your Smart TV or phone.',
          castWirelessHeading: 'Wireless Display & Browser Cast',
          castWinMiracast: 'Windows Cast (Miracast)',
          castBrowserRemote: 'Browser / Chromecast',
          castPlay: 'Play',
          castPause: 'Pause',
          castStop: 'Stop',
          castNoTrack: 'Load a video or audio track first before casting.',
          castSentNotice: 'Now casting "{title}" to {device}.',
          castFailedNotice: 'Could not cast to {device}: {err}',
          castBrowserUnsupported: 'Direct browser Chromecast is not available here. Use DLNA Smart TV, Wi-Fi Stream, or Windows Cast instead.'
        },
        ar: {
          dropTitle: 'أفلت ملفات الصوت أو الفيديو أو المجلد أو قائمة التشغيل هنا',
          dropSub: 'ملفات الصوت والفيديو والترجمة (.SRT / .VTT) وقوائم التشغيل (.XSPF / .M3U8 / .PLS)',
          menuMedia: 'الوسائط',
          menuPlayback: 'التشغيل',
          menuAudio: 'الصوت',
          menuVideo: 'الفيديو',
          menuView: 'العرض',
          menuHelp: 'مساعدة',
          cmdOpenFolder: 'فتح مجلد...',
          cmdOpenFiles: 'فتح ملفات...',
          cmdResume: 'استئناف آخر جلسة',
          cmdSaveToLibrary: 'حفظ القائمة في المكتبة...',
          cmdImportPl: 'استيراد قائمة تشغيل (.xspf / .m3u8 / .pls)',
          headingExport: 'تصدير قائمة التشغيل الحالية',
          cmdExportXspf: 'تصدير بصيغة .XSPF (VLC)',
          cmdExportM3u8: 'تصدير بصيغة .M3U8',
          cmdExportPls: 'تصدير بصيغة .PLS',
          cmdClearQueue: 'مسح القائمة الحالية',
          cmdPlayPause: 'تشغيل / إيقاف مؤقت',
          cmdPrev: 'الملف السابق',
          cmdNext: 'الملف التالي',
          cmdShuffle: 'تشغيل عشوائي',
          cmdRepeat: 'تبديل وضع التكرار',
          cmdAbLoop: 'تكرار مقطع (A–B)',
          cmdAddBookmark: 'حفظ علامة زمنية',
          headingSpeed: 'سرعة التشغيل',
          speedNormal: '1.0x (عادي)',
          headingSleep: 'مؤقت النوم',
          sleepOff: 'إيقاف',
          sleep15: '15 دقيقة',
          sleep30: '30 دقيقة',
          sleep60: '60 دقيقة',
          sleepTrack: 'عند نهاية الملف الحالي',
          cmdEq: 'معادل الصوت (5 نطاقات)',
          cmdMute: 'كتم / إعادة الصوت',
          headingEqPresets: 'إعدادات المعادل الجاهزة',
          eqFlat: 'متوازن',
          eqBass: 'جهير عميق',
          eqVocal: 'وضوح الصوت',
          eqVocalShort: 'صوتي',
          eqAcoustic: 'أكوستيك',
          eqNight: 'الوضع الليلي',
          eqNightShort: 'ليلي',
          eqCinema: 'سينمائي',
          eqBoost: 'تضخيم',
          btnReset: 'إعادة ضبط',
          cmdToggleVideoView: 'التبديل بين عرض الفيديو والصوت فقط',
          cmdLoadSubs: 'إضافة ملف ترجمة (.srt / .vtt)...',
          cmdToggleSubs: 'إظهار / إخفاء الترجمة',
          cmdPip: 'صورة داخل صورة',
          cmdFullscreen: 'ملء الشاشة',
          cmdToggleTheme: 'التبديل بين الوضع الفاتح والداكن',
          cmdToggleLang: 'تغيير اللغة (EN / عربي)',
          cmdToggleSidebar: 'إظهار / إخفاء القائمة الجانبية',
          cmdSavedLibrary: 'مكتبة القوائم المحفوظة',
          cmdPinWindow: 'تثبيت النافذة بالأعلى',
          cmdCheckUpdates: 'البحث عن تحديثات...',
          cmdShortcuts: 'اختصارات لوحة المفاتيح',
          btnOpenFolder: 'فتح مجلد',
          btnOpenFiles: 'فتح ملفات',
          resumeReady: 'جلسة محفوظة جاهزة للاستئناف',
          btnResumeLast: 'استئناف آخر جلسة',
          btnAudioView: 'وضع الصوت',
          btnFull: 'ملء الشاشة',
          btnExitFull: 'خروج',
          stageEmptyTitle: 'افتح مجلدا أو اسحب ملفات الصوت والفيديو هنا',
          stageEmptySub: 'يدعم جميع صيغ الصوت والفيديو والترجمة وقوائم التشغيل (.xspf / .m3u8 / .pls)',
          btnShowVideo: 'العودة إلى عرض الفيديو',
          vizSpectrum: 'طيف متناظر',
          vizWave: 'موجة حريرية',
          vizOrb: 'هالة صوتية',
          vizLed: 'أعمدة استوديو',
          tabQueue: 'قائمة التشغيل',
          tabSaved: 'القوائم المحفوظة',
          tabSavedShort: 'المحفوظة',
          resumeFilesMissing: 'تعذّر العثور على ملفات الجلسة السابقة على القرص. ربما تم نقلها أو حذفها.',
          currentQueue: 'قائمة التشغيل الحالية',
          btnSavePl: '+ حفظ القائمة',
          btnClear: 'مسح',
          btnSaveConfirm: 'حفظ',
          filterAll: 'الكل',
          filterAudio: 'صوت',
          filterVideo: 'فيديو',
          filterStarred: 'المفضلة',
          emptyTitle: 'لا توجد ملفات محملة بعد',
          emptyDesc: 'افتح مجلدا أو اختر ملفات صوت وفيديو أو قوائم تشغيل، أو اسحبها مباشرة إلى النافذة.',
          savedSubtitle: 'كل قائمة تحتفظ بآخر ملف وثانية توقفت عندها',
          btnImport: 'استيراد',
          nothingPlaying: 'لا يوجد ملف قيد التشغيل',
          idle: 'في وضع الاستعداد',
          searchPlaceholder: 'ابحث داخل القائمة...',
          playlistNamePlaceholder: 'اسم قائمة التشغيل...',
          scPlay: 'تشغيل / إيقاف مؤقت',
          scSeek: 'تقديم أو ترجيع 5 ثوان',
          scVol: 'رفع أو خفض الصوت 5%',
          scMute: 'كتم / إعادة الصوت',
          scFull: 'ملء الشاشة للفيديو',
          scPip: 'صورة داخل صورة',
          scAb: 'تكرار مقطع A–B',
          scBookmark: 'حفظ علامة زمنية',
          scStar: 'إضافة الملف الحالي للمفضلة',
          scOpen: 'فتح مجلد محلي',
          scSavePl: 'حفظ القائمة في المكتبة',
          itemsWord: 'عنصر',
          audioWord: 'صوت',
          videoWord: 'فيديو',
          showingWord: 'عرض',
          ofWord: 'من',
          kindVideo: 'فيديو',
          kindAudio: 'صوت',
          savedEmptyHtml: 'لا توجد قوائم تشغيل محفوظة بعد.<br/>افتح مجلدا واضغط على <strong>+ حفظ القائمة</strong> لإضافتها إلى مكتبتك.',
          resumePrefix: 'استئناف',
          readyFromStart: 'جاهزة للتشغيل من البداية',
          deleteWord: 'حذف',
          sortType: 'النوع',
          repeatOff: 'التكرار: متوقف',
          repeatAll: 'التكرار: الكل',
          repeatOne: 'التكرار: ملف واحد',
          reselectHint: 'أعد اختيار المجلد للاستئناف',
          updateChecking: 'جار البحث عن تحديثات جديدة...',
          updateAvailable: 'يتوفر تحديث جديد (v{v}) جاهز للتحميل.',
          updateDownloading: 'جار تحميل التحديث... {p}%',
          updateDownloaded: 'تم تحميل التحديث (v{v}) — أعد التشغيل للتثبيت.',
          updateLatest: 'أنت تستخدم أحدث إصدار من AAZ Player بالفعل.',
          updateDevHint: 'تعمل التحديثات التلقائية داخل نسخة برنامج ويندوز المثبتة.',
          updateBtnDownload: 'تحميل التحديث',
          updateBtnRestart: 'إعادة التشغيل والتثبيت',
          updateError: 'تعذر البحث عن التحديثات حاليا.',
          cmdNewWindow: 'فتح نافذة جديدة',
          cmdAudioOutput: 'مخرج الصوت (سماعة / هاند فري)...',
          outputTitle: 'قناة إخراج الصوت',
          outputSub: 'مستقلة لهذه النافذة أو التبويب فقط',
          outputDefault: 'مخرج الصوت الافتراضي للنظام',
          outputUnlock: 'اختيار أو إظهار أسماء السماعات...',
          outputUnsupported: 'تغيير مخرج الصوت يتطلب متصفح كروم أو إيدج أو برنامج ويندوز.',
          outputSwitched: 'تم تحويل صوت هذه النافذة إلى: {name}',
          outputFailed: 'تعذر تحويل مخرج الصوت لهذا الجهاز.',
          outputNoExtra: 'لم يتم العثور على مخارج صوت إضافية.',
          newWindowBrowserHint: 'في المتصفح افتح تبويبا جديدا من البرنامج واختر مخرج صوت مختلفا له.',
          cmdNewTab: 'تبويب جديد',
          scNewTab: 'فتح تبويب جديد',
          scCloseTab: 'إغلاق التبويب الحالي',
          scSwitchTab: 'التبديل إلى التبويب التالي',
          cmdSubStyle: 'تنسيق وخط الترجمة...',
          subModalTitle: 'إعدادات خط وشكل الترجمة',
          subFontFamily: 'نوع الخط (الخطوط المثبتة على الجهاز)',
          subLoadSysFonts: 'جلب خطوط الجهاز',
          subFontSearchPlaceholder: 'ابحث أو اكتب اسم أي خط مثبت...',
          subTypography: 'الخط واللون والحدود',
          subFontSize: 'حجم الخط',
          subFontWeight: 'سُمك وشكل الخط',
          subWeightNormal: 'عادي (400)',
          subWeightSemi: 'متوسط (600)',
          subWeightBold: 'عريض (700)',
          subWeightExtra: 'عريض جدا (800)',
          subItalic: 'مائل',
          subTextColor: 'لون النص',
          subOutline: 'حدود النص الخارجية',
          subBgBox: 'الخلفية والإطار والموضع',
          subBgColor: 'لون وشفافية الخلفية',
          subBorder: 'إطار خلفية الترجمة',
          subRadius: 'استدارة الحواف',
          subShadow: 'ظل النص',
          subPosition: 'المسافة من أسفل الشاشة',
          subReset: 'استعادة الافتراضي',
          subDone: 'تم',
          subPreviewSample: 'معاينة مباشرة لشكل وخط الترجمة\nAAZ Player — Subtitle Live Preview',
          menuSubtitles: 'الترجمة',
          headingSubSync: 'تقديم وتأخير الترجمة',
          cmdSubEarlier: 'تقديم الترجمة (-0.25 ثانية)',
          cmdSubLater: 'تأخير الترجمة (+0.25 ثانية)',
          cmdSubSyncReset: 'إعادة ضبط التوقيت (0.0 ثانية)',
          scSubSync: 'تقديم أو تأخير الترجمة',
          subSyncHint: 'اختصار سريع: G للتقديم / H للتأخير',
          subSyncNotice: 'توقيت الترجمة: {offset}',
          subAutoLoaded: 'تم ربط الترجمة تلقائيا: {name}',
          cmdPrevFrame: 'الإطار السابق',
          cmdNextFrame: 'الإطار التالي',
          cmdSnapshot: 'التقاط صورة من الفيديو',
          headingAspect: 'نسبة العرض إلى الارتفاع',
          aspectDefault: 'الافتراضي',
          aspectFill: 'ملء وتمديد الشاشة',
          headingZoom: 'التكبير والتصغير',
          zoomQuarter: 'ربع الحجم (0.25x)',
          zoomHalf: 'نصف الحجم (0.5x)',
          zoomOriginal: 'الحجم الأصلي (1:1)',
          zoomLarge: 'تكبير متوسط (1.5x)',
          zoomDouble: 'ضعف الحجم (2.0x)',
          headingCrop: 'قص الحواف',
          cropDefault: 'بدون قص (الافتراضي)',
          cropFill: 'ملء الشاشة بدون حواف',
          cmdResetVideo: 'إعادة ضبط أبعاد الفيديو',
          scFrameStep: 'ترجيع أو تقديم إطار واحد',
          scSnapshot: 'التقاط صورة من الفيديو',
          snapshotSaved: 'تم حفظ الصورة: {name}',
          snapshotFailed: 'تعذر التقاط صورة من الفيديو.',
          snapshotNoVideo: 'شغّل فيديو أولاً لالتقاط صورة.',
          aspectChanged: 'نسبة العرض: {val}',
          zoomChanged: 'التكبير: {val}',
          cropChanged: 'قص الحواف: {val}',
          videoResetNotice: 'تمت إعادة ضبط أبعاد وتكبير وقص الفيديو للافتراضي.',
          btnUndo: 'تراجع',
          sortCustom: 'يدوي',
          sortDuration: 'المدة',
          watchedWord: 'تمت مشاهدته',
          upNextBadge: 'التالي #{n}',
          stopAfterBadge: 'إيقاف بعده',
          plAppendFiles: 'إضافة ملفات للقائمة الحالية...',
          plAppendFolder: 'إضافة مجلد للقائمة الحالية...',
          plShuffleOrder: 'خلط ترتيب القائمة نهائياً',
          plRemoveDupes: 'حذف العناصر المكررة',
          plRemoveWatched: 'حذف ما تمت مشاهدته',
          plClearUpNext: 'مسح قائمة التشغيل التالي',
          plCtxPlay: 'تشغيل الآن',
          plCtxPlayNext: 'تشغيل كالتالي فوراً',
          plCtxRemoveUpNext: 'إزالة من التشغيل التالي',
          plCtxStopAfter: 'إيقاف التشغيل بعد هذا الملف',
          plCtxClearStopAfter: 'إلغاء الإيقاف بعد هذا الملف',
          plCtxMoveTop: 'نقل إلى أعلى القائمة',
          plCtxMoveUp: 'تحريك لأعلى',
          plCtxMoveDown: 'تحريك لأسفل',
          plCtxMoveBottom: 'نقل إلى أسفل القائمة',
          plCtxStar: 'إضافة للمفضلة',
          plCtxUnstar: 'إزالة من المفضلة',
          plCtxWatched: 'تحديد كتمت مشاهدته',
          plCtxUnwatched: 'تحديد كغير مشاهد',
          plCtxResetProg: 'إعادة موضع الاستكمال للبداية',
          plCtxCopyName: 'نسخ اسم الملف',
          plCtxRemove: 'حذف من قائمة التشغيل',
          plRemovedNotice: 'تم حذف "{name}" من قائمة التشغيل.',
          plRestoredNotice: 'تمت استعادة "{name}" إلى قائمة التشغيل.',
          plDupesRemoved: 'تم حذف {n} عنصر مكرر من القائمة.',
          plNoDupes: 'لا توجد عناصر مكررة في القائمة.',
          plWatchedRemoved: 'تم حذف {n} عنصر تمت مشاهدته.',
          plNoWatched: 'لا توجد عناصر محددة كمشاهدة لحذفها.',
          plShuffledNotice: 'تم خلط ترتيب عناصر قائمة التشغيل.',
          plAppendedNotice: 'تمت إضافة {n} عنصر إلى القائمة الحالية.',
          plStopAfterSet: 'سيتوقف التشغيل تلقائياً بعد "{name}".',
          plStopAfterCleared: 'تم إلغاء الإيقاف بعد المقطع.',
          plStoppedAfterNotice: 'توقف التشغيل تلقائياً بعد انتهاء "{name}".',
          plUpNextAdded: 'تمت جدولة "{name}" ليعمل تالياً.',
          plCopiedName: 'تم نسخ الاسم "{name}".',
          savedCtxOpen: 'فتح وتشغيل القائمة',
          savedCtxRename: 'إعادة تسمية القائمة',
          savedCtxDelete: 'حذف القائمة المحفوظة',
          savedDeletedNotice: 'تم حذف القائمة المحفوظة "{name}".',
          savedRestoredNotice: 'تمت استعادة القائمة المحفوظة "{name}".',
          savedRenamedNotice: 'تم تغيير اسم القائمة إلى "{name}".',
          savedFilesMissing: 'تعذر العثور على ملفات القائمة "{name}" على الجهاز (ربما تم نقلها أو حذفها).',
          savedUpdatedNotice: 'تم حفظ "{name}" ({n} عنصر).',
          savedDragHint: 'اسحب لإعادة الترتيب',
          cmdCast: 'بث إلى الشاشة / التلفاز...',
          scCast: 'البث إلى الشاشة أو التلفاز الذكي',
          scReorder: 'تحريك العنصر المحدد لأعلى أو لأسفل',
          scRemoveTrack: 'حذف العنصر المحدد من القائمة',
          castModalTitle: 'البث إلى التلفاز / الشاشة الذكية',
          castDlnaHeading: 'الشاشات الذكية على نفس الشبكة',
          castScan: 'بحث في الشبكة',
          castScanning: 'جاري البحث عن الشاشات...',
          castScanningHint: 'اضغط "بحث في الشبكة" لاكتشاف شاشات التلفاز الذكية المتصلة بنفس شبكة الواي فاي.',
          castNoneFound: 'لم يتم العثور على شاشات متصلة حالياً. تأكد من اتصال التلفاز والكمبيوتر بنفس الشبكة أو استخدم البث عبر رابط الشبكة أو البث اللاسلكي بالأسفل.',
          castDesktopOnly: 'الاكتشاف التلقائي للشاشات والبث المحلي يتطلب تشغيل تطبيق سطح المكتب على ويندوز.',
          castBtnSend: 'بث الآن',
          castBtnConnected: 'جاري البث',
          castLanHeading: 'البث المباشر لمتصفح التلفاز أو الهاتف',
          castStartLan: 'تشغيل بث الشبكة',
          castStopLan: 'إيقاف البث',
          castLanDesc: 'يبث الفيديو والترجمة مباشرة عبر شبكة الواي فاي المنزلية. افتح الرابط التالي في متصفح التلفاز أو الهاتف على نفس الشبكة.',
          castCopyUrl: 'نسخ الرابط',
          castUrlCopied: 'تم نسخ رابط البث! افتحه في التلفاز الذكي أو الهاتف.',
          castWirelessHeading: 'البث اللاسلكي للشاشة والمتصفح',
          castWinMiracast: 'بث شاشة ويندوز اللاسلكي',
          castBrowserRemote: 'بث المتصفح / كروم كاست',
          castPlay: 'تشغيل',
          castPause: 'إيقاف مؤقت',
          castStop: 'إيقاف',
          castNoTrack: 'قم بتشغيل فيديو أو ملف صوتي أولاً قبل بدء البث.',
          castSentNotice: 'جاري بث "{title}" على {device}.',
          castFailedNotice: 'تعذر البث إلى {device}: {err}',
          castBrowserUnsupported: 'بث المتصفح غير مدعوم هنا، استخدم اكتشاف الشاشات أو بث الواي فاي أو بث ويندوز اللاسلكي.',
          cmdThemes: 'أشكال الثيمات (16)...',
          themesBtnTitle: 'معرض الثيمات (16 شكلاً)',
          themesModalTitle: 'معرض الثيمات (16 شكلاً)',
          themesModalSub: 'اختر من بين 16 شكلاً وتصميماً مميزاً تشمل ماينكرافت وليجو وروبلوكس وأركيد وويندوز 95 والمزيد — مع الحفاظ على الهوية الخضراء والوضعين الداكن والفاتح.',
          modeDark: 'داكن',
          modeLight: 'فاتح',
          setSkinLabel: 'شكل وتصميم الواجهة',
          setSkinBtn: 'اختيار شكل الثيم (16)...',
          skinAppliedNotice: 'تم تفعيل الثيم: {name}'
        }
      };

      function t(key, vars = {}) {
        const dict = I18N[state.lang] || I18N.en;
        let str = dict[key] ?? I18N.en[key] ?? key;
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(`{${k}}`, String(v));
        }
        return str;
      }

      function syncThemeGalleryModeButtons() {
        if (el.themeGalleryDarkBtn) {
          el.themeGalleryDarkBtn.classList.toggle('is-active', state.theme !== 'light');
          el.themeGalleryDarkBtn.setAttribute('aria-pressed', String(state.theme !== 'light'));
        }
        if (el.themeGalleryLightBtn) {
          el.themeGalleryLightBtn.classList.toggle('is-active', state.theme === 'light');
          el.themeGalleryLightBtn.setAttribute('aria-pressed', String(state.theme === 'light'));
        }
      }

      function syncActiveSkinReadout() {
        const meta = getSkinMeta(state.skin);
        const label = state.lang === 'ar' ? meta.nameAr : meta.nameEn;
        if (el.setActiveSkinName) el.setActiveSkinName.textContent = label;
      }

      function renderThemeGallery() {
        if (!el.themeGalleryGrid) return;
        const isAr = state.lang === 'ar';
        const frag = document.createDocumentFragment();

        for (const skin of SKINS) {
          const isActive = state.skin === skin.id;
          const card = document.createElement('button');
          card.type = 'button';
          card.className = `theme-card${isActive ? ' is-active' : ''}`;
          card.dataset.skinId = skin.id;
          card.setAttribute('role', 'option');
          card.setAttribute('aria-selected', String(isActive));

          const preview = document.createElement('div');
          preview.className = 'theme-mini-preview';
          preview.setAttribute('data-preview-skin', skin.id);
          preview.setAttribute('aria-hidden', 'true');

          const miniTop = document.createElement('div');
          miniTop.className = 'theme-mini-top';
          const miniTitle = document.createElement('span');
          miniTitle.className = 'theme-mini-title';
          miniTitle.textContent = 'AAZ';
          const miniDots = document.createElement('span');
          miniDots.className = 'theme-mini-dots';
          miniDots.append(
            document.createElement('span'),
            document.createElement('span'),
            document.createElement('span')
          );
          miniTop.append(miniTitle, miniDots);

          const miniMid = document.createElement('div');
          miniMid.className = 'theme-mini-mid';

          const miniStage = document.createElement('div');
          miniStage.className = 'theme-mini-stage';
          const miniPlay = document.createElement('span');
          miniPlay.className = 'theme-mini-play';
          miniPlay.textContent = '▶';
          const miniBar = document.createElement('span');
          miniBar.className = 'theme-mini-bar';
          miniBar.appendChild(document.createElement('i'));
          miniStage.append(miniPlay, miniBar);

          const miniSide = document.createElement('div');
          miniSide.className = 'theme-mini-side';
          miniSide.append(
            document.createElement('span'),
            document.createElement('span'),
            document.createElement('span')
          );

          miniMid.append(miniStage, miniSide);
          preview.append(miniTop, miniMid);

          const info = document.createElement('div');
          info.className = 'theme-card-info';
          const head = document.createElement('div');
          head.className = 'theme-card-head';
          const nameEl = document.createElement('span');
          nameEl.className = 'theme-card-name';
          nameEl.textContent = isAr ? skin.nameAr : skin.nameEn;
          const tagEl = document.createElement('span');
          tagEl.className = 'theme-card-tag';
          tagEl.textContent = isAr ? skin.tagAr : skin.tagEn;
          head.append(nameEl, tagEl);

          const descEl = document.createElement('div');
          descEl.className = 'theme-card-desc';
          descEl.textContent = isAr ? skin.descAr : skin.descEn;

          info.append(head, descEl);
          card.append(preview, info);

          card.addEventListener('click', () => {
            applySkin(skin.id, true, true);
            const chosenName = state.lang === 'ar' ? skin.nameAr : skin.nameEn;
            showNotice(t('skinAppliedNotice', { name: chosenName }));
          });

          frag.appendChild(card);
        }

        el.themeGalleryGrid.replaceChildren(frag);
      }

      function openThemeGalleryModal() {
        closeAllMenus();
        syncThemeGalleryModeButtons();
        renderThemeGallery();
        if (el.themeGalleryModal) el.themeGalleryModal.hidden = false;
      }

      function closeThemeGalleryModal() {
        if (el.themeGalleryModal) el.themeGalleryModal.hidden = true;
      }

      function applySkin(skinId, persist = true, broadcast = true) {
        state.skin = sanitizeSkin(skinId);
        if (state.skin !== DEFAULT_SKIN) {
          document.documentElement.setAttribute('data-skin', state.skin);
        } else {
          document.documentElement.removeAttribute('data-skin');
        }
        if (persist) {
          try {
            localStorage.setItem(SKIN_STORAGE_KEY, state.skin);
          } catch (err) {
            errorHandler.log('storage.skin', err);
          }
        }
        if (broadcast) {
          postToShell('aaz-sync-prefs', { skin: state.skin });
        }
        syncActiveSkinReadout();
        if (el.themeGalleryModal && !el.themeGalleryModal.hidden) {
          el.themeGalleryGrid.querySelectorAll('.theme-card').forEach((card) => {
            const active = card.dataset.skinId === state.skin;
            card.classList.toggle('is-active', active);
            card.setAttribute('aria-selected', String(active));
          });
        }
        if (AudioStudio && el.audioStage && !el.audioStage.hidden) {
          if (el.media.paused) AudioStudio.renderIdleFrame();
        }
      }

      function applyTheme(theme, persist = true, broadcast = true) {
        state.theme = theme === 'light' ? 'light' : 'dark';
        if (state.theme === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
        el.themeSunIcon.style.display = state.theme === 'light' ? 'none' : 'block';
        el.themeMoonIcon.style.display = state.theme === 'light' ? 'block' : 'none';
        syncThemeGalleryModeButtons();
        if (persist) {
          try {
            localStorage.setItem('aaz_theme', state.theme);
          } catch (err) {
            errorHandler.log('storage.theme', err);
          }
        }
        if (broadcast) {
          postToShell('aaz-sync-prefs', { theme: state.theme });
        }
        if (AudioStudio && el.audioStage && !el.audioStage.hidden) {
          if (el.media.paused) AudioStudio.renderIdleFrame();
        }
      }

      function applyLanguage(lang, persist = true, broadcast = true) {
        state.lang = lang === 'ar' ? 'ar' : 'en';
        const isAr = state.lang === 'ar';
        document.documentElement.lang = isAr ? 'ar' : 'en';
        document.documentElement.dir = isAr ? 'rtl' : 'ltr';

        document.querySelectorAll('[data-i18n]').forEach((node) => {
          const key = node.dataset.i18n;
          if (key) node.textContent = t(key);
        });

        el.langToggleBtn.textContent = isAr ? 'EN' : 'عربي';
        el.searchInput.placeholder = t('searchPlaceholder');
        el.savePlNameInput.placeholder = t('playlistNamePlaceholder');
        el.subFontSearchInput.placeholder = t('subFontSearchPlaceholder');
        el.subPreviewBox.textContent = t('subPreviewSample');

        if (persist) {
          try {
            localStorage.setItem('aaz_lang', state.lang);
          } catch (err) {
            errorHandler.log('storage.lang', err);
          }
        }
        if (broadcast) {
          postToShell('aaz-sync-prefs', { lang: state.lang });
        }

        // Refresh dynamic strings immediately
        syncActiveSkinReadout();
        if (el.themeGalleryModal && !el.themeGalleryModal.hidden) renderThemeGallery();
        updateNowPlayingUI();
        updatePlaylistHeader();
        updateSortButtonUI();
        updateShuffleRepeatUI();
        renderSavedPlaylists();
        refreshResumeBanner();
        updateAudioOutputButtonUI();
        renderAudioOutputList();
        if (state.allTracks.length > 0) renderPlaylist();
        syncCastButtonState();
        if (el.castModal && !el.castModal.hidden) renderCastDevices();
        if (phase3) phase3.applyTranslations();
      }

      function setVizMode(mode, persist = true) {
        if (!['spectrum', 'wave', 'orb', 'led'].includes(mode)) mode = 'spectrum';
        state.vizMode = mode;
        el.vizModeBtns.forEach((btn) => {
          btn.classList.toggle('is-active', btn.dataset.viz === mode);
        });
        if (persist) {
          try {
            localStorage.setItem('aaz_viz_mode', mode);
          } catch (err) {
            errorHandler.log('storage.vizMode', err);
          }
        }
        if (el.media.paused || el.media.ended) AudioStudio.renderIdleFrame();
      }

      /* =======================================================================
         4. Web Audio Studio Engine (5-Band EQ + Preamp + 4-Mode Studio Visualizer)
         ======================================================================= */
      const AudioStudio = {
        ctx: null,
        source: null,
        filters: [],
        preamp: null,
        analyser: null,
        freqData: null,
        timeData: null,
        rafId: null,
        initialized: false,
        failed: false,
        barLevels: new Array(40).fill(0),
        barCaps: new Array(40).fill(0),
        ledLevels: new Array(32).fill(0),
        ledCaps: new Array(32).fill(0),
        orbEnergy: 0,
        connecting: false,
        unlockListenerBound: false,

        hasActiveDSP() {
          if (state.preampGain > 1.001) return true;
          return Array.isArray(state.eqGains) && state.eqGains.some((g) => Math.abs(Number(g) || 0) > 0.05);
        },

        needsAudioGraph() {
          return this.hasActiveDSP() || Boolean(el.audioStage && !el.audioStage.hidden);
        },

        bindGestureUnlock() {
          if (this.unlockListenerBound) return;
          this.unlockListenerBound = true;
          const unlock = () => {
            this.unlockListenerBound = false;
            document.removeEventListener('pointerdown', unlock, true);
            document.removeEventListener('keydown', unlock, true);
            if (!this.initialized && this.needsAudioGraph() && !el.media.paused) {
              this.ensureInit(true);
            } else if (this.ctx && this.ctx.state === 'suspended') {
              this.ctx.resume().catch((err) => errorHandler.log('audio.ctx.resumeGesture', err));
            }
          };
          document.addEventListener('pointerdown', unlock, true);
          document.addEventListener('keydown', unlock, true);
        },

        ensureInit(force = false) {
          if (this.failed) return false;
          if (this.initialized) {
            if (this.ctx && this.ctx.state === 'suspended') {
              this.ctx.resume().catch((err) => errorHandler.log('audio.ctx.resume', err));
            }
            return true;
          }
          // Keep native <video>/<audio> OS default playback untouched until EQ, Preamp, or Audio Visualizer is actually needed!
          // This prevents WebView2's AudioContext from silencing newly launched files before a channel is manually chosen.
          if (!force && !this.needsAudioGraph()) {
            return false;
          }
          if (this.connecting) return false;

          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
              this.failed = true;
              return false;
            }
            const effectiveSink = resolveEffectiveSinkId(state.audioSinkId);
            if (!this.ctx) {
              if (effectiveSink) {
                try {
                  this.ctx = new AudioCtx({ sinkId: effectiveSink });
                } catch (err) {
                  this.ctx = new AudioCtx();
                  handleAudioSinkFallback('audio.ctx.constructorSinkId', err);
                }
              } else {
                this.ctx = new AudioCtx();
              }
            }

            const finalizeGraph = () => {
              if (this.initialized || this.failed || !this.ctx) return true;
              try {
                this.source = this.ctx.createMediaElementSource(el.media);

                this.filters = EQ_FREQUENCIES.map((freq, idx) => {
                  const filter = this.ctx.createBiquadFilter();
                  filter.type = idx === 0 ? 'lowshelf' : idx === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
                  filter.frequency.value = freq;
                  filter.Q.value = 1.05;
                  filter.gain.value = state.eqGains[idx] || 0;
                  return filter;
                });

                this.preamp = this.ctx.createGain();
                this.preamp.gain.value = state.preampGain || 1;

                this.analyser = this.ctx.createAnalyser();
                this.analyser.fftSize = 256;
                this.analyser.smoothingTimeConstant = 0.8;
                this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
                this.timeData = new Uint8Array(this.analyser.fftSize);

                let node = this.source;
                for (const f of this.filters) {
                  node.connect(f);
                  node = f;
                }
                node.connect(this.preamp);
                this.preamp.connect(this.analyser);
                this.analyser.connect(this.ctx.destination);

                this.initialized = true;
                this.connecting = false;

                // Bind concrete hardware audio sink if resolved (never call setSinkId('') redundantly on fresh AudioContext)
                const targetSink = resolveEffectiveSinkId(state.audioSinkId);
                if (targetSink && typeof this.ctx.setSinkId === 'function' && this.ctx.sinkId !== targetSink) {
                  this.ctx.setSinkId(targetSink).catch((err) => {
                    handleAudioSinkFallback('audio.ctx.setSinkId', err);
                  });
                }
                return true;
              } catch (err) {
                errorHandler.log('audio.finalizeGraph', err);
                this.connecting = false;
                this.failed = true;
                return false;
              }
            };

            // Only attach MediaElementSource when AudioContext is confirmed running — never hijack <video> with a suspended context!
            if (this.ctx.state === 'running') {
              return finalizeGraph();
            }

            this.connecting = true;
            this.ctx.resume()
              .then(() => {
                this.connecting = false;
                if (this.ctx && this.ctx.state === 'running') {
                  finalizeGraph();
                } else {
                  this.bindGestureUnlock();
                }
              })
              .catch((err) => {
                errorHandler.log('audio.ctx.resumeInit', err);
                this.connecting = false;
                this.bindGestureUnlock();
              });
            return false;
          } catch (err) {
            errorHandler.log('audio.ensureInit', err);
            this.connecting = false;
            this.failed = true;
            return false;
          }
        },

        applyEQ() {
          if (!this.initialized) {
            if (this.hasActiveDSP()) this.ensureInit(true);
            return;
          }
          this.filters.forEach((filter, idx) => {
            filter.gain.setTargetAtTime(state.eqGains[idx] || 0, this.ctx.currentTime, 0.02);
          });
          if (this.preamp) {
            this.preamp.gain.setTargetAtTime(state.preampGain || 1, this.ctx.currentTime, 0.02);
          }
        },

        getPalette() {
          const isLight = state.theme === 'light';
          return isLight
            ? {
                low: 'rgba(18, 108, 66, 0.68)',
                mid: 'rgba(24, 133, 81, 0.92)',
                high: 'rgba(54, 178, 114, 0.98)',
                reflect: 'rgba(24, 133, 81, 0.16)',
                cap: '#b07b16',
                idle: 'rgba(24, 133, 81, 0.24)',
                line: 'rgba(24, 133, 81, 0.22)',
                wave1: 'rgba(24, 133, 81, 0.85)',
                wave2: 'rgba(176, 123, 22, 0.62)',
                waveFill: 'rgba(24, 133, 81, 0.14)',
                coreBg: '#e4efe7',
                coreText: '#10251a'
              }
            : {
                low: 'rgba(26, 108, 62, 0.72)',
                mid: 'rgba(61, 196, 121, 0.94)',
                high: 'rgba(146, 240, 184, 0.98)',
                reflect: 'rgba(61, 196, 121, 0.17)',
                cap: '#e0be72',
                idle: 'rgba(61, 196, 121, 0.24)',
                line: 'rgba(61, 196, 121, 0.18)',
                wave1: 'rgba(72, 214, 136, 0.92)',
                wave2: 'rgba(214, 178, 103, 0.65)',
                waveFill: 'rgba(61, 196, 121, 0.15)',
                coreBg: '#0c1c13',
                coreText: '#edf5ef'
              };
        },

        prepareCanvas() {
          const canvas = el.visualizerCanvas;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.floor(rect.width * dpr);
          const h = Math.floor(rect.height * dpr);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, w, h);
          return { ctx, w, h, dpr };
        },

        startVisualizer() {
          if (this.rafId !== null) return;
          const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          const draw = () => {
            this.renderFrame(prefersReduced);
            if (!el.media.paused && !el.media.ended && !el.audioStage.hidden) {
              this.rafId = requestAnimationFrame(draw);
            } else {
              this.rafId = null;
              this.renderIdleFrame();
            }
          };
          this.rafId = requestAnimationFrame(draw);
        },

        stopVisualizer() {
          if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
          }
          this.renderIdleFrame();
        },

        sampleLogBand(idx, total, prefersReduced, tSec) {
          if (this.initialized && this.freqData && !prefersReduced) {
            const len = this.freqData.length;
            const start = Math.floor(Math.pow(idx / total, 1.55) * (len * 0.82));
            const end = Math.max(start + 1, Math.floor(Math.pow((idx + 1) / total, 1.55) * (len * 0.82)));
            let sum = 0;
            for (let b = start; b < Math.min(len, end); b++) sum += this.freqData[b];
            return Math.min(1, (sum / Math.max(1, end - start)) / 245);
          }
          return 0.14 + 0.14 * Math.abs(Math.sin(tSec * 2.6 + idx * 0.35));
        },

        renderIdleFrame() {
          const prep = this.prepareCanvas();
          if (!prep) return;
          const { ctx, w, h, dpr } = prep;
          const pal = this.getPalette();
          const mode = state.vizMode || 'spectrum';

          if (mode === 'orb') {
            const cx = w / 2;
            const cy = h / 2;
            const baseR = Math.min(w, h) * 0.25;
            ctx.strokeStyle = pal.idle;
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = pal.coreBg;
            ctx.beginPath();
            ctx.arc(cx, cy, baseR * 0.72, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = pal.line;
            ctx.stroke();

            ctx.fillStyle = pal.coreText;
            ctx.font = `700 ${Math.round(baseR * 0.38)}px "Plus Jakarta Sans", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('AAZ', cx, cy + 1 * dpr);
            return;
          }

          if (mode === 'wave') {
            ctx.strokeStyle = pal.idle;
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            for (let x = 0; x <= w; x += 4 * dpr) {
              const y = h / 2 + Math.sin((x / w) * Math.PI * 4) * (4 * dpr);
              if (x === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
            return;
          }

          if (mode === 'led') {
            const cols = 32;
            const gap = 4 * dpr;
            const colW = Math.max(3 * dpr, (w - gap * (cols - 1)) / cols);
            const segH = 4 * dpr;
            ctx.fillStyle = pal.idle;
            for (let i = 0; i < cols; i++) {
              const x = i * (colW + gap);
              ctx.beginPath();
              ctx.roundRect(x, h - segH - 4 * dpr, colW, segH, 1.5 * dpr);
              ctx.fill();
            }
            return;
          }

          // Spectrum idle horizon
          const horizonY = Math.round(h * 0.72);
          ctx.strokeStyle = pal.line;
          ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.moveTo(0, horizonY);
          ctx.lineTo(w, horizonY);
          ctx.stroke();

          const bars = 40;
          const gap = 4 * dpr;
          const barW = Math.max(3 * dpr, (w - gap * (bars - 1)) / bars);
          ctx.fillStyle = pal.idle;
          for (let i = 0; i < bars; i++) {
            const distCenter = Math.abs(i - (bars - 1) / 2) / (bars / 2);
            const restH = (4 + (1 - distCenter) * 7) * dpr;
            const x = i * (barW + gap);
            ctx.beginPath();
            ctx.roundRect(x, horizonY - restH, barW, restH, 2 * dpr);
            ctx.fill();
          }
        },

        renderFrame(prefersReduced) {
          const prep = this.prepareCanvas();
          if (!prep) return;
          const { ctx, w, h, dpr } = prep;
          const pal = this.getPalette();
          const tSec = Date.now() * 0.001;

          if (this.initialized && this.analyser && !prefersReduced) {
            this.analyser.getByteFrequencyData(this.freqData);
            this.analyser.getByteTimeDomainData(this.timeData);
          }

          const mode = state.vizMode || 'spectrum';

          /* --- MODE 1: Mirrored Peak-Hold Spectrum with Horizon Reflection --- */
          if (mode === 'spectrum') {
            const bars = 40;
            const half = bars / 2;
            const gap = 4 * dpr;
            const barW = Math.max(3 * dpr, (w - gap * (bars - 1)) / bars);
            const horizonY = Math.round(h * 0.74);
            const maxBarH = horizonY - 10 * dpr;
            const reflectMax = h - horizonY - 4 * dpr;

            ctx.strokeStyle = pal.line;
            ctx.lineWidth = 1 * dpr;
            ctx.beginPath();
            ctx.moveTo(0, horizonY);
            ctx.lineTo(w, horizonY);
            ctx.stroke();

            const grad = ctx.createLinearGradient(0, horizonY, 0, 8 * dpr);
            grad.addColorStop(0, pal.low);
            grad.addColorStop(0.62, pal.mid);
            grad.addColorStop(1, pal.high);

            for (let i = 0; i < bars; i++) {
              // Mirror center-out: bass in center, shimmering highs toward edges
              const mirrorIdx = i < half ? (half - 1 - i) : (i - half);
              const raw = this.sampleLogBand(mirrorIdx, half, prefersReduced, tSec);
              this.barLevels[i] = Math.max(raw, this.barLevels[i] * 0.87);
              this.barCaps[i] = Math.max(this.barLevels[i], this.barCaps[i] - 0.014);

              const barH = Math.max(3 * dpr, this.barLevels[i] * maxBarH);
              const capY = horizonY - Math.max(barH + 4 * dpr, this.barCaps[i] * maxBarH + 3 * dpr);
              const x = i * (barW + gap);

              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.roundRect(x, horizonY - barH, barW, barH, [3 * dpr, 3 * dpr, 1 * dpr, 1 * dpr]);
              ctx.fill();

              // Golden floating peak-hold cap
              ctx.fillStyle = pal.cap;
              ctx.beginPath();
              ctx.roundRect(x, Math.max(2 * dpr, capY), barW, 2.5 * dpr, 1.5 * dpr);
              ctx.fill();

              // Soft mirror reflection beneath horizon
              const refH = Math.min(reflectMax, barH * 0.32);
              ctx.fillStyle = pal.reflect;
              ctx.beginPath();
              ctx.roundRect(x, horizonY + 2 * dpr, barW, refH, [1 * dpr, 1 * dpr, 2 * dpr, 2 * dpr]);
              ctx.fill();
            }
            return;
          }

          /* --- MODE 2: Aurora Ribbon Wave (Layered Live Waveform) --- */
          if (mode === 'wave') {
            const cy = h * 0.5;
            const amp = h * 0.4;
            const samples = this.timeData && this.initialized && !prefersReduced ? this.timeData.length : 128;

            const drawRibbon = (strokeColor, fillColor, phaseShift, scaleY, lineWidth) => {
              ctx.beginPath();
              for (let i = 0; i < samples; i++) {
                const pct = i / (samples - 1);
                const x = pct * w;
                const envelope = Math.sin(pct * Math.PI); // Smooth tapered ends
                let v = 0;
                if (this.initialized && this.timeData && !prefersReduced) {
                  v = ((this.timeData[i] - 128) / 128) * scaleY;
                } else {
                  v = Math.sin(pct * Math.PI * 5 + tSec * 3.5 + phaseShift) * 0.32 * scaleY;
                }
                const harmonic = Math.sin(pct * Math.PI * 3 + tSec * 2.2 + phaseShift) * 0.08 * scaleY;
                const y = cy + (v + harmonic) * amp * envelope;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              }
              ctx.strokeStyle = strokeColor;
              ctx.lineWidth = lineWidth * dpr;
              ctx.lineJoin = 'round';
              ctx.stroke();

              if (fillColor) {
                ctx.lineTo(w, cy);
                ctx.lineTo(0, cy);
                ctx.closePath();
                ctx.fillStyle = fillColor;
                ctx.fill();
              }
            };

            // Center baseline
            ctx.strokeStyle = pal.line;
            ctx.lineWidth = 1 * dpr;
            ctx.beginPath();
            ctx.moveTo(0, cy);
            ctx.lineTo(w, cy);
            ctx.stroke();

            drawRibbon(pal.wave2, null, 1.3, 0.72, 1.6);
            drawRibbon(pal.wave1, pal.waveFill, 0, 1.05, 2.6);
            return;
          }

          /* --- MODE 3: Radial Pulse Orb (360° Frequency Halo + Pulsing AAZ Core) --- */
          if (mode === 'orb') {
            const cx = w / 2;
            const cy = h / 2;
            const minDim = Math.min(w, h);
            let bassSum = 0;
            for (let b = 0; b < 6; b++) bassSum += this.sampleLogBand(b, 24, prefersReduced, tSec);
            const bass = bassSum / 6;
            this.orbEnergy = Math.max(bass, this.orbEnergy * 0.88);

            const baseR = minDim * (0.23 + this.orbEnergy * 0.055);
            const spokes = 64;
            const maxRay = minDim * 0.22;

            // Soft radial glow
            const glow = ctx.createRadialGradient(cx, cy, baseR * 0.5, cx, cy, baseR + maxRay * 1.15);
            glow.addColorStop(0, pal.waveFill);
            glow.addColorStop(1, 'rgba(61, 196, 121, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(cx, cy, baseR + maxRay * 1.15, 0, Math.PI * 2);
            ctx.fill();

            // 360° radiating bars
            for (let i = 0; i < spokes; i++) {
              const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2;
              const symIdx = i < spokes / 2 ? i : (spokes - 1 - i);
              const val = this.sampleLogBand(symIdx, spokes / 2, prefersReduced, tSec);
              const rayLen = 4 * dpr + val * maxRay;

              const x1 = cx + Math.cos(angle) * (baseR + 3 * dpr);
              const y1 = cy + Math.sin(angle) * (baseR + 3 * dpr);
              const x2 = cx + Math.cos(angle) * (baseR + 3 * dpr + rayLen);
              const y2 = cy + Math.sin(angle) * (baseR + 3 * dpr + rayLen);

              ctx.strokeStyle = val > 0.72 ? pal.cap : pal.mid;
              ctx.lineWidth = 2.4 * dpr;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(x1, y1);
              ctx.lineTo(x2, y2);
              ctx.stroke();
            }

            // Center AAZ Core
            ctx.fillStyle = pal.coreBg;
            ctx.beginPath();
            ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = pal.mid;
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();

            ctx.fillStyle = pal.coreText;
            ctx.font = `800 ${Math.round(baseR * 0.42)}px "Plus Jakarta Sans", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('AAZ', cx, cy + 1 * dpr);
            return;
          }

          /* --- MODE 4: Pro Studio LED Meter (Segmented VU Blocks) --- */
          const cols = 32;
          const rows = 14;
          const gapX = 4 * dpr;
          const gapY = 3 * dpr;
          const colW = Math.max(4 * dpr, (w - gapX * (cols - 1)) / cols);
          const cellH = Math.max(3 * dpr, (h - 8 * dpr - gapY * (rows - 1)) / rows);

          for (let c = 0; c < cols; c++) {
            const raw = this.sampleLogBand(c, cols, prefersReduced, tSec);
            this.ledLevels[c] = Math.max(raw, this.ledLevels[c] * 0.85);
            this.ledCaps[c] = Math.max(this.ledLevels[c], this.ledCaps[c] - 0.016);

            const litRows = Math.max(1, Math.round(this.ledLevels[c] * rows));
            const capRow = Math.min(rows - 1, Math.floor(this.ledCaps[c] * rows));
            const x = c * (colW + gapX);

            for (let r = 0; r < rows; r++) {
              const y = h - 4 * dpr - (r + 1) * cellH - r * gapY;
              const isLit = r < litRows;
              const isCap = r === capRow && this.ledCaps[c] > 0.1;

              if (isCap) {
                ctx.fillStyle = pal.cap;
              } else if (isLit) {
                ctx.fillStyle = r >= rows - 3 ? pal.high : r >= rows * 0.45 ? pal.mid : pal.low;
              } else {
                ctx.fillStyle = pal.line;
              }
              ctx.beginPath();
              ctx.roundRect(x, y, colW, cellH, 1.5 * dpr);
              ctx.fill();
            }
          }
        }
      };

      /* =======================================================================
         5. IndexedDB (Stores Both Last Folder & Per-Playlist Folder Handles!)
         ======================================================================= */
      const HandleStore = {
        open() {
          return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
              reject(new Error('IndexedDB unavailable'));
              return;
            }
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB error'));
          });
        },

        async putHandle(key, handle) {
          try {
            const db = await this.open();
            await new Promise((resolve, reject) => {
              const tx = db.transaction(IDB_STORE, 'readwrite');
              tx.objectStore(IDB_STORE).put(handle, key);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            db.close();
            return true;
          } catch (err) {
            errorHandler.log('idb.putHandle', err);
            return false;
          }
        },

        async getHandle(key) {
          try {
            const db = await this.open();
            const handle = await new Promise((resolve, reject) => {
              const tx = db.transaction(IDB_STORE, 'readonly');
              const req = tx.objectStore(IDB_STORE).get(key);
              req.onsuccess = () => resolve(req.result || null);
              req.onerror = () => reject(req.error);
            });
            db.close();
            return handle;
          } catch (err) {
            errorHandler.log('idb.getHandle', err);
            return null;
          }
        },

        async deleteHandle(key) {
          try {
            const db = await this.open();
            await new Promise((resolve, reject) => {
              const tx = db.transaction(IDB_STORE, 'readwrite');
              tx.objectStore(IDB_STORE).delete(key);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            db.close();
          } catch (err) {
            errorHandler.log('idb.deleteHandle', err);
          }
        }
      };

      const StateStore = {
        load() {
          try {
            return storageManager.load();
          } catch (err) {
            errorHandler.log('storage.load', err);
            return null;
          }
        },

        save(payload) {
          try {
            const res = storageManager.update((latest) => ({ ...latest, ...payload }));
            if (!res.ok) {
              errorHandler.log('storage.save', new Error(res.error || 'Storage write failed'));
              showNotice(
                state.lang === 'ar'
                  ? 'تعذّر حفظ البيانات — مساحة التخزين المحلية ممتلئة أو غير متاحة.'
                  : 'Could not save state — local storage is full or unavailable.',
                true
              );
            }
            return res.ok;
          } catch (err) {
            errorHandler.log('storage.save', err);
            return false;
          }
        },

        clearSessionOnly() {
          try {
            const res = storageManager.update((current) => {
              delete current.trackKey;
              delete current.trackName;
              delete current.trackFullPath;
              delete current.folderName;
              delete current.nativeFolderPath;
              delete current.nativeTrackPaths;
              delete current.currentTime;
              delete current.activeSavedPlaylistId;
              return current;
            });
            return res.ok;
          } catch (err) {
            errorHandler.log('storage.clearSessionOnly', err);
            return false;
          }
        },

        loadSavedPlaylists() {
          const current = this.load();
          return Array.isArray(current?.savedPlaylists) ? current.savedPlaylists : [];
        },

        saveSavedPlaylists(list) {
          try {
            const nextList = Array.isArray(list) ? list : [];
            const res = storageManager.update((current) => {
              current.savedPlaylists = nextList;
              return current;
            });
            if (!res.ok) {
              errorHandler.log('storage.saveSavedPlaylists', new Error(res.error || 'Storage write failed'));
              showNotice(
                state.lang === 'ar'
                  ? 'تعذّر حفظ القائمة — مساحة التخزين المحلية ممتلئة أو غير متاحة.'
                  : 'Could not save playlist — local storage is full or unavailable.',
                true
              );
            }
            return res.ok;
          } catch (err) {
            errorHandler.log('storage.saveSavedPlaylists', err);
            return false;
          }
        }
      };

      const errorHandler = createErrorHandler({
        showToast: (msg, kind) => showNotice(msg, kind === 'error'),
        getLang: () => state.lang,
      });

      /* =======================================================================
         6. Utilities, Subtitle Converter & Playlist Export/Import (.XSPF/.M3U8/.PLS)
         ======================================================================= */
      function getExtension(filename) {
        const idx = filename.lastIndexOf('.');
        if (idx <= 0 || idx === filename.length - 1) return '';
        return filename.slice(idx + 1).toLowerCase();
      }

      function stripExtension(filename) {
        const idx = filename.lastIndexOf('.');
        return idx > 0 ? filename.slice(0, idx) : filename;
      }

      function classifyFile(name, mimeType = '') {
        const ext = getExtension(name);
        if (VIDEO_EXTENSIONS.has(ext)) return { kind: 'video', ext: ext.toUpperCase() };
        if (AUDIO_EXTENSIONS.has(ext)) return { kind: 'audio', ext: ext.toUpperCase() };
        if (SUBTITLE_EXTENSIONS.has(ext)) return { kind: 'subtitle', ext: ext.toUpperCase() };
        if (mimeType) {
          if (mimeType.startsWith('video/')) return { kind: 'video', ext: (ext || 'VIDEO').toUpperCase() };
          if (mimeType.startsWith('audio/')) return { kind: 'audio', ext: (ext || 'AUDIO').toUpperCase() };
        }
        return null;
      }

      function escapeXml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
      }

      function srtToWebVtt(rawText) {
        return convertSrtToWebVtt(rawText, 0);
      }

      function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
        const total = Math.floor(seconds);
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        const mm = String(mins).padStart(2, '0');
        const ss = String(secs).padStart(2, '0');
        return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
      }

      function setRangeFill(inputEl, ratio) {
        const pct = Math.max(0, Math.min(100, ratio * 100));
        inputEl.style.setProperty('--progress', `${pct}%`);
      }

      function showNotice(message, isError = false, undoAction = null) {
        el.statusNoticeText.textContent = message;
        el.statusNotice.classList.toggle('is-error', isError);
        state.noticeUndoHandler = typeof undoAction === 'function' ? undoAction : null;
        if (el.noticeUndoBtn) {
          el.noticeUndoBtn.hidden = !state.noticeUndoHandler;
        }
        el.statusNotice.hidden = false;
      }

      function hideNotice() {
        state.noticeUndoHandler = null;
        if (el.noticeUndoBtn) el.noticeUndoBtn.hidden = true;
        el.statusNotice.hidden = true;
      }

      function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
        if (desktopBridge?.isAndroid && typeof desktopBridge.saveTextFile === 'function') {
          desktopBridge
            .saveTextFile(filename, content, mimeType)
            .catch((err) => errorHandler.log('android.saveTextFile', err));
          return;
        }
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function exportPlaylistFile(format, tracksOverride = null, titleOverride = null) {
        const tracks = tracksOverride || getModeQueue();
        if (!tracks || tracks.length === 0) {
          showNotice('No tracks to export. Load a folder or files first.', true);
          return;
        }
        const title = (titleOverride || state.folderName || 'A-Z Playlist').trim();
        const safeFileName = title.replace(/[\\/:*?"<>|]+/g, '_');
        const exported = buildPlaylistExport(tracks, format, title);
        if (!exported || exported.exportedCount === 0) {
          showNotice(
            state.lang === 'ar'
              ? 'لا توجد مسارات ملفات صالحة للتصدير.'
              : 'No exportable file paths were found for these tracks.',
            true
          );
          return;
        }
        downloadTextFile(`${safeFileName}.${exported.ext}`, exported.content, exported.mime);
        const skippedSuffix = exported.skippedCount > 0 ? ` (${exported.skippedCount} skipped)` : '';
        showNotice(`Exported "${safeFileName}.${exported.ext}" (${exported.exportedCount} tracks${skippedSuffix}).`);
      }

      async function handleImportedPlaylistContent(filename, rawText, baseFilePath = '') {
        const parsed = parsePlaylistText(rawText, filename, baseFilePath);
        const locations = parsed.map((item) => item.location).filter(Boolean);
        if (locations.length === 0) {
          showNotice(`No media entries were found in "${filename}".`, true);
          return;
        }

        // In Desktop app: resolve real file paths directly from disk in exact playlist order!
        if (desktopBridge) {
          const res = await desktopBridge.inspectPaths(locations);
          if (res && res.entries && res.entries.length > 0) {
            const { tracks: rawTracks, subMap } = buildTracksFromElectronEntries(res.entries, {
              preserveOrder: true,
            });
            const byNormPath = new Map();
            for (const tr of rawTracks) {
              if (tr.fullPath) byNormPath.set(normalizeWindowsPath(tr.fullPath), tr);
            }
            const orderedTracks = [];
            const seenNorms = new Set();
            let missingCount = 0;
            for (const loc of locations) {
              const norm = normalizeWindowsPath(loc);
              const found = byNormPath.get(norm);
              if (found) {
                if (!seenNorms.has(norm)) {
                  seenNorms.add(norm);
                  orderedTracks.push(found);
                }
              } else {
                missingCount += 1;
              }
            }
            if (orderedTracks.length > 0) {
              state.sortMode = 'custom';
              updateSortButtonUI();
              await applyLoadedTracks(orderedTracks, subMap, stripExtension(filename), 'electron', {
                restoreSavedPosition: false,
                autoPlay: true,
              });
              const missingNote = missingCount > 0 ? ` (${missingCount} missing)` : '';
              showNotice(`Imported "${filename}" (${orderedTracks.length} tracks loaded${missingNote}).`);
              return;
            }
          }
          showNotice(
            state.lang === 'ar'
              ? `تعذّر العثور على ملفات القائمة "${filename}" على القرص.`
              : `None of the files referenced in "${filename}" were found on disk.`,
            true
          );
          return;
        }

        // In Browser: match imported entries against currently loaded folder tracks safely (no ambiguous basename swaps)
        if (state.allTracks.length > 0) {
          const ordered = [];
          const addedKeys = new Set();
          let missingCount = 0;

          for (const loc of locations) {
            const normLoc = String(loc).replace(/\\/g, '/');
            const base = normLoc.split('/').pop() || '';
            const hasDir = normLoc.includes('/');
            const found = findTrackSafely(state.allTracks, {
              key: normLoc,
              name: hasDir ? '' : base,
            }) || (hasDir
              ? state.allTracks.find((t) => {
                  const tKey = String(t.key || '').replace(/^(?:fs|rel):/i, '').replace(/\\/g, '/').toLowerCase();
                  return tKey === normLoc.toLowerCase() || tKey.endsWith(`/${normLoc.toLowerCase()}`);
                })
              : null);
            if (found && !addedKeys.has(found.key)) {
              addedKeys.add(found.key);
              ordered.push(found);
            } else if (!found) {
              missingCount += 1;
            }
          }

          if (ordered.length > 0) {
            state.sortMode = 'custom';
            updateSortButtonUI();
            state.allTracks = ordered;
            state.folderName = stripExtension(filename);
            updateModeCounts();
            updatePlaylistHeader();
            renderPlaylist();
            await loadTrackByKey(ordered[0].key, { autoPlay: true, startTime: 0 });
            const missingNote = missingCount > 0 ? ` (${missingCount} missing)` : '';
            showNotice(`Applied "${filename}" (${ordered.length} matching tracks${missingNote}).`);
            return;
          }
        }

        showNotice(`Parsed ${locations.length} items from "${filename}". Open the folder containing those files first (or run AAZ Player on Windows to open file paths directly).`);
      }

      /* =======================================================================
         7. Built-In Saved Playlists Library (Exact Snapshots, Reorder & Delete)
         ======================================================================= */
      function normalizeFsPath(p) {
        return String(p || '').trim().replace(/\//g, '\\').toLowerCase();
      }

      function buildSavedTrackMeta(tr) {
        return {
          key: tr.key,
          name: tr.name,
          displayName: tr.displayName,
          folderPath: tr.folderPath || '',
          kind: tr.kind || 'video',
          ext: tr.ext || '',
          fullPath: tr.fullPath || '',
          fileUrl: tr.fileUrl || '',
          duration: tr.duration || 0,
          size: tr.size || 0
        };
      }

      function syncSavedPlaylistsFromStorage() {
        const latest = StateStore.loadSavedPlaylists();
        state.savedPlaylists = latest;
        if (state.activeSavedPlaylistId && !latest.some((p) => p.id === state.activeSavedPlaylistId)) {
          state.activeSavedPlaylistId = null;
        }
        updateSidebarCounts();
        if (state.sidebarTab === 'saved') renderSavedPlaylists();
      }

      function applyTracksSnapshotToSavedEntry(pl, tracks) {
        if (!pl || !Array.isArray(tracks)) return;
        const paths = tracks.map((tr) => tr.fullPath).filter(Boolean);
        pl.trackKeys = tracks.map((tr) => tr.key);
        pl.trackMeta = tracks.map(buildSavedTrackMeta);
        pl.nativeFilePaths = paths;
        pl.trackCount = tracks.length;
        pl.audioCount = tracks.filter((tr) => tr.kind === 'audio').length;
        pl.videoCount = tracks.filter((tr) => tr.kind === 'video').length;
        if (paths.length > 0 && pl.nativeFolderPath) {
          const normFolder = normalizeFsPath(pl.nativeFolderPath).replace(/\\+$/, '') + '\\';
          const allInside = paths.every((fp) => normalizeFsPath(fp).startsWith(normFolder));
          if (!allInside) pl.nativeFolderPath = '';
        }
      }

      async function saveCurrentQueueToLibrary(customName) {
        if (state.allTracks.length === 0) {
          showNotice('Load a folder or files first before saving a playlist.', true);
          return;
        }

        const name = (customName || state.folderName || 'My Playlist').trim();
        const tracks = getModeQueue();
        const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const curTrack = getCurrentTrack();

        let hasIdbHandle = false;
        if (!desktopBridge && state.currentDirHandle) {
          hasIdbHandle = await HandleStore.putHandle(id, state.currentDirHandle);
        }

        const nativeFilePaths = tracks.map((tr) => tr.fullPath).filter(Boolean);
        let verifiedFolderPath = '';
        if (state.nativeFolderPath) {
          const normFolder = normalizeFsPath(state.nativeFolderPath).replace(/\\+$/, '') + '\\';
          const allFromFolder = nativeFilePaths.length > 0 && nativeFilePaths.every((fp) => normalizeFsPath(fp).startsWith(normFolder));
          if (allFromFolder) verifiedFolderPath = state.nativeFolderPath;
        }

        const entry = {
          id,
          name,
          folderName: state.folderName,
          nativeFolderPath: verifiedFolderPath,
          nativeFilePaths,
          hasIdbHandle,
          trackKeys: tracks.map((tr) => tr.key),
          trackMeta: tracks.map(buildSavedTrackMeta),
          trackCount: tracks.length,
          audioCount: tracks.filter((tr) => tr.kind === 'audio').length,
          videoCount: tracks.filter((tr) => tr.kind === 'video').length,
          playlistMode: state.playlistMode,
          lastTrackKey: curTrack ? curTrack.key : (tracks[0]?.key || ''),
          lastTrackName: curTrack ? curTrack.name : (tracks[0]?.name || ''),
          lastTime: curTrack && Number.isFinite(el.media.currentTime) ? Math.floor(el.media.currentTime * 10) / 10 : 0,
          updatedAt: Date.now()
        };

        const latestList = StateStore.loadSavedPlaylists();
        const nextSavedPlaylists = [entry, ...latestList];
        if (!StateStore.saveSavedPlaylists(nextSavedPlaylists)) {
          return;
        }
        state.savedPlaylists = nextSavedPlaylists;
        state.activeSavedPlaylistId = id;
        persistPlaybackState();
        renderSavedPlaylists();
        updateSidebarCounts();

        el.savePlBar.hidden = true;
        el.savePlNameInput.value = '';
        showNotice(t('savedUpdatedNotice', { name, n: tracks.length }));
      }

      function applySavedPlaylistOrder(tracks, savedKeys, strictFilter = false) {
        return filterTracksBySavedPlaylist(tracks, savedKeys, strictFilter);
      }

      let savedPlaylistOpenSeq = 0;

      async function openSavedPlaylist(playlistId) {
        const latestList = StateStore.loadSavedPlaylists();
        state.savedPlaylists = latestList;
        const pl = state.savedPlaylists.find((p) => p.id === playlistId);
        if (!pl) return;
        hideNotice();

        const seq = ++savedPlaylistOpenSeq;
        const targetTrackKey = pl.lastTrackKey;
        const targetTrackName = pl.lastTrackName;
        const targetTime = Number.isFinite(pl.lastTime) ? pl.lastTime : 0;

        // 1. PRIORITY 1 (Desktop): Load the EXACT saved file paths (from nativeFilePaths OR trackMeta.fullPath).
        // This guarantees playlists NEVER mix up with another folder AND automatically heals legacy saved playlists!
        const exactFilePaths = (Array.isArray(pl.nativeFilePaths) && pl.nativeFilePaths.length > 0)
          ? pl.nativeFilePaths.filter(Boolean)
          : (Array.isArray(pl.trackMeta) ? pl.trackMeta.map((m) => m && m.fullPath).filter(Boolean) : []);

        if (desktopBridge && exactFilePaths.length > 0) {
          const res = await desktopBridge.inspectPaths(exactFilePaths);
          if (seq !== savedPlaylistOpenSeq) return;
          if (res && res.entries?.length) {
            const { tracks: rawTracks, subMap } = buildTracksFromElectronEntries(res.entries);
            const byNormPath = new Map();
            for (const tr of rawTracks) {
              if (tr.fullPath) byNormPath.set(normalizeFsPath(tr.fullPath), tr);
            }
            const metaByNormPath = new Map();
            if (Array.isArray(pl.trackMeta)) {
              for (const m of pl.trackMeta) {
                if (m && m.fullPath) metaByNormPath.set(normalizeFsPath(m.fullPath), m);
              }
            }

            const orderedTracks = [];
            const usedKeys = new Set();
            const seenPaths = new Set();
            for (const fp of exactFilePaths) {
              const norm = normalizeFsPath(fp);
              if (!norm || seenPaths.has(norm)) continue;
              const found = byNormPath.get(norm);
              if (!found) continue;
              seenPaths.add(norm);
              const meta = metaByNormPath.get(norm);
              let finalKey = (meta && meta.key) ? meta.key : found.key;
              if (usedKeys.has(finalKey)) {
                let suffix = 2;
                while (usedKeys.has(`${finalKey} (${suffix})`)) suffix++;
                finalKey = `${finalKey} (${suffix})`;
              }
              usedKeys.add(finalKey);
              orderedTracks.push({
                ...found,
                key: finalKey,
                displayName: (meta && meta.displayName) ? meta.displayName : found.displayName,
                folderPath: (meta && meta.folderPath) ? meta.folderPath : found.folderPath,
                duration: found.duration || (meta && meta.duration) || null
              });
            }

            if (orderedTracks.length > 0) {
              state.sortMode = 'custom';
              updateSortButtonUI();
              state.activeSavedPlaylistId = pl.id;
              state.playlistMode = pl.playlistMode || 'all';
              updateModeTabsUI();
              await applyLoadedTracks(orderedTracks, subMap, pl.name, 'electron', {
                restoreSavedPosition: false,
                autoPlay: false,
                keepActiveSavedPlaylist: true,
                nativeFolderPath: ''
              });
              if (seq !== savedPlaylistOpenSeq) return;
              const match = orderedTracks.find((tr) => tr.key === targetTrackKey || tr.name === targetTrackName) || orderedTracks[0];
              if (match) await loadTrackByKey(match.key, { autoPlay: true, startTime: targetTime });
              switchSidebarTab('queue');
              renderSavedPlaylists();
              return;
            }
          }
        }

        // 2. PRIORITY 2 (Desktop): Fallback to saved nativeFolderPath ONLY when no exact file paths existed (F11)
        if (desktopBridge && exactFilePaths.length === 0 && pl.nativeFolderPath) {
          const res = await desktopBridge.readFolder(pl.nativeFolderPath);
          if (seq !== savedPlaylistOpenSeq) return;
          if (res && res.entries?.length) {
            let { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
            if (Array.isArray(pl.trackKeys) && pl.trackKeys.length > 0) {
              tracks = applySavedPlaylistOrder(tracks, pl.trackKeys, true);
              if (tracks.length === 0) {
                showNotice(t('savedFilesMissing', { name: pl.name }), true);
                return;
              }
              state.sortMode = 'custom';
              updateSortButtonUI();
            }
            state.activeSavedPlaylistId = pl.id;
            state.playlistMode = pl.playlistMode || 'all';
            updateModeTabsUI();
            await applyLoadedTracks(tracks, subMap, pl.name, 'electron', {
              restoreSavedPosition: false,
              autoPlay: false,
              keepActiveSavedPlaylist: true,
              nativeFolderPath: res.folderPath
            });
            if (seq !== savedPlaylistOpenSeq) return;
            const match = findTrackSafely(tracks, { key: targetTrackKey, name: targetTrackName }) || tracks[0];
            if (match) await loadTrackByKey(match.key, { autoPlay: true, startTime: targetTime });
            switchSidebarTab('queue');
            renderSavedPlaylists();
            return;
          }
        }

        // 3. Desktop missing-files guard: never silently open a wrong folder!
        if (desktopBridge) {
          showNotice(t('savedFilesMissing', { name: pl.name }), true);
          return;
        }

        // 4. Browser: Stored IndexedDB FileSystemDirectoryHandle for this specific playlist
        if (pl.hasIdbHandle) {
          const handle = await HandleStore.getHandle(pl.id);
          if (seq !== savedPlaylistOpenSeq) return;
          if (handle) {
            try {
              let perm = await handle.queryPermission({ mode: 'read' });
              if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
              if (perm === 'granted') {
                const subMap = new Map();
                let tracks = await scanDirectoryHandle(handle, '', subMap, handle.name || '');
                if (seq !== savedPlaylistOpenSeq) return;
                tracks.sort((a, b) => naturalCollator.compare(a.key, b.key));
                if (tracks.length > 0) {
                  if (Array.isArray(pl.trackKeys) && pl.trackKeys.length > 0) {
                    tracks = applySavedPlaylistOrder(tracks, pl.trackKeys, true);
                    if (tracks.length === 0) {
                      showNotice(t('savedFilesMissing', { name: pl.name }), true);
                      return;
                    }
                    state.sortMode = 'custom';
                    updateSortButtonUI();
                  }
                  state.currentDirHandle = handle;
                  state.activeSavedPlaylistId = pl.id;
                  state.playlistMode = pl.playlistMode || 'all';
                  updateModeTabsUI();
                  await applyLoadedTracks(tracks, subMap, pl.name, 'fsa', {
                    restoreSavedPosition: false,
                    autoPlay: false,
                    keepActiveSavedPlaylist: true,
                    nativeFolderPath: ''
                  });
                  if (seq !== savedPlaylistOpenSeq) return;
                  const match = findTrackSafely(tracks, { key: targetTrackKey, name: targetTrackName }) || tracks[0];
                  if (match) await loadTrackByKey(match.key, { autoPlay: true, startTime: targetTime });
                  switchSidebarTab('queue');
                  renderSavedPlaylists();
                  return;
                }
              }
            } catch (err) {
              errorHandler.log('savedPlaylist.fsaOpen', err);
              // Fall through to folder prompt
            }
          }
        }

        // 5. Browser fallback: prompt user to select the folder and jump straight to saved track + second
        state.activeSavedPlaylistId = pl.id;
        state.savedSession = {
          ...(state.savedSession || {}),
          trackKey: targetTrackKey,
          trackName: targetTrackName,
          currentTime: targetTime,
          folderName: pl.name
        };
        showNotice(`Select folder "${pl.folderName || pl.name}" to resume "${pl.name}" at ${formatTime(targetTime)}.`);
        await openFolderWithPersistence(true);
      }

      async function deleteSavedPlaylist(playlistId) {
        const latestList = StateStore.loadSavedPlaylists();
        const source = latestList.length > 0 ? latestList : state.savedPlaylists;
        const idx = source.findIndex((p) => p.id === playlistId);
        if (idx === -1) return;
        const [removed] = source.splice(idx, 1);

        state.savedPlaylists = source;
        if (state.activeSavedPlaylistId === playlistId) {
          state.activeSavedPlaylistId = null;
        }
        state.lastDeletedSavedPlUndo = { entry: removed, index: idx };

        await HandleStore.deleteHandle(playlistId);
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        persistPlaybackState();
        renderSavedPlaylists();
        updateSidebarCounts();
        showNotice(t('savedDeletedNotice', { name: removed.name }), false, undoLastSavedPlaylistDelete);
      }

      function undoLastSavedPlaylistDelete() {
        const undo = state.lastDeletedSavedPlUndo;
        if (!undo || !undo.entry) return;
        state.lastDeletedSavedPlUndo = null;
        const latestList = StateStore.loadSavedPlaylists();
        const list = latestList.length > 0 ? latestList : [...state.savedPlaylists];
        if (!list.some((p) => p.id === undo.entry.id)) {
          const insertAt = Math.min(Math.max(0, undo.index), list.length);
          list.splice(insertAt, 0, undo.entry);
        }
        state.savedPlaylists = list;
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        renderSavedPlaylists();
        updateSidebarCounts();
        showNotice(t('savedRestoredNotice', { name: undo.entry.name }));
      }

      function renameSavedPlaylist(playlistId, rawNewName) {
        const cleanName = String(rawNewName || '').trim();
        if (!cleanName) return;
        const latestList = StateStore.loadSavedPlaylists();
        const list = latestList.length > 0 ? latestList : [...state.savedPlaylists];
        const pl = list.find((p) => p.id === playlistId);
        if (!pl) return;
        pl.name = cleanName;
        pl.updatedAt = Date.now();
        state.savedPlaylists = list;
        if (state.activeSavedPlaylistId === playlistId) {
          state.folderName = cleanName;
          updatePlaylistHeader();
          notifyShellTabState();
        }
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        renderSavedPlaylists();
        showNotice(t('savedRenamedNotice', { name: cleanName }));
      }

      function startInlineRenameSavedPlaylist(playlistId) {
        const card = el.savedPlaylistsContainer.querySelector(`.saved-pl-card[data-pl-id="${CSS.escape(playlistId)}"]`);
        const pl = state.savedPlaylists.find((p) => p.id === playlistId);
        if (!card || !pl) return;
        const nameEl = card.querySelector('.saved-pl-name');
        if (!nameEl) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'saved-pl-rename-input';
        input.value = pl.name;
        input.setAttribute('aria-label', t('savedCtxRename'));

        let finished = false;
        const commit = (save) => {
          if (finished) return;
          finished = true;
          const nextVal = input.value.trim();
          if (save && nextVal && nextVal !== pl.name) {
            renameSavedPlaylist(playlistId, nextVal);
          } else {
            renderSavedPlaylists();
          }
        };

        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            commit(false);
          }
        });
        input.addEventListener('blur', () => commit(true));

        nameEl.replaceWith(input);
        input.focus();
        input.select();
      }

      function reorderSavedPlaylists(dragId, targetId, insertAfter = false) {
        if (!dragId || !targetId || dragId === targetId) return;
        const latestList = StateStore.loadSavedPlaylists();
        const list = latestList.length > 0 ? latestList : [...state.savedPlaylists];
        const fromIdx = list.findIndex((p) => p.id === dragId);
        if (fromIdx === -1) return;
        const [moved] = list.splice(fromIdx, 1);
        let toIdx = list.findIndex((p) => p.id === targetId);
        if (toIdx === -1) {
          list.push(moved);
        } else {
          if (insertAfter) toIdx += 1;
          list.splice(toIdx, 0, moved);
        }
        state.savedPlaylists = list;
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        renderSavedPlaylists();
      }

      function moveSavedPlaylistRelative(playlistId, direction, focusAfter = false) {
        const latestList = StateStore.loadSavedPlaylists();
        const list = latestList.length > 0 ? latestList : [...state.savedPlaylists];
        const idx = list.findIndex((p) => p.id === playlistId);
        if (idx === -1) return;
        let targetIdx = idx;
        if (direction === 'top') targetIdx = 0;
        else if (direction === 'bottom') targetIdx = list.length - 1;
        else if (direction === 'up') targetIdx = Math.max(0, idx - 1);
        else if (direction === 'down') targetIdx = Math.min(list.length - 1, idx + 1);
        if (targetIdx === idx) return;

        const [moved] = list.splice(idx, 1);
        list.splice(targetIdx, 0, moved);
        state.savedPlaylists = list;
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        renderSavedPlaylists();
        if (focusAfter) {
          const movedCard = el.savedPlaylistsContainer.querySelector(`.saved-pl-card[data-pl-id="${CSS.escape(playlistId)}"]`);
          if (movedCard) movedCard.focus();
        }
      }

      let savedPlDragSuppressClickUntil = 0;

      function startPointerSavedPlReorder(downEvent, sourceCard, pl) {
        const startX = downEvent.clientX;
        const startY = downEvent.clientY;
        const startedOnGrip = Boolean(downEvent.target.closest('.saved-pl-drag-handle'));
        let active = false;
        let ghost = null;
        let dropTargetId = '';
        let dropAfter = false;
        let scrollRaf = null;
        let lastClientY = startY;

        const clearDropHints = () => {
          el.savedPlaylistsContainer.querySelectorAll('.is-drop-before, .is-drop-after').forEach((n) => {
            n.classList.remove('is-drop-before', 'is-drop-after');
          });
        };

        const updateDropTarget = (clientY) => {
          clearDropHints();
          dropTargetId = '';
          const cards = Array.from(el.savedPlaylistsContainer.querySelectorAll('.saved-pl-card'));
          if (cards.length < 2) return;

          let bestCard = null;
          let bestDist = Infinity;
          let after = false;

          for (const c of cards) {
            const rect = c.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            const dist = Math.abs(clientY - mid);
            if (dist < bestDist) {
              bestDist = dist;
              bestCard = c;
              after = clientY > mid;
            }
          }

          if (bestCard && bestCard.dataset.plId !== pl.id) {
            dropTargetId = bestCard.dataset.plId;
            dropAfter = after;
            bestCard.classList.add(after ? 'is-drop-after' : 'is-drop-before');
          }
        };

        const autoScrollLoop = () => {
          if (!active) return;
          const listRect = el.savedPlaylistsContainer.getBoundingClientRect();
          const edge = 36;
          if (lastClientY < listRect.top + edge) {
            el.savedPlaylistsContainer.scrollTop -= Math.max(4, Math.round((listRect.top + edge - lastClientY) * 0.35));
            updateDropTarget(lastClientY);
          } else if (lastClientY > listRect.bottom - edge) {
            el.savedPlaylistsContainer.scrollTop += Math.max(4, Math.round((lastClientY - (listRect.bottom - edge)) * 0.35));
            updateDropTarget(lastClientY);
          }
          scrollRaf = requestAnimationFrame(autoScrollLoop);
        };

        const cleanup = (commitDrop) => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onCancel, true);
          window.removeEventListener('keydown', onKeyDown, true);
          if (scrollRaf !== null) {
            cancelAnimationFrame(scrollRaf);
            scrollRaf = null;
          }
          clearDropHints();
          sourceCard.classList.remove('is-dragging');
          document.body.classList.remove('is-reordering-tracks');
          if (ghost) {
            ghost.remove();
            ghost = null;
          }
          const finalTarget = dropTargetId;
          const finalAfter = dropAfter;
          if (active) {
            savedPlDragSuppressClickUntil = Date.now();
            if (commitDrop && finalTarget && finalTarget !== pl.id) {
              reorderSavedPlaylists(pl.id, finalTarget, finalAfter);
            }
          }
        };

        const onMove = (ev) => {
          lastClientY = ev.clientY;
          if (!active) {
            const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
            if (dist < (startedOnGrip ? 4 : 7)) return;
            active = true;
            closePlaylistMenus();
            sourceCard.classList.add('is-dragging');
            document.body.classList.add('is-reordering-tracks');

            const cardRect = sourceCard.getBoundingClientRect();
            ghost = document.createElement('div');
            ghost.className = 'track-drag-ghost';
            ghost.style.width = `${Math.min(340, Math.max(180, Math.round(cardRect.width)))}px`;
            ghost.innerHTML = `<span class="track-drag-ghost-icon">⋮⋮</span><span class="track-drag-ghost-name"></span>`;
            ghost.querySelector('.track-drag-ghost-name').textContent = pl.name;
            document.body.appendChild(ghost);
            scrollRaf = requestAnimationFrame(autoScrollLoop);
          }

          ev.preventDefault();
          if (ghost) {
            const ghostW = ghost.offsetWidth || 240;
            const left = Math.max(8, Math.min(window.innerWidth - ghostW - 8, ev.clientX - ghostW * 0.35));
            const top = Math.max(8, Math.min(window.innerHeight - 44, ev.clientY - 18));
            ghost.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
          }
          updateDropTarget(ev.clientY);
        };

        const onUp = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKeyDown = (ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            cleanup(false);
          }
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onCancel, true);
        window.addEventListener('keydown', onKeyDown, true);
      }

      function openSavedPlContextMenu(playlistId, clientX, clientY) {
        if (!el.savedPlContextMenu) return;
        const pl = state.savedPlaylists.find((p) => p.id === playlistId);
        if (!pl) return;
        closeAllMenus();
        state.activeContextSavedPlId = playlistId;

        el.savedPlContextMenu.hidden = false;
        el.savedPlContextMenu.style.left = '0px';
        el.savedPlContextMenu.style.top = '0px';
        const rect = el.savedPlContextMenu.getBoundingClientRect();
        const pad = 8;
        const x = Math.min(Math.max(clientX, pad), Math.max(pad, window.innerWidth - rect.width - pad));
        const y = Math.min(Math.max(clientY, pad), Math.max(pad, window.innerHeight - rect.height - pad));
        el.savedPlContextMenu.style.left = `${x}px`;
        el.savedPlContextMenu.style.top = `${y}px`;
      }

      function duplicateSavedPlaylist(plId) {
        const src = state.savedPlaylists.find((p) => p.id === plId);
        if (!src) return;
        const copySuffix = state.lang === 'ar' ? ' (نسخة)' : ' (Copy)';
        const clone = JSON.parse(JSON.stringify(src));
        clone.id = `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        clone.name = `${src.name}${copySuffix}`;
        clone.createdAt = Date.now();
        clone.updatedAt = Date.now();
        const idx = state.savedPlaylists.findIndex((p) => p.id === plId);
        state.savedPlaylists.splice(idx + 1, 0, clone);
        StateStore.saveSavedPlaylists(state.savedPlaylists);
        renderSavedPlaylists();
        showNotice(phase3 ? phase3.p3t('savedDuplicated', { name: clone.name }) : `Duplicated "${clone.name}"`);
      }

      function executeSavedPlContextCommand(cmd) {
        const plId = state.activeContextSavedPlId;
        closePlaylistMenus();
        if (!plId) return;
        const pl = state.savedPlaylists.find((p) => p.id === plId);
        if (!pl) return;

        switch (cmd) {
          case 'open':
            openSavedPlaylist(plId);
            break;
          case 'rename':
            startInlineRenameSavedPlaylist(plId);
            break;
          case 'duplicate':
            duplicateSavedPlaylist(plId);
            break;
          case 'move-top':
            moveSavedPlaylistRelative(plId, 'top');
            break;
          case 'move-up':
            moveSavedPlaylistRelative(plId, 'up');
            break;
          case 'move-down':
            moveSavedPlaylistRelative(plId, 'down');
            break;
          case 'move-bottom':
            moveSavedPlaylistRelative(plId, 'bottom');
            break;
          case 'export-xspf':
            exportPlaylistFile('xspf', pl.trackMeta || [], pl.name);
            break;
          case 'export-m3u8':
            exportPlaylistFile('m3u8', pl.trackMeta || [], pl.name);
            break;
          case 'export-pls':
            exportPlaylistFile('pls', pl.trackMeta || [], pl.name);
            break;
          case 'delete':
            deleteSavedPlaylist(plId);
            break;
        }
      }

      function renderSavedPlaylists() {
        el.savedPlaylistsContainer.innerHTML = '';
        updateSidebarCounts();

        if (state.savedPlaylists.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'no-results';
          empty.innerHTML = t('savedEmptyHtml');
          el.savedPlaylistsContainer.appendChild(empty);
          return;
        }

        const q = phase3 ? phase3.getSavedSearchQuery() : '';
        const visiblePlaylists = q
          ? state.savedPlaylists.filter((pl) => String(pl.name || '').toLowerCase().includes(q))
          : state.savedPlaylists;

        if (visiblePlaylists.length === 0) {
          const noRes = document.createElement('div');
          noRes.className = 'no-results';
          noRes.textContent = phase3 ? phase3.p3t('savedNoMatch') : 'No matching playlists.';
          el.savedPlaylistsContainer.appendChild(noRes);
          return;
        }

        const frag = document.createDocumentFragment();
        for (const pl of visiblePlaylists) {
          const isActive = pl.id === state.activeSavedPlaylistId;
          const card = document.createElement('div');
          card.className = `saved-pl-card${isActive ? ' is-active' : ''}`;
          card.dataset.plId = pl.id;
          card.setAttribute('tabindex', '0');

          const top = document.createElement('div');
          top.className = 'saved-pl-top';

          const dragGrip = document.createElement('span');
          dragGrip.className = 'saved-pl-drag-handle';
          dragGrip.title = t('savedDragHint');
          dragGrip.setAttribute('aria-hidden', 'true');
          dragGrip.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>';

          const titleWrap = document.createElement('div');
          titleWrap.style.minWidth = '0';
          titleWrap.style.flex = '1';

          const nameEl = document.createElement('div');
          nameEl.className = 'saved-pl-name';
          nameEl.textContent = pl.name;

          const metaEl = document.createElement('div');
          metaEl.className = 'saved-pl-meta';
          metaEl.textContent = `${pl.trackCount} ${t('itemsWord')} · ${pl.audioCount} ${t('audioWord')} · ${pl.videoCount} ${t('videoWord')}`;

          titleWrap.append(nameEl, metaEl);

          const headActions = document.createElement('div');
          headActions.className = 'saved-pl-head-actions';

          const quickDelBtn = document.createElement('button');
          quickDelBtn.type = 'button';
          quickDelBtn.className = 'saved-pl-icon-btn is-danger';
          quickDelBtn.title = t('savedCtxDelete');
          quickDelBtn.setAttribute('aria-label', t('savedCtxDelete'));
          quickDelBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
          quickDelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSavedPlaylist(pl.id);
          });

          headActions.appendChild(quickDelBtn);
          top.append(dragGrip, titleWrap, headActions);

          const resumeEl = document.createElement('div');
          resumeEl.className = 'saved-pl-resume';
          resumeEl.textContent = pl.lastTrackName
            ? `${t('resumePrefix')}: ${stripExtension(pl.lastTrackName)} · ${formatTime(pl.lastTime || 0)}`
            : t('readyFromStart');

          const actions = document.createElement('div');
          actions.className = 'saved-pl-actions';

          const exportsGroup = document.createElement('div');
          exportsGroup.className = 'saved-pl-exports';

          for (const fmt of ['xspf', 'm3u8', 'pls']) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mini-link-btn';
            btn.textContent = `.${fmt.toUpperCase()}`;
            btn.title = `.${fmt.toUpperCase()}`;
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              exportPlaylistFile(fmt, pl.trackMeta || [], pl.name);
            });
            exportsGroup.appendChild(btn);
          }

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'mini-link-btn is-danger';
          delBtn.textContent = t('deleteWord');
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSavedPlaylist(pl.id);
          });

          actions.append(exportsGroup, delBtn);
          card.append(top, resumeEl, actions);

          card.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('button, input')) return;
            startPointerSavedPlReorder(e, card, pl);
          });

          card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSavedPlContextMenu(pl.id, e.clientX, e.clientY);
          });

          card.addEventListener('click', (e) => {
            if (e.target.closest('button, input')) return;
            if (Date.now() - savedPlDragSuppressClickUntil < 260) return;
            openSavedPlaylist(pl.id);
          });

          card.addEventListener('keydown', (e) => {
            if (e.target.closest('input')) return;
            if (e.key === 'Enter') {
              openSavedPlaylist(pl.id);
            } else if (e.key === 'Delete') {
              e.preventDefault();
              e.stopPropagation();
              deleteSavedPlaylist(pl.id);
            } else if (e.altKey && e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              moveSavedPlaylistRelative(pl.id, 'up', true);
            } else if (e.altKey && e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              moveSavedPlaylistRelative(pl.id, 'down', true);
            }
          });

          frag.appendChild(card);
        }

        el.savedPlaylistsContainer.appendChild(frag);
      }

      /* =======================================================================
         8. Fullscreen 2-Second Auto-Hide Engine (Hides Overlays + Cursor!)
         ======================================================================= */
      function isFullscreenActive() {
        return Boolean(document.fullscreenElement || document.webkitFullscreenElement || state.electronFsFallback);
      }

      function clearFsIdleTimer() {
        if (state.fsIdleTimer !== null) {
          clearTimeout(state.fsIdleTimer);
          state.fsIdleTimer = null;
        }
      }

      function wakeFullscreenHud() {
        el.videoFrame.classList.remove('is-fs-idle');
        el.videoFrame.classList.add('is-hud-visible');
        clearFsIdleTimer();

        // Hide toolbar, HUD, and mouse cursor completely after 2 seconds of inactivity!
        if (isFullscreenActive()) {
          state.fsIdleTimer = window.setTimeout(() => {
            if (isFullscreenActive()) {
              el.videoFrame.classList.add('is-fs-idle');
              el.videoFrame.classList.remove('is-hud-visible');
            }
          }, FULLSCREEN_IDLE_MS);
        } else {
          // Even in windowed mode, auto-hide the top-right video overlay after 2s idle
          state.fsIdleTimer = window.setTimeout(() => {
            el.videoFrame.classList.remove('is-hud-visible');
          }, FULLSCREEN_IDLE_MS);
        }
      }

      el.videoFrame.addEventListener('mousemove', wakeFullscreenHud);
      el.videoFrame.addEventListener('mousedown', wakeFullscreenHud);
      el.videoFrame.addEventListener('mouseleave', () => {
        if (!isFullscreenActive()) {
          clearFsIdleTimer();
          el.videoFrame.classList.remove('is-hud-visible');
        }
      });

      const onFullscreenChange = () => {
        const active = isFullscreenActive();
        el.dockFullscreenBtn.classList.toggle('is-active', active);
        el.dockFullscreenBtn.setAttribute('aria-pressed', String(active));
        el.dockFsEnterIcon.style.display = active ? 'none' : 'block';
        el.dockFsExitIcon.style.display = active ? 'block' : 'none';
        el.dockFullscreenBtn.title = active ? `${t('btnExitFull')} (F)` : `${t('cmdFullscreen')} (F)`;

        if (active) {
          if (!el.videoFrame.hidden) {
            wakeFullscreenHud();
          } else {
            clearFsIdleTimer();
            el.videoFrame.classList.remove('is-fs-idle');
            el.videoFrame.classList.remove('is-hud-visible');
            requestAnimationFrame(() => AudioStudio.renderIdleFrame());
          }
        } else {
          clearFsIdleTimer();
          el.videoFrame.classList.remove('is-fs-idle');
          el.videoFrame.classList.remove('is-hud-visible');
          if (!el.audioStage.hidden) {
            requestAnimationFrame(() => AudioStudio.renderIdleFrame());
          }
        }
      };
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);

      /* =======================================================================
         9. Derived Queue, Persistence & 2-Second Autosave
         ======================================================================= */
      function getModeQueue() {
        let list = state.allTracks;
        if (state.playlistMode === 'audio') list = list.filter((tItem) => tItem.kind === 'audio');
        else if (state.playlistMode === 'video') list = list.filter((tItem) => tItem.kind === 'video');
        else if (state.playlistMode === 'starred') list = list.filter((tItem) => state.starredKeys.has(tItem.key));

        const sorted = [...list];
        if (state.sortMode === 'custom') {
          return sorted;
        } else if (state.sortMode === 'desc') {
          sorted.sort((a, b) => naturalCollator.compare(b.key, a.key));
        } else if (state.sortMode === 'type') {
          sorted.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'video' ? -1 : 1) : naturalCollator.compare(a.key, b.key)));
        } else if (state.sortMode === 'duration') {
          sorted.sort((a, b) => ((b.duration || 0) - (a.duration || 0)) || naturalCollator.compare(a.key, b.key));
        } else {
          sorted.sort((a, b) => naturalCollator.compare(a.key, b.key));
        }
        return sorted;
      }

      function getVisibleQueue() {
        const queue = getModeQueue();
        const q = state.searchQuery.trim().toLowerCase();
        if (!q) return queue;
        return queue.filter(
          (tItem) =>
            tItem.displayName.toLowerCase().includes(q) ||
            tItem.folderPath.toLowerCase().includes(q) ||
            tItem.ext.toLowerCase().includes(q)
        );
      }

      function getCurrentTrack() {
        return state.currentKey ? state.allTracks.find((tItem) => tItem.key === state.currentKey) || null : null;
      }

      function getCurrentQueuePosition() {
        const queue = getModeQueue();
        return { queue, idx: queue.findIndex((tItem) => tItem.key === state.currentKey) };
      }

      function persistPlaybackState(overrideTime = null) {
        const track = getCurrentTrack();
        const currentTime =
          overrideTime !== null
            ? Math.max(0, overrideTime)
            : Number.isFinite(el.media.currentTime)
              ? el.media.currentTime
              : 0;
        const cleanTime = Math.floor(currentTime * 10) / 10;

        const hasActiveTracks = state.allTracks.length > 0;
        let persistedNativeTrackPaths = [];
        if (hasActiveTracks) {
          if (!state.nativeFolderPath) {
            const seen = new Set();
            for (const tr of state.allTracks) {
              if (!tr.fullPath) continue;
              const norm = normalizeFsPath(tr.fullPath);
              if (seen.has(norm)) continue;
              seen.add(norm);
              persistedNativeTrackPaths.push(tr.fullPath);
              if (persistedNativeTrackPaths.length >= 500) break;
            }
          }
        } else if (Array.isArray(state.savedSession?.nativeTrackPaths)) {
          persistedNativeTrackPaths = state.savedSession.nativeTrackPaths;
        }

        const sessionPatch = {
          trackKey: track ? track.key : (state.savedSession?.trackKey || ''),
          trackName: track ? track.name : (state.savedSession?.trackName || ''),
          trackFullPath: track?.fullPath || (!hasActiveTracks ? (state.savedSession?.trackFullPath || '') : ''),
          folderName: state.folderName || (state.savedSession?.folderName || ''),
          nativeFolderPath: hasActiveTracks ? (state.nativeFolderPath || '') : (state.savedSession?.nativeFolderPath || ''),
          nativeTrackPaths: persistedNativeTrackPaths,
          activeSavedPlaylistId: hasActiveTracks ? state.activeSavedPlaylistId : (state.savedSession?.activeSavedPlaylistId || null),
          currentTime: cleanTime,
          duration: Number.isFinite(el.media.duration) ? el.media.duration : 0,
          volume: el.media.volume,
          muted: el.media.muted,
          playbackRate: el.media.playbackRate,
          playlistMode: state.playlistMode,
          videoDisplayMode: state.videoDisplayMode,
          sortMode: state.sortMode,
          shuffle: state.shuffle,
          repeatMode: state.repeatMode,
          eqPreset: state.eqPreset,
          eqGains: state.eqGains,
          preampGain: state.preampGain,
          starredKeys: Array.from(state.starredKeys),
          watchedKeys: Array.from(state.watchedKeys),
          progressByKey: state.progressByKey,
          bookmarksByKey: state.bookmarksByKey,
          updatedAt: Date.now()
        };

        // Atomic read-latest-modify-write: never resurrects playlists deleted in another tab or wipes Phase 3 domains (F01)
        const res = storageManager.update((latest) => {
          const latestPlaylists = Array.isArray(latest.savedPlaylists) ? latest.savedPlaylists : [];
          state.savedPlaylists = latestPlaylists;

          if (state.activeSavedPlaylistId && state.allTracks.length > 0) {
            const pl = latestPlaylists.find((p) => p.id === state.activeSavedPlaylistId);
            if (pl) {
              if (track) {
                pl.lastTrackKey = track.key;
                pl.lastTrackName = track.name;
                pl.lastTime = cleanTime;
              }
              pl.playlistMode = state.playlistMode;
              if (state.sortMode === 'custom') {
                applyTracksSnapshotToSavedEntry(pl, state.allTracks);
              }
              pl.updatedAt = Date.now();
            } else {
              state.activeSavedPlaylistId = null;
              sessionPatch.activeSavedPlaylistId = null;
            }
          }

          return {
            ...latest,
            ...sessionPatch,
            savedPlaylists: latestPlaylists,
          };
        });

        if (res.ok) {
          state.savedSession = { ...sessionPatch, savedPlaylists: res.state.savedPlaylists };
          if (state.sidebarTab === 'saved') renderSavedPlaylists();
        } else {
          errorHandler.log('storage.persistPlaybackState', new Error(res.error || 'Storage write failed'));
        }
      }

      function startAutosaveTimer() {
        stopAutosaveTimer();
        state.autosaveTimer = window.setInterval(() => {
          if (!el.media.paused && !el.media.ended && state.currentKey) {
            persistPlaybackState();
          }
        }, AUTOSAVE_INTERVAL_MS);
      }

      function stopAutosaveTimer() {
        if (state.autosaveTimer !== null) {
          clearInterval(state.autosaveTimer);
          state.autosaveTimer = null;
        }
      }

      /* =======================================================================
         10. Local Media & Folder Loading (Electron + FSA API + Fallback Input)
         ======================================================================= */
      async function scanDirectoryHandle(dirHandle, relativePrefix = '', subMap = new Map()) {
        const collected = [];
        for await (const [name, entry] of dirHandle.entries()) {
          if (name.startsWith('.')) continue;
          if (entry.kind === 'file') {
            const info = classifyFile(name);
            if (!info) continue;
            const relPath = relativePrefix + name;
            const key = buildCanonicalTrackKey({ relPath, name });
            if (info.kind === 'subtitle') {
              subMap.set(stripExtension(relPath).toLowerCase(), { name, fileHandle: entry, file: null, fullPath: null });
            } else {
              collected.push({
                key, name,
                displayName: stripExtension(name),
                folderPath: relativePrefix.replace(/\/$/, ''),
                kind: info.kind, ext: info.ext,
                fileHandle: entry, file: null, fileUrl: null, fullPath: '',
                size: null, duration: null
              });
            }
          } else if (entry.kind === 'directory') {
            try {
              const nested = await scanDirectoryHandle(entry, `${relativePrefix}${name}/`, subMap);
              collected.push(...nested);
            } catch (err) {
              errorHandler.log('fs.scanNestedDir', err);
            }
          }
        }
        return collected;
      }

      function buildTracksFromFileList(fileList) {
        let inferredFolder = '';
        const tracks = [];
        const subMap = new Map();
        const usedKeys = new Set();
        for (const file of Array.from(fileList || [])) {
          const info = classifyFile(file.name, file.type);
          if (!info) continue;
          const rel = file.webkitRelativePath || '';
          const key = buildCanonicalTrackKey({
            relPath: rel,
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            usedKeys,
          });
          let folderPath = '';
          if (rel) {
            const parts = rel.split('/');
            if (!inferredFolder && parts.length > 1) inferredFolder = parts[0];
            if (parts.length > 2) folderPath = parts.slice(1, -1).join('/');
          }
          if (info.kind === 'subtitle') {
            subMap.set(stripExtension(rel || file.name).toLowerCase(), { name: file.name, fileHandle: null, file, fullPath: null });
            continue;
          }
          tracks.push({
            key, name: file.name,
            displayName: stripExtension(file.name),
            folderPath, kind: info.kind, ext: info.ext,
            fileHandle: null, file, fileUrl: null, fullPath: '',
            size: file.size, duration: null
          });
        }
        tracks.sort((a, b) => naturalCollator.compare(a.key, b.key));
        return { tracks, subMap, folderName: inferredFolder || 'Selected Media' };
      }

      function buildTracksFromElectronEntries(entries, { preserveOrder = false } = {}) {
        const tracks = [];
        const subMap = new Map();
        const usedKeys = new Set();
        for (const item of entries || []) {
          if (item.kind === 'subtitle') {
            const subBase = item.fullPath
              ? stripExtension(normalizeWindowsPath(item.fullPath))
              : stripExtension(item.key || item.name || '').toLowerCase();
            subMap.set(subBase, {
              name: item.name, fileHandle: null, file: null, fullPath: item.fullPath
            });
          } else {
            const key = buildCanonicalTrackKey({
              fullPath: item.fullPath || '',
              relPath: item.key || '',
              name: item.name,
              size: item.size,
              usedKeys,
            });
            tracks.push({
              key,
              name: item.name,
              displayName: stripExtension(item.name),
              folderPath: item.folderPath || extractParentFolderLabel(item.fullPath),
              kind: item.kind, ext: item.ext,
              fileHandle: null, file: null,
              fileUrl: item.fileUrl, fullPath: item.fullPath || '',
              size: item.size || null, duration: null
            });
          }
        }
        if (!preserveOrder) {
          tracks.sort((a, b) => naturalCollator.compare(a.key, b.key));
        }
        return { tracks, subMap };
      }

      async function openFolderWithPersistence(autoPlayOnLoad = false) {
        hideNotice();

        if (desktopBridge) {
          try {
            const res = await desktopBridge.selectFolder();
            if (!res) return;
            const { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
            if (tracks.length === 0) {
              showNotice(`No supported audio or video files were found in "${res.folderName}".`, true);
              return;
            }
            state.currentDirHandle = null;
            await applyLoadedTracks(tracks, subMap, res.folderName, 'electron', {
              restoreSavedPosition: true,
              autoPlay: autoPlayOnLoad,
              nativeFolderPath: res.folderPath
            });
            return;
          } catch (err) {
            showNotice(`Could not open folder: ${err?.message || 'Error'}`, true);
            return;
          }
        }

        const pickerFn =
          (IS_TAB_FRAME && typeof window.parent.showDirectoryPicker === 'function')
            ? window.parent.showDirectoryPicker.bind(window.parent)
            : (typeof window.showDirectoryPicker === 'function' ? window.showDirectoryPicker.bind(window) : null);

        if (!pickerFn) {
          state.resumeAutoPlayPending = autoPlayOnLoad;
          el.dirInput.value = '';
          el.dirInput.click();
          return;
        }

        try {
          const dirHandle = await pickerFn({ id: 'aaz-media-folder', mode: 'read' });
          await loadFromDirectoryHandle(dirHandle, {
            saveHandle: true, restoreSavedPosition: true, autoPlay: autoPlayOnLoad
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          if (err && err.name === 'SecurityError') {
            state.resumeAutoPlayPending = autoPlayOnLoad;
            el.dirInput.value = '';
            el.dirInput.click();
            return;
          }
          showNotice(`Could not open folder: ${err?.message || 'Unknown error'}`, true);
        }
      }

      async function openFilesPicker() {
        hideNotice();
        if (desktopBridge && desktopBridge.selectFiles) {
          const res = await desktopBridge.selectFiles();
          if (!res) return;
          if (res.playlists && res.playlists.length > 0) {
            await handleImportedPlaylistContent(
              res.playlists[0].name,
              res.playlists[0].content,
              res.playlists[0].fullPath || ''
            );
            return;
          }
          if (!res.entries?.length) return;
          const { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
          if (tracks.length === 0) return;
          await applyLoadedTracks(tracks, subMap, t('currentQueue'), 'electron', {
            restoreSavedPosition: true, autoPlay: false, nativeFolderPath: ''
          });
          return;
        }
        el.filesInput.value = '';
        el.filesInput.click();
      }

      async function loadFromDirectoryHandle(dirHandle, options = {}) {
        const { saveHandle = true, restoreSavedPosition = true, autoPlay = false } = options;
        const subMap = new Map();
        const tracks = await scanDirectoryHandle(dirHandle, '', subMap);
        tracks.sort((a, b) => naturalCollator.compare(a.key, b.key));
        if (tracks.length === 0) {
          showNotice(`No supported audio or video files were found in "${dirHandle.name}".`, true);
          return false;
        }
        state.currentDirHandle = dirHandle;
        if (saveHandle) {
          await HandleStore.putHandle(IDB_LAST_DIR_KEY, dirHandle);
          state.savedDirHandle = dirHandle;
        }
        await applyLoadedTracks(tracks, subMap, dirHandle.name, 'fsa', { restoreSavedPosition, autoPlay, nativeFolderPath: '' });
        return true;
      }

      function findLegacyHistoryFullPath(saved) {
        if (!saved || !phase3 || !phase3.historyManager) return '';
        const entries = phase3.historyManager.getEntries();
        if (!Array.isArray(entries) || entries.length === 0) return '';
        const match = entries.find((h) =>
          h && h.fullPath && (
            (saved.trackKey && h.relPath && String(h.relPath).toLowerCase() === String(saved.trackKey).toLowerCase()) ||
            (saved.trackName && h.name === saved.trackName)
          )
        );
        return match ? match.fullPath : '';
      }

      async function handleResumeLastSession() {
        hideNotice();
        const saved = state.savedSession;
        const latestPlaylists = StateStore.loadSavedPlaylists();
        state.savedPlaylists = latestPlaylists;

        // 1. If the previous session was a Saved Playlist, reopen & auto-play it directly
        if (saved?.activeSavedPlaylistId && state.savedPlaylists.some((p) => p.id === saved.activeSavedPlaylistId)) {
          await openSavedPlaylist(saved.activeSavedPlaylistId);
          el.resumeBanner.hidden = true;
          return;
        }

        // 2. Desktop: restore saved folder directly without opening Windows Explorer
        if (desktopBridge && saved?.nativeFolderPath) {
          try {
            const res = await desktopBridge.readFolder(saved.nativeFolderPath);
            if (res && res.entries?.length) {
              const { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
              if (tracks.length > 0) {
                await applyLoadedTracks(tracks, subMap, res.folderName, 'electron', {
                  restoreSavedPosition: true, autoPlay: true, nativeFolderPath: res.folderPath
                });
                el.resumeBanner.hidden = true;
                return;
              }
            }
          } catch (err) {
            errorHandler.log('session.resumeNativeFolder', err);
          }
        }

        // 3. Desktop: restore saved file paths / trackFullPath / legacy Watch History path directly
        if (desktopBridge && desktopBridge.inspectPaths) {
          const candidatePaths = [];
          const seen = new Set();
          const addCandidate = (fp) => {
            if (!fp || typeof fp !== 'string') return;
            const norm = normalizeFsPath(fp);
            if (!norm || seen.has(norm)) return;
            seen.add(norm);
            candidatePaths.push(fp);
          };
          if (Array.isArray(saved?.nativeTrackPaths)) {
            for (const fp of saved.nativeTrackPaths) addCandidate(fp);
          }
          if (saved?.trackFullPath) addCandidate(saved.trackFullPath);
          if (candidatePaths.length === 0) {
            const legacyPath = findLegacyHistoryFullPath(saved);
            if (legacyPath) addCandidate(legacyPath);
          }

          if (candidatePaths.length > 0) {
            try {
              const res = await desktopBridge.inspectPaths(candidatePaths);
              if (res && res.entries?.length) {
                const { tracks: rawTracks, subMap } = buildTracksFromElectronEntries(res.entries);
                const byNorm = new Map();
                for (const tr of rawTracks) {
                  if (tr.fullPath) byNorm.set(normalizeFsPath(tr.fullPath), tr);
                }
                const orderedTracks = [];
                const addedNorms = new Set();
                for (const fp of candidatePaths) {
                  const norm = normalizeFsPath(fp);
                  const found = byNorm.get(norm);
                  if (found && !addedNorms.has(norm)) {
                    addedNorms.add(norm);
                    orderedTracks.push(found);
                  }
                }
                for (const tr of rawTracks) {
                  const norm = tr.fullPath ? normalizeFsPath(tr.fullPath) : '';
                  if (!norm || !addedNorms.has(norm)) orderedTracks.push(tr);
                }

                if (orderedTracks.length > 0) {
                  await applyLoadedTracks(
                    orderedTracks,
                    subMap,
                    saved?.folderName || res.folderName || t('currentQueue'),
                    'electron',
                    { restoreSavedPosition: true, autoPlay: true, nativeFolderPath: '' }
                  );
                  el.resumeBanner.hidden = true;
                  return;
                }
              }
            } catch (err) {
              errorHandler.log('session.resumeNativePaths', err);
            }
          }

          // Desktop guard: never unexpectedly pop open Windows Explorer if files were moved/deleted
          showNotice(t('resumeFilesMissing'), true);
          return;
        }

        // 4. Browser mode: stored FileSystemDirectoryHandle
        if (state.savedDirHandle) {
          try {
            let perm = await state.savedDirHandle.queryPermission({ mode: 'read' });
            if (perm !== 'granted') perm = await state.savedDirHandle.requestPermission({ mode: 'read' });
            if (perm !== 'granted') {
              showNotice('Folder read permission was denied. Click "Resume Last Session" again or pick the folder manually.', true);
              return;
            }
            const ok = await loadFromDirectoryHandle(state.savedDirHandle, {
              saveHandle: false, restoreSavedPosition: true, autoPlay: true
            });
            if (ok) el.resumeBanner.hidden = true;
            return;
          } catch (err) {
            errorHandler.log('session.resumeDir', err);
            showNotice('The saved folder could not be accessed. Please re-select it.', true);
          }
        }

        if (saved && saved.trackName) {
          await openFolderWithPersistence(true);
        }
      }

      async function applyLoadedTracks(tracks, subMap, folderName, sourceMode, options = {}) {
        const {
          restoreSavedPosition = true,
          autoPlay = false,
          keepActiveSavedPlaylist = false,
          nativeFolderPath = '',
          startTime = 0
        } = options;
        trackLoadGen += 1;
        subtitleOpGen += 1;
        stopAutosaveTimer();
        el.media.pause();
        revokeMediaUrls();
        clearABLoop();

        if (!keepActiveSavedPlaylist) {
          state.activeSavedPlaylistId = null;
        }
        state.nativeFolderPath = typeof nativeFolderPath === 'string' ? nativeFolderPath : '';
        state.allTracks = tracks;
        state.subtitlesByBaseKey = subMap || new Map();
        state.folderName = folderName;
        state.sourceMode = sourceMode;
        state.currentKey = '';
        state.searchQuery = '';
        el.searchInput.value = '';
        el.resumeBanner.hidden = true;

        if (getModeQueue().length === 0 && state.playlistMode !== 'all') {
          state.playlistMode = 'all';
          updateModeTabsUI();
        }

        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        renderPlaylist();

        const saved = restoreSavedPosition ? state.savedSession : null;
        const matched = saved
          ? findTrackSafely(tracks, {
              fullPath: saved.trackFullPath || '',
              key: saved.trackKey || '',
              name: saved.trackName || '',
            })
          : null;

        if (matched) {
          const seekTo = Number.isFinite(saved.currentTime) ? saved.currentTime : 0;
          await loadTrackByKey(matched.key, { autoPlay, startTime: seekTo });
        } else {
          const first = getModeQueue()[0] || tracks[0];
          const explicitStart = Number.isFinite(startTime) && startTime > 0 ? startTime : 0;
          if (first) await loadTrackByKey(first.key, { autoPlay, startTime: explicitStart });
        }
      }

      /* =======================================================================
         11. Playback, Subtitles & Transport Logic
         ======================================================================= */
      function hexToRgba(hex, opacityPct) {
        const clean = String(hex || '#000000').replace('#', '');
        const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
        const r = parseInt(full.slice(0, 2), 16) || 0;
        const g = parseInt(full.slice(2, 4), 16) || 0;
        const b = parseInt(full.slice(4, 6), 16) || 0;
        const a = Math.max(0, Math.min(1, Number(opacityPct) / 100));
        return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
      }

      function applySubtitleStyleToDOM() {
        const s = state.subtitleStyle;
        const fontStack = s.fontFamily ? `"${s.fontFamily.replace(/"/g, '')}", 'Cairo', 'Segoe UI', sans-serif` : `'Cairo', 'Segoe UI', sans-serif`;
        const bgRgba = hexToRgba(s.bgColor, s.bgOpacity);
        const shadowCss = s.shadowBlur > 0 ? `0 2px ${s.shadowBlur}px rgba(0, 0, 0, 0.92)` : 'none';

        el.subtitleOverlay.style.setProperty('--sub-font', fontStack);
        el.subtitleOverlay.style.setProperty('--sub-size', `${s.fontSize}px`);
        el.subtitleOverlay.style.setProperty('--sub-weight', String(s.fontWeight));
        el.subtitleOverlay.style.setProperty('--sub-italic', s.italic ? 'italic' : 'normal');
        el.subtitleOverlay.style.setProperty('--sub-color', s.textColor);
        el.subtitleOverlay.style.setProperty('--sub-bg', bgRgba);
        el.subtitleOverlay.style.setProperty('--sub-border-color', s.borderColor);
        el.subtitleOverlay.style.setProperty('--sub-border-w', `${s.borderWidth}px`);
        el.subtitleOverlay.style.setProperty('--sub-radius', `${s.borderRadius}px`);
        el.subtitleOverlay.style.setProperty('--sub-outline-color', s.outlineColor);
        el.subtitleOverlay.style.setProperty('--sub-outline-w', `${s.outlineWidth}px`);
        el.subtitleOverlay.style.setProperty('--sub-shadow', shadowCss);
        el.subtitleOverlay.style.setProperty('--sub-bottom', `${s.bottomOffset}%`);

        // Mirror exact styling on the Live Preview box inside the modal
        const p = el.subPreviewBox.style;
        p.fontFamily = fontStack;
        p.fontSize = `${Math.min(36, Math.max(15, s.fontSize * 0.78))}px`;
        p.fontWeight = String(s.fontWeight);
        p.fontStyle = s.italic ? 'italic' : 'normal';
        p.color = s.textColor;
        p.backgroundColor = bgRgba;
        p.border = `${s.borderWidth}px solid ${s.borderColor}`;
        p.borderRadius = `${s.borderRadius}px`;
        p.webkitTextStroke = `${s.outlineWidth}px ${s.outlineColor}`;
        p.textShadow = shadowCss;
      }

      function syncSubtitleControlsUI() {
        const s = state.subtitleStyle;
        el.subFontSizeRange.value = String(s.fontSize);
        el.subFontSizeVal.textContent = `${s.fontSize}px`;
        el.subFontWeightSelect.value = String(s.fontWeight);
        el.subItalicBtn.classList.toggle('btn-primary', Boolean(s.italic));
        el.subItalicBtn.setAttribute('aria-pressed', String(Boolean(s.italic)));
        el.subTextColorInput.value = s.textColor;
        el.subTextColorVal.textContent = s.textColor;
        el.subOutlineColorInput.value = s.outlineColor;
        el.subOutlineWidthRange.value = String(s.outlineWidth);
        el.subOutlineVal.textContent = `${s.outlineWidth}px`;
        el.subBgColorInput.value = s.bgColor;
        el.subBgOpacityRange.value = String(s.bgOpacity);
        el.subBgOpacityVal.textContent = `${s.bgOpacity}%`;
        el.subBorderColorInput.value = s.borderColor;
        el.subBorderWidthRange.value = String(s.borderWidth);
        el.subBorderVal.textContent = `${s.borderWidth}px`;
        el.subRadiusRange.value = String(s.borderRadius);
        el.subRadiusVal.textContent = `${s.borderRadius}px`;
        el.subShadowRange.value = String(s.shadowBlur);
        el.subShadowVal.textContent = `${s.shadowBlur}px`;
        el.subPositionRange.value = String(s.bottomOffset);
        el.subPositionVal.textContent = `${s.bottomOffset}%`;
        setRangeFill(el.subFontSizeRange, (s.fontSize - 14) / (72 - 14));
        setRangeFill(el.subOutlineWidthRange, s.outlineWidth / 6);
        setRangeFill(el.subBgOpacityRange, s.bgOpacity / 100);
        setRangeFill(el.subBorderWidthRange, s.borderWidth / 5);
        setRangeFill(el.subRadiusRange, s.borderRadius / 22);
        setRangeFill(el.subShadowRange, s.shadowBlur / 16);
        setRangeFill(el.subPositionRange, (s.bottomOffset - 2) / (40 - 2));
      }

      function updateSubtitleStyle(patch, persist = true, broadcast = true) {
        state.subtitleStyle = sanitizeSubtitleStyle({ ...state.subtitleStyle, ...patch });
        applySubtitleStyleToDOM();
        syncSubtitleControlsUI();
        if (persist) {
          try {
            localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(state.subtitleStyle));
          } catch (err) {
            errorHandler.log('storage.subtitleStyle', err);
          }
        }
        if (broadcast) {
          postToShell('aaz-sync-prefs', { subtitleStyle: state.subtitleStyle });
        }
      }

      function renderFontPickerList() {
        const query = (el.subFontSearchInput.value || '').trim().toLowerCase();
        const filtered = state.systemFonts.filter((f) => !query || f.toLowerCase().includes(query));
        el.subFontCountLabel.textContent = `${filtered.length}`;
        el.subFontList.innerHTML = '';

        const frag = document.createDocumentFragment();
        const visibleList = filtered.slice(0, 260);
        visibleList.forEach((fontName) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `sub-font-option${state.subtitleStyle.fontFamily === fontName ? ' is-active' : ''}`;
          btn.textContent = fontName;
          btn.title = fontName;
          btn.style.fontFamily = `"${fontName.replace(/"/g, '')}", sans-serif`;
          btn.addEventListener('click', () => {
            updateSubtitleStyle({ fontFamily: fontName }, true, true);
            renderFontPickerList();
          });
          frag.appendChild(btn);
        });

        // Allow direct custom font name entry if user typed a font not shown
        if (query && !filtered.some((f) => f.toLowerCase() === query)) {
          const customName = el.subFontSearchInput.value.trim();
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sub-font-option is-active';
          btn.textContent = `"${customName}"`;
          btn.addEventListener('click', () => {
            updateSubtitleStyle({ fontFamily: customName }, true, true);
            renderFontPickerList();
          });
          frag.appendChild(btn);
        }

        el.subFontList.appendChild(frag);
      }

      async function loadSystemFonts(userTriggered = false) {
        const found = new Set(FALLBACK_FONTS);
        try {
          if (desktopBridge && typeof desktopBridge.listSystemFonts === 'function') {
            const sysList = await desktopBridge.listSystemFonts();
            if (Array.isArray(sysList)) {
              sysList.forEach((name) => { if (name) found.add(name); });
              state.systemFontsLoaded = true;
            }
          } else if (typeof window.queryLocalFonts === 'function') {
            const localFonts = await window.queryLocalFonts();
            if (Array.isArray(localFonts)) {
              localFonts.forEach((f) => { if (f && f.family) found.add(f.family); });
              state.systemFontsLoaded = true;
            }
          } else if (IS_TAB_FRAME && typeof window.parent.queryLocalFonts === 'function') {
            const localFonts = await window.parent.queryLocalFonts();
            if (Array.isArray(localFonts)) {
              localFonts.forEach((f) => { if (f && f.family) found.add(f.family); });
              state.systemFontsLoaded = true;
            }
          }
        } catch (err) {
          errorHandler.log('fonts.loadSystem', err);
          if (userTriggered) {
            showNotice(state.lang === 'ar' ? 'تم عرض الخطوط الأساسية المتاحة.' : 'Showing standard system fonts.');
          }
        }

        state.systemFonts = [...found].sort((a, b) => a.localeCompare(b));
        renderFontPickerList();
      }

      function openSubtitleStyleModal() {
        el.subPreviewBox.textContent = t('subPreviewSample');
        applySubtitleStyleToDOM();
        syncSubtitleControlsUI();
        el.subtitleModal.hidden = false;
        if (!state.systemFontsLoaded) {
          loadSystemFonts(false);
        } else {
          renderFontPickerList();
        }
      }

      function formatSubtitleOffset(sec) {
        const clean = Math.round((Number(sec) || 0) * 100) / 100;
        const sign = clean > 0 ? '+' : '';
        return `${sign}${clean.toFixed(1)}s`;
      }

      function updateSubtitleOffsetUI() {
        el.subOffsetReadout.textContent = formatSubtitleOffset(state.subtitleOffsetSec);
      }

      function adjustSubtitleOffset(deltaSec, showToast = true) {
        state.subtitleOffsetSec = Math.max(-60, Math.min(60, Math.round((state.subtitleOffsetSec + deltaSec) * 100) / 100));
        updateSubtitleOffsetUI();
        renderActiveSubtitleCues();
        if (showToast) {
          showNotice(t('subSyncNotice', { offset: formatSubtitleOffset(state.subtitleOffsetSec) }));
        }
      }

      function resetSubtitleOffset(showToast = true) {
        state.subtitleOffsetSec = 0;
        updateSubtitleOffsetUI();
        renderActiveSubtitleCues();
        if (showToast) {
          showNotice(t('subSyncNotice', { offset: formatSubtitleOffset(0) }));
        }
      }

      async function readSubtitleFileSmart(file) {
        if (!file) return '';
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
            return new TextDecoder('utf-16le').decode(buf);
          }
          if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
            return new TextDecoder('utf-16be').decode(buf);
          }
          try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch (utf8Err) {
            errorHandler.log('subtitle.decodeUtf8Fallback', utf8Err);
            try {
              return new TextDecoder('windows-1256').decode(buf);
            } catch (win1256Err) {
              errorHandler.log('subtitle.decodeWin1256Fallback', win1256Err);
              return await file.text();
            }
          }
        } catch (err) {
          errorHandler.log('subtitle.readSmart', err);
          return await file.text();
        }
      }

      function renderActiveSubtitleCues() {
        const tracks = el.media.textTracks;
        if (!state.subtitlesEnabled || !state.activeSubtitleUrl || !tracks || tracks.length === 0) {
          el.subtitleCueStack.innerHTML = '';
          el.subtitleOverlay.hidden = true;
          return;
        }
        const track = tracks[0];
        if (track.mode !== 'hidden') track.mode = 'hidden';

        let matchedCues = [];
        if (Math.abs(state.subtitleOffsetSec) > 0.001 && track.cues && track.cues.length > 0) {
          // Positive offset = delay subtitles (show later); Negative offset = advance subtitles (show earlier)
          const effectiveTime = el.media.currentTime - state.subtitleOffsetSec;
          for (let i = 0; i < track.cues.length; i++) {
            const c = track.cues[i];
            if (effectiveTime >= c.startTime && effectiveTime <= c.endTime) {
              matchedCues.push(c);
            }
          }
        } else if (track.activeCues && track.activeCues.length > 0) {
          matchedCues = Array.from(track.activeCues);
        }

        if (matchedCues.length === 0) {
          el.subtitleCueStack.innerHTML = '';
          el.subtitleOverlay.hidden = true;
          return;
        }

        el.subtitleCueStack.innerHTML = '';
        for (let i = 0; i < matchedCues.length; i++) {
          const cue = matchedCues[i];
          const rawText = String(cue.text || '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .trim();
          if (!rawText) continue;
          const box = document.createElement('div');
          box.className = 'subtitle-cue-box';
          box.setAttribute('dir', 'auto');
          box.textContent = rawText;
          el.subtitleCueStack.appendChild(box);
        }
        el.subtitleOverlay.hidden = el.subtitleCueStack.children.length === 0;
      }

      function clearActiveSubtitles({ cancelPending = true } = {}) {
        if (cancelPending) subtitleOpGen += 1;
        if (state.activeSubtitleUrl) {
          URL.revokeObjectURL(state.activeSubtitleUrl);
          state.activeSubtitleUrl = null;
        }
        state.activeSubtitleVtt = null;
        state.subtitleOffsetSec = 0;
        updateSubtitleOffsetUI();
        el.media.querySelectorAll('track').forEach((tr) => tr.remove());
        el.subtitleCueStack.innerHTML = '';
        el.subtitleOverlay.hidden = true;
        el.subtitleBtn.classList.remove('is-active');
      }

      function revokeMediaUrls() {
        if (state.activeObjectUrl) {
          URL.revokeObjectURL(state.activeObjectUrl);
          state.activeObjectUrl = null;
        }
        clearActiveSubtitles({ cancelPending: false });
      }

      function attachSubtitleVttText(vttSourceText, label = 'Subtitles') {
        clearActiveSubtitles({ cancelPending: false });
        const vtt = srtToWebVtt(vttSourceText);
        state.activeSubtitleVtt = vtt;
        const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
        state.activeSubtitleUrl = URL.createObjectURL(blob);

        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = label;
        trackEl.src = state.activeSubtitleUrl;
        trackEl.default = true;
        el.media.appendChild(trackEl);

        state.subtitlesEnabled = true;
        const bindTrack = () => {
          const tt = trackEl.track || (el.media.textTracks && el.media.textTracks[0]);
          if (tt) {
            // Keep native cue rendering 'hidden' so our custom styled overlay renders with full fonts/borders/colors & timing sync!
            tt.mode = 'hidden';
            tt.removeEventListener('cuechange', renderActiveSubtitleCues);
            tt.addEventListener('cuechange', renderActiveSubtitleCues);
            renderActiveSubtitleCues();
          }
        };
        trackEl.addEventListener('load', bindTrack);
        bindTrack();
        el.subtitleBtn.classList.add('is-active');
      }

      function getPreferredSubtitleLang() {
        return phase3?.getPlaybackSettings?.().defaultSubtitleLang || 'auto';
      }

      function findFuzzySubtitleInLoadedMap(track) {
        if (!track || state.subtitlesByBaseKey.size === 0) return null;
        const trackDir = (track.folderPath || '').toLowerCase();
        const videosInSameDir = state.allTracks.filter(
          (tr) => tr.kind === 'video' && (tr.folderPath || '').toLowerCase() === trackDir
        ).length;
        return selectBestSubtitleCandidate(track, state.subtitlesByBaseKey, {
          preferredLang: getPreferredSubtitleLang(),
          uiLang: state.lang,
          videosInSameDir,
        });
      }

      async function autoLoadMatchingSubtitle(track, opGen = subtitleOpGen) {
        if (!track || track.kind !== 'video') return;
        const isStillCurrent = () => opGen === subtitleOpGen && state.currentKey === track.key;

        // 1. Check loaded folder/queue subtitle map (exact + fuzzy + language preference)
        const subEntry = findFuzzySubtitleInLoadedMap(track);
        if (subEntry) {
          try {
            let text = null;
            if (subEntry.file) text = await readSubtitleFileSmart(subEntry.file);
            else if (subEntry.fileHandle) {
              const f = await subEntry.fileHandle.getFile();
              subEntry.file = f;
              text = await readSubtitleFileSmart(f);
            } else if (subEntry.fullPath && desktopBridge) {
              text = await desktopBridge.readTextFile(subEntry.fullPath);
            }
            if (!isStillCurrent()) return;
            if (text) {
              attachSubtitleVttText(text, subEntry.name);
              return;
            }
          } catch (err) {
            errorHandler.log('subtitle.autoLoadEntry', err);
          }
        }

        if (!isStillCurrent()) return;

        // 2. Desktop native nearby folder / fuzzy subtitle scan honoring defaultSubtitleLang + uiLang (F12)
        if (track.fullPath && desktopBridge && typeof desktopBridge.findNearbySubtitle === 'function') {
          try {
            const preferredLang = getPreferredSubtitleLang();
            const found = await desktopBridge.findNearbySubtitle(track.fullPath, preferredLang, state.lang);
            if (!isStillCurrent()) return;
            if (found && found.text) {
              attachSubtitleVttText(found.text, found.name || 'Subtitles');
              showNotice(t('subAutoLoaded', { name: found.name || '' }));
            }
          } catch (err) {
            errorHandler.log('subtitle.findNearby', err);
          }
        }
      }

      function getTrackProgressEntry(track) {
        if (!track) return null;
        if (state.progressByKey[track.key]) return state.progressByKey[track.key];
        const legacyKey = lookupLegacyKeyFallback(track, state.allTracks);
        return legacyKey ? state.progressByKey[legacyKey] || null : null;
      }

      function getTrackBookmarksList(track) {
        if (!track) return [];
        const direct = state.bookmarksByKey[track.key];
        if (Array.isArray(direct) && direct.length > 0) return direct;
        const legacyKey = lookupLegacyKeyFallback(track, state.allTracks);
        if (legacyKey && Array.isArray(state.bookmarksByKey[legacyKey])) {
          return state.bookmarksByKey[legacyKey];
        }
        return [];
      }

      async function loadTrackByKey(trackKey, options = {}) {
        const { autoPlay = true } = options;
        const track = state.allTracks.find((tr) => tr.key === trackKey);
        if (!track) return;

        const gen = ++trackLoadGen;
        const subGen = ++subtitleOpGen;

        let startTime = options.startTime;
        if (startTime === undefined) {
          const allowResume = phase3 ? phase3.shouldResumePosition() : true;
          const savedProg = allowResume ? getTrackProgressEntry(track) : null;
          if (savedProg && Number.isFinite(savedProg.time) && savedProg.time > 2 && (!savedProg.duration || savedProg.time < savedProg.duration * 0.92)) {
            startTime = savedProg.time;
          } else {
            startTime = 0;
          }
        }

        hideNotice();
        stopAutosaveTimer();
        clearABLoop();

        let createdObjectUrl = null;
        try {
          revokeMediaUrls();
          let srcUrl = null;

          if (track.fileUrl) {
            srcUrl = track.fileUrl;
          } else {
            let file = track.file;
            if (!file && track.fileHandle) {
              file = await track.fileHandle.getFile();
              if (gen !== trackLoadGen) return;
              track.file = file;
              track.size = file.size;
            }
            if (!file) throw new Error('File could not be read from disk.');
            createdObjectUrl = URL.createObjectURL(file);
            if (gen !== trackLoadGen) {
              URL.revokeObjectURL(createdObjectUrl);
              return;
            }
            srcUrl = createdObjectUrl;
            state.activeObjectUrl = srcUrl;
          }

          if (gen !== trackLoadGen) return;

          state.currentKey = track.key;
          state.pendingSeekTime = startTime > 0 ? startTime : null;

          // Register loadedmetadata/error listener BEFORE el.media.load() so fast loads never miss it (F09)
          let metadataPromise = null;
          if (startTime > 0) {
            metadataPromise = new Promise((resolve) => {
              const done = () => {
                el.media.removeEventListener('loadedmetadata', done);
                el.media.removeEventListener('error', done);
                el.media.removeEventListener('emptied', done);
                resolve();
              };
              el.media.addEventListener('loadedmetadata', done, { once: true });
              el.media.addEventListener('error', done, { once: true });
              el.media.addEventListener('emptied', done, { once: true });
            });
          }

          el.media.src = srcUrl;
          el.media.playbackRate = state.playbackRate || 1;
          el.media.load();

          updateStageVisibility();
          updateNowPlayingUI();
          updateTransportAvailability();
          highlightActivePlaylistRow(true);
          renderBookmarks();

          el.currentTimeLabel.textContent = formatTime(startTime);
          el.durationLabel.textContent = track.duration ? formatTime(track.duration) : '00:00';
          el.seekBar.value = '0';
          el.fsSeekBar.value = '0';
          setRangeFill(el.seekBar, 0);
          setRangeFill(el.fsSeekBar, 0);

          persistPlaybackState(startTime);
          await autoLoadMatchingSubtitle(track, subGen);
          if (gen !== trackLoadGen) return;

          // If Cast LAN Server is running, automatically sync the newly selected track + subtitle to the TV!
          if (state.castServerInfo && track.fullPath && desktopBridge && desktopBridge.castStartServer) {
            syncActiveCastTrack(track).catch((err) => errorHandler.log('cast.syncActiveTrack', err));
          }

          if (metadataPromise && el.media.readyState < 1) {
            await metadataPromise;
            if (gen !== trackLoadGen) return;
          }

          if (autoPlay) {
            if (desktopBridge?.isAndroid && window.innerWidth <= 820 && state.mobileView && state.mobileView !== 'player') {
              setMobileView('player');
            }
            try {
              await ensureAudioOutputBound();
              if (gen !== trackLoadGen) return;
              if (AudioStudio.needsAudioGraph()) AudioStudio.ensureInit(false);
              await el.media.play();
            } catch (playErr) {
              if (playErr && playErr.name !== 'AbortError') console.warn('Autoplay blocked:', playErr);
            }
          }
        } catch (err) {
          if (createdObjectUrl && state.activeObjectUrl !== createdObjectUrl) {
            URL.revokeObjectURL(createdObjectUrl);
          }
          if (gen === trackLoadGen) {
            showNotice(`Unable to load "${track.name}": ${err?.message || 'File unreadable'}`, true);
          }
        }
      }

      async function togglePlayPause() {
        if (state.allTracks.length === 0) return;
        if (!state.currentKey) {
          const first = getModeQueue()[0] || state.allTracks[0];
          if (first) await loadTrackByKey(first.key, { autoPlay: true, startTime: undefined });
          return;
        }
        if (el.media.paused) {
          try {
            await ensureAudioOutputBound();
            if (AudioStudio.needsAudioGraph()) AudioStudio.ensureInit(false);
            await el.media.play();
          } catch (err) {
            showNotice(`Playback failed: ${err?.message || 'Could not start media'}`, true);
          }
        } else {
          el.media.pause();
        }
      }

      function pickNextTrackKey(isAutoAdvance = false) {
        const { queue, idx } = getCurrentQueuePosition();
        if (queue.length === 0) return null;
        if (isAutoAdvance && state.repeatMode === 'one' && state.currentKey) return state.currentKey;

        // Honor Up Next priority queue first!
        while (state.upNextKeys.length > 0) {
          const queuedKey = state.upNextKeys.shift();
          if (state.allTracks.some((tr) => tr.key === queuedKey)) {
            renderPlaylist();
            return queuedKey;
          }
        }

        if (state.shuffle && queue.length > 1) {
          let r = idx;
          while (r === idx) r = Math.floor(Math.random() * queue.length);
          return queue[r].key;
        }
        if (idx === -1) return queue[0].key;
        if (idx + 1 < queue.length) return queue[idx + 1].key;
        if (state.repeatMode === 'all') return queue[0].key;
        return null;
      }

      function playNextTrack(autoPlay = true, isAutoAdvance = false) {
        const nextKey = pickNextTrackKey(isAutoAdvance);
        if (!nextKey) return false;
        if (nextKey === state.currentKey && isAutoAdvance) {
          seekToSeconds(0);
          el.media.play().catch((err) => errorHandler.log('playback.repeatOnePlay', err));
          return true;
        }
        loadTrackByKey(nextKey, { autoPlay, startTime: 0 });
        return true;
      }

      function playPreviousTrack() {
        const { queue, idx } = getCurrentQueuePosition();
        if (queue.length === 0) return;
        if (el.media.currentTime > 3) {
          seekToSeconds(0);
          return;
        }
        if (idx > 0) loadTrackByKey(queue[idx - 1].key, { autoPlay: !el.media.paused, startTime: 0 });
        else if (state.repeatMode === 'all' && queue.length > 1) loadTrackByKey(queue[queue.length - 1].key, { autoPlay: !el.media.paused, startTime: 0 });
        else seekToSeconds(0);
      }

      function seekToSeconds(targetSeconds) {
        if (!state.currentKey || !Number.isFinite(el.media.duration) || el.media.duration <= 0) return;
        const clamped = Math.max(0, Math.min(el.media.duration, targetSeconds));
        el.media.currentTime = clamped;
        updateSeekUI();
        persistPlaybackState(clamped);
      }

      function skipBySeconds(delta) {
        if (!state.currentKey) return;
        seekToSeconds((Number.isFinite(el.media.currentTime) ? el.media.currentTime : 0) + delta);
      }

      function cycleABLoop() {
        if (!state.currentKey || !Number.isFinite(el.media.duration) || el.media.duration <= 0) return;
        const now = el.media.currentTime;
        if (state.abPointA === null) {
          state.abPointA = now;
          state.abPointB = null;
        } else if (state.abPointB === null) {
          if (now <= state.abPointA + 0.5) {
            showNotice('Point B must be after Point A.');
            return;
          }
          state.abPointB = now;
          seekToSeconds(state.abPointA);
        } else {
          clearABLoop();
          return;
        }
        updateABLoopUI();
      }

      function clearABLoop() {
        state.abPointA = null;
        state.abPointB = null;
        updateABLoopUI();
      }

      function updateABLoopUI() {
        const dur = Number.isFinite(el.media.duration) && el.media.duration > 0 ? el.media.duration : 0;
        if (state.abPointA === null) {
          el.abLoopBtn.textContent = 'A–B';
          el.abLoopBtn.classList.remove('is-gold');
          el.abLoopRegion.hidden = true;
        } else if (state.abPointB === null) {
          el.abLoopBtn.textContent = 'A·';
          el.abLoopBtn.classList.add('is-gold');
          el.abLoopRegion.hidden = true;
        } else {
          el.abLoopBtn.textContent = 'A↔B';
          el.abLoopBtn.classList.add('is-gold');
          if (dur > 0) {
            el.abLoopRegion.style.left = `${(state.abPointA / dur) * 100}%`;
            el.abLoopRegion.style.width = `${Math.max(1, ((state.abPointB - state.abPointA) / dur) * 100)}%`;
            el.abLoopRegion.hidden = false;
          }
        }
      }

      /* =======================================================================
         12. Controls, EQ, Stars, Bookmarks & Sleep Timer
         ======================================================================= */
      function setVolume(val, persist = true) {
        const clamped = Math.max(0, Math.min(1, Number(val)));
        el.media.volume = clamped;
        if (clamped > 0 && el.media.muted) el.media.muted = false;
        updateVolumeUI();
        if (persist) persistPlaybackState();
      }

      function toggleMute() {
        el.media.muted = !el.media.muted;
        updateVolumeUI();
        persistPlaybackState();
      }

      function setPlaybackRate(rate, persist = true) {
        const chosen = SPEED_STEPS.includes(Number(rate)) ? Number(rate) : 1;
        state.playbackRate = chosen;
        el.media.playbackRate = chosen;
        el.speedCycleBtn.textContent = `${chosen}x`;
        el.speedCycleBtn.classList.toggle('is-active', chosen !== 1);
        document.querySelectorAll('.menu-action[data-speed]').forEach((item) => {
          item.classList.toggle('is-checked', Number(item.dataset.speed) === chosen);
        });
        if (persist) persistPlaybackState();
      }

      function cycleSpeed() {
        const idx = SPEED_STEPS.indexOf(state.playbackRate || 1);
        setPlaybackRate(SPEED_STEPS[(idx + 1) % SPEED_STEPS.length], true);
      }

      /* =======================================================================
         11B. Video Aspect Ratio, Zoom, Crop, Frame-by-Frame & HD Snapshot
         ======================================================================= */
      function parseRatioString(ratioStr) {
        if (!ratioStr || !ratioStr.includes(':')) return null;
        const [w, h] = ratioStr.split(':').map(Number);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return w / h;
      }

      function applyVideoTransform() {
        const frame = el.videoFrame;
        const stage = el.videoViewportStage;
        const video = el.media;
        if (!frame || !stage || !video) return;

        const fw = frame.clientWidth || 0;
        const fh = frame.clientHeight || 0;
        const zoom = Number(state.videoZoom) || 1;
        const aspect = state.videoAspect || 'default';
        const crop = state.videoCrop || 'default';

        // Reset defaults
        stage.style.width = '100%';
        stage.style.height = '100%';
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';

        if (crop !== 'default') {
          if (crop === 'fill') {
            video.style.objectFit = 'cover';
          } else {
            const targetRatio = parseRatioString(crop);
            if (targetRatio && fw > 0 && fh > 0) {
              let boxW = fw;
              let boxH = fw / targetRatio;
              if (boxH > fh) {
                boxH = fh;
                boxW = fh * targetRatio;
              }
              stage.style.width = `${Math.round(boxW)}px`;
              stage.style.height = `${Math.round(boxH)}px`;
              video.style.objectFit = 'cover';
            }
          }
        } else if (aspect !== 'default') {
          if (aspect === 'fill') {
            video.style.objectFit = 'fill';
          } else {
            const targetRatio = parseRatioString(aspect);
            if (targetRatio && fw > 0 && fh > 0) {
              let boxW = fw;
              let boxH = fw / targetRatio;
              if (boxH > fh) {
                boxH = fh;
                boxW = fh * targetRatio;
              }
              stage.style.width = `${Math.round(boxW)}px`;
              stage.style.height = `${Math.round(boxH)}px`;
              video.style.objectFit = 'fill';
            }
          }
        }

        stage.style.transform = zoom === 1 ? 'none' : `scale(${zoom})`;

        document.querySelectorAll('.menu-action[data-aspect]').forEach((item) => {
          item.classList.toggle('is-checked', item.dataset.aspect === aspect);
        });
        document.querySelectorAll('.menu-action[data-zoom]').forEach((item) => {
          item.classList.toggle('is-checked', Number(item.dataset.zoom) === zoom);
        });
        document.querySelectorAll('.menu-action[data-crop]').forEach((item) => {
          item.classList.toggle('is-checked', item.dataset.crop === crop);
        });
      }

      function setVideoAspect(val, notify = true) {
        state.videoAspect = val || 'default';
        if (state.videoAspect !== 'default') state.videoCrop = 'default';
        applyVideoTransform();
        if (notify) {
          const label = val === 'default' ? t('aspectDefault') : val === 'fill' ? t('aspectFill') : val;
          showNotice(t('aspectChanged', { val: label }));
        }
      }

      function setVideoZoom(val, notify = true) {
        const z = Number(val);
        state.videoZoom = Number.isFinite(z) && z > 0 ? z : 1;
        applyVideoTransform();
        if (notify) {
          showNotice(t('zoomChanged', { val: `${state.videoZoom}x` }));
        }
      }

      function setVideoCrop(val, notify = true) {
        state.videoCrop = val || 'default';
        if (state.videoCrop !== 'default') state.videoAspect = 'default';
        applyVideoTransform();
        if (notify) {
          const label = val === 'default' ? t('cropDefault') : val === 'fill' ? t('cropFill') : val;
          showNotice(t('cropChanged', { val: label }));
        }
      }

      function resetVideoTransform(notify = true) {
        state.videoAspect = 'default';
        state.videoZoom = 1;
        state.videoCrop = 'default';
        applyVideoTransform();
        if (notify) showNotice(t('videoResetNotice'));
      }

      function stepVideoFrame(direction) {
        const track = getCurrentTrack();
        if (!track || track.kind !== 'video') return;
        if (!Number.isFinite(el.media.duration) || el.media.duration <= 0) return;
        if (!el.media.paused) el.media.pause();
        const frameDuration = 1 / 30;
        const nextTime = Math.max(0, Math.min(el.media.duration, (el.media.currentTime || 0) + direction * frameDuration));
        el.media.currentTime = nextTime;
        updateSeekUI();
        if (state.activeSubtitleUrl && state.subtitlesEnabled) renderActiveSubtitleCues();
      }

      async function captureVideoSnapshot() {
        const track = getCurrentTrack();
        if (!track || track.kind !== 'video' || !el.media.videoWidth || !el.media.videoHeight) {
          showNotice(t('snapshotNoVideo'), true);
          return;
        }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = el.media.videoWidth;
          canvas.height = el.media.videoHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas unavailable');
          ctx.drawImage(el.media, 0, 0, canvas.width, canvas.height);

          const dataUrl = canvas.toDataURL('image/png');
          const safeBase = (track.displayName || 'video').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
          const timeStamp = formatTime(el.media.currentTime || 0).replace(/:/g, '-');
          const fileName = `AAZ_${safeBase}_${timeStamp}.png`;

          // Brief shutter flash feedback
          el.videoSnapshotFlash.classList.remove('is-flashing');
          void el.videoSnapshotFlash.offsetWidth;
          el.videoSnapshotFlash.classList.add('is-flashing');

          if (desktopBridge && typeof desktopBridge.saveSnapshot === 'function') {
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            const res = await desktopBridge.saveSnapshot(base64, fileName);
            if (res && res.saved) {
              const savedName = res.path ? res.path.split(/[\\/]/).pop() : fileName;
              showNotice(t('snapshotSaved', { name: savedName || fileName }));
            }
          } else {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showNotice(t('snapshotSaved', { name: fileName }));
          }
        } catch (err) {
          errorHandler.log('video.snapshot', err);
          showNotice(t('snapshotFailed'), true);
        }
      }

      if (typeof ResizeObserver === 'function') {
        const videoResizeObserver = new ResizeObserver(() => {
          if (!el.videoFrame.hidden) applyVideoTransform();
        });
        videoResizeObserver.observe(el.videoFrame);
      }

      function applyEQPreset(presetName, persist = true) {
        const values = EQ_PRESETS[presetName];
        if (!values) return;
        state.eqPreset = presetName;
        state.eqGains = [...values];
        updateEQUI();
        AudioStudio.applyEQ();
        if (persist) persistPlaybackState();
      }

      function updateEQUI() {
        el.eqPresetBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.preset === state.eqPreset));
        document.querySelectorAll('.menu-action[data-eq]').forEach((item) => {
          item.classList.toggle('is-checked', item.dataset.eq === state.eqPreset);
        });
        el.eqBandSliders.forEach((slider, idx) => {
          const v = state.eqGains[idx] || 0;
          slider.value = String(v);
          setRangeFill(slider, (v + 12) / 24);
          if (el.eqBandVals[idx]) el.eqBandVals[idx].textContent = `${v > 0 ? '+' : ''}${v}dB`;
        });
        el.preampSlider.value = String(state.preampGain);
        setRangeFill(el.preampSlider, (state.preampGain - 1) / 0.5);
        el.preampVal.textContent = `${Math.round(state.preampGain * 100)}%`;
        const modified = state.eqGains.some((g) => g !== 0) || state.preampGain > 1.01;
        el.eqToggleBtn.classList.toggle('is-active', !el.eqDrawer.hidden || modified);
      }

      function toggleStarKey(trackKey) {
        if (!trackKey) return;
        if (state.starredKeys.has(trackKey)) state.starredKeys.delete(trackKey);
        else state.starredKeys.add(trackKey);
        updateModeCounts();
        updateStarButtonsUI();
        renderPlaylist();
        persistPlaybackState();
      }

      function updateStarButtonsUI() {
        const starred = Boolean(state.currentKey && state.starredKeys.has(state.currentKey));
        el.starCurrentBtn.disabled = !state.currentKey;
        el.starCurrentBtn.classList.toggle('is-gold', starred);
        const poly = el.starCurrentBtn.querySelector('polygon');
        if (poly) poly.setAttribute('fill', starred ? 'currentColor' : 'none');
      }

      function addBookmarkAtCurrentTime() {
        const track = getCurrentTrack();
        if (!track || !Number.isFinite(el.media.currentTime)) return;
        const sec = Math.floor(el.media.currentTime);
        const existing = sanitizeBookmarkList(getTrackBookmarksList(track));
        if (existing.some((t) => Math.abs(t - sec) < 2)) {
          showNotice(`Bookmark already exists near ${formatTime(sec)}.`);
          return;
        }
        existing.push(sec);
        state.bookmarksByKey[track.key] = sanitizeBookmarkList(existing);
        renderBookmarks();
        persistPlaybackState();
      }

      function removeBookmark(trackKey, sec) {
        const existing = sanitizeBookmarkList(state.bookmarksByKey[trackKey]);
        if (existing.length === 0) return;
        const next = existing.filter((t) => t !== sec);
        if (next.length > 0) state.bookmarksByKey[trackKey] = next;
        else delete state.bookmarksByKey[trackKey];
        renderBookmarks();
        persistPlaybackState();
      }

      function renderBookmarks() {
        const track = getCurrentTrack();
        el.bookmarksStrip.innerHTML = '';
        el.bookmarkTicks.innerHTML = '';
        if (!track) {
          el.bookmarksStrip.hidden = true;
          return;
        }
        const list = sanitizeBookmarkList(getTrackBookmarksList(track));
        if (list.length === 0) {
          el.bookmarksStrip.hidden = true;
          return;
        }
        const label = document.createElement('span');
        label.className = 'bookmarks-strip-label';
        label.textContent = 'Bookmarks';
        el.bookmarksStrip.appendChild(label);

        const dur = Number.isFinite(el.media.duration) && el.media.duration > 0 ? el.media.duration : 0;
        for (const sec of list) {
          const item = document.createElement('div');
          item.className = 'bookmark-item';

          const jump = document.createElement('button');
          jump.type = 'button';
          jump.className = 'bookmark-jump';
          jump.textContent = formatTime(sec);
          jump.addEventListener('click', () => seekToSeconds(sec));

          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'bookmark-del';
          del.textContent = '×';
          del.setAttribute('aria-label', `Remove bookmark at ${formatTime(sec)}`);
          del.addEventListener('click', () => removeBookmark(track.key, sec));

          item.append(jump, del);
          el.bookmarksStrip.appendChild(item);

          if (dur > 0 && sec <= dur) {
            const tick = document.createElement('span');
            tick.className = 'bookmark-tick';
            tick.style.left = `${(sec / dur) * 100}%`;
            el.bookmarkTicks.appendChild(tick);
          }
        }
        el.bookmarksStrip.hidden = false;
      }

      function clearSleepTimer() {
        if (state.sleepInterval !== null) {
          clearInterval(state.sleepInterval);
          state.sleepInterval = null;
        }
        state.sleepEndAt = null;
        el.sleepBadge.hidden = true;
        document.querySelectorAll('.menu-action[data-sleep]').forEach((item) => {
          item.classList.toggle('is-checked', item.dataset.sleep === '0');
        });
      }

      function configureSleepTimer(val) {
        if (state.sleepInterval !== null) {
          clearInterval(state.sleepInterval);
          state.sleepInterval = null;
        }
        document.querySelectorAll('.menu-action[data-sleep]').forEach((item) => {
          item.classList.toggle('is-checked', item.dataset.sleep === String(val));
        });
        if (String(val) === '0') {
          clearSleepTimer();
          return;
        }
        if (val === 'track') {
          state.sleepEndAt = 'track';
          el.sleepBadge.textContent = 'Sleep: End';
          el.sleepBadge.hidden = false;
          return;
        }
        const mins = Number(val);
        if (!Number.isFinite(mins) || mins <= 0) {
          clearSleepTimer();
          return;
        }
        state.sleepEndAt = Date.now() + mins * 60 * 1000;
        const tick = () => {
          if (typeof state.sleepEndAt !== 'number') return;
          const rem = state.sleepEndAt - Date.now();
          if (rem <= 0) {
            el.media.pause();
            persistPlaybackState();
            clearSleepTimer();
            showNotice('Sleep timer finished — playback paused and state saved.');
            return;
          }
          el.sleepBadge.textContent = `Sleep ${Math.ceil(rem / 60000)}m`;
          el.sleepBadge.hidden = false;
        };
        tick();
        state.sleepInterval = window.setInterval(tick, 10000);
      }

      /* =======================================================================
         13. UI Views, Fullscreen, PiP & Sidebar Management
         ======================================================================= */
      function switchSidebarTab(tab) {
        const valid = ['queue', 'saved', 'library'];
        state.sidebarTab = valid.includes(tab) ? tab : 'queue';
        const isQueue = state.sidebarTab === 'queue';
        const isSaved = state.sidebarTab === 'saved';
        const isLibrary = state.sidebarTab === 'library';

        el.tabQueueBtn.classList.toggle('is-active', isQueue);
        el.tabQueueBtn.setAttribute('aria-selected', String(isQueue));
        el.tabSavedBtn.classList.toggle('is-active', isSaved);
        el.tabSavedBtn.setAttribute('aria-selected', String(isSaved));
        if (el.tabLibraryBtn) {
          el.tabLibraryBtn.classList.toggle('is-active', isLibrary);
          el.tabLibraryBtn.setAttribute('aria-selected', String(isLibrary));
        }

        el.panelQueue.hidden = !isQueue;
        el.panelSaved.hidden = !isSaved;
        if (el.panelLibrary) el.panelLibrary.hidden = !isLibrary;

        if (isSaved) renderSavedPlaylists();
        if (isLibrary && phase3) phase3.renderLibrary();
      }

      function toggleSidebar() {
        state.sidebarHidden = !state.sidebarHidden;
        el.shell.classList.toggle('is-sidebar-hidden', state.sidebarHidden);
        el.toggleSidebarBtn.classList.toggle('is-active', !state.sidebarHidden);
        el.toggleSidebarBtn.setAttribute('aria-pressed', String(!state.sidebarHidden));
        requestAnimationFrame(() => AudioStudio.renderIdleFrame());
      }

      function setPlaylistMode(mode, persist = true) {
        if (!['all', 'audio', 'video', 'starred'].includes(mode)) return;
        state.playlistMode = mode;
        if (mode === 'video') state.videoDisplayMode = 'video';
        updateModeTabsUI();
        updatePlaylistHeader();
        renderPlaylist();
        updateStageVisibility();
        updateTransportAvailability();
        if (persist) persistPlaybackState();
      }

      function setVideoDisplayMode(mode, persist = true) {
        state.videoDisplayMode = mode === 'audio' ? 'audio' : 'video';
        updateStageVisibility();
        if (state.videoDisplayMode === 'audio') {
          clearFsIdleTimer();
          el.videoFrame.classList.remove('is-fs-idle');
          el.videoFrame.classList.remove('is-hud-visible');
          if (!el.media.paused) AudioStudio.startVisualizer();
          else requestAnimationFrame(() => AudioStudio.renderIdleFrame());
        } else if (isFullscreenActive()) {
          wakeFullscreenHud();
        }
        if (persist) persistPlaybackState();
      }

      function syncMobileMiniBar() {
        if (!desktopBridge?.isAndroid || !el.mobileMiniNowBar) return;
        const track = getCurrentTrack();
        const isPhone = window.innerWidth <= 820;
        const showMini = Boolean(isPhone && track && state.mobileView && state.mobileView !== 'player');
        el.mobileMiniNowBar.hidden = !showMini;
        if (!track) return;
        const playing = !el.media.paused && !el.media.ended;
        if (el.mobileMiniTitle) el.mobileMiniTitle.textContent = track.displayName || track.name || '';
        if (el.mobileMiniSub) {
          const kindLabel = track.kind === 'video' ? t('kindVideo') : t('kindAudio');
          el.mobileMiniSub.textContent = `${kindLabel} · ${track.ext || ''}`.replace(/\s·\s$/, '');
        }
        if (el.mobileMiniPlayIcon) el.mobileMiniPlayIcon.style.display = playing ? 'none' : 'block';
        if (el.mobileMiniPauseIcon) el.mobileMiniPauseIcon.style.display = playing ? 'block' : 'none';
        if (el.mobileMiniNextBtn && el.nextBtn) {
          el.mobileMiniNextBtn.disabled = Boolean(el.nextBtn.disabled);
        }
      }

      function setMobileView(view) {
        const valid = ['player', 'queue', 'library', 'saved'];
        const nextView = valid.includes(view) ? view : 'player';
        state.mobileView = nextView;
        document.documentElement.dataset.mobileView = nextView;
        if (nextView !== 'player') {
          switchSidebarTab(nextView);
        }
        if (el.mobileNavBtns && el.mobileNavBtns.length) {
          el.mobileNavBtns.forEach((btn) => {
            const active = btn.dataset.mobileNav === nextView;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', String(active));
          });
        }
        syncMobileMiniBar();
        if (nextView === 'player') {
          requestAnimationFrame(() => AudioStudio.renderIdleFrame());
        }
      }

      async function toggleFullscreen() {
        try {
          if (isFullscreenActive()) {
            if (document.fullscreenElement && document.exitFullscreen) {
              await document.exitFullscreen();
            } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
              document.webkitExitFullscreen();
            }
            if (desktopBridge?.isAndroid && desktopBridge.setImmersiveFullscreen) {
              desktopBridge.setImmersiveFullscreen(false).catch((err) => errorHandler.log('android.immersiveExit', err));
            }
            if (state.electronFsFallback) {
              state.electronFsFallback = false;
              el.mediaStage.classList.remove('is-pseudo-fullscreen');
              el.videoFrame.classList.remove('is-pseudo-fullscreen');
              postToShell('aaz-shell-fullscreen', { active: false });
              if (desktopBridge && desktopBridge.setWindowFullscreen) {
                await desktopBridge.setWindowFullscreen(false);
              }
              onFullscreenChange();
            }
          } else {
            let entered = false;
            try {
              if (el.mediaStage.requestFullscreen) {
                await el.mediaStage.requestFullscreen();
                entered = Boolean(document.fullscreenElement);
              } else if (el.mediaStage.webkitRequestFullscreen) {
                el.mediaStage.webkitRequestFullscreen();
                entered = true;
              }
            } catch (err) {
              errorHandler.log('ui.requestFullscreen', err);
              entered = false;
            }
            if (desktopBridge?.isAndroid && desktopBridge.setImmersiveFullscreen) {
              desktopBridge.setImmersiveFullscreen(true).catch((err) => errorHandler.log('android.immersiveEnter', err));
            }
            // Fallback to Desktop native window fullscreen + full-bleed stage if DOM fullscreen was restricted
            if (!entered && desktopBridge && desktopBridge.setWindowFullscreen) {
              await desktopBridge.setWindowFullscreen(true);
              state.electronFsFallback = true;
              el.mediaStage.classList.add('is-pseudo-fullscreen');
              postToShell('aaz-shell-fullscreen', { active: true });
              onFullscreenChange();
            } else if (!entered && desktopBridge?.isAndroid) {
              state.electronFsFallback = true;
              el.mediaStage.classList.add('is-pseudo-fullscreen');
              onFullscreenChange();
            } else if (!entered && !el.videoFrame.hidden && el.media.requestFullscreen) {
              await el.media.requestFullscreen();
            }
          }
        } catch (err) {
          errorHandler.log('ui.toggleFullscreen', err);
        }
      }

      async function togglePictureInPicture() {
        const track = getCurrentTrack();
        if (!track || track.kind !== 'video') return;
        if (desktopBridge?.isAndroid && typeof desktopBridge.enterPictureInPicture === 'function') {
          if (state.videoDisplayMode === 'audio') setVideoDisplayMode('video', true);
          const ok = await desktopBridge.enterPictureInPicture();
          if (!ok) {
            showNotice(
              state.lang === 'ar'
                ? 'وضع صورة داخل صورة غير مدعوم على هذا الجهاز.'
                : 'Picture-in-Picture is not supported on this device.'
            );
          }
          return;
        }
        if (!document.pictureInPictureEnabled) {
          showNotice('Picture-in-Picture is not supported in this browser.');
          return;
        }
        try {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          else {
            if (state.videoDisplayMode === 'audio') setVideoDisplayMode('video', true);
            await el.media.requestPictureInPicture();
          }
        } catch (err) {
          errorHandler.log('video.pictureInPicture', err);
          showNotice('Could not enter Picture-in-Picture mode.');
        }
      }

      function clearQueue() {
        stopAutosaveTimer();
        el.media.pause();
        el.media.removeAttribute('src');
        el.media.load();
        revokeMediaUrls();
        clearABLoop();
        AudioStudio.stopVisualizer();

        state.allTracks = [];
        state.subtitlesByBaseKey.clear();
        state.currentKey = '';
        state.folderName = '';
        state.nativeFolderPath = '';
        state.currentDirHandle = null;
        state.activeSavedPlaylistId = null;
        state.sourceMode = 'none';
        state.pendingSeekTime = null;
        state.searchQuery = '';
        state.upNextKeys = [];
        state.stopAfterKey = '';
        state.lastRemovedUndo = null;
        el.searchInput.value = '';
        el.savePlBar.hidden = true;

        updateModeCounts();
        updateSidebarCounts();
        updateStageVisibility();
        updateNowPlayingUI();
        updateStarButtonsUI();
        updateTransportAvailability();
        updatePlaylistHeader();
        renderPlaylist();
        renderBookmarks();
        refreshResumeBanner();
      }

      function updateStageVisibility() {
        const track = getCurrentTrack();
        const isVideo = Boolean(track && track.kind === 'video');
        const showVideo = isVideo && state.videoDisplayMode === 'video';
        el.videoFrame.hidden = !showVideo;
        el.audioStage.hidden = showVideo;
        el.showVideoBtn.hidden = !(isVideo && !showVideo);
        if (!showVideo) requestAnimationFrame(() => AudioStudio.renderIdleFrame());
      }

      function updateNowPlayingUI() {
        const track = getCurrentTrack();
        updateStarButtonsUI();

        if (!track) {
          el.nowPlayingKicker.textContent = 'AAZ Player';
          el.trackTitle.textContent = t('stageEmptyTitle');
          el.trackTitle.classList.add('is-empty');
          el.trackSubpath.textContent = t('stageEmptySub');
          el.dockNowTitle.textContent = t('nothingPlaying');
          el.dockNowMeta.textContent = t('idle');
          el.fsTitleLabel.textContent = '';
          el.currentTimeLabel.textContent = '00:00';
          el.durationLabel.textContent = '00:00';
          el.seekBar.value = '0';
          el.fsSeekBar.value = '0';
          setRangeFill(el.seekBar, 0);
          setRangeFill(el.fsSeekBar, 0);
          document.title = 'AAZ Player';
          notifyShellTabState();
          return;
        }

        const { queue, idx } = getCurrentQueuePosition();
        const pos = idx >= 0 ? `${String(idx + 1).padStart(2, '0')} / ${String(queue.length).padStart(2, '0')}` : '';
        const kindLabel = track.kind === 'video' ? t('kindVideo') : t('kindAudio');

        el.nowPlayingKicker.textContent = `${pos} · ${kindLabel} · ${track.ext}`;
        el.trackTitle.textContent = track.displayName;
        el.trackTitle.classList.remove('is-empty');
        el.trackSubpath.textContent = track.folderPath
          ? `${state.folderName} / ${track.folderPath} · ${track.name}`
          : `${state.folderName} · ${track.name}`;

        el.dockNowTitle.textContent = track.displayName;
        el.dockNowTitle.title = track.name;
        el.dockNowMeta.textContent = `${pos} · ${track.ext} · ${state.folderName}`;
        el.fsTitleLabel.textContent = track.displayName;
        document.title = `${track.displayName} — AAZ Player`;
        notifyShellTabState();
      }

      function syncMediaSession() {
        const track = getCurrentTrack();
        const isPlaying = !el.media.paused && !el.media.ended;
        if (desktopBridge?.isAndroid && typeof desktopBridge.updateMediaSession === 'function') {
          Promise.resolve(
            desktopBridge.updateMediaSession({
              title: track ? track.displayName || track.name || 'AAZ Player' : 'AAZ Player',
              artist: state.folderName || 'AAZ Player',
              isPlaying: Boolean(track && isPlaying),
              durationMs: Number.isFinite(el.media.duration) ? Math.round(el.media.duration * 1000) : 0,
              positionMs: Number.isFinite(el.media.currentTime) ? Math.round(el.media.currentTime * 1000) : 0,
            })
          ).catch((err) => errorHandler.log('android.updateMediaSession', err));
        }
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        try {
          if (track && typeof MediaMetadata === 'function') {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: track.displayName || track.name || 'AAZ Player',
              artist: state.folderName || 'AAZ Player',
              album: 'AAZ Player',
            });
          } else if (!track) {
            navigator.mediaSession.metadata = null;
          }
          navigator.mediaSession.playbackState = !track ? 'none' : isPlaying ? 'playing' : 'paused';
        } catch (err) {
          errorHandler.log('mediaSession.sync', err);
        }
      }

      function notifyShellTabState() {
        const track = getCurrentTrack();
        const isPlaying = !el.media.paused && !el.media.ended;
        const { queue, idx } = getCurrentQueuePosition();
        const canPrev = queue.length > 0 && (idx > 0 || state.repeatMode === 'all' || el.media.currentTime > 3);
        const canNext = queue.length > 0 && (idx < queue.length - 1 || state.repeatMode === 'all' || (state.shuffle && queue.length > 1));
        postToShell('aaz-tab-state', {
          title: track ? track.displayName : '',
          isPlaying,
          hasMedia: state.allTracks.length > 0,
          canPrev,
          canNext,
          kind: track ? track.kind : '',
          sinkLabel: state.audioSinkId ? (state.audioSinkLabel || '') : ''
        });
        syncMediaSession();
        syncMobileMiniBar();
      }

      function updatePlayButtonUI() {
        const playing = !el.media.paused && !el.media.ended;
        el.playIcon.style.display = playing ? 'none' : 'block';
        el.pauseIcon.style.display = playing ? 'block' : 'none';
        el.fsPlayIcon.style.display = playing ? 'none' : 'block';
        el.fsPauseIcon.style.display = playing ? 'block' : 'none';
        el.playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        notifyShellTabState();
      }

      function updateTransportAvailability() {
        const { queue, idx } = getCurrentQueuePosition();
        const hasAny = state.allTracks.length > 0;
        const hasCur = Boolean(state.currentKey);

        el.playPauseBtn.disabled = !hasAny;
        el.seekBar.disabled = !hasCur;
        el.skipBackBtn.disabled = !hasCur;
        el.skipForwardBtn.disabled = !hasCur;
        el.addBookmarkBtn.disabled = !hasCur;
        el.abLoopBtn.disabled = !hasCur;

        el.prevBtn.disabled = !(queue.length > 0 && (idx > 0 || state.repeatMode === 'all' || el.media.currentTime > 3));
        el.nextBtn.disabled = !(queue.length > 0 && (idx < queue.length - 1 || state.repeatMode === 'all' || (state.shuffle && queue.length > 1)));
        notifyShellTabState();
      }

      function updateSeekUI() {
        if (state.isSeeking) return;
        const cur = Number.isFinite(el.media.currentTime) ? el.media.currentTime : 0;
        const dur = Number.isFinite(el.media.duration) ? el.media.duration : 0;

        el.currentTimeLabel.textContent = formatTime(cur);
        el.fsTimeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        if (dur > 0) {
          el.durationLabel.textContent = state.showRemainingTime
            ? `-${formatTime(Math.max(0, dur - cur))}`
            : formatTime(dur);
          const ratio = Math.min(1, cur / dur);
          const val = String(Math.round(ratio * 1000));
          el.seekBar.value = val;
          el.fsSeekBar.value = val;
          setRangeFill(el.seekBar, ratio);
          setRangeFill(el.fsSeekBar, ratio);
        }
      }

      function updateVolumeUI() {
        const muted = el.media.muted || el.media.volume === 0;
        const displayVol = el.media.muted ? 0 : el.media.volume;
        el.volumeSlider.value = String(displayVol);
        setRangeFill(el.volumeSlider, displayVol);
        el.volumeReadout.textContent = `${Math.round(displayVol * 100)}%`;
        el.volHighIcon.style.display = muted ? 'none' : 'block';
        el.volMuteIcon.style.display = muted ? 'block' : 'none';
      }

      function updateShuffleRepeatUI() {
        el.shuffleBtn.classList.toggle('is-active', state.shuffle);
        el.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
        el.repeatBtn.classList.toggle('is-active', state.repeatMode !== 'off');
        el.repeatOneBadge.hidden = state.repeatMode !== 'one';
        const label = state.repeatMode === 'one' ? t('repeatOne') : state.repeatMode === 'all' ? t('repeatAll') : t('repeatOff');
        el.repeatBtn.title = label;
      }

      function updateSortButtonUI() {
        const map = {
          custom: t('sortCustom'),
          asc: 'A–Z',
          desc: 'Z–A',
          type: t('sortType'),
          duration: t('sortDuration')
        };
        el.sortBtn.textContent = map[state.sortMode] || 'A–Z';
        el.sortBtn.classList.toggle('is-active', state.sortMode === 'custom');
      }

      function updateModeTabsUI() {
        el.modeTabs.forEach((tab) => {
          const active = tab.dataset.mode === state.playlistMode;
          tab.classList.toggle('is-active', active);
          tab.setAttribute('aria-selected', String(active));
        });
      }

      function updateModeCounts() {
        const total = state.allTracks.length;
        const audio = state.allTracks.filter((tItem) => tItem.kind === 'audio').length;
        const video = total - audio;
        const starred = state.allTracks.filter((tItem) => state.starredKeys.has(tItem.key)).length;
        el.countAll.textContent = String(total);
        el.countAudio.textContent = String(audio);
        el.countVideo.textContent = String(video);
        el.countStarred.textContent = String(starred);
      }

      function updateSidebarCounts() {
        el.queueTabCount.textContent = String(state.allTracks.length);
        el.savedTabCount.textContent = String(state.savedPlaylists.length);
      }

      function updatePlaylistHeader() {
        const total = state.allTracks.length;
        const visible = getVisibleQueue().length;
        el.playlistTitle.textContent = state.folderName || t('currentQueue');
        if (total === 0) {
          el.playlistMeta.textContent = `0 ${t('itemsWord')}`;
        } else {
          const audio = state.allTracks.filter((tItem) => tItem.kind === 'audio').length;
          const video = total - audio;
          const watchedCount = state.allTracks.filter((tItem) => state.watchedKeys.has(tItem.key)).length;
          const totalDur = state.allTracks.reduce((acc, tr) => acc + (Number.isFinite(tr.duration) && tr.duration > 0 ? tr.duration : 0), 0);
          const parts = [];
          if (state.searchQuery.trim() || state.playlistMode !== 'all') {
            parts.push(`${t('showingWord')} ${visible} ${t('ofWord')} ${total}`);
          } else {
            parts.push(`${total} ${t('itemsWord')}`);
          }
          if (audio > 0 && video > 0) parts.push(`${audio} ${t('audioWord')} · ${video} ${t('videoWord')}`);
          else if (video > 0) parts.push(`${video} ${t('videoWord')}`);
          else if (audio > 0) parts.push(`${audio} ${t('audioWord')}`);
          if (totalDur > 0) parts.push(formatTime(totalDur));
          if (watchedCount > 0) parts.push(`${watchedCount} ${t('watchedWord')}`);
          el.playlistMeta.textContent = parts.join(' · ');
        }
        el.clearQueueBtn.hidden = total === 0;
        el.openSavePlBarBtn.hidden = total === 0;
      }

      /* =======================================================================
         13B. Playlist Powerhouse: Drag Reorder, Context Menu, Up Next, Undo & Tools
         ======================================================================= */
      function snapshotCurrentOrderToCustom() {
        if (state.sortMode === 'custom') return;
        const modeOrdered = getModeQueue();
        const inModeSet = new Set(modeOrdered.map((tr) => tr.key));
        const outside = state.allTracks.filter((tr) => !inModeSet.has(tr.key));
        state.allTracks = [...modeOrdered, ...outside];
        state.sortMode = 'custom';
        updateSortButtonUI();
      }

      function reorderTrack(fromKey, toKey, dropAfter = false) {
        if (!fromKey || !toKey || fromKey === toKey) return;
        snapshotCurrentOrderToCustom();
        const fromIdx = state.allTracks.findIndex((tr) => tr.key === fromKey);
        if (fromIdx === -1) return;
        const [moved] = state.allTracks.splice(fromIdx, 1);
        let toIdx = state.allTracks.findIndex((tr) => tr.key === toKey);
        if (toIdx === -1) {
          state.allTracks.push(moved);
        } else {
          if (dropAfter) toIdx += 1;
          state.allTracks.splice(toIdx, 0, moved);
        }
        renderPlaylist();
        updateNowPlayingUI();
        updateTransportAvailability();
        persistPlaybackState();
      }

      function moveTrackRelative(trackKey, direction, keepFocus = false) {
        if (!trackKey) return;
        snapshotCurrentOrderToCustom();
        const visible = getVisibleQueue();
        const visIdx = visible.findIndex((tr) => tr.key === trackKey);
        if (visIdx === -1) return;

        if (direction === 'top') {
          if (visIdx === 0) return;
          reorderTrack(trackKey, visible[0].key, false);
        } else if (direction === 'bottom') {
          if (visIdx === visible.length - 1) return;
          reorderTrack(trackKey, visible[visible.length - 1].key, true);
        } else if (direction === 'up') {
          if (visIdx <= 0) return;
          reorderTrack(trackKey, visible[visIdx - 1].key, false);
        } else if (direction === 'down') {
          if (visIdx >= visible.length - 1) return;
          reorderTrack(trackKey, visible[visIdx + 1].key, true);
        }

        if (keepFocus) {
          const row = Array.from(el.playlistList.querySelectorAll('.track-row')).find((r) => r.dataset.key === trackKey);
          if (row) row.focus();
        }
      }

      function removeTrackByKey(trackKey) {
        const idx = state.allTracks.findIndex((tr) => tr.key === trackKey);
        if (idx === -1) return;
        const wasCurrent = trackKey === state.currentKey;
        const prevQueue = getModeQueue();
        const prevQueueIdx = prevQueue.findIndex((tr) => tr.key === trackKey);
        const [removed] = state.allTracks.splice(idx, 1);

        state.upNextKeys = state.upNextKeys.filter((k) => k !== trackKey);
        if (state.stopAfterKey === trackKey) state.stopAfterKey = '';

        state.lastRemovedUndo = { track: removed, index: idx, wasCurrent };

        if (wasCurrent) {
          const nextQueue = getModeQueue();
          if (nextQueue.length > 0) {
            const nextTrack = nextQueue[Math.min(Math.max(prevQueueIdx, 0), nextQueue.length - 1)];
            const wasPlaying = !el.media.paused && !el.media.ended;
            loadTrackByKey(nextTrack.key, { autoPlay: wasPlaying, startTime: undefined });
          } else {
            stopAutosaveTimer();
            el.media.pause();
            el.media.removeAttribute('src');
            el.media.load();
            revokeMediaUrls();
            clearABLoop();
            AudioStudio.stopVisualizer();
            state.currentKey = '';
          }
        }

        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        updateStageVisibility();
        updateNowPlayingUI();
        updateTransportAvailability();
        renderPlaylist();
        persistPlaybackState();

        showNotice(t('plRemovedNotice', { name: removed.displayName }), false, undoLastTrackRemoval);
      }

      function undoLastTrackRemoval() {
        const undo = state.lastRemovedUndo;
        if (!undo || !undo.track) return;
        state.lastRemovedUndo = null;
        if (!state.allTracks.some((tr) => tr.key === undo.track.key)) {
          const insertAt = Math.min(Math.max(0, undo.index), state.allTracks.length);
          state.allTracks.splice(insertAt, 0, undo.track);
        }
        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        updateTransportAvailability();
        renderPlaylist();
        persistPlaybackState();
        showNotice(t('plRestoredNotice', { name: undo.track.displayName }));
      }

      function toggleUpNext(trackKey) {
        const track = state.allTracks.find((tr) => tr.key === trackKey);
        if (!track) return;
        const pos = state.upNextKeys.indexOf(trackKey);
        if (pos !== -1) {
          state.upNextKeys.splice(pos, 1);
        } else {
          state.upNextKeys.push(trackKey);
          showNotice(t('plUpNextAdded', { name: track.displayName }));
        }
        renderPlaylist();
      }

      function toggleStopAfter(trackKey) {
        const track = state.allTracks.find((tr) => tr.key === trackKey);
        if (!track) return;
        if (state.stopAfterKey === trackKey) {
          state.stopAfterKey = '';
          showNotice(t('plStopAfterCleared'));
        } else {
          state.stopAfterKey = trackKey;
          showNotice(t('plStopAfterSet', { name: track.displayName }));
        }
        renderPlaylist();
      }

      function toggleWatchedKey(trackKey) {
        if (!trackKey) return;
        if (state.watchedKeys.has(trackKey)) {
          state.watchedKeys.delete(trackKey);
        } else {
          state.watchedKeys.add(trackKey);
          delete state.progressByKey[trackKey];
        }
        updatePlaylistHeader();
        renderPlaylist();
        persistPlaybackState();
      }

      function resetTrackProgress(trackKey) {
        if (!trackKey) return;
        delete state.progressByKey[trackKey];
        state.watchedKeys.delete(trackKey);
        if (trackKey === state.currentKey) {
          seekToSeconds(0);
        }
        updatePlaylistHeader();
        renderPlaylist();
        persistPlaybackState();
      }

      function shuffleQueueOrder() {
        if (state.allTracks.length < 2) return;
        snapshotCurrentOrderToCustom();
        const arr = [...state.allTracks];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        state.allTracks = arr;
        renderPlaylist();
        updateNowPlayingUI();
        updateTransportAvailability();
        persistPlaybackState();
        showNotice(t('plShuffledNotice'));
      }

      function removeDuplicateTracks() {
        if (state.allTracks.length < 2) {
          showNotice(t('plNoDupes'));
          return;
        }
        const { kept, removed } = deduplicateTracksSafely(state.allTracks);
        const removedCount = removed.length;
        if (removedCount === 0) {
          showNotice(t('plNoDupes'));
          return;
        }
        state.allTracks = kept;
        state.upNextKeys = state.upNextKeys.filter((k) => kept.some((tr) => tr.key === k));
        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        updateTransportAvailability();
        renderPlaylist();
        persistPlaybackState();
        showNotice(t('plDupesRemoved', { n: removedCount }));
      }

      function removeWatchedTracks() {
        const before = state.allTracks.length;
        const kept = state.allTracks.filter((tr) => !state.watchedKeys.has(tr.key) || tr.key === state.currentKey);
        const removedCount = before - kept.length;
        if (removedCount === 0) {
          showNotice(t('plNoWatched'));
          return;
        }
        state.allTracks = kept;
        state.upNextKeys = state.upNextKeys.filter((k) => kept.some((tr) => tr.key === k));
        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        updateTransportAvailability();
        renderPlaylist();
        persistPlaybackState();
        showNotice(t('plWatchedRemoved', { n: removedCount }));
      }

      function appendTracksToQueue(newTracks, newSubMap) {
        if (!Array.isArray(newTracks) || newTracks.length === 0) return;
        const existingKeys = new Set(state.allTracks.map((tr) => tr.key));
        let added = 0;
        for (const tr of newTracks) {
          let key = tr.key;
          if (existingKeys.has(key)) {
            if (tr.fullPath && state.allTracks.some((e) => e.fullPath && e.fullPath === tr.fullPath)) continue;
            let suffix = 2;
            while (existingKeys.has(`${key} (${suffix})`)) suffix++;
            key = `${key} (${suffix})`;
            tr.key = key;
          }
          existingKeys.add(key);
          state.allTracks.push(tr);
          added++;
        }
        if (newSubMap) {
          for (const [k, v] of newSubMap.entries()) {
            state.subtitlesByBaseKey.set(k, v);
          }
        }
        if (added > 0 && state.nativeFolderPath) {
          const normFolder = normalizeFsPath(state.nativeFolderPath).replace(/\\+$/, '') + '\\';
          const stillPureFolder = state.allTracks.every((tr) => tr.fullPath && normalizeFsPath(tr.fullPath).startsWith(normFolder));
          if (!stillPureFolder) state.nativeFolderPath = '';
        }
        if (!state.folderName) state.folderName = t('currentQueue');
        el.resumeBanner.hidden = true;
        updateModeCounts();
        updateSidebarCounts();
        updatePlaylistHeader();
        updateTransportAvailability();
        renderPlaylist();
        persistPlaybackState();
        if (!state.currentKey && state.allTracks.length > 0) {
          loadTrackByKey(state.allTracks[0].key, { autoPlay: false, startTime: undefined });
        }
        showNotice(t('plAppendedNotice', { n: added }));
      }

      async function appendFilesToQueue() {
        hideNotice();
        if (desktopBridge && desktopBridge.selectFiles) {
          const res = await desktopBridge.selectFiles();
          if (!res || !res.entries?.length) return;
          const { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
          appendTracksToQueue(tracks, subMap);
          return;
        }
        state.appendModePending = 'files';
        el.filesInput.value = '';
        el.filesInput.click();
      }

      async function appendFolderToQueue() {
        hideNotice();
        if (desktopBridge && desktopBridge.selectFolder) {
          const res = await desktopBridge.selectFolder();
          if (!res || !res.entries?.length) return;
          const { tracks, subMap } = buildTracksFromElectronEntries(res.entries);
          appendTracksToQueue(tracks, subMap);
          return;
        }
        const pickerFn =
          (IS_TAB_FRAME && typeof window.parent.showDirectoryPicker === 'function')
            ? window.parent.showDirectoryPicker.bind(window.parent)
            : (typeof window.showDirectoryPicker === 'function' ? window.showDirectoryPicker.bind(window) : null);
        if (pickerFn) {
          try {
            const dirHandle = await pickerFn({ id: 'aaz-media-folder', mode: 'read' });
            const subMap = new Map();
            const tracks = await scanDirectoryHandle(dirHandle, '', subMap);
            tracks.sort((a, b) => naturalCollator.compare(a.key, b.key));
            appendTracksToQueue(tracks, subMap);
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return;
          }
        }
        state.appendModePending = 'folder';
        el.dirInput.value = '';
        el.dirInput.click();
      }

      function closePlaylistMenus() {
        if (el.playlistContextMenu) el.playlistContextMenu.hidden = true;
        if (el.savedPlContextMenu) el.savedPlContextMenu.hidden = true;
        if (el.playlistToolsMenu) el.playlistToolsMenu.hidden = true;
        state.activeContextTrackKey = '';
        state.activeContextSavedPlId = '';
      }

      function openPlaylistContextMenu(trackKey, clientX, clientY) {
        if (!el.playlistContextMenu) return;
        const track = state.allTracks.find((tr) => tr.key === trackKey);
        if (!track) return;
        closeAllMenus();
        state.activeContextTrackKey = trackKey;

        const isUpNext = state.upNextKeys.includes(trackKey);
        const isStopAfter = state.stopAfterKey === trackKey;
        const isStarred = state.starredKeys.has(trackKey);
        const isWatched = state.watchedKeys.has(trackKey);

        if (el.plCtxPlayNextLbl) el.plCtxPlayNextLbl.textContent = isUpNext ? t('plCtxRemoveUpNext') : t('plCtxPlayNext');
        if (el.plCtxStopAfterLbl) el.plCtxStopAfterLbl.textContent = isStopAfter ? t('plCtxClearStopAfter') : t('plCtxStopAfter');
        if (el.plCtxStarLbl) el.plCtxStarLbl.textContent = isStarred ? t('plCtxUnstar') : t('plCtxStar');
        if (el.plCtxWatchedLbl) el.plCtxWatchedLbl.textContent = isWatched ? t('plCtxUnwatched') : t('plCtxWatched');

        el.playlistContextMenu.hidden = false;
        el.playlistContextMenu.style.left = '0px';
        el.playlistContextMenu.style.top = '0px';
        const rect = el.playlistContextMenu.getBoundingClientRect();
        const pad = 8;
        const x = Math.min(Math.max(clientX, pad), Math.max(pad, window.innerWidth - rect.width - pad));
        const y = Math.min(Math.max(clientY, pad), Math.max(pad, window.innerHeight - rect.height - pad));
        el.playlistContextMenu.style.left = `${x}px`;
        el.playlistContextMenu.style.top = `${y}px`;
      }

      function executePlaylistContextCommand(cmd) {
        const key = state.activeContextTrackKey;
        closePlaylistMenus();
        if (!key) return;
        const track = state.allTracks.find((tr) => tr.key === key);
        if (!track) return;

        switch (cmd) {
          case 'play':
            loadTrackByKey(key, { autoPlay: true, startTime: undefined });
            break;
          case 'play-next':
            toggleUpNext(key);
            break;
          case 'stop-after':
            toggleStopAfter(key);
            break;
          case 'move-top':
            moveTrackRelative(key, 'top');
            break;
          case 'move-up':
            moveTrackRelative(key, 'up');
            break;
          case 'move-down':
            moveTrackRelative(key, 'down');
            break;
          case 'move-bottom':
            moveTrackRelative(key, 'bottom');
            break;
          case 'toggle-star':
            toggleStarKey(key);
            break;
          case 'toggle-watched':
            toggleWatchedKey(key);
            break;
          case 'reset-progress':
            resetTrackProgress(key);
            break;
          case 'copy-name':
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(track.name).then(() => {
                showNotice(t('plCopiedName', { name: track.name }));
              }).catch((err) => errorHandler.log('clipboard.copyTrackName', err));
            }
            break;
          case 'remove':
            removeTrackByKey(key);
            break;
        }
      }

      function updateTrackRowProgress(trackKey, pct) {
        const rows = el.playlistList.querySelectorAll('.track-row');
        for (const row of rows) {
          if (row.dataset.key === trackKey) {
            let fill = row.querySelector('.track-progress-fill');
            if (!fill && pct > 0) {
              const bar = document.createElement('span');
              bar.className = 'track-progress-bar';
              fill = document.createElement('span');
              fill.className = 'track-progress-fill';
              bar.appendChild(fill);
              row.appendChild(bar);
            }
            if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            break;
          }
        }
      }

      function renderPlaylist() {
        el.playlistList.innerHTML = '';
        if (state.allTracks.length === 0) {
          el.playlistList.appendChild(el.emptyState);
          return;
        }
        const visible = getVisibleQueue();
        if (visible.length === 0) {
          const msg = document.createElement('div');
          msg.className = 'no-results';
          msg.textContent = state.searchQuery.trim()
            ? `No files matching "${state.searchQuery.trim()}"`
            : state.playlistMode === 'starred'
              ? 'No starred tracks yet.'
              : `No ${state.playlistMode} files in this playlist.`;
          el.playlistList.appendChild(msg);
          return;
        }

        const frag = document.createDocumentFragment();
        visible.forEach((track, idx) => {
          const isActive = track.key === state.currentKey;
          const isStarred = state.starredKeys.has(track.key);
          const isWatched = state.watchedKeys.has(track.key);
          const upNextPos = state.upNextKeys.indexOf(track.key);
          const isStopAfter = state.stopAfterKey === track.key;
          const prog = state.progressByKey[track.key];
          const progPct = prog && prog.duration > 0 ? Math.min(100, Math.round((prog.time / prog.duration) * 100)) : 0;
          const hasSub = track.kind === 'video' && state.subtitlesByBaseKey.has(stripExtension(track.key).toLowerCase());

          const row = document.createElement('div');
          row.className = `track-row${isActive ? ' is-active' : ''}${isWatched ? ' is-watched' : ''}`;
          row.dataset.key = track.key;
          row.setAttribute('role', 'option');
          row.setAttribute('tabindex', '0');
          row.setAttribute('aria-selected', String(isActive));
          row.title = track.key;

          const dragGrip = document.createElement('span');
          dragGrip.className = 'track-drag-handle';
          dragGrip.setAttribute('aria-hidden', 'true');
          dragGrip.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>';

          const idxCell = document.createElement('span');
          idxCell.className = 'track-index';
          idxCell.innerHTML = isActive
            ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>'
            : String(idx + 1).padStart(2, '0');

          const infoCell = document.createElement('span');
          infoCell.className = 'track-info';

          const nameRow = document.createElement('span');
          nameRow.className = 'track-name-row';

          const nameSpan = document.createElement('span');
          nameSpan.className = 'track-name';
          nameSpan.textContent = track.displayName;
          nameRow.appendChild(nameSpan);

          if (isWatched) {
            const wDot = document.createElement('span');
            wDot.className = 'track-watched-dot';
            wDot.title = t('watchedWord');
            wDot.textContent = '✓';
            nameRow.appendChild(wDot);
          }
          if (upNextPos !== -1) {
            const badge = document.createElement('span');
            badge.className = 'track-mini-tag is-upnext';
            badge.textContent = t('upNextBadge', { n: upNextPos + 1 });
            nameRow.appendChild(badge);
          }
          if (isStopAfter) {
            const badge = document.createElement('span');
            badge.className = 'track-mini-tag is-stop';
            badge.textContent = t('stopAfterBadge');
            nameRow.appendChild(badge);
          }
          infoCell.appendChild(nameRow);

          const subParts = [];
          if (track.kind === 'video') subParts.push('Video');
          subParts.push(track.ext);
          if (hasSub) subParts.push('CC');
          if (track.folderPath) subParts.push(track.folderPath);

          const subSpan = document.createElement('span');
          subSpan.className = 'track-sub';
          subSpan.textContent = subParts.join(' · ');
          infoCell.appendChild(subSpan);

          const starBtn = document.createElement('button');
          starBtn.type = 'button';
          starBtn.className = `track-star-btn${isStarred ? ' is-starred' : ''}`;
          starBtn.setAttribute('aria-label', isStarred ? 'Unstar track' : 'Star track');
          starBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
          starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStarKey(track.key);
          });

          const rightCell = document.createElement('span');
          rightCell.className = 'track-right';
          rightCell.textContent = track.duration ? formatTime(track.duration) : track.size ? formatBytes(track.size) : '';

          row.append(dragGrip, idxCell, infoCell, starBtn, rightCell);

          if (progPct > 2 && !isWatched) {
            const bar = document.createElement('span');
            bar.className = 'track-progress-bar';
            const fill = document.createElement('span');
            fill.className = 'track-progress-fill';
            fill.style.width = `${progPct}%`;
            bar.appendChild(fill);
            row.appendChild(bar);
          }

          // Pointer-Events Manual Reorder (100% WebView2 / Tauri / Touch / Mouse compatible — no OS forbidden cursor!)
          row.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.track-star-btn')) return;
            startPointerTrackReorder(e, row, track);
          });

          // Right-click Playlist Track Context Menu
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPlaylistContextMenu(track.key, e.clientX, e.clientY);
          });

          const activate = () => {
            if (Date.now() - pointerDragSuppressClickUntil < 260) return;
            if (track.key === state.currentKey) togglePlayPause();
            else loadTrackByKey(track.key, { autoPlay: true, startTime: undefined });
          };
          row.addEventListener('click', activate);
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              activate();
            } else if (e.key === 'Delete') {
              e.preventDefault();
              e.stopPropagation();
              removeTrackByKey(track.key);
            } else if (e.altKey && e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              moveTrackRelative(track.key, 'up', true);
            } else if (e.altKey && e.key === 'ArrowDown') {
              e.preventDefault();
              e.stopPropagation();
              moveTrackRelative(track.key, 'down', true);
            }
          });
          frag.appendChild(row);
        });
        el.playlistList.appendChild(frag);
      }

      let pointerDragSuppressClickUntil = 0;

      function startPointerTrackReorder(downEvent, sourceRow, track) {
        const startX = downEvent.clientX;
        const startY = downEvent.clientY;
        const startedOnGrip = Boolean(downEvent.target.closest('.track-drag-handle'));
        let active = false;
        let ghost = null;
        let dropTargetKey = '';
        let dropAfter = false;
        let scrollRaf = null;
        let lastClientY = startY;

        const clearDropHints = () => {
          el.playlistList.querySelectorAll('.is-drop-before, .is-drop-after').forEach((n) => {
            n.classList.remove('is-drop-before', 'is-drop-after');
          });
        };

        const updateDropTarget = (clientY) => {
          clearDropHints();
          dropTargetKey = '';
          const rows = Array.from(el.playlistList.querySelectorAll('.track-row'));
          if (rows.length < 2) return;

          let bestRow = null;
          let bestDist = Infinity;
          let after = false;

          for (const r of rows) {
            const rect = r.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            const dist = Math.abs(clientY - mid);
            if (dist < bestDist) {
              bestDist = dist;
              bestRow = r;
              after = clientY > mid;
            }
          }

          if (bestRow && bestRow.dataset.key !== track.key) {
            dropTargetKey = bestRow.dataset.key;
            dropAfter = after;
            bestRow.classList.toggle('is-drop-before', !after);
            bestRow.classList.toggle('is-drop-after', after);
          }
        };

        const runAutoScroll = () => {
          if (!active) return;
          const listRect = el.playlistList.getBoundingClientRect();
          const edge = 38;
          if (lastClientY < listRect.top + edge) {
            el.playlistList.scrollTop -= Math.max(3, Math.round((listRect.top + edge - lastClientY) * 0.28));
            updateDropTarget(lastClientY);
          } else if (lastClientY > listRect.bottom - edge) {
            el.playlistList.scrollTop += Math.max(3, Math.round((lastClientY - (listRect.bottom - edge)) * 0.28));
            updateDropTarget(lastClientY);
          }
          scrollRaf = requestAnimationFrame(runAutoScroll);
        };

        const beginDrag = (ev) => {
          active = true;
          state.dragTrackKey = track.key;
          sourceRow.classList.add('is-dragging');
          document.body.classList.add('is-reordering-tracks');

          ghost = document.createElement('div');
          ghost.className = 'track-drag-ghost';
          const dot = document.createElement('span');
          dot.className = 'track-drag-ghost-dot';
          const txt = document.createElement('span');
          txt.textContent = track.displayName;
          ghost.append(dot, txt);
          ghost.style.transform = `translate3d(${ev.clientX + 14}px, ${ev.clientY - 16}px, 0)`;
          document.body.appendChild(ghost);
          scrollRaf = requestAnimationFrame(runAutoScroll);
        };

        const onPointerMove = (ev) => {
          lastClientY = ev.clientY;
          if (!active) {
            const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
            if (dist < (startedOnGrip ? 3 : 7)) return;
            beginDrag(ev);
          }
          ev.preventDefault();
          if (ghost) {
            const gx = Math.min(window.innerWidth - 220, Math.max(8, ev.clientX + 14));
            const gy = Math.min(window.innerHeight - 40, Math.max(8, ev.clientY - 16));
            ghost.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
          }
          updateDropTarget(ev.clientY);
        };

        const finish = (commit) => {
          window.removeEventListener('pointermove', onPointerMove, true);
          window.removeEventListener('pointerup', onPointerUp, true);
          window.removeEventListener('pointercancel', onPointerCancel, true);
          window.removeEventListener('blur', onPointerCancel);
          if (scrollRaf) cancelAnimationFrame(scrollRaf);
          clearDropHints();
          sourceRow.classList.remove('is-dragging');
          document.body.classList.remove('is-reordering-tracks');
          if (ghost) ghost.remove();
          const wasActive = active;
          const target = dropTargetKey;
          const isAfter = dropAfter;
          active = false;
          state.dragTrackKey = '';
          if (wasActive) {
            pointerDragSuppressClickUntil = Date.now();
            if (commit && target && target !== track.key) {
              reorderTrack(track.key, target, isAfter);
            }
          }
        };

        const onPointerUp = () => finish(true);
        const onPointerCancel = () => finish(false);

        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerCancel, true);
        window.addEventListener('blur', onPointerCancel);
      }

      function highlightActivePlaylistRow(scrollIntoView = false) {
        const rows = el.playlistList.querySelectorAll('.track-row');
        rows.forEach((row, idx) => {
          const isActive = row.dataset.key === state.currentKey;
          row.classList.toggle('is-active', isActive);
          row.setAttribute('aria-selected', String(isActive));
          const idxCell = row.querySelector('.track-index');
          if (idxCell) {
            idxCell.innerHTML = isActive
              ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>'
              : String(idx + 1).padStart(2, '0');
          }
          if (isActive && scrollIntoView) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }

      function updateTrackRowDuration(trackKey, duration) {
        const rows = el.playlistList.querySelectorAll('.track-row');
        for (const row of rows) {
          if (row.dataset.key === trackKey) {
            const rightCell = row.querySelector('.track-right');
            if (rightCell) rightCell.textContent = formatTime(duration);
            break;
          }
        }
      }

      function refreshResumeBanner() {
        const saved = state.savedSession;
        const hasSavedPl = Boolean(
          saved?.activeSavedPlaylistId && state.savedPlaylists.some((p) => p.id === saved.activeSavedPlaylistId)
        );
        const hasNativeFolder = Boolean(desktopBridge && saved?.nativeFolderPath);
        const hasNativeFiles = Boolean(
          desktopBridge && (saved?.trackFullPath || (Array.isArray(saved?.nativeTrackPaths) && saved.nativeTrackPaths.length > 0))
        );
        const hasLegacyHistory = Boolean(desktopBridge && findLegacyHistoryFullPath(saved));
        const hasNative = hasSavedPl || hasNativeFolder || hasNativeFiles || hasLegacyHistory;
        const hasHandle = Boolean(state.savedDirHandle);
        const hasInfo = Boolean(saved && saved.trackName);

        if (!hasNative && !hasHandle && !hasInfo) {
          el.resumeBanner.hidden = true;
          return;
        }
        const folderLabel = state.savedDirHandle?.name || saved?.folderName || t('currentQueue');
        el.resumeTrackLabel.textContent = saved?.trackName ? stripExtension(saved.trackName) : `Folder: ${folderLabel}`;
        const timeStr = Number.isFinite(saved?.currentTime) ? formatTime(saved.currentTime) : '00:00';
        el.resumeDetailLabel.textContent = (hasNative || hasHandle || desktopBridge)
          ? `${folderLabel} · ${timeStr}`
          : `${folderLabel} · ${timeStr} · ${t('reselectHint')}`;
        el.resumeBanner.hidden = false;
      }

      /* =======================================================================
         14. Top Desktop Menu Bar, Cascading Submenus & Custom Context Menu
         ======================================================================= */
      function closeAllSubmenus(root = document) {
        root.querySelectorAll('.menu-sub.is-sub-open').forEach((sub) => sub.classList.remove('is-sub-open'));
      }

      function closeContextMenu() {
        if (!el.contextMenu) return;
        el.contextMenu.hidden = true;
        closeAllSubmenus(el.contextMenu);
      }

      function closeAllMenus() {
        el.menuBar.querySelectorAll('.menu-item.is-open').forEach((item) => {
          item.classList.remove('is-open');
          item.querySelector('.menu-trigger')?.setAttribute('aria-expanded', 'false');
        });
        closeAllSubmenus(el.menuBar);
        closeContextMenu();
        closePlaylistMenus();
      }

      function positionSubmenuFlyout(subEl) {
        if (!subEl) return;
        const panel = subEl.querySelector(':scope > .menu-sub-panel');
        if (!panel) return;
        subEl.classList.remove('is-flip-x', 'is-flip-x-right', 'is-flip-y');

        const isRtl = document.documentElement.dir === 'rtl';
        const subRect = subEl.getBoundingClientRect();
        const estW = Math.max(panel.offsetWidth || 0, 224);
        const estH = Math.max(panel.offsetHeight || 0, 220);

        if (!isRtl) {
          if (subRect.right + estW + 12 > window.innerWidth && subRect.left - estW - 12 > 0) {
            subEl.classList.add('is-flip-x');
          }
        } else {
          if (subRect.left - estW - 12 < 0 && subRect.right + estW + 12 < window.innerWidth) {
            subEl.classList.add('is-flip-x-right');
          }
        }

        if (subRect.top + estH + 12 > window.innerHeight && subRect.bottom - estH > 8) {
          subEl.classList.add('is-flip-y');
        }
      }

      function bindSubmenus(container) {
        if (!container) return;
        container.querySelectorAll('.menu-sub').forEach((subEl) => {
          const trigger = subEl.querySelector(':scope > .menu-sub-trigger');
          subEl.addEventListener('mouseenter', () => {
            positionSubmenuFlyout(subEl);
          });
          if (trigger) {
            trigger.addEventListener('click', (e) => {
              e.stopPropagation();
              const wasOpen = subEl.classList.contains('is-sub-open');
              const parentMenu = subEl.parentElement;
              if (parentMenu) closeAllSubmenus(parentMenu);
              if (!wasOpen) {
                positionSubmenuFlyout(subEl);
                subEl.classList.add('is-sub-open');
              }
            });
          }
        });
      }

      bindSubmenus(el.menuBar);
      bindSubmenus(el.contextMenu);

      el.menuBar.querySelectorAll('.menu-item').forEach((item) => {
        const trigger = item.querySelector('.menu-trigger');
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasOpen = item.classList.contains('is-open');
          closeAllMenus();
          if (!wasOpen) {
            if (phase3 && item.querySelector('#mediaRecentSubmenu')) phase3.renderHistory();
            item.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
          }
        });
        trigger.addEventListener('mouseenter', () => {
          if (el.menuBar.querySelector('.menu-item.is-open') && !item.classList.contains('is-open')) {
            closeAllMenus();
            if (phase3 && item.querySelector('#mediaRecentSubmenu')) phase3.renderHistory();
            item.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
          }
        });
      });

      document.addEventListener('click', () => closeAllMenus());
      window.addEventListener('resize', () => closeContextMenu());
      window.addEventListener('blur', () => closeAllMenus());

      function openStageContextMenu(clientX, clientY) {
        if (!el.contextMenu) return;
        closeAllMenus();
        el.contextMenu.hidden = false;
        el.contextMenu.style.left = '0px';
        el.contextMenu.style.top = '0px';

        const rect = el.contextMenu.getBoundingClientRect();
        const pad = 8;
        const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
        const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
        const x = Math.min(Math.max(clientX, pad), maxLeft);
        const y = Math.min(Math.max(clientY, pad), maxTop);

        el.contextMenu.style.left = `${x}px`;
        el.contextMenu.style.top = `${y}px`;
      }

      // Suppress WebView2/Browser default context menu everywhere (except editable inputs)
      // and open AAZ Player's custom themed context menu on the media stage
      document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]')) {
          return;
        }
        e.preventDefault();
        if (e.target.closest('#aazContextMenu, #playlistContextMenu, #savedPlContextMenu, .track-row, .saved-pl-card')) return;
        if (e.target.closest('#mediaStage')) {
          openStageContextMenu(e.clientX, e.clientY);
        } else {
          closeAllMenus();
        }
      });

      function openSavePlaylistPrompt() {
        if (state.allTracks.length === 0) {
          showNotice('Load a folder or files first before saving a playlist.', true);
          return;
        }
        if (state.sidebarHidden) toggleSidebar();
        switchSidebarTab('queue');
        el.savePlBar.hidden = false;
        el.savePlNameInput.value = state.folderName || 'My Playlist';
        el.savePlNameInput.focus();
        el.savePlNameInput.select();
      }

      async function executeMenuAction(actionBtn) {
        if (!actionBtn || actionBtn.classList.contains('menu-sub-trigger')) return;
        closeAllMenus();

        const cmd = actionBtn.dataset.cmd;
        if (actionBtn.dataset.speed) {
          setPlaybackRate(Number(actionBtn.dataset.speed), true);
          return;
        }
        if (actionBtn.dataset.sleep !== undefined) {
          configureSleepTimer(actionBtn.dataset.sleep);
          return;
        }
        if (actionBtn.dataset.eq) {
          applyEQPreset(actionBtn.dataset.eq, true);
          return;
        }
        if (actionBtn.dataset.aspect) {
          setVideoAspect(actionBtn.dataset.aspect, true);
          return;
        }
        if (actionBtn.dataset.zoom) {
          setVideoZoom(Number(actionBtn.dataset.zoom), true);
          return;
        }
        if (actionBtn.dataset.crop) {
          setVideoCrop(actionBtn.dataset.crop, true);
          return;
        }

        switch (cmd) {
          case 'open-folder': openFolderWithPersistence(false); break;
          case 'open-files': openFilesPicker(); break;
          case 'new-tab': postToShell('aaz-new-tab'); break;
          case 'new-window': openNewPlayerWindow(); break;
          case 'resume-session': handleResumeLastSession(); break;
          case 'save-to-library': openSavePlaylistPrompt(); break;
          case 'import-playlist': el.playlistImportInput.value = ''; el.playlistImportInput.click(); break;
          case 'export-xspf': exportPlaylistFile('xspf'); break;
          case 'export-m3u8': exportPlaylistFile('m3u8'); break;
          case 'export-pls': exportPlaylistFile('pls'); break;
          case 'clear-queue': clearQueue(); notifyShellTabState(); break;
          case 'toggle-play': togglePlayPause(); break;
          case 'prev-track': playPreviousTrack(); break;
          case 'next-track': playNextTrack(true, false); break;
          case 'prev-frame': stepVideoFrame(-1); break;
          case 'next-frame': stepVideoFrame(1); break;
          case 'toggle-shuffle': state.shuffle = !state.shuffle; updateShuffleRepeatUI(); updateTransportAvailability(); persistPlaybackState(); break;
          case 'cycle-repeat': {
            const order = ['off', 'all', 'one'];
            state.repeatMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
            updateShuffleRepeatUI(); updateTransportAvailability(); persistPlaybackState();
            break;
          }
          case 'ab-loop': cycleABLoop(); break;
          case 'add-bookmark': addBookmarkAtCurrentTime(); break;
          case 'open-audio-output': toggleAudioOutputPopover(true); break;
          case 'toggle-eq':
            el.eqDrawer.hidden = !el.eqDrawer.hidden;
            el.eqToggleBtn.setAttribute('aria-expanded', String(!el.eqDrawer.hidden));
            updateEQUI();
            break;
          case 'toggle-mute': toggleMute(); break;
          case 'toggle-video-view':
            setVideoDisplayMode(state.videoDisplayMode === 'video' ? 'audio' : 'video', true);
            break;
          case 'take-snapshot': captureVideoSnapshot(); break;
          case 'reset-video-transform': resetVideoTransform(true); break;
          case 'load-subtitles':
            el.subtitleInput.value = '';
            el.subtitleInput.click();
            break;
          case 'toggle-subtitles':
            if (state.activeSubtitleUrl) {
              state.subtitlesEnabled = !state.subtitlesEnabled;
              el.subtitleBtn.classList.toggle('is-active', state.subtitlesEnabled);
              renderActiveSubtitleCues();
            }
            break;
          case 'open-subtitle-style': openSubtitleStyleModal(); break;
          case 'sub-sync-earlier': adjustSubtitleOffset(-0.25, true); break;
          case 'sub-sync-later': adjustSubtitleOffset(0.25, true); break;
          case 'sub-sync-reset': resetSubtitleOffset(true); break;
          case 'open-cast': openCastModal(); break;
          case 'toggle-pip': togglePictureInPicture(); break;
          case 'toggle-fullscreen': toggleFullscreen(); break;
          case 'toggle-theme': applyTheme(state.theme === 'dark' ? 'light' : 'dark', true); break;
          case 'open-themes': openThemeGalleryModal(); break;
          case 'toggle-lang': applyLanguage(state.lang === 'ar' ? 'en' : 'ar', true); break;
          case 'toggle-sidebar': toggleSidebar(); break;
          case 'open-saved-tab':
            if (state.sidebarHidden) toggleSidebar();
            switchSidebarTab('saved');
            break;
          case 'open-library-tab':
            if (state.sidebarHidden) toggleSidebar();
            switchSidebarTab('library');
            break;
          case 'toggle-mini-player':
            if (phase3) phase3.toggleMiniPlayer();
            break;
          case 'open-settings':
            if (phase3) phase3.openSettingsModal();
            break;
          case 'toggle-pin': el.pinWindowBtn.click(); break;
          case 'check-updates': triggerUpdateCheck(); break;
          case 'show-shortcuts':
            if (phase3) phase3.renderShortcutsEditor();
            el.shortcutsModal.hidden = false;
            break;
        }
      }

      el.menuBar.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('.menu-action');
        if (!actionBtn || actionBtn.classList.contains('menu-sub-trigger')) return;
        e.stopPropagation();
        executeMenuAction(actionBtn);
      });

      if (el.contextMenu) {
        el.contextMenu.addEventListener('click', (e) => {
          const actionBtn = e.target.closest('.menu-action');
          if (!actionBtn || actionBtn.classList.contains('menu-sub-trigger')) return;
          e.stopPropagation();
          executeMenuAction(actionBtn);
        });
      }

      /* =======================================================================
         14C. Cast to TV & Smart Screen Engine (DLNA/UPnP + LAN Stream + Miracast)
         ======================================================================= */
      function getMimeForTrack(track) {
        const ext = (track?.ext || '').toLowerCase();
        const map = {
          mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
          mov: 'video/quicktime', avi: 'video/x-msvideo', ogv: 'video/ogg', ts: 'video/mp2t',
          mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
          m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus'
        };
        return map[ext] || (track?.kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
      }

      function getShiftedSubtitleVtt() {
        if (!state.activeSubtitleVtt || !state.subtitlesEnabled) return null;
        if (Math.abs(state.subtitleOffsetSec) < 0.001) return state.activeSubtitleVtt;
        return shiftWebVtt(state.activeSubtitleVtt, state.subtitleOffsetSec);
      }

      function syncCastButtonState() {
        const active = Boolean(state.castServerInfo || state.activeCastDevice);
        if (el.videoCastBtn) el.videoCastBtn.classList.toggle('is-active', active);
        if (el.castLanToggleBtn) {
          el.castLanToggleBtn.textContent = state.castServerInfo ? t('castStopLan') : t('castStartLan');
          el.castLanToggleBtn.classList.toggle('btn-primary', !state.castServerInfo);
        }
        if (el.castLanUrlBox && el.castLanUrlText) {
          el.castLanUrlBox.hidden = !state.castServerInfo;
          if (state.castServerInfo) {
            el.castLanUrlText.textContent = state.castServerInfo.receiverUrl;
          }
        }
        if (el.castRemoteBar) {
          el.castRemoteBar.hidden = !state.activeCastDevice;
          if (state.activeCastDevice) {
            const cur = getCurrentTrack();
            el.castConnectedName.textContent = state.activeCastDevice.name;
            el.castConnectedTrack.textContent = cur ? cur.displayName : '';
          }
        }
      }

      async function ensureCastLanServer(track) {
        if (!desktopBridge || !desktopBridge.castStartServer) {
          showNotice(t('castDesktopOnly'), true);
          return null;
        }
        if (!track || !track.fullPath) {
          showNotice(t('castNoTrack'), true);
          return null;
        }
        const info = await desktopBridge.castStartServer(
          track.fullPath,
          track.displayName || track.name,
          getShiftedSubtitleVtt()
        );
        state.castServerInfo = info;
        syncCastButtonState();
        return info;
      }

      async function syncActiveCastTrack(track) {
        if (!track || !track.fullPath || !desktopBridge || !desktopBridge.castStartServer) return;
        const info = await desktopBridge.castStartServer(
          track.fullPath,
          track.displayName || track.name,
          getShiftedSubtitleVtt()
        );
        state.castServerInfo = info;
        if (state.activeCastDevice && desktopBridge.castToDlna) {
          const bustUrl = appendQueryParam(info.mediaUrl, 't', Date.now());
          await desktopBridge.castToDlna(
            state.activeCastDevice.controlUrl,
            bustUrl,
            track.displayName || track.name,
            getMimeForTrack(track)
          );
        }
        syncCastButtonState();
      }

      async function toggleCastLanServer() {
        if (state.castServerInfo) {
          if (desktopBridge && desktopBridge.castStopServer) {
            await desktopBridge.castStopServer().catch((err) => errorHandler.log('cast.stopServer', err));
          }
          state.castServerInfo = null;
          state.activeCastDevice = null;
          syncCastButtonState();
          renderCastDevices();
          return;
        }
        const track = getCurrentTrack();
        if (!track) {
          showNotice(t('castNoTrack'), true);
          return;
        }
        try {
          await ensureCastLanServer(track);
        } catch (err) {
          errorHandler.notify(ErrorCategory.NETWORK_DLNA, err);
        }
      }

      function renderCastDevices() {
        if (!el.castDeviceList) return;
        el.castDeviceList.innerHTML = '';

        if (!desktopBridge || !desktopBridge.castDiscoverDevices) {
          const hint = document.createElement('div');
          hint.className = 'cast-empty-hint';
          hint.textContent = t('castDesktopOnly');
          el.castDeviceList.appendChild(hint);
          return;
        }

        if (state.castScanning) {
          const scanning = document.createElement('div');
          scanning.className = 'cast-empty-hint';
          scanning.textContent = t('castScanning');
          el.castDeviceList.appendChild(scanning);
          return;
        }

        if (state.castDevices.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'cast-empty-hint';
          empty.textContent = t('castNoneFound');
          el.castDeviceList.appendChild(empty);
          return;
        }

        const frag = document.createDocumentFragment();
        for (const dev of state.castDevices) {
          const isConnected = state.activeCastDevice && state.activeCastDevice.id === dev.id;
          const item = document.createElement('div');
          item.className = `cast-device-item${isConnected ? ' is-connected' : ''}`;

          const info = document.createElement('div');
          info.className = 'cast-device-meta';
          const nameEl = document.createElement('div');
          nameEl.className = 'cast-device-name';
          nameEl.textContent = dev.name;
          const metaEl = document.createElement('div');
          metaEl.className = 'cast-device-sub';
          metaEl.textContent = dev.manufacturer ? `${dev.manufacturer} · DLNA / UPnP` : 'DLNA / UPnP Smart TV';
          info.append(nameEl, metaEl);

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `btn ${isConnected ? 'btn-primary' : ''}`;
          btn.style.height = '28px';
          btn.style.padding = '0 12px';
          btn.style.fontSize = '12px';
          btn.textContent = isConnected ? t('castBtnConnected') : t('castBtnSend');
          btn.addEventListener('click', () => castToDlnaDevice(dev));

          item.append(info, btn);
          frag.appendChild(item);
        }
        el.castDeviceList.appendChild(frag);
      }

      async function scanCastDevices() {
        if (!desktopBridge || !desktopBridge.castDiscoverDevices) {
          renderCastDevices();
          return;
        }
        state.castScanning = true;
        if (el.castScanBtn) {
          el.castScanBtn.disabled = true;
          el.castScanBtn.textContent = t('castScanning');
        }
        renderCastDevices();
        try {
          const devices = await desktopBridge.castDiscoverDevices();
          state.castDevices = Array.isArray(devices) ? devices : [];
        } catch (err) {
          errorHandler.log('cast.discoverDevices', err);
          state.castDevices = [];
        } finally {
          state.castScanning = false;
          if (el.castScanBtn) {
            el.castScanBtn.disabled = false;
            el.castScanBtn.textContent = t('castScan');
          }
          renderCastDevices();
        }
      }

      async function castToDlnaDevice(device) {
        const track = getCurrentTrack();
        if (!track || !track.fullPath) {
          showNotice(t('castNoTrack'), true);
          return;
        }
        try {
          const info = await ensureCastLanServer(track);
          if (!info) return;
          const bustUrl = appendQueryParam(info.mediaUrl, 't', Date.now());
          await desktopBridge.castToDlna(
            device.controlUrl,
            bustUrl,
            track.displayName || track.name,
            getMimeForTrack(track)
          );
          state.activeCastDevice = device;
          el.media.pause();
          syncCastButtonState();
          renderCastDevices();
          showNotice(t('castSentNotice', { title: track.displayName, device: device.name }));
        } catch (err) {
          errorHandler.notify(ErrorCategory.NETWORK_DLNA, err, device.name);
        }
      }

      async function sendDlnaControl(action) {
        if (!state.activeCastDevice || !desktopBridge || !desktopBridge.castDlnaControl) return;
        try {
          await desktopBridge.castDlnaControl(state.activeCastDevice.controlUrl, action, null);
          if (action === 'stop') {
            state.activeCastDevice = null;
            syncCastButtonState();
            renderCastDevices();
          }
        } catch (err) {
          errorHandler.notify(ErrorCategory.NETWORK_DLNA, err);
        }
      }

      async function triggerWindowsMiracast() {
        if (desktopBridge && desktopBridge.castOpenWindowsCast) {
          await desktopBridge.castOpenWindowsCast().catch((err) => errorHandler.log('cast.openWindowsCast', err));
        } else {
          showNotice(t('castDesktopOnly'), true);
        }
      }

      async function triggerBrowserRemoteCast() {
        const track = getCurrentTrack();
        if (!track) {
          showNotice(t('castNoTrack'), true);
          return;
        }
        if (el.media && el.media.remote && typeof el.media.remote.prompt === 'function') {
          try {
            await el.media.remote.prompt();
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            errorHandler.log('cast.remotePrompt', err);
          }
        }
        showNotice(t('castBrowserUnsupported'), true);
      }

      function openCastModal() {
        if (!el.castModal) return;
        closeAllMenus();
        el.castModal.hidden = false;
        syncCastButtonState();
        if (desktopBridge && desktopBridge.castDiscoverDevices && state.castDevices.length === 0 && !state.castScanning) {
          scanCastDevices();
        } else {
          renderCastDevices();
        }
      }

      function closeCastModal() {
        if (el.castModal) el.castModal.hidden = true;
      }

      /* =======================================================================
         14B. Built-In Auto-Updater UI Controller (GitHub Releases / Electron)
         ======================================================================= */
      function handleUpdateStatus(payload) {
        if (!payload || !payload.status) return;
        const { status, version, percent, message } = payload;

        if (status === 'checking') {
          showNotice(t('updateChecking'));
        } else if (status === 'available') {
          state.updateState = 'available';
          el.updateBannerText.textContent = t('updateAvailable', { v: version || '' });
          el.updateProgressTrack.hidden = true;
          el.updateActionBtn.hidden = false;
          el.updateActionBtn.disabled = false;
          el.updateActionBtn.textContent = t('updateBtnDownload');
          el.updateBanner.hidden = false;
        } else if (status === 'downloading') {
          state.updateState = 'downloading';
          const pct = Math.max(0, Math.min(100, Number(percent) || 0));
          el.updateBannerText.textContent = t('updateDownloading', { p: pct });
          el.updateProgressTrack.hidden = false;
          el.updateProgressFill.style.width = `${pct}%`;
          el.updateActionBtn.hidden = true;
          el.updateBanner.hidden = false;
        } else if (status === 'downloaded') {
          state.updateState = 'downloaded';
          el.updateBannerText.textContent = t('updateDownloaded', { v: version || '' });
          el.updateProgressTrack.hidden = true;
          el.updateActionBtn.hidden = false;
          el.updateActionBtn.disabled = false;
          el.updateActionBtn.textContent = t('updateBtnRestart');
          el.updateBanner.hidden = false;
        } else if (status === 'not-available') {
          showNotice(t('updateLatest'));
        } else if (status === 'error') {
          errorHandler.notify(ErrorCategory.UPDATE, message || t('updateError'));
        }
      }

      async function triggerUpdateCheck() {
        if (!desktopBridge || !desktopBridge.checkForUpdates) {
          showNotice(t('updateDevHint'));
          return;
        }
        showNotice(t('updateChecking'));
        const res = await desktopBridge.checkForUpdates();
        if (res?.status === 'dev-mode') {
          showNotice(t('updateDevHint'));
        } else if (res?.status === 'error') {
          errorHandler.notify(ErrorCategory.UPDATE, res.message || t('updateError'));
        }
      }

      /* =======================================================================
         14C. Per-Window / Per-Tab Audio Output Routing (Speakers / Hands-Free)
         ======================================================================= */
      const SESSION_SINK_KEY = `aaz_tab_audio_sink_${CURRENT_TAB_ID || 'main'}`;
      const LOCAL_SINK_KEY = 'aaz_audio_output_pref_v1';

      function openNewPlayerWindow() {
        if (desktopBridge && desktopBridge.openNewWindow) {
          desktopBridge.openNewWindow();
          return;
        }
        showNotice(t('newWindowBrowserHint'));
      }

      function canSwitchAudioOutput() {
        return Boolean(
          (typeof el.media.setSinkId === 'function') ||
          (window.AudioContext && typeof AudioContext.prototype.setSinkId === 'function')
        );
      }

      function stripDefaultPrefix(label) {
        return String(label || '').replace(/^(?:default|communications)\s*[-–—:]\s*/i, '').trim().toLowerCase();
      }

      // Resolve logical sink ID ('' = System Default) to the concrete Windows hardware deviceId!
      // Fixes WebView2/Chromium silent virtual '' default sink on Windows multi-output setups.
      function resolveEffectiveSinkId(preferredId = state.audioSinkId) {
        const logical = !preferredId || preferredId === 'default' ? '' : preferredId;
        if (logical) {
          const exact = state.audioDevices.find((d) => d.deviceId === logical);
          if (exact) return exact.deviceId;
          if (state.audioSinkLabel) {
            const byLabel = state.audioDevices.find((d) => d.label && d.label === state.audioSinkLabel);
            if (byLabel) return byLabel.deviceId;
          }
          return logical;
        }
        if (state.defaultAudioDevice && state.defaultAudioDevice.deviceId) {
          return state.defaultAudioDevice.deviceId;
        }
        return '';
      }

      let lastAudioSinkErrorToastTs = 0;

      async function handleAudioSinkFallback(context, err, options = {}) {
        const { silent = false, persistFallback = true } = options;
        errorHandler.log(context, err);

        if (AudioStudio.initialized && AudioStudio.ctx && typeof AudioStudio.ctx.setSinkId === 'function' && AudioStudio.ctx.sinkId) {
          try {
            await AudioStudio.ctx.setSinkId('');
          } catch (resetErr) {
            errorHandler.log('audio.ctx.resetDefaultSink', resetErr);
          }
        }
        if (typeof el.media.setSinkId === 'function' && el.media.sinkId) {
          try {
            await el.media.setSinkId('');
          } catch (resetErr) {
            errorHandler.log('audio.media.resetDefaultSink', resetErr);
          }
        }

        state.audioSinkId = '';
        state.audioSinkLabel = '';
        if (persistFallback) {
          const fallbackPayload = JSON.stringify({ id: '', label: '' });
          try {
            sessionStorage.setItem(SESSION_SINK_KEY, fallbackPayload);
          } catch (storeErr) {
            errorHandler.log('storage.audioSinkSessionFallback', storeErr);
          }
          try {
            localStorage.setItem(LOCAL_SINK_KEY, fallbackPayload);
          } catch (storeErr) {
            errorHandler.log('storage.audioSinkLocalFallback', storeErr);
          }
        }

        updateAudioOutputButtonUI();
        renderAudioOutputList();
        notifyShellTabState();

        if (!silent) {
          const now = Date.now();
          if (now - lastAudioSinkErrorToastTs >= 2500) {
            lastAudioSinkErrorToastTs = now;
            errorHandler.notify(ErrorCategory.AUDIO_OUTPUT, err);
          }
        }
      }

      async function ensureAudioOutputBound() {
        if (!canSwitchAudioOutput()) return;
        if (!state.audioDevicesLoaded) {
          await refreshAudioOutputDevices();
        }
        const effectiveId = resolveEffectiveSinkId(state.audioSinkId);
        if (effectiveId) {
          if (AudioStudio.initialized && AudioStudio.ctx && typeof AudioStudio.ctx.setSinkId === 'function') {
            if (AudioStudio.ctx.sinkId !== effectiveId) {
              try {
                await AudioStudio.ctx.setSinkId(effectiveId);
              } catch (err) {
                await handleAudioSinkFallback('audio.ensureBound.ctx', err);
              }
            }
          } else if (typeof el.media.setSinkId === 'function') {
            if (el.media.sinkId !== effectiveId) {
              try {
                await el.media.setSinkId(effectiveId);
              } catch (err) {
                await handleAudioSinkFallback('audio.ensureBound.media', err);
              }
            }
          }
        }
        if (AudioStudio.initialized && AudioStudio.ctx && AudioStudio.ctx.state === 'suspended') {
          try {
            await AudioStudio.ctx.resume();
          } catch (err) {
            errorHandler.log('audio.ensureBound.resume', err);
          }
        }
      }

      function updateAudioOutputButtonUI() {
        const isCustom = Boolean(state.audioSinkId && state.audioSinkId !== 'default');
        el.audioOutputBtn.classList.toggle('is-active', isCustom);
        const defaultName = state.defaultAudioDevice?.label
          ? `${t('outputDefault')} (${state.defaultAudioDevice.label})`
          : t('outputDefault');
        el.audioOutputBtn.title = isCustom && state.audioSinkLabel
          ? `${t('outputTitle')}: ${state.audioSinkLabel}`
          : `${t('outputTitle')}: ${defaultName}`;
      }

      async function applyAudioOutputDevice(deviceId, label = '', silent = false, persistGlobal = true) {
        const logicalId = !deviceId || deviceId === 'default' ? '' : deviceId;
        if (!canSwitchAudioOutput()) {
          if (!silent) showNotice(t('outputUnsupported'), true);
          return false;
        }

        if (!state.audioDevicesLoaded) {
          await refreshAudioOutputDevices();
        }

        const effectiveId = resolveEffectiveSinkId(logicalId);
        const applyTarget = effectiveId || logicalId;

        const ctxAttempted = Boolean(AudioStudio.initialized && AudioStudio.ctx && typeof AudioStudio.ctx.setSinkId === 'function');
        const mediaAttempted = typeof el.media.setSinkId === 'function';
        let ctxApplied = false;
        let mediaApplied = false;
        let lastErr = null;

        // 1. Primary path when Web Audio EQ/Visualizer is active: route AudioContext sink
        if (ctxAttempted) {
          try {
            await AudioStudio.ctx.setSinkId(applyTarget);
            ctxApplied = true;
          } catch (err) {
            errorHandler.log('audio.ctx.setSinkId', err);
            if (applyTarget !== logicalId) {
              try {
                await AudioStudio.ctx.setSinkId(logicalId);
                ctxApplied = true;
              } catch (err2) {
                errorHandler.log('audio.ctx.setSinkIdLogical', err2);
                lastErr = err2;
              }
            } else {
              lastErr = err;
            }
          }
        }

        // 2. Media element sink: primary before AudioContext init; best-effort fallback afterwards
        if (mediaAttempted) {
          try {
            await el.media.setSinkId(applyTarget);
            mediaApplied = true;
          } catch (err) {
            errorHandler.log('audio.media.setSinkId', err);
            if (applyTarget !== logicalId) {
              try {
                await el.media.setSinkId(logicalId);
                mediaApplied = true;
              } catch (err2) {
                errorHandler.log('audio.media.setSinkIdLogical', err2);
                if (!ctxApplied && !AudioStudio.initialized) lastErr = err2;
              }
            } else if (!ctxApplied && !AudioStudio.initialized) {
              lastErr = err;
            }
          }
        }

        const primaryFailed = (ctxAttempted && !ctxApplied) || (!ctxAttempted && mediaAttempted && !mediaApplied);
        const applied = !primaryFailed && (ctxApplied || mediaApplied || (!AudioStudio.initialized && window.AudioContext && typeof AudioContext.prototype.setSinkId === 'function'));
        if (!applied) {
          await handleAudioSinkFallback('audio.applyOutputDevice', lastErr || new Error('setSinkId failed'), {
            silent,
            persistFallback: persistGlobal,
          });
          return false;
        }

        state.audioSinkId = logicalId;
        state.audioSinkLabel = logicalId ? (label || logicalId) : '';
        const savedPayload = JSON.stringify({
          id: state.audioSinkId,
          label: state.audioSinkLabel
        });
        try {
          sessionStorage.setItem(SESSION_SINK_KEY, savedPayload);
        } catch (err) {
          errorHandler.log('storage.audioSinkSession', err);
        }
        if (persistGlobal) {
          try {
            localStorage.setItem(LOCAL_SINK_KEY, savedPayload);
          } catch (err) {
            errorHandler.log('storage.audioSinkLocal', err);
          }
        }

        updateAudioOutputButtonUI();
        renderAudioOutputList();
        notifyShellTabState();
        if (!silent) {
          const shownName = state.audioSinkLabel || state.defaultAudioDevice?.label || t('outputDefault');
          showNotice(t('outputSwitched', { name: shownName }));
        }
        return true;
      }

      async function refreshAudioOutputDevices() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
          state.audioDevices = [];
          state.defaultAudioDevice = null;
          state.audioDevicesLoaded = true;
          renderAudioOutputList();
          return;
        }
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          const outputs = all.filter((d) => d.kind === 'audiooutput');
          const defaultEntry = outputs.find((d) => d.deviceId === 'default') || null;
          const seen = new Set();
          const concrete = outputs.filter((d) => {
            if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') {
              return false;
            }
            if (seen.has(d.deviceId)) return false;
            seen.add(d.deviceId);
            return true;
          });

          // Resolve the REAL concrete hardware device backing Windows 'default'
          let matchedDefault = null;
          if (defaultEntry) {
            if (defaultEntry.groupId) {
              matchedDefault = concrete.find((d) => d.groupId && d.groupId === defaultEntry.groupId) || null;
            }
            if (!matchedDefault && defaultEntry.label) {
              const targetLbl = stripDefaultPrefix(defaultEntry.label);
              if (targetLbl) {
                matchedDefault = concrete.find((d) => d.label && d.label.trim().toLowerCase() === targetLbl) ||
                  concrete.find((d) => d.label && d.label.trim().toLowerCase().includes(targetLbl)) ||
                  null;
              }
            }
          }
          if (!matchedDefault && concrete.length > 0) {
            matchedDefault = concrete[0];
          }
          state.defaultAudioDevice = matchedDefault;

          const comms = outputs.find((d) => d.deviceId === 'communications' && d.label);
          state.audioDevices = comms ? [...concrete, comms] : concrete;
        } catch (err) {
          errorHandler.log('audio.enumerateDevices', err);
          state.audioDevices = [];
          state.defaultAudioDevice = null;
        }
        state.audioDevicesLoaded = true;
        updateAudioOutputButtonUI();
        renderAudioOutputList();
      }

      function renderAudioOutputList() {
        el.audioOutputList.innerHTML = '';

        const makeRow = (id, label) => {
          const isCurrent = (id === '' && !state.audioSinkId) || (id !== '' && state.audioSinkId === id);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `output-device-item${isCurrent ? ' is-active' : ''}`;
          btn.setAttribute('role', 'option');
          btn.setAttribute('aria-selected', String(isCurrent));

          const nameSpan = document.createElement('span');
          nameSpan.className = 'output-device-name';
          nameSpan.textContent = label;
          nameSpan.title = label;

          const checkSpan = document.createElement('span');
          checkSpan.className = 'output-check';
          checkSpan.textContent = isCurrent ? '✓' : '';

          btn.append(nameSpan, checkSpan);
          btn.addEventListener('click', async () => {
            await applyAudioOutputDevice(id, id ? label : '', false, true);
            toggleAudioOutputPopover(false);
          });
          return btn;
        };

        const defaultRowLabel = state.defaultAudioDevice?.label
          ? `${t('outputDefault')} — ${state.defaultAudioDevice.label}`
          : t('outputDefault');
        el.audioOutputList.appendChild(makeRow('', defaultRowLabel));

        let hasMaskedLabels = false;
        state.audioDevices.forEach((dev, idx) => {
          if (!dev.label) hasMaskedLabels = true;
          const cleanLabel = dev.label || `${t('outputTitle')} ${idx + 1}`;
          el.audioOutputList.appendChild(makeRow(dev.deviceId, cleanLabel));
        });

        // Show unlock/native picker button if browser hides labels or supports selectAudioOutput()
        const supportsSelect = Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function');
        el.audioOutputFooter.hidden = !(supportsSelect || hasMaskedLabels || state.audioDevices.length === 0);
      }

      async function toggleAudioOutputPopover(forceState) {
        const willOpen = typeof forceState === 'boolean' ? forceState : el.audioOutputPopover.hidden;
        if (willOpen) {
          closeAllMenus();
          await refreshAudioOutputDevices();
          el.audioOutputPopover.hidden = false;
          el.audioOutputBtn.setAttribute('aria-expanded', 'true');
        } else {
          el.audioOutputPopover.hidden = true;
          el.audioOutputBtn.setAttribute('aria-expanded', 'false');
        }
      }

      async function unlockOrSelectAudioOutput() {
        if (navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function') {
          try {
            const dev = await navigator.mediaDevices.selectAudioOutput();
            if (dev && dev.deviceId) {
              await refreshAudioOutputDevices();
              await applyAudioOutputDevice(dev.deviceId, dev.label || t('outputTitle'), false);
              toggleAudioOutputPopover(false);
              return;
            }
          } catch (err) {
            if (err && err.name === 'NotAllowedError') return;
            errorHandler.log('audio.selectAudioOutput', err);
          }
        }
        // Fallback: brief mic permission probe unlocks full Windows audiooutput device labels in Chromium
        if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((tr) => tr.stop());
            await refreshAudioOutputDevices();
          } catch (err) {
            errorHandler.log('audio.unlockDevices', err);
            showNotice(t('outputNoExtra'));
          }
        }
      }

      /* =======================================================================
         15. Media & UI Event Listeners
         ======================================================================= */
      el.media.addEventListener('loadedmetadata', () => {
        const track = getCurrentTrack();
        const dur = el.media.duration;
        if (Number.isFinite(dur) && dur > 0) {
          if (track) {
            track.duration = dur;
            updateTrackRowDuration(track.key, dur);
            updatePlaylistHeader();
          }
          if (state.pendingSeekTime !== null) {
            el.media.currentTime = Math.max(0, Math.min(state.pendingSeekTime, Math.max(0, dur - 0.25)));
            state.pendingSeekTime = null;
          }
        }
        el.media.playbackRate = state.playbackRate || 1;
        updateSeekUI();
        updateTransportAvailability();
        updateABLoopUI();
        renderBookmarks();
        applyVideoTransform();
      });

      el.media.addEventListener('timeupdate', () => {
        if (state.abPointA !== null && state.abPointB !== null && el.media.currentTime >= state.abPointB) {
          el.media.currentTime = state.abPointA;
        }
        updateSeekUI();
        if (state.activeSubtitleUrl && state.subtitlesEnabled) renderActiveSubtitleCues();
        if (el.media.currentTime > 3 && el.prevBtn.disabled) updateTransportAvailability();

        // Save per-track resume progress & auto-mark watched at >= 92%
        const nowTs = Date.now();
        if (state.currentKey && Number.isFinite(el.media.duration) && el.media.duration > 8 && nowTs - state.lastProgressSaveTs >= 3000) {
          state.lastProgressSaveTs = nowTs;
          const cur = el.media.currentTime;
          const dur = el.media.duration;
          const pct = Math.round((cur / dur) * 100);
          if (pct >= 92) {
            if (!state.watchedKeys.has(state.currentKey)) {
              state.watchedKeys.add(state.currentKey);
              delete state.progressByKey[state.currentKey];
              updatePlaylistHeader();
              renderPlaylist();
            }
          } else if (cur > 2) {
            state.progressByKey[state.currentKey] = { time: Math.floor(cur * 10) / 10, duration: Math.floor(dur) };
            updateTrackRowProgress(state.currentKey, pct);
          }
        }
      });

      el.media.addEventListener('play', () => {
        if (AudioStudio.needsAudioGraph()) AudioStudio.ensureInit(false);
        else if (AudioStudio.initialized && AudioStudio.ctx && AudioStudio.ctx.state === 'suspended') {
          AudioStudio.ctx.resume().catch((err) => errorHandler.log('audio.ctx.resumeOnPlay', err));
        }
        updatePlayButtonUI();
        startAutosaveTimer();
        if (!el.audioStage.hidden) AudioStudio.startVisualizer();
      });

      el.media.addEventListener('playing', () => {
        if (AudioStudio.initialized && AudioStudio.ctx && AudioStudio.ctx.state === 'suspended') {
          AudioStudio.ctx.resume().catch((err) => errorHandler.log('audio.ctx.resumeOnPlaying', err));
        }
      });

      el.media.addEventListener('pause', () => {
        updatePlayButtonUI();
        stopAutosaveTimer();
        AudioStudio.stopVisualizer();
        if (state.currentKey) persistPlaybackState();
      });

      el.media.addEventListener('seeked', () => {
        if (state.activeSubtitleUrl && state.subtitlesEnabled) renderActiveSubtitleCues();
        if (state.currentKey) persistPlaybackState();
      });

      el.media.addEventListener('ended', () => {
        stopAutosaveTimer();
        updatePlayButtonUI();
        AudioStudio.stopVisualizer();
        const finishedKey = state.currentKey;
        const finishedTrack = getCurrentTrack();
        if (finishedKey) {
          state.watchedKeys.add(finishedKey);
          delete state.progressByKey[finishedKey];
          updatePlaylistHeader();
          renderPlaylist();
        }
        if (state.stopAfterKey && state.stopAfterKey === finishedKey) {
          state.stopAfterKey = '';
          renderPlaylist();
          persistPlaybackState(0);
          showNotice(t('plStoppedAfterNotice', { name: finishedTrack ? finishedTrack.displayName : '' }));
          return;
        }
        if (state.sleepEndAt === 'track') {
          clearSleepTimer();
          persistPlaybackState(0);
          showNotice('Sleep timer finished at end of track.');
          return;
        }
        const advanced = playNextTrack(true, true);
        if (!advanced) persistPlaybackState(0);
      });

      el.media.addEventListener('error', () => {
        stopAutosaveTimer();
        updatePlayButtonUI();
        AudioStudio.stopVisualizer();
        const track = getCurrentTrack();
        errorHandler.notifyMediaError(el.media.error, track ? track.name : '');
      });

      // Single-click = Play/Pause (debounced so Double-Click cleanly toggles Fullscreen without pause/play flicker!)
      let videoClickTimer = null;
      const isVideoSurfaceClick = (e) => !e.target.closest('.video-toolbar, .fs-bottom-hud, button, input');

      el.videoFrame.addEventListener('click', (e) => {
        if (!isVideoSurfaceClick(e)) return;
        if (videoClickTimer !== null) clearTimeout(videoClickTimer);
        videoClickTimer = window.setTimeout(() => {
          videoClickTimer = null;
          togglePlayPause();
        }, 210);
      });

      el.videoFrame.addEventListener('dblclick', (e) => {
        if (!isVideoSurfaceClick(e)) return;
        e.preventDefault();
        if (videoClickTimer !== null) {
          clearTimeout(videoClickTimer);
          videoClickTimer = null;
        }
        toggleFullscreen();
      });

      // Source buttons (Clean & Deduplicated)
      el.openFolderBtn.addEventListener('click', () => openFolderWithPersistence(false));
      el.emptyOpenFolderBtn.addEventListener('click', () => openFolderWithPersistence(false));
      el.openFilesBtn.addEventListener('click', openFilesPicker);
      el.emptyOpenFilesBtn.addEventListener('click', openFilesPicker);
      el.savedImportBtn.addEventListener('click', () => {
        el.playlistImportInput.value = '';
        el.playlistImportInput.click();
      });

      // Theme, Visual Skin Studio, Language, Visualizer Mode & Auto-Update Controls
      el.themeToggleBtn.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark', true));
      if (el.closeThemeGalleryBtn) {
        el.closeThemeGalleryBtn.addEventListener('click', () => closeThemeGalleryModal());
      }
      if (el.themeGalleryModal) {
        el.themeGalleryModal.addEventListener('click', (e) => {
          if (e.target === el.themeGalleryModal) closeThemeGalleryModal();
        });
      }
      if (el.themeGalleryDarkBtn) {
        el.themeGalleryDarkBtn.addEventListener('click', () => applyTheme('dark', true, true));
      }
      if (el.themeGalleryLightBtn) {
        el.themeGalleryLightBtn.addEventListener('click', () => applyTheme('light', true, true));
      }
      el.langToggleBtn.addEventListener('click', () => applyLanguage(state.lang === 'ar' ? 'en' : 'ar', true));
      el.vizModeBtns.forEach((btn) => btn.addEventListener('click', () => setVizMode(btn.dataset.viz, true)));

      el.updateActionBtn.addEventListener('click', async () => {
        if (!desktopBridge) return;
        if (state.updateState === 'available' && desktopBridge.downloadUpdate) {
          el.updateActionBtn.disabled = true;
          try {
            await desktopBridge.downloadUpdate();
          } catch (err) {
            el.updateActionBtn.disabled = false;
            errorHandler.notify(ErrorCategory.UPDATE, err);
          }
        } else if (state.updateState === 'downloaded' && desktopBridge.installUpdate) {
          el.updateActionBtn.disabled = true;
          try {
            const launched = await desktopBridge.installUpdate();
            if (!launched) {
              el.updateActionBtn.disabled = false;
              showNotice(
                state.lang === 'ar'
                  ? 'تعذر تشغيل المثبت المحمّل. جرّب إعادة التحميل.'
                  : 'Could not launch the downloaded installer. Please try downloading again.',
                true
              );
            }
          } catch (err) {
            el.updateActionBtn.disabled = false;
            errorHandler.notify(ErrorCategory.UPDATE, err);
          }
        }
      });
      el.dismissUpdateBtn.addEventListener('click', () => {
        el.updateBanner.hidden = true;
      });

      // Audio Output Channel Picker Events
      el.audioOutputBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAudioOutputPopover();
      });
      el.audioOutputPopover.addEventListener('click', (e) => e.stopPropagation());
      el.refreshOutputsBtn.addEventListener('click', () => refreshAudioOutputDevices());
      el.chooseOutputNativeBtn.addEventListener('click', () => unlockOrSelectAudioOutput());
      document.addEventListener('click', () => {
        if (!el.audioOutputPopover.hidden) toggleAudioOutputPopover(false);
      });
      if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', async () => {
          await refreshAudioOutputDevices();
          if (!state.audioSinkId) {
            await ensureAudioOutputBound();
          }
        });
      }

      el.dirInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        const shouldPlay = state.resumeAutoPlayPending;
        const isAppend = state.appendModePending === 'folder';
        state.resumeAutoPlayPending = false;
        state.appendModePending = null;
        if (!files || files.length === 0) return;
        const { tracks, subMap, folderName } = buildTracksFromFileList(files);
        if (tracks.length === 0) {
          showNotice('No supported audio or video files were found in that folder.', true);
          return;
        }
        if (isAppend) {
          appendTracksToQueue(tracks, subMap);
          return;
        }
        state.currentDirHandle = null;
        await applyLoadedTracks(tracks, subMap, folderName, 'input', { restoreSavedPosition: true, autoPlay: shouldPlay });
      });

      el.filesInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        const isAppend = state.appendModePending === 'files';
        state.appendModePending = null;
        if (files.length === 0) return;
        if (!isAppend && files.length === 1 && PLAYLIST_EXTENSIONS.has(getExtension(files[0].name))) {
          try {
            await handleImportedPlaylistContent(files[0].name, await files[0].text());
          } catch (err) {
            errorHandler.notify(ErrorCategory.PLAYLIST, err);
          }
          return;
        }
        const { tracks, subMap, folderName } = buildTracksFromFileList(files);
        if (tracks.length === 0) {
          showNotice('Please select supported audio or video files.', true);
          return;
        }
        if (isAppend) {
          appendTracksToQueue(tracks, subMap);
          return;
        }
        state.currentDirHandle = null;
        state.activeSavedPlaylistId = null;
        await applyLoadedTracks(tracks, subMap, folderName, 'input', { restoreSavedPosition: true, autoPlay: false });
      });

      el.playlistImportInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          await handleImportedPlaylistContent(file.name, text);
        } catch (err) {
          errorHandler.notify(ErrorCategory.PLAYLIST, err);
        }
      });

      el.subtitleBtn.addEventListener('click', (e) => {
        if (!e.shiftKey && state.activeSubtitleUrl) {
          state.subtitlesEnabled = !state.subtitlesEnabled;
          el.subtitleBtn.classList.toggle('is-active', state.subtitlesEnabled);
          renderActiveSubtitleCues();
          return;
        }
        el.subtitleInput.value = '';
        el.subtitleInput.click();
      });

      el.closeSubtitleModalBtn.addEventListener('click', () => { el.subtitleModal.hidden = true; });
      el.subDoneBtn.addEventListener('click', () => { el.subtitleModal.hidden = true; });
      el.subtitleModal.addEventListener('click', (e) => {
        if (e.target === el.subtitleModal) el.subtitleModal.hidden = true;
      });
      el.subLoadSysFontsBtn.addEventListener('click', () => loadSystemFonts(true));
      el.subFontSearchInput.addEventListener('input', renderFontPickerList);
      el.subFontSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && el.subFontSearchInput.value.trim()) {
          updateSubtitleStyle({ fontFamily: el.subFontSearchInput.value.trim() }, true, true);
          renderFontPickerList();
        }
      });
      el.subFontSizeRange.addEventListener('input', () => updateSubtitleStyle({ fontSize: Number(el.subFontSizeRange.value) }));
      el.subFontWeightSelect.addEventListener('change', () => updateSubtitleStyle({ fontWeight: el.subFontWeightSelect.value }));
      el.subItalicBtn.addEventListener('click', () => updateSubtitleStyle({ italic: !state.subtitleStyle.italic }));
      el.subTextColorInput.addEventListener('input', () => updateSubtitleStyle({ textColor: el.subTextColorInput.value }));
      el.subSwatches.forEach((btn) => {
        btn.addEventListener('click', () => updateSubtitleStyle({ textColor: btn.dataset.subSwatch }));
      });
      el.subOutlineColorInput.addEventListener('input', () => updateSubtitleStyle({ outlineColor: el.subOutlineColorInput.value }));
      el.subOutlineWidthRange.addEventListener('input', () => updateSubtitleStyle({ outlineWidth: Number(el.subOutlineWidthRange.value) }));
      el.subBgColorInput.addEventListener('input', () => updateSubtitleStyle({ bgColor: el.subBgColorInput.value }));
      el.subBgOpacityRange.addEventListener('input', () => updateSubtitleStyle({ bgOpacity: Number(el.subBgOpacityRange.value) }));
      el.subBorderColorInput.addEventListener('input', () => updateSubtitleStyle({ borderColor: el.subBorderColorInput.value }));
      el.subBorderWidthRange.addEventListener('input', () => updateSubtitleStyle({ borderWidth: Number(el.subBorderWidthRange.value) }));
      el.subRadiusRange.addEventListener('input', () => updateSubtitleStyle({ borderRadius: Number(el.subRadiusRange.value) }));
      el.subShadowRange.addEventListener('input', () => updateSubtitleStyle({ shadowBlur: Number(el.subShadowRange.value) }));
      el.subPositionRange.addEventListener('input', () => updateSubtitleStyle({ bottomOffset: Number(el.subPositionRange.value) }));
      el.subOffsetBtns.forEach((btn) => {
        btn.addEventListener('click', () => adjustSubtitleOffset(Number(btn.dataset.subOffset), false));
      });
      el.subOffsetResetBtn.addEventListener('click', () => resetSubtitleOffset(false));
      el.subResetBtn.addEventListener('click', () => {
        updateSubtitleStyle({ ...SUBTITLE_STYLE_DEFAULTS }, true, true);
        renderFontPickerList();
      });

      el.subtitleInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const opGen = ++subtitleOpGen;
        const expectedTrackKey = state.currentKey;
        try {
          const text = await readSubtitleFileSmart(file);
          if (opGen !== subtitleOpGen || state.currentKey !== expectedTrackKey) return;
          attachSubtitleVttText(text, file.name);
        } catch (err) {
          errorHandler.notify(ErrorCategory.SUBTITLE, err);
        }
      });

      // Resume & Notice
      el.resumeSessionBtn.addEventListener('click', handleResumeLastSession);
      el.dismissResumeBtn.addEventListener('click', async () => {
        await HandleStore.deleteHandle(IDB_LAST_DIR_KEY);
        StateStore.clearSessionOnly();
        state.savedDirHandle = null;
        if (state.savedSession) {
          state.savedSession.trackName = '';
          state.savedSession.nativeFolderPath = '';
        }
        el.resumeBanner.hidden = true;
      });
      el.closeNoticeBtn.addEventListener('click', hideNotice);
      if (el.noticeUndoBtn) {
        el.noticeUndoBtn.addEventListener('click', () => {
          const fn = state.noticeUndoHandler;
          hideNotice();
          if (typeof fn === 'function') fn();
        });
      }

      // Sidebar, Playlist Power Tools, Track Context Menu & Save Playlist Bar
      el.toggleSidebarBtn.addEventListener('click', toggleSidebar);
      el.tabQueueBtn.addEventListener('click', () => switchSidebarTab('queue'));
      el.tabSavedBtn.addEventListener('click', () => switchSidebarTab('saved'));
      if (el.tabLibraryBtn) el.tabLibraryBtn.addEventListener('click', () => switchSidebarTab('library'));
      el.openSavePlBarBtn.addEventListener('click', openSavePlaylistPrompt);
      el.confirmSavePlBtn.addEventListener('click', () => saveCurrentQueueToLibrary(el.savePlNameInput.value));
      el.cancelSavePlBtn.addEventListener('click', () => { el.savePlBar.hidden = true; });
      el.savePlNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveCurrentQueueToLibrary(el.savePlNameInput.value);
        if (e.key === 'Escape') el.savePlBar.hidden = true;
      });

      if (el.playlistToolsBtn && el.playlistToolsMenu) {
        el.playlistToolsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasOpen = !el.playlistToolsMenu.hidden;
          closeAllMenus();
          if (!wasOpen) el.playlistToolsMenu.hidden = false;
        });
        el.playlistToolsMenu.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-pltool]');
          if (!btn) return;
          e.stopPropagation();
          const tool = btn.dataset.pltool;
          closePlaylistMenus();
          if (tool === 'append-files') appendFilesToQueue();
          else if (tool === 'append-folder') appendFolderToQueue();
          else if (tool === 'shuffle-order') shuffleQueueOrder();
          else if (tool === 'remove-dupes') removeDuplicateTracks();
          else if (tool === 'remove-watched') removeWatchedTracks();
          else if (tool === 'clear-upnext') {
            state.upNextKeys = [];
            renderPlaylist();
          }
        });
      }

      if (el.playlistContextMenu) {
        el.playlistContextMenu.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-plcmd]');
          if (!btn) return;
          e.stopPropagation();
          executePlaylistContextCommand(btn.dataset.plcmd);
        });
      }

      if (el.savedPlContextMenu) {
        el.savedPlContextMenu.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-splcmd]');
          if (!btn) return;
          e.stopPropagation();
          executeSavedPlContextCommand(btn.dataset.splcmd);
        });
      }

      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
          const fresh = StateStore.load();
          if (fresh) {
            if (Array.isArray(fresh.savedPlaylists)) state.savedPlaylists = fresh.savedPlaylists;
            if (fresh.progressByKey && typeof fresh.progressByKey === 'object') {
              state.progressByKey = fresh.progressByKey;
            }
            if (fresh.bookmarksByKey && typeof fresh.bookmarksByKey === 'object') {
              state.bookmarksByKey = fresh.bookmarksByKey;
            }
            if (Array.isArray(fresh.starredKeys)) state.starredKeys = new Set(fresh.starredKeys);
            if (Array.isArray(fresh.watchedKeys)) state.watchedKeys = new Set(fresh.watchedKeys);
          }
          syncSavedPlaylistsFromStorage();
          renderBookmarks();
          if (phase3 && typeof phase3.invalidateStoreCache === 'function') {
            phase3.invalidateStoreCache();
            phase3.renderHistory();
            phase3.renderLibrary();
            phase3.renderShortcutsEditor?.();
            phase3.syncSettingsModalUI?.();
          }
        } else if (e.key === 'aaz_theme' && (e.newValue === 'dark' || e.newValue === 'light')) {
          applyTheme(e.newValue, false, false);
        } else if (e.key === SKIN_STORAGE_KEY && e.newValue) {
          applySkin(sanitizeSkin(e.newValue), false, false);
        } else if (e.key === 'aaz_lang' && (e.newValue === 'en' || e.newValue === 'ar')) {
          applyLanguage(e.newValue, false, false);
        }
      });

      // Pin on Top (Electron .exe)
      el.pinWindowBtn.addEventListener('click', async () => {
        if (!desktopBridge) return;
        const pinned = await desktopBridge.setAlwaysOnTop(!state.isPinnedOnTop);
        state.isPinnedOnTop = Boolean(pinned);
        el.pinWindowBtn.classList.toggle('is-active', state.isPinnedOnTop);
        el.pinWindowBtn.setAttribute('aria-pressed', String(state.isPinnedOnTop));
      });

      // Video Controls & Fullscreen HUD
      el.prevFrameBtn.addEventListener('click', () => stepVideoFrame(-1));
      el.nextFrameBtn.addEventListener('click', () => stepVideoFrame(1));
      el.snapshotBtn.addEventListener('click', captureVideoSnapshot);
      el.fsPrevFrameBtn.addEventListener('click', () => stepVideoFrame(-1));
      el.fsNextFrameBtn.addEventListener('click', () => stepVideoFrame(1));
      el.fsSnapshotBtn.addEventListener('click', captureVideoSnapshot);
      el.audioOnlyViewBtn.addEventListener('click', () => setVideoDisplayMode('audio', true));
      el.showVideoBtn.addEventListener('click', () => setVideoDisplayMode('video', true));
      if (el.videoCastBtn) el.videoCastBtn.addEventListener('click', openCastModal);
      el.pipBtn.addEventListener('click', togglePictureInPicture);

      // Resizable Split-Pane Playlist Sidebar (LTR & RTL aware + persisted width)
      const SIDEBAR_WIDTH_KEY = 'aaz_sidebar_width';
      function applySidebarWidth(widthPx, persist = false) {
        if (!el.workspace) return;
        const maxW = Math.max(280, Math.min(720, Math.floor(window.innerWidth * 0.65)));
        const clamped = Math.max(240, Math.min(maxW, Math.round(widthPx)));
        el.workspace.style.setProperty('--sidebar-w', `${clamped}px`);
        if (persist) {
          try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
          } catch (err) {
            errorHandler.log('storage.sidebarWidth', err);
          }
        }
        if (el.audioStage && !el.audioStage.hidden) {
          requestAnimationFrame(() => AudioStudio.renderIdleFrame());
        }
      }

      if (el.sidebarResizer && el.workspace) {
        el.sidebarResizer.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const startX = e.clientX;
          const startW = el.sidebarPane ? el.sidebarPane.getBoundingClientRect().width : 360;
          const isRtl = document.documentElement.dir === 'rtl';
          el.sidebarResizer.classList.add('is-resizing');
          document.body.classList.add('is-resizing-sidebar');

          const onMove = (ev) => {
            // LTR: sidebar is on the right -> moving left increases sidebar width
            // RTL: sidebar is on the left  -> moving right increases sidebar width
            const delta = isRtl ? (ev.clientX - startX) : (startX - ev.clientX);
            applySidebarWidth(startW + delta, false);
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
            el.sidebarResizer.classList.remove('is-resizing');
            document.body.classList.remove('is-resizing-sidebar');
            const finalW = el.sidebarPane ? el.sidebarPane.getBoundingClientRect().width : 360;
            applySidebarWidth(finalW, true);
          };

          window.addEventListener('pointermove', onMove, true);
          window.addEventListener('pointerup', onUp, true);
          window.addEventListener('pointercancel', onUp, true);
        });

        el.sidebarResizer.addEventListener('dblclick', () => {
          applySidebarWidth(360, true);
        });
      }
      el.dockFullscreenBtn.addEventListener('click', toggleFullscreen);
      el.audioExitFsBtn.addEventListener('click', toggleFullscreen);
      el.fsExitBtn.addEventListener('click', toggleFullscreen);
      el.fsPlayBtn.addEventListener('click', togglePlayPause);

      // Cast Modal Controls
      if (el.closeCastModalBtn) el.closeCastModalBtn.addEventListener('click', closeCastModal);
      if (el.castModal) {
        el.castModal.addEventListener('click', (e) => {
          if (e.target === el.castModal) closeCastModal();
        });
      }
      if (el.castScanBtn) el.castScanBtn.addEventListener('click', scanCastDevices);
      if (el.castLanToggleBtn) el.castLanToggleBtn.addEventListener('click', toggleCastLanServer);
      if (el.castCopyUrlBtn) {
        el.castCopyUrlBtn.addEventListener('click', () => {
          if (!state.castServerInfo) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(state.castServerInfo.receiverUrl).then(() => {
              showNotice(t('castUrlCopied'));
            }).catch((err) => errorHandler.log('clipboard.copyCastUrl', err));
          }
        });
      }
      if (el.castWindowsBtn) el.castWindowsBtn.addEventListener('click', triggerWindowsMiracast);
      if (el.castBrowserBtn) el.castBrowserBtn.addEventListener('click', triggerBrowserRemoteCast);
      if (el.castRemotePlayBtn) el.castRemotePlayBtn.addEventListener('click', () => sendDlnaControl('play'));
      if (el.castRemotePauseBtn) el.castRemotePauseBtn.addEventListener('click', () => sendDlnaControl('pause'));
      if (el.castRemoteStopBtn) el.castRemoteStopBtn.addEventListener('click', () => sendDlnaControl('stop'));

      // EQ Drawer
      el.eqToggleBtn.addEventListener('click', () => {
        el.eqDrawer.hidden = !el.eqDrawer.hidden;
        el.eqToggleBtn.setAttribute('aria-expanded', String(!el.eqDrawer.hidden));
        updateEQUI();
      });
      el.eqPresetBtns.forEach((btn) => btn.addEventListener('click', () => applyEQPreset(btn.dataset.preset, true)));
      el.eqResetBtn.addEventListener('click', () => { state.preampGain = 1; applyEQPreset('flat', true); });
      el.eqBandSliders.forEach((slider, idx) => {
        slider.addEventListener('input', () => {
          state.eqPreset = 'custom';
          state.eqGains[idx] = Number(slider.value);
          updateEQUI();
          AudioStudio.applyEQ();
        });
        slider.addEventListener('change', () => persistPlaybackState());
      });
      el.preampSlider.addEventListener('input', () => {
        state.preampGain = Number(el.preampSlider.value);
        updateEQUI();
        AudioStudio.applyEQ();
      });
      el.preampSlider.addEventListener('change', () => persistPlaybackState());

      // Dock Controls
      el.playPauseBtn.addEventListener('click', togglePlayPause);
      el.prevBtn.addEventListener('click', playPreviousTrack);
      el.nextBtn.addEventListener('click', () => playNextTrack(true, false));
      el.skipBackBtn.addEventListener('click', () => skipBySeconds(-SKIP_SECONDS));
      el.skipForwardBtn.addEventListener('click', () => skipBySeconds(SKIP_SECONDS));
      el.shuffleBtn.addEventListener('click', () => {
        state.shuffle = !state.shuffle;
        updateShuffleRepeatUI();
        updateTransportAvailability();
        persistPlaybackState();
      });
      el.repeatBtn.addEventListener('click', () => {
        const order = ['off', 'all', 'one'];
        state.repeatMode = order[(order.indexOf(state.repeatMode) + 1) % order.length];
        updateShuffleRepeatUI();
        updateTransportAvailability();
        persistPlaybackState();
      });
      el.abLoopBtn.addEventListener('click', cycleABLoop);
      el.starCurrentBtn.addEventListener('click', () => toggleStarKey(state.currentKey));
      el.speedCycleBtn.addEventListener('click', cycleSpeed);
      el.addBookmarkBtn.addEventListener('click', addBookmarkAtCurrentTime);
      el.durationLabel.addEventListener('click', () => {
        state.showRemainingTime = !state.showRemainingTime;
        updateSeekUI();
      });

      // Seek bars (Main + Fullscreen HUD)
      const bindScrubber = (bar) => {
        bar.addEventListener('pointerdown', () => { state.isSeeking = true; });
        bar.addEventListener('input', () => {
          state.isSeeking = true;
          const ratio = Number(bar.value) / 1000;
          setRangeFill(bar, ratio);
          if (Number.isFinite(el.media.duration) && el.media.duration > 0) {
            el.currentTimeLabel.textContent = formatTime(ratio * el.media.duration);
          }
        });
        const commit = () => {
          if (!state.isSeeking) return;
          state.isSeeking = false;
          const ratio = Number(bar.value) / 1000;
          if (Number.isFinite(el.media.duration) && el.media.duration > 0) {
            seekToSeconds(ratio * el.media.duration);
          }
        };
        bar.addEventListener('change', commit);
        bar.addEventListener('pointerup', commit);
      };
      bindScrubber(el.seekBar);
      bindScrubber(el.fsSeekBar);

      el.volumeSlider.addEventListener('input', (e) => setVolume(e.target.value, false));
      el.volumeSlider.addEventListener('change', (e) => setVolume(e.target.value, true));
      el.muteBtn.addEventListener('click', toggleMute);

      // Playlist modes, search & sort
      el.modeTabs.forEach((tab) => tab.addEventListener('click', () => setPlaylistMode(tab.dataset.mode, true)));
      let playlistSearchTimer = null;
      el.searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        clearTimeout(playlistSearchTimer);
        playlistSearchTimer = setTimeout(() => {
          state.searchQuery = val;
          updatePlaylistHeader();
          renderPlaylist();
        }, 120);
      });
      el.sortBtn.addEventListener('click', () => {
        const order = ['custom', 'asc', 'desc', 'type', 'duration'];
        state.sortMode = order[(order.indexOf(state.sortMode) + 1) % order.length];
        updateSortButtonUI();
        renderPlaylist();
        updateTransportAvailability();
        persistPlaybackState();
      });
      el.clearQueueBtn.addEventListener('click', clearQueue);

      // Shortcuts modal
      el.closeShortcutsBtn.addEventListener('click', () => { el.shortcutsModal.hidden = true; });
      el.shortcutsModal.addEventListener('click', (e) => {
        if (e.target === el.shortcutsModal) el.shortcutsModal.hidden = true;
      });

      /* =======================================================================
         16. Global Keyboard Shortcuts
         ======================================================================= */
      window.addEventListener('keydown', (e) => {
        if (isFullscreenActive()) wakeFullscreenHud();

        if (phase3 && phase3.isCapturingShortcut()) {
          phase3.matchAndDispatchShortcut(e);
          return;
        }

        if (e.key === 'Escape') {
          if (state.electronFsFallback) {
            toggleFullscreen();
            return;
          }
          closeAllMenus();
          toggleAudioOutputPopover(false);
          closeCastModal();
          if (phase3) {
            phase3.cancelShortcutCapture();
            phase3.closeSettingsModal();
          }
          el.shortcutsModal.hidden = true;
          el.subtitleModal.hidden = true;
          closeThemeGalleryModal();
          el.savePlBar.hidden = true;
          return;
        }

        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 't') {
          e.preventDefault();
          postToShell('aaz-new-tab');
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
          if (IS_TAB_FRAME) {
            e.preventDefault();
            postToShell('aaz-close-tab');
            return;
          }
        }
        if (e.ctrlKey && e.key === 'Tab') {
          e.preventDefault();
          postToShell('aaz-cycle-tab', { dir: e.shiftKey ? -1 : 1 });
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && /^[1-9]$/.test(e.key) && IS_TAB_FRAME) {
          e.preventDefault();
          postToShell('aaz-activate-index', { index: Number(e.key) - 1 });
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
          e.preventDefault();
          openNewPlayerWindow();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          if (e.shiftKey) openFilesPicker();
          else openFolderWithPersistence(false);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          openSavePlaylistPrompt();
          return;
        }

        const activeTag = document.activeElement?.tagName;
        const isTyping =
          (activeTag === 'INPUT' && document.activeElement.type !== 'range') ||
          activeTag === 'TEXTAREA' ||
          activeTag === 'SELECT' ||
          document.activeElement?.isContentEditable;
        if (isTyping) return;

        // Dispatch user-customizable shortcuts first
        if (phase3 && phase3.matchAndDispatchShortcut(e)) {
          return;
        }

        if (e.key === ',') {
          e.preventDefault();
          stepVideoFrame(-1);
        } else if (e.key === '.') {
          e.preventDefault();
          stepVideoFrame(1);
        } else if (e.key === '0') {
          if (!el.videoFrame.hidden) resetVideoTransform(true);
        } else if (e.key === '?') {
          if (phase3) phase3.renderShortcutsEditor();
          el.shortcutsModal.hidden = !el.shortcutsModal.hidden;
        }
      });

      /* =======================================================================
         17. Drag & Drop (Folders, Media, Subtitles, or .XSPF/.M3U8/.PLS)
         ======================================================================= */
      let dragDepth = 0;
      el.shell.addEventListener('dragenter', (e) => {
        if (state.dragTrackKey) return;
        e.preventDefault();
        dragDepth++;
        el.shell.classList.add('is-dragging');
      });
      el.shell.addEventListener('dragover', (e) => {
        if (state.dragTrackKey) return;
        e.preventDefault();
      });
      el.shell.addEventListener('dragleave', (e) => {
        if (state.dragTrackKey) return;
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) el.shell.classList.remove('is-dragging');
      });
      el.shell.addEventListener('drop', async (e) => {
        if (state.dragTrackKey) return;
        e.preventDefault();
        dragDepth = 0;
        el.shell.classList.remove('is-dragging');
        hideNotice();

        const items = Array.from(e.dataTransfer?.items || []);
        if (!desktopBridge && items.length === 1 && typeof items[0].getAsFileSystemHandle === 'function') {
          try {
            const handle = await items[0].getAsFileSystemHandle();
            if (handle && handle.kind === 'directory') {
              state.activeSavedPlaylistId = null;
              await loadFromDirectoryHandle(handle, { saveHandle: true, restoreSavedPosition: true, autoPlay: false });
              return;
            }
          } catch (err) {
            errorHandler.log('drop.fileSystemHandle', err);
          }
        }

        const droppedFiles = Array.from(e.dataTransfer?.files || []);
        if (droppedFiles.length === 0) return;

        if (droppedFiles.length === 1) {
          const ext = getExtension(droppedFiles[0].name);
          if (SUBTITLE_EXTENSIONS.has(ext)) {
            attachSubtitleVttText(await readSubtitleFileSmart(droppedFiles[0]), droppedFiles[0].name);
            showNotice(`Loaded subtitles: ${droppedFiles[0].name}`);
            return;
          }
          if (PLAYLIST_EXTENSIONS.has(ext)) {
            await handleImportedPlaylistContent(droppedFiles[0].name, await droppedFiles[0].text());
            return;
          }
        }

        const { tracks, subMap, folderName } = buildTracksFromFileList(droppedFiles);
        if (tracks.length === 0) {
          showNotice('No supported audio or video files were found in the dropped items.', true);
          return;
        }
        state.currentDirHandle = null;
        state.activeSavedPlaylistId = null;
        await applyLoadedTracks(tracks, subMap, folderName, 'input', { restoreSavedPosition: true, autoPlay: false });
      });

      /* =======================================================================
         18. Lifecycle Persistence & Initialization
         ======================================================================= */
      window.addEventListener('beforeunload', () => { if (state.currentKey) persistPlaybackState(); });
      window.addEventListener('pagehide', () => { if (state.currentKey) persistPlaybackState(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && state.currentKey) persistPlaybackState();
      });
      window.addEventListener('resize', () => {
        if (!el.audioStage.hidden && el.media.paused) AudioStudio.renderIdleFrame();
      });

      async function init() {
        const saved = StateStore.load();
        state.savedSession = saved;

        if (saved) {
          el.media.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : 0.85;
          el.media.muted = Boolean(saved.muted);
          setPlaybackRate(saved.playbackRate || 1, false);
          if (['all', 'audio', 'video', 'starred'].includes(saved.playlistMode)) state.playlistMode = saved.playlistMode;
          if (['video', 'audio'].includes(saved.videoDisplayMode)) state.videoDisplayMode = saved.videoDisplayMode;
          if (['custom', 'asc', 'desc', 'type', 'duration'].includes(saved.sortMode)) state.sortMode = saved.sortMode;
          state.shuffle = Boolean(saved.shuffle);
          if (['off', 'all', 'one'].includes(saved.repeatMode)) state.repeatMode = saved.repeatMode;
          if (typeof saved.eqPreset === 'string') state.eqPreset = saved.eqPreset;
          if (Array.isArray(saved.eqGains) && saved.eqGains.length === 5) {
            state.eqGains = saved.eqGains.map((v) => Math.max(-12, Math.min(12, Number(v) || 0)));
          }
          if (Number.isFinite(saved.preampGain)) state.preampGain = Math.max(1, Math.min(1.5, saved.preampGain));
          if (Array.isArray(saved.starredKeys)) state.starredKeys = new Set(saved.starredKeys);
          if (Array.isArray(saved.watchedKeys)) state.watchedKeys = new Set(saved.watchedKeys);
          if (saved.progressByKey && typeof saved.progressByKey === 'object') state.progressByKey = saved.progressByKey;
          if (saved.bookmarksByKey && typeof saved.bookmarksByKey === 'object') state.bookmarksByKey = saved.bookmarksByKey;
          if (Array.isArray(saved.savedPlaylists)) state.savedPlaylists = saved.savedPlaylists;
          // Do NOT pre-populate state.nativeFolderPath before a folder is actually loaded into this tab!
          state.nativeFolderPath = '';
        } else {
          el.media.volume = 0.85;
          setPlaybackRate(1, false);
        }

        async function handleExternalOpenPaths(paths, options = {}) {
          const { startTime = 0 } = options;
          if (!desktopBridge || !paths || !paths.length) return false;
          const inspected = await desktopBridge.inspectPaths(paths);
          if (!inspected) return false;
          if (inspected.playlists && inspected.playlists.length > 0) {
            await handleImportedPlaylistContent(
              inspected.playlists[0].name,
              inspected.playlists[0].content,
              inspected.playlists[0].fullPath || ''
            );
            return true;
          }
          if (!inspected.entries?.length) return false;
          // Support dragging a single .srt / .vtt subtitle directly onto an active video!
          if (inspected.entries.length === 1 && inspected.entries[0].kind === 'subtitle' && inspected.entries[0].fullPath) {
            const opGen = ++subtitleOpGen;
            const expectedTrackKey = state.currentKey;
            const subText = await desktopBridge.readTextFile(inspected.entries[0].fullPath);
            if (opGen !== subtitleOpGen || state.currentKey !== expectedTrackKey) return true;
            if (subText) {
              attachSubtitleVttText(subText, inspected.entries[0].name);
              showNotice(t('subAutoLoaded', { name: inspected.entries[0].name }));
              return true;
            }
          }
          const { tracks, subMap } = buildTracksFromElectronEntries(inspected.entries);
          if (tracks.length === 0) return false;
          await applyLoadedTracks(tracks, subMap, inspected.folderName || t('currentQueue'), 'electron', {
            restoreSavedPosition: inspected.isDirectory && !(startTime > 0),
            autoPlay: true,
            startTime,
            nativeFolderPath: inspected.isDirectory ? (inspected.folderPath || '') : ''
          });
          return true;
        }

        function handleTaskbarMediaAction(action) {
          if (action === 'toggle-play') togglePlayPause();
          else if (action === 'play') {
            if (el.media.paused) togglePlayPause();
          } else if (action === 'pause') {
            if (!el.media.paused) togglePlayPause();
          } else if (action === 'stop') {
            el.media.pause();
            el.media.currentTime = 0;
            updatePlayButtonUI();
          } else if (action === 'prev') playPreviousTrack();
          else if (action === 'next') playNextTrack(true, false);
        }

        if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
          const bindMs = (name, fn) => {
            try {
              navigator.mediaSession.setActionHandler(name, fn);
            } catch (err) {
              errorHandler.log(`mediaSession.bind.${name}`, err);
            }
          };
          bindMs('play', () => {
            if (el.media.paused) togglePlayPause();
          });
          bindMs('pause', () => {
            if (!el.media.paused) togglePlayPause();
          });
          bindMs('previoustrack', () => playPreviousTrack());
          bindMs('nexttrack', () => playNextTrack(true, false));
          bindMs('seekbackward', (details) => skipBySeconds(-(details?.seekOffset || 5)));
          bindMs('seekforward', (details) => skipBySeconds(details?.seekOffset || 5));
        }

        if (desktopBridge) {
          const isAndroid = Boolean(desktopBridge.isAndroid);
          el.pinWindowBtn.hidden = isAndroid;
          el.menuPinItem.hidden = isAndroid;
          if (desktopBridge.getAppVersion) {
            try {
              const ver = await desktopBridge.getAppVersion();
              if (ver) {
                state.appVersion = ver;
                el.menuVersionLabel.textContent = `AAZ Player v${ver}`;
              }
            } catch (err) {
              errorHandler.log('desktop.getAppVersion', err);
            }
          }
          if (!IS_TAB_FRAME) {
            if (desktopBridge.onUpdateStatus) desktopBridge.onUpdateStatus(handleUpdateStatus);
            if (desktopBridge.onOpenExternal) desktopBridge.onOpenExternal(handleExternalOpenPaths);
            if (desktopBridge.onTaskbarAction) desktopBridge.onTaskbarAction(handleTaskbarMediaAction);
            if (desktopBridge.onMediaAction) desktopBridge.onMediaAction(handleTaskbarMediaAction);
          }

          // Android Phone & Tablet Shell Navigation, Touch Gestures, & Back Stack
          if (isAndroid) {
            if (el.mobileBottomNav) {
              el.mobileBottomNav.hidden = false;
              el.mobileNavBtns.forEach((btn) => {
                btn.addEventListener('click', () => {
                  const target = btn.dataset.mobileNav || 'player';
                  setMobileView(target);
                });
              });
            }
            if (el.mobileMiniOpenPlayerBtn) {
              el.mobileMiniOpenPlayerBtn.addEventListener('click', () => setMobileView('player'));
            }
            if (el.mobileMiniPlayBtn) {
              el.mobileMiniPlayBtn.addEventListener('click', () => togglePlayPause());
            }
            if (el.mobileMiniNextBtn) {
              el.mobileMiniNextBtn.addEventListener('click', () => playNextTrack(true, false));
            }
            setMobileView('player');
            window.addEventListener('resize', syncMobileMiniBar);

            let lastBackConfirmAt = 0;
            const mobileGestures = createMobileGestureController({
              onSeekDelta: (delta) => {
                if (!getCurrentTrack()) return;
                skipBySeconds(delta);
                showNotice(delta > 0 ? `+${delta}s` : `${delta}s`);
              },
              onTogglePlay: () => togglePlayPause(),
              onBrightnessChange: (level) => {
                desktopBridge.setScreenBrightness?.(level).catch((err) => errorHandler.log('android.brightness', err));
                showNotice(
                  state.lang === 'ar'
                    ? `السطوع: ${Math.round(level * 100)}%`
                    : `Brightness: ${Math.round(level * 100)}%`
                );
              },
              onVolumeChange: (level) => {
                setVolume(level, true);
                showNotice(
                  state.lang === 'ar'
                    ? `الصوت: ${Math.round(level * 100)}%`
                    : `Volume: ${Math.round(level * 100)}%`
                );
              },
              onPinchZoom: (scale) => {
                state.videoZoom = Number(scale.toFixed(2));
                applyVideoTransform();
              },
              onCloseTopModal: () => {
                closeAllMenus();
                const openModal = document.querySelector('.modal-backdrop:not([hidden])');
                if (openModal) openModal.hidden = true;
              },
              onExitFullscreenOrPip: () => {
                toggleFullscreen();
              },
              onNavigateBack: () => {
                setMobileView('player');
              },
              onConfirmExit: () => {
                lastBackConfirmAt = Date.now();
                showNotice(
                  state.lang === 'ar'
                    ? 'اضغط رجوع مرة أخرى للخروج من التطبيق.'
                    : 'Press Back again to exit AAZ Player.'
                );
              },
            });

            if (el.mediaStage) {
              let touchStartX = 0;
              let touchStartY = 0;
              let touchLastY = 0;
              let touchAxis = 'none';
              let pinchStartDist = 0;
              let pinchStartZoom = 1;
              let touchMoved = false;

              el.mediaStage.addEventListener(
                'touchstart',
                (ev) => {
                  if (ev.target && ev.target.closest('button, input, select, .context-menu, .fs-hud')) return;
                  if (ev.touches.length === 2) {
                    const dx = ev.touches[0].clientX - ev.touches[1].clientX;
                    const dy = ev.touches[0].clientY - ev.touches[1].clientY;
                    pinchStartDist = Math.hypot(dx, dy);
                    pinchStartZoom = state.videoZoom || 1;
                    touchAxis = 'pinch';
                    touchMoved = true;
                    return;
                  }
                  if (ev.touches.length === 1) {
                    touchStartX = ev.touches[0].clientX;
                    touchStartY = ev.touches[0].clientY;
                    touchLastY = touchStartY;
                    touchAxis = 'none';
                    touchMoved = false;
                  }
                },
                { passive: true }
              );

              el.mediaStage.addEventListener(
                'touchmove',
                (ev) => {
                  if (touchAxis === 'pinch' && ev.touches.length === 2 && pinchStartDist > 20) {
                    const dx = ev.touches[0].clientX - ev.touches[1].clientX;
                    const dy = ev.touches[0].clientY - ev.touches[1].clientY;
                    const dist = Math.hypot(dx, dy);
                    mobileGestures.handlePinchScale(pinchStartZoom * (dist / pinchStartDist));
                    return;
                  }
                  if (ev.touches.length !== 1) return;
                  const curX = ev.touches[0].clientX;
                  const curY = ev.touches[0].clientY;
                  if (touchAxis === 'none') {
                    touchAxis = decideGestureAxis(curX - touchStartX, curY - touchStartY, TOUCH_SLOP_PX);
                  }
                  if (touchAxis === 'vertical') {
                    touchMoved = true;
                    const rect = el.mediaStage.getBoundingClientRect();
                    const relX = rect.width > 0 ? (touchStartX - rect.left) / rect.width : 0.5;
                    const deltaY = curY - touchLastY;
                    touchLastY = curY;
                    mobileGestures.handleVerticalSwipe({
                      relativeXRatio: relX,
                      deltaY,
                      stageHeight: rect.height || 360,
                      currentVolume: el.media.volume,
                    });
                  }
                },
                { passive: true }
              );

              el.mediaStage.addEventListener(
                'touchend',
                (ev) => {
                  if (touchMoved || touchAxis !== 'none') {
                    touchAxis = 'none';
                    touchMoved = false;
                    return;
                  }
                  const changed = ev.changedTouches && ev.changedTouches[0];
                  if (!changed) return;
                  if (ev.target && ev.target.closest('button, input, select, .context-menu, .fs-hud')) return;
                  const rect = el.mediaStage.getBoundingClientRect();
                  const relX = rect.width > 0 ? (changed.clientX - rect.left) / rect.width : 0.5;
                  mobileGestures.handleTap(relX, Date.now());
                },
                { passive: true }
              );
            }

            window.__aazHandleAndroidBack = () => {
              const hasOpenModal = Boolean(
                document.querySelector('.modal-backdrop:not([hidden])') ||
                  (el.contextMenu && !el.contextMenu.hidden) ||
                  document.querySelector('.menu-item.is-open')
              );
              const isPlaying = !el.media.paused && !el.media.ended;
              const withinConfirmWindow = Date.now() - lastBackConfirmAt < 2200;
              const outcome = mobileGestures.handleBackAction({
                hasOpenModal,
                isFullscreen: isFullscreenActive(),
                isPip: false,
                hasInternalBackView: Boolean(state.mobileView && state.mobileView !== 'player'),
                isPlaying: isPlaying && !withinConfirmWindow,
              });
              return outcome !== 'allow-exit';
            };
          }
        }

        if (IS_TAB_FRAME) {
          window.addEventListener('message', (e) => {
            const msg = receiveShellMessage(e, window.parent);
            if (!msg) return;
            if (msg.type === 'aaz-open-external') {
              handleExternalOpenPaths(msg.paths);
            } else if (msg.type === 'aaz-update-status') {
              handleUpdateStatus(msg.payload);
            } else if (msg.type === 'aaz-apply-prefs') {
              if (msg.theme) applyTheme(msg.theme, false, false);
              if (msg.skin) applySkin(msg.skin, false, false);
              if (msg.lang) applyLanguage(msg.lang, false, false);
              if (msg.subtitleStyle) updateSubtitleStyle(msg.subtitleStyle, false, false);
            } else if (msg.type === 'aaz-shell-mini-state') {
              if (phase3) phase3.applyMiniPlayerVisuals(msg.enabled, msg.alwaysOnTop);
            } else if (msg.type === 'aaz-taskbar-action') {
              handleTaskbarMediaAction(msg.action);
            }
          });
        }

        // Apply saved Theme, Visual Skin, Language (RTL/LTR), Visualizer Style & Subtitle Styling
        let savedTheme = 'dark';
        let savedSkin = DEFAULT_SKIN;
        let savedLang = 'en';
        let savedViz = 'spectrum';
        try {
          savedTheme = localStorage.getItem('aaz_theme') || 'dark';
          savedSkin = sanitizeSkin(localStorage.getItem(SKIN_STORAGE_KEY));
          savedLang = localStorage.getItem('aaz_lang') || 'en';
          savedViz = localStorage.getItem('aaz_viz_mode') || 'spectrum';
          const savedSubRaw = localStorage.getItem(SUBTITLE_STYLE_KEY);
          if (savedSubRaw) {
            const parsedSub = JSON.parse(savedSubRaw);
            if (parsedSub && typeof parsedSub === 'object') {
              state.subtitleStyle = sanitizeSubtitleStyle(parsedSub);
            }
          }
        } catch (err) {
          errorHandler.log('storage.loadPrefs', err);
        }

        applySubtitleStyleToDOM();
        syncSubtitleControlsUI();
        applyTheme(savedTheme, false, false);
        applySkin(savedSkin, false, false);
        setVizMode(savedViz, false);
        applyLanguage(savedLang, false, false);

        // Restore saved playlist sidebar width
        try {
          const savedW = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
          if (Number.isFinite(savedW) && savedW >= 240) {
            applySidebarWidth(savedW, false);
          }
        } catch (err) {
          errorHandler.log('storage.loadSidebarWidth', err);
        }

        // Enumerate real hardware audio outputs FIRST, then bind preferred output OR concrete Windows Default!
        await refreshAudioOutputDevices();
        let restoredAudioSink = false;
        try {
          const rawSink = sessionStorage.getItem(SESSION_SINK_KEY) || localStorage.getItem(LOCAL_SINK_KEY);
          if (rawSink) {
            const parsedSink = JSON.parse(rawSink);
            if (parsedSink && typeof parsedSink.id === 'string' && parsedSink.id) {
              const matched = state.audioDevices.find((d) => d.deviceId === parsedSink.id) ||
                (parsedSink.label ? state.audioDevices.find((d) => d.label && d.label === parsedSink.label) : null);
              if (matched) {
                restoredAudioSink = await applyAudioOutputDevice(matched.deviceId, matched.label || parsedSink.label || '', true, false);
              }
            }
          }
        } catch (err) {
          errorHandler.log('storage.loadAudioSink', err);
        }
        if (!restoredAudioSink) {
          state.audioSinkId = '';
          state.audioSinkLabel = '';
          await ensureAudioOutputBound();
        }
        updateAudioOutputButtonUI();
        renderAudioOutputList();

        el.toggleSidebarBtn.classList.add('is-active');
        updateModeTabsUI();
        updateSortButtonUI();
        updateShuffleRepeatUI();
        updateVolumeUI();
        updateEQUI();
        updatePlayButtonUI();
        updateStageVisibility();
        applyVideoTransform();
        updateTransportAvailability();
        updateSidebarCounts();
        renderSavedPlaylists();

        // Initialize Phase 3 Product Evolution Controller (History, Library, Settings, Shortcuts, Mini Player, Backup/Restore)
        phase3 = createPhase3Controller({
          storageManager,
          desktopBridge,
          errorHandler,
          media: el.media,
          postToShell,
          showNotice,
          closeAllMenus,
          normalizeFsPath,
          getLang: () => state.lang,
          getTheme: () => state.theme,
          getSkin: () => state.skin,
          getSubtitleStyle: () => state.subtitleStyle,
          getSidebarTab: () => state.sidebarTab,
          getCurrentTrack,
          getAudioDevices: () => state.audioDevices || [],
          renderSavedPlaylists,
          findTrackInQueue: (histItem) => {
            if (!histItem) return null;
            return findTrackSafely(state.allTracks, {
              fullPath: histItem.fullPath || '',
              key: histItem.relPath || histItem.key || '',
              name: histItem.name || '',
            });
          },
          loadTrackByKey,
          openExternalPathAtTime: async (fullPath, startTime = 0) => {
            const opened = await handleExternalOpenPaths([fullPath], { startTime });
            if (!opened) {
              showNotice(
                state.lang === 'ar'
                  ? 'تعذر فتح الملف — ربما تم نقله أو حذفه من الجهاز.'
                  : 'Could not open file — it may have been moved or deleted.',
                true
              );
            }
          },
          togglePlayPause,
          stopPlayback: () => {
            el.media.pause();
            el.media.currentTime = 0;
            updatePlayButtonUI();
            persistPlaybackState(0);
          },
          skipBySeconds,
          adjustVolume: (delta) => setVolume(el.media.volume + delta, true),
          setVolume: (vol) => setVolume(vol, true),
          setPlaybackRate: (rate) => setPlaybackRate(rate, true),
          setVideoAspect: (aspect) => {
            state.videoAspect = aspect || 'default';
            applyVideoTransform();
          },
          toggleMute,
          toggleFullscreen,
          togglePictureInPicture,
          playNextTrack: () => playNextTrack(true, false),
          playPrevTrack: playPreviousTrack,
          adjustSubtitleOffset: (delta) => adjustSubtitleOffset(delta, true),
          toggleAudioOutputPopover: () => toggleAudioOutputPopover(),
          openCastModal,
          openSubtitleModal: openSubtitleStyleModal,
          openThemeGalleryModal,
          captureVideoSnapshot,
          cycleABLoop,
          addBookmarkAtCurrentTime,
          selectAudioOutput: async (deviceId, label) => {
            await applyAudioOutputDevice(deviceId || '', label || '', true, true);
          },
          onBackupRestored: (restoredState, prefs) => {
            if (Array.isArray(restoredState.savedPlaylists)) {
              state.savedPlaylists = restoredState.savedPlaylists;
            }
            if (Array.isArray(restoredState.starredKeys)) {
              state.starredKeys = new Set(restoredState.starredKeys);
            }
            if (Array.isArray(restoredState.watchedKeys)) {
              state.watchedKeys = new Set(restoredState.watchedKeys);
            }
            if (restoredState.progressByKey) state.progressByKey = restoredState.progressByKey;
            if (restoredState.bookmarksByKey) state.bookmarksByKey = restoredState.bookmarksByKey;
            if (prefs?.theme) applyTheme(prefs.theme, true, true);
            if (prefs?.skin) applySkin(prefs.skin, true, true);
            if (prefs?.lang) applyLanguage(prefs.lang, true, true);
            if (prefs?.subtitleStyle) updateSubtitleStyle(prefs.subtitleStyle, true, true);
            renderSavedPlaylists();
            updateSidebarCounts();
          },
        });
        phase3.applyTranslations();

        state.savedDirHandle = await HandleStore.getHandle(IDB_LAST_DIR_KEY);
        if (IS_INITIAL_TAB || !IS_TAB_FRAME) {
          refreshResumeBanner();
        }
        notifyShellTabState();
        postToShell('aaz-tab-ready');
        requestAnimationFrame(() => AudioStudio.renderIdleFrame());

        if (desktopBridge?.isAndroid && !IS_TAB_FRAME && typeof desktopBridge.getLaunchFiles === 'function') {
          try {
            const launchPaths = await desktopBridge.getLaunchFiles();
            if (Array.isArray(launchPaths) && launchPaths.length > 0) {
              await handleExternalOpenPaths(launchPaths);
            }
          } catch (err) {
            errorHandler.log('android.getLaunchFiles', err);
          }
        }
      }

      init();
}
