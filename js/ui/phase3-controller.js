/**
 * Phase 3 Product Evolution Controller for AAZ Player.
 *
 * Cleanly integrates all 8 Phase 3 features with the core player engine:
 * 1. Watch History Sidebar Tab (resume, completion, search, remove, clear, privacy toggle)
 * 2. Advanced Saved Playlists (search + duplicate saved playlist)
 * 3. Configurable Keyboard Shortcuts Editor (live key capture, conflict detection, reset)
 * 4. Mini Player Mode (compact floating HUD reusing the same playback engine)
 * 5. Window Layout Persistence (delegated to workspace-shell / window-layout)
 * 6. Media Library Sidebar Tab (user-selected folders, rescan, remove, search, filter, sort)
 * 7. Playback Settings Modal (speed, volume, resume, subtitle lang, aspect, audio output, GPU readout, JSON backup/restore)
 * 8. UX Polish (buffering indicator, empty states, bilingual EN/AR sync)
 */

import { createHistoryManager } from '../modules/history-manager.js';
import { createLibraryManager } from '../modules/library-manager.js';
import {
  createShortcutsManager,
  normalizeKeyCombo,
  isTypingTarget,
} from '../modules/shortcuts-manager.js';
import {
  createSettingsManager,
  detectHardwareAcceleration,
} from '../modules/settings-manager.js';
import { formatTime, formatBytes, formatRelativeDate } from '../utils/time-utils.js';
import { ErrorCategory } from '../utils/error-handler.js';

const P3_I18N = {
  en: {
    tabLibrary: 'Library',
    menuOpenRecent: 'Open Recent / History',
    miniBtnTitle: 'Mini Player Mode (Ctrl+Shift+M)',
    settingsBtnTitle: 'Playback Settings (Ctrl+,)',
    miniReturn: 'Full Player',
    miniPin: 'Always on Top',
    miniSizePreset: 'Cycle Mini Size (S / M / L)',
    miniMinimize: 'Minimize',
    miniClose: 'Close',
    bufferingLabel: 'Buffering...',
    savedSearchPh: 'Search saved playlists...',
    savedCtxDuplicate: 'Duplicate Playlist',
    savedDuplicated: 'Duplicated playlist "{name}".',
    savedNoMatch: 'No saved playlists match your search.',
    histTitle: 'Watch History',
    histPauseOn: 'History Recording: On',
    histPauseOff: 'History Recording: Paused',
    histClearAll: 'Clear Watch History',
    histCleared: 'Watch history cleared.',
    histRemoveBtn: 'Remove from history',
    histRemoved: 'Removed from history.',
    histMoreNote: 'Showing latest 20 of {total} items',
    histEmptyTitle: 'No recent items yet',
    histEmptyDesc: 'Recently played tracks will appear here so you can resume where you left off.',
    histPausedNote: 'Watch history recording is paused in privacy mode.',
    histCompleted: 'Completed',
    histResumeAt: 'Resume at',
    histCannotReopenWeb: 'Open the original folder again in browser mode to replay this item.',
    libTitle: 'Media Library',
    libEmptyMeta: 'No folders added yet',
    libMetaSummary: '{folders} {folderWord} · {items} {itemWord}',
    libFolderOne: 'folder',
    libFolderMany: 'folders',
    libItemOne: 'item',
    libItemMany: 'items',
    libAddFolder: '+ Folder',
    libAddFolderFull: '+ Add Folder',
    libRescan: 'Rescan',
    libRemoveFolder: 'Remove folder',
    libAllFolders: 'All Folders',
    libSearchPh: 'Filter library files...',
    libSortName: 'Name',
    libSortDate: 'Date',
    libSortDur: 'Duration',
    libNoMatch: 'No library files match your filter.',
    libEmptyTitle: 'Your Media Library is empty',
    libEmptyDesc: 'Add your favorite media folders to browse, search, filter, and play instantly.',
    libFolderAdded: 'Added "{name}" ({count} items) to Media Library.',
    libFolderRescanned: 'Rescanned "{name}" ({count} items).',
    libFolderRemoved: 'Removed "{name}" from Media Library.',
    libFolderMissing: 'Folder not found on disk: "{name}".',
    libWebUnsupported: 'Persistent folder scanning works in the AAZ Desktop App. Use Open Folder in browser mode.',
    scModalHint: 'Click any shortcut badge and press a new key combination. Press Esc to cancel.',
    scPressKey: 'Press key...',
    scResetAll: 'Reset All Defaults',
    scConflictMsg: '"{key}" is already assigned to "{action}".',
    scOverrideBtn: 'Replace',
    scUpdated: 'Updated shortcut for "{action}" to {key}.',
    scResetDone: 'All keyboard shortcuts restored to defaults.',
    settingsTitle: 'Playback Settings',
    setSpeed: 'Default Playback Speed',
    setVolume: 'Default Volume',
    setResume: 'Resume Previous Playback Position',
    setResumeSub: 'Automatically continue audio and video from where you stopped.',
    setSubLang: 'Default Subtitle Language Preference',
    setSubAuto: 'Auto (Match UI / Filename)',
    setSubAr: 'Arabic (العربية)',
    setSubEn: 'English',
    setSubStyleBtn: 'Customize Subtitle Font & Style...',
    setAspect: 'Default Video Aspect Ratio',
    setAudioOut: 'Preferred Audio Output Device',
    setAudioSysDefault: 'System Default Output',
    setHistoryRec: 'Record Watch History',
    setHistoryRecSub: 'Save recently played files and timestamps locally on this device.',
    setHwAccel: 'Graphics / Hardware Acceleration',
    setHwActive: 'Hardware Accelerated',
    setHwSoftware: 'Software Fallback',
    setBackupHeading: 'Backup & Restore Data',
    setBackupDesc: 'Export or restore your saved playlists, watch history, media library, shortcuts, and settings as JSON.',
    setExportBackup: 'Export Backup (.json)',
    setImportBackup: 'Restore Backup...',
    setResetDefaults: 'Reset Settings',
    setSavedNotice: 'Playback settings updated.',
    setBackupExported: 'Backup exported successfully.',
    setBackupRestored: 'Backup restored successfully.',
  },
  ar: {
    tabLibrary: 'المكتبة',
    menuOpenRecent: 'الملفات الأخيرة / السجل',
    miniBtnTitle: 'المشغل المصغر (Ctrl+Shift+M)',
    settingsBtnTitle: 'إعدادات التشغيل (Ctrl+,)',
    miniReturn: 'الوضع الكامل',
    miniPin: 'تثبيت في الأعلى',
    miniSizePreset: 'تغيير حجم المصغر (S / M / L)',
    miniMinimize: 'تصغير',
    miniClose: 'إغلاق',
    bufferingLabel: 'جارٍ التحميل...',
    savedSearchPh: 'ابحث في القوائم المحفوظة...',
    savedCtxDuplicate: 'تكرار القائمة',
    savedDuplicated: 'تم تكرار القائمة "{name}".',
    savedNoMatch: 'لا توجد قوائم محفوظة تطابق البحث.',
    histTitle: 'سجل المشاهدة',
    histPauseOn: 'تسجيل السجل: مفعّل',
    histPauseOff: 'تسجيل السجل: متوقف',
    histClearAll: 'مسح سجل المشاهدة',
    histCleared: 'تم مسح سجل المشاهدة.',
    histRemoveBtn: 'إزالة من السجل',
    histRemoved: 'تمت الإزالة من السجل.',
    histMoreNote: 'عرض أحدث 20 من أصل {total} عنصر',
    histEmptyTitle: 'لا توجد ملفات أخيرة بعد',
    histEmptyDesc: 'ستظهر المقاطع التي تشغلها هنا لمتابعة المشاهدة من حيث توقفت.',
    histPausedNote: 'تسجيل سجل المشاهدة متوقف مؤقتاً في وضع الخصوصية.',
    histCompleted: 'مكتمل',
    histResumeAt: 'استئناف عند',
    histCannotReopenWeb: 'أعد فتح المجلد الأصلي في وضع المتصفح لتشغيل هذا الملف.',
    libTitle: 'مكتبة الوسائط',
    libEmptyMeta: 'لم تتم إضافة مجلدات بعد',
    libMetaSummary: '{folders} {folderWord} · {items} {itemWord}',
    libFolderOne: 'مجلد',
    libFolderMany: 'مجلدات',
    libItemOne: 'عنصر',
    libItemMany: 'عنصر',
    libAddFolder: '+ مجلد',
    libAddFolderFull: '+ إضافة مجلد',
    libRescan: 'تحديث',
    libRemoveFolder: 'إزالة المجلد',
    libAllFolders: 'كل المجلدات',
    libSearchPh: 'ابحث داخل المكتبة...',
    libSortName: 'الاسم',
    libSortDate: 'التاريخ',
    libSortDur: 'المدة',
    libNoMatch: 'لا توجد ملفات في المكتبة تطابق الفلتر.',
    libEmptyTitle: 'مكتبة الوسائط فارغة',
    libEmptyDesc: 'أضف مجلدات الوسائط المفضلة لديك للتصفح والبحث والتشغيل الفوري.',
    libFolderAdded: 'تمت إضافة "{name}" ({count} ملف) إلى المكتبة.',
    libFolderRescanned: 'تم تحديث "{name}" ({count} ملف).',
    libFolderRemoved: 'تمت إزالة "{name}" من المكتبة.',
    libFolderMissing: 'تعذر العثور على المجلد على القرص: "{name}".',
    libWebUnsupported: 'فحص المجلدات الدائم يعمل في تطبيق سطح المكتب AAZ Player. استخدم فتح مجلد في المتصفح.',
    scModalHint: 'انقر على أي اختصار واضغط تركيبة المفاتيح الجديدة. اضغط Esc للإلغاء.',
    scPressKey: 'اضغط مفتاحاً...',
    scResetAll: 'استعادة الافتراضي',
    scConflictMsg: 'الاختصار "{key}" مستخدم بالفعل لـ "{action}".',
    scOverrideBtn: 'استبدال',
    scUpdated: 'تم تحديث اختصار "{action}" إلى {key}.',
    scResetDone: 'تمت استعادة جميع الاختصارات الافتراضية.',
    settingsTitle: 'إعدادات التشغيل',
    setSpeed: 'سرعة التشغيل الافتراضية',
    setVolume: 'مستوى الصوت الافتراضي',
    setResume: 'استئناف التشغيل من الموضع السابق',
    setResumeSub: 'متابعة الصوت والفيديو تلقائياً من آخر ثانية توقفت عندها.',
    setSubLang: 'لغة الترجمة المفضلة',
    setSubAuto: 'تلقائي (حسب الواجهة واسم الملف)',
    setSubAr: 'العربية (Arabic)',
    setSubEn: 'الإنجليزية (English)',
    setSubStyleBtn: 'تخصيص خط وشكل الترجمة...',
    setAspect: 'نسبة أبعاد الفيديو الافتراضية',
    setAudioOut: 'جهاز إخراج الصوت المفضل',
    setAudioSysDefault: 'مخرج النظام الافتراضي',
    setHistoryRec: 'تسجيل سجل المشاهدة',
    setHistoryRecSub: 'حفظ المقاطع التي تم تشغيلها مؤخراً محلياً على جهازك فقط.',
    setHwAccel: 'الرسوميات وتسريع العتاد',
    setHwActive: 'تسريع العتاد نشط',
    setHwSoftware: 'وضع المعالجة البرمجية',
    setBackupHeading: 'النسخ الاحتياطي والاستعادة',
    setBackupDesc: 'تصدير أو استعادة القوائم المحفوظة وسجل المشاهدة والمكتبة والاختصارات والإعدادات كملف JSON.',
    setExportBackup: 'تصدير نسخة احتياطية (.json)',
    setImportBackup: 'استعادة نسخة...',
    setResetDefaults: 'استعادة الإعدادات',
    setSavedNotice: 'تم حفظ إعدادات التشغيل.',
    setBackupExported: 'تم تصدير النسخة الاحتياطية بنجاح.',
    setBackupRestored: 'تمت استعادة النسخة الاحتياطية بنجاح.',
  },
};

export function createPhase3Controller(api) {
  let storeCache = api.storageManager.load();

  function getStore() {
    if (!storeCache) {
      storeCache = api.storageManager.load();
    }
    return storeCache;
  }

  function invalidateStoreCache() {
    storeCache = api.storageManager.load();
  }

  function persistStore() {
    api.storageManager.save(storeCache);
  }

  function p3t(key, vars = {}) {
    const lang = api.getLang() === 'ar' ? 'ar' : 'en';
    const raw = (P3_I18N[lang] && P3_I18N[lang][key]) || P3_I18N.en[key] || key;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  }

  const settingsManager = createSettingsManager({
    getStore,
    persist: persistStore,
  });

  const historyManager = createHistoryManager({
    getStore,
    persist: persistStore,
    isRecordingEnabled: () => settingsManager.get().recordWatchHistory,
  });

  const libraryManager = createLibraryManager({
    getStore,
    persist: persistStore,
  });

  const shortcutsManager = createShortcutsManager({
    getStore,
    persist: persistStore,
  });

  // UI state
  const uiState = {
    historySearch: '',
    historyFilter: 'all',
    librarySearch: '',
    libraryType: 'all',
    librarySort: 'name',
    libraryFolderFilter: '',
    savedSearch: '',
    capturingActionId: null,
    pendingConflict: null,
    miniActive: false,
    miniAlwaysOnTop: true,
    miniSizeIdx: 1,
    miniSeeking: false,
    lastHistoryPersistAt: 0,
  };

  const MINI_SIZE_PRESETS = [
    { label: 'S', width: 360, height: 202 },
    { label: 'M', width: 480, height: 270 },
    { label: 'L', width: 640, height: 360 },
  ];

  // Grab DOM nodes safely
  const dom = {
    // Sidebar tabs & panels
    tabLibraryBtn: document.getElementById('tabLibraryBtn'),
    libraryTabCount: document.getElementById('libraryTabCount'),
    panelLibrary: document.getElementById('panelLibrary'),
    // Saved search
    savedSearchInput: document.getElementById('savedSearchInput'),
    // Media -> Open Recent / Watch History cascading submenu
    recentHistoryCount: document.getElementById('recentHistoryCount'),
    recentHistoryList: document.getElementById('recentHistoryList'),
    historyPauseMenuBtn: document.getElementById('historyPauseMenuBtn'),
    historyPauseMenuLabel: document.getElementById('historyPauseMenuLabel'),
    historyClearMenuBtn: document.getElementById('historyClearMenuBtn'),
    // Library UI (unified with Queue)
    libMeta: document.getElementById('libMeta'),
    libAddFolderBtn: document.getElementById('libAddFolderBtn'),
    libRescanAllBtn: document.getElementById('libRescanAllBtn'),
    libFolderChips: document.getElementById('libFolderChips'),
    libSearchInput: document.getElementById('libSearchInput'),
    libTypeBtns: document.querySelectorAll('[data-lib-type]'),
    libCountAll: document.getElementById('libCountAll'),
    libCountAudio: document.getElementById('libCountAudio'),
    libCountVideo: document.getElementById('libCountVideo'),
    libSortBtn: document.getElementById('libSortBtn'),
    libList: document.getElementById('libList'),
    // Mini player HUD & triggers
    miniPlayerBtn: document.getElementById('miniPlayerBtn'),
    miniPlayerHud: document.getElementById('miniPlayerHud'),
    miniDragBar: document.getElementById('miniDragBar'),
    miniTrackTitle: document.getElementById('miniTrackTitle'),
    miniSizeBtn: document.getElementById('miniSizeBtn'),
    miniPinBtn: document.getElementById('miniPinBtn'),
    miniExpandBtn: document.getElementById('miniExpandBtn'),
    miniMinBtn: document.getElementById('miniMinBtn'),
    miniCloseBtn: document.getElementById('miniCloseBtn'),
    miniSeekSlider: document.getElementById('miniSeekSlider'),
    miniTimeLabel: document.getElementById('miniTimeLabel'),
    miniPrevBtn: document.getElementById('miniPrevBtn'),
    miniPlayBtn: document.getElementById('miniPlayBtn'),
    miniPlayIcon: document.getElementById('miniPlayIcon'),
    miniPauseIcon: document.getElementById('miniPauseIcon'),
    miniNextBtn: document.getElementById('miniNextBtn'),
    miniMuteBtn: document.getElementById('miniMuteBtn'),
    miniVolIcon: document.getElementById('miniVolIcon'),
    miniMuteIcon: document.getElementById('miniMuteIcon'),
    miniVolSlider: document.getElementById('miniVolSlider'),
    // Buffering overlay
    stageBuffering: document.getElementById('stageBuffering'),
    stageBufferingText: document.getElementById('stageBufferingText'),
    // Shortcuts Modal
    shortcutsList: document.getElementById('shortcutsEditorList'),
    shortcutsResetAllBtn: document.getElementById('shortcutsResetAllBtn'),
    shortcutsConflictBar: document.getElementById('shortcutsConflictBar'),
    shortcutsConflictText: document.getElementById('shortcutsConflictText'),
    shortcutsConflictOverrideBtn: document.getElementById('shortcutsConflictOverrideBtn'),
    // Settings Modal
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    setDefaultSpeed: document.getElementById('setDefaultSpeed'),
    setDefaultVolume: document.getElementById('setDefaultVolume'),
    setDefaultVolumeVal: document.getElementById('setDefaultVolumeVal'),
    setResumeToggle: document.getElementById('setResumeToggle'),
    setSubtitleLang: document.getElementById('setSubtitleLang'),
    setOpenSubStyleBtn: document.getElementById('setOpenSubStyleBtn'),
    setOpenThemesBtn: document.getElementById('setOpenThemesBtn'),
    setDefaultAspect: document.getElementById('setDefaultAspect'),
    setAudioDevice: document.getElementById('setAudioDevice'),
    setHistoryRecToggle: document.getElementById('setHistoryRecToggle'),
    setHwBadge: document.getElementById('setHwBadge'),
    setHwRenderer: document.getElementById('setHwRenderer'),
    setExportBackupBtn: document.getElementById('setExportBackupBtn'),
    setImportBackupBtn: document.getElementById('setImportBackupBtn'),
    backupImportInput: document.getElementById('backupImportInput'),
    setResetBtn: document.getElementById('setResetBtn'),
  };

  /* -------------------------------------------------------------------------
     1. Bilingual Translation Sync for Phase 3 UI
     ------------------------------------------------------------------------- */
  function applyTranslations() {
    document.querySelectorAll('[data-p3-i18n]').forEach((node) => {
      const key = node.getAttribute('data-p3-i18n');
      if (key) node.textContent = p3t(key);
    });
    if (dom.savedSearchInput) dom.savedSearchInput.placeholder = p3t('savedSearchPh');
    if (dom.libSearchInput) dom.libSearchInput.placeholder = p3t('libSearchPh');
    if (dom.miniPlayerBtn) dom.miniPlayerBtn.title = p3t('miniBtnTitle');
    if (dom.openSettingsBtn) dom.openSettingsBtn.title = p3t('settingsBtnTitle');
    if (dom.miniSizeBtn) dom.miniSizeBtn.title = p3t('miniSizePreset');
    if (dom.miniPinBtn) dom.miniPinBtn.title = p3t('miniPin');
    if (dom.miniExpandBtn) dom.miniExpandBtn.title = p3t('miniReturn');
    if (dom.miniMinBtn) dom.miniMinBtn.title = p3t('miniMinimize');
    if (dom.miniCloseBtn) dom.miniCloseBtn.title = p3t('miniClose');
    if (dom.stageBufferingText) dom.stageBufferingText.textContent = p3t('bufferingLabel');

    updateLibSortButtonUI();
    updateCounts();
    renderHistory();
    renderLibrary();
    renderShortcutsEditor();
    syncSettingsModalUI();
  }

  function updateCounts() {
    const histCount = historyManager.getEntries().length;
    if (dom.recentHistoryCount) {
      dom.recentHistoryCount.textContent = String(histCount);
      dom.recentHistoryCount.hidden = histCount === 0;
    }
    if (dom.libraryTabCount) {
      const total = libraryManager.getFolders().reduce((acc, f) => acc + (f.items?.length || 0), 0);
      dom.libraryTabCount.textContent = String(total);
    }
  }

  function updateLibSortButtonUI() {
    if (!dom.libSortBtn) return;
    const labels = {
      name: p3t('libSortName'),
      date: p3t('libSortDate'),
      duration: p3t('libSortDur'),
    };
    dom.libSortBtn.textContent = labels[uiState.librarySort] || p3t('libSortName');
  }

  /* -------------------------------------------------------------------------
     2. Watch History Cascading Submenu (Media -> Open Recent / History)
     ------------------------------------------------------------------------- */
  function renderHistory() {
    if (!dom.recentHistoryList) return;
    const isRec = settingsManager.get().recordWatchHistory;
    if (dom.historyPauseMenuLabel) {
      dom.historyPauseMenuLabel.textContent = isRec ? p3t('histPauseOn') : p3t('histPauseOff');
    }
    if (dom.historyPauseMenuBtn) {
      dom.historyPauseMenuBtn.classList.toggle('is-checked', !isRec);
      dom.historyPauseMenuBtn.setAttribute('aria-pressed', String(!isRec));
    }

    const allEntries = historyManager.getEntries();
    const entries = allEntries.slice(0, 20);
    if (dom.historyClearMenuBtn) {
      dom.historyClearMenuBtn.disabled = allEntries.length === 0;
    }

    const frag = document.createDocumentFragment();

    if (!isRec) {
      const note = document.createElement('div');
      note.className = 'menu-recent-note';
      note.textContent = p3t('histPausedNote');
      frag.appendChild(note);
    }

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'menu-recent-empty';
      empty.textContent = p3t('histEmptyTitle');
      frag.appendChild(empty);
      dom.recentHistoryList.replaceChildren(frag);
      updateCounts();
      return;
    }

    const lang = api.getLang();
    for (const item of entries) {
      const row = document.createElement('div');
      row.className = `menu-recent-row${item.completed ? ' is-completed' : ''}`;
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '0');

      const badge = document.createElement('span');
      badge.className = `menu-recent-kind is-${item.kind}`;
      badge.textContent = item.kind === 'audio' ? 'AUD' : 'VID';

      const info = document.createElement('div');
      info.className = 'menu-recent-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'menu-recent-title';
      titleEl.textContent = item.title;
      titleEl.title = item.fullPath || item.title;

      const pct =
        item.duration > 0 ? Math.min(100, Math.round((item.lastTime / item.duration) * 100)) : 0;
      const statusText = item.completed
        ? `✓ ${p3t('histCompleted')}`
        : `${p3t('histResumeAt')} ${formatTime(item.lastTime)}${item.duration ? ` / ${formatTime(item.duration)}` : ''}`;

      const metaEl = document.createElement('div');
      metaEl.className = 'menu-recent-meta';
      metaEl.textContent = `${statusText} · ${formatRelativeDate(item.lastPlayedAt, lang)}`;

      info.append(titleEl, metaEl);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'menu-recent-remove';
      delBtn.title = p3t('histRemoveBtn');
      delBtn.setAttribute('aria-label', p3t('histRemoveBtn'));
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        historyManager.removeEntry(item.id);
        renderHistory();
      });

      row.append(badge, info, delBtn);

      if (pct > 2 || item.completed) {
        const barWrap = document.createElement('span');
        barWrap.className = 'menu-recent-progress';
        const barFill = document.createElement('span');
        barFill.className = 'menu-recent-progress-fill';
        barFill.style.width = `${item.completed ? 100 : pct}%`;
        barWrap.appendChild(barFill);
        row.appendChild(barWrap);
      }

      const triggerPlay = (e) => {
        if (e) e.stopPropagation();
        if (api.closeAllMenus) api.closeAllMenus();
        playHistoryItem(item);
      };
      row.addEventListener('click', triggerPlay);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerPlay(e);
        }
      });

      frag.appendChild(row);
    }

    if (allEntries.length > 20) {
      const moreNote = document.createElement('div');
      moreNote.className = 'menu-recent-note';
      moreNote.textContent = p3t('histMoreNote', { total: allEntries.length });
      frag.appendChild(moreNote);
    }

    dom.recentHistoryList.replaceChildren(frag);
    updateCounts();
  }

  async function playHistoryItem(item) {
    // 1. If already loaded in current queue, seek/play directly!
    const existing = api.findTrackInQueue(item);
    if (existing) {
      const startTime = item.completed ? 0 : item.lastTime || 0;
      await api.loadTrackByKey(existing.key, { autoPlay: true, startTime });
      return;
    }

    // 2. Desktop native path -> open via Tauri inspectPaths
    if (item.fullPath && api.desktopBridge && api.desktopBridge.inspectPaths) {
      try {
        const startTime = item.completed ? 0 : item.lastTime || 0;
        await api.openExternalPathAtTime(item.fullPath, startTime);
      } catch (err) {
        api.errorHandler.notify(ErrorCategory.FILE_ACCESS, err);
      }
      return;
    }

    api.showNotice(p3t('histCannotReopenWeb'), true);
  }

  /* -------------------------------------------------------------------------
     3. Media Library Rendering & Folder Management (Unified with Queue UI)
     ------------------------------------------------------------------------- */
  function renderLibrary() {
    if (!dom.libList) return;
    const folders = libraryManager.getFolders();

    // Compute counts for header meta and segmented All/Audio/Video tabs
    const scopedItems = libraryManager.queryItems({
      search: '',
      type: 'all',
      sortBy: 'name',
      folderPath: uiState.libraryFolderFilter,
    });
    const totalAll = folders.reduce((acc, f) => acc + (f.items?.length || 0), 0);
    const scopedAudio = scopedItems.filter((it) => it.kind === 'audio').length;
    const scopedVideo = scopedItems.filter((it) => it.kind === 'video').length;

    if (dom.libCountAll) dom.libCountAll.textContent = String(scopedItems.length);
    if (dom.libCountAudio) dom.libCountAudio.textContent = String(scopedAudio);
    if (dom.libCountVideo) dom.libCountVideo.textContent = String(scopedVideo);

    if (dom.libMeta) {
      if (folders.length === 0) {
        dom.libMeta.textContent = p3t('libEmptyMeta');
      } else {
        dom.libMeta.textContent = p3t('libMetaSummary', {
          folders: folders.length,
          folderWord: folders.length === 1 ? p3t('libFolderOne') : p3t('libFolderMany'),
          items: totalAll,
          itemWord: totalAll === 1 ? p3t('libItemOne') : p3t('libItemMany'),
        });
      }
    }

    // Render compact folder filter strip (matching Queue theme tokens)
    if (dom.libFolderChips) {
      const chipFrag = document.createDocumentFragment();
      if (folders.length > 0) {
        const allChip = document.createElement('button');
        allChip.type = 'button';
        allChip.className = `lib-folder-all${!uiState.libraryFolderFilter ? ' is-active' : ''}`;
        allChip.textContent = p3t('libAllFolders');
        allChip.addEventListener('click', () => {
          uiState.libraryFolderFilter = '';
          renderLibrary();
        });
        chipFrag.appendChild(allChip);

        for (const f of folders) {
          const wrap = document.createElement('div');
          wrap.className = `lib-folder-item${uiState.libraryFolderFilter === f.path ? ' is-active' : ''}`;

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lib-folder-label';
          btn.title = f.path;
          const nameSpan = document.createElement('span');
          nameSpan.textContent = f.name;
          const countSpan = document.createElement('span');
          countSpan.className = 'lib-folder-count';
          countSpan.textContent = String(f.items?.length || 0);
          btn.append(nameSpan, countSpan);
          btn.addEventListener('click', () => {
            uiState.libraryFolderFilter = uiState.libraryFolderFilter === f.path ? '' : f.path;
            renderLibrary();
          });

          const rescanBtn = document.createElement('button');
          rescanBtn.type = 'button';
          rescanBtn.className = 'lib-folder-act';
          rescanBtn.title = p3t('libRescan');
          rescanBtn.setAttribute('aria-label', p3t('libRescan'));
          rescanBtn.textContent = '↻';
          rescanBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            rescanLibraryFolder(f.path);
          });

          const remBtn = document.createElement('button');
          remBtn.type = 'button';
          remBtn.className = 'lib-folder-act is-danger';
          remBtn.title = p3t('libRemoveFolder');
          remBtn.setAttribute('aria-label', p3t('libRemoveFolder'));
          remBtn.textContent = '×';
          remBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            libraryManager.removeFolder(f.path);
            if (uiState.libraryFolderFilter === f.path) uiState.libraryFolderFilter = '';
            renderLibrary();
            api.showNotice(p3t('libFolderRemoved', { name: f.name }));
          });

          wrap.append(btn, rescanBtn, remBtn);
          chipFrag.appendChild(wrap);
        }
      }
      dom.libFolderChips.replaceChildren(chipFrag);
    }

    const items = libraryManager.queryItems({
      search: uiState.librarySearch,
      type: uiState.libraryType,
      sortBy: uiState.librarySort,
      folderPath: uiState.libraryFolderFilter,
    });

    const frag = document.createDocumentFragment();

    if (folders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'empty-icon-wrap';
      iconWrap.setAttribute('aria-hidden', 'true');
      iconWrap.innerHTML =
        '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = p3t('libEmptyTitle');

      const desc = document.createElement('div');
      desc.className = 'empty-desc';
      desc.textContent = p3t('libEmptyDesc');

      const actions = document.createElement('div');
      actions.className = 'empty-actions';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = p3t('libAddFolderFull');
      addBtn.addEventListener('click', () => addFolderToLibrary());
      actions.appendChild(addBtn);

      empty.append(iconWrap, title, desc, actions);
      frag.appendChild(empty);
      dom.libList.replaceChildren(frag);
      updateCounts();
      return;
    }

    if (items.length === 0) {
      const noRes = document.createElement('div');
      noRes.className = 'no-results';
      noRes.textContent = p3t('libNoMatch');
      frag.appendChild(noRes);
      dom.libList.replaceChildren(frag);
      updateCounts();
      return;
    }

    const currentTrack = api.getCurrentTrack();
    const norm = api.normalizeFsPath || ((p) => String(p || '').toLowerCase());
    const activeNormPath = currentTrack?.fullPath ? norm(currentTrack.fullPath) : '';

    items.forEach((item, idx) => {
      const isActive = Boolean(activeNormPath && item.fullPath && norm(item.fullPath) === activeNormPath);
      const row = document.createElement('div');
      row.className = `track-row lib-track-row${isActive ? ' is-active' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-selected', String(isActive));
      row.title = item.fullPath || item.name;

      const idxCell = document.createElement('span');
      idxCell.className = 'track-index';
      if (isActive) {
        idxCell.innerHTML =
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
      } else {
        idxCell.textContent = String(idx + 1).padStart(2, '0');
      }

      const infoCell = document.createElement('span');
      infoCell.className = 'track-info';

      const nameRow = document.createElement('span');
      nameRow.className = 'track-name-row';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'track-name';
      nameSpan.textContent = item.title;
      nameRow.appendChild(nameSpan);
      infoCell.appendChild(nameRow);

      const ext = item.name && item.name.includes('.') ? item.name.split('.').pop().toUpperCase() : '';
      const subParts = [];
      subParts.push(item.kind === 'video' ? 'Video' : 'Audio');
      if (ext) subParts.push(ext);
      if (item.folderName) subParts.push(item.folderName);

      const subSpan = document.createElement('span');
      subSpan.className = 'track-sub';
      subSpan.textContent = subParts.join(' · ');
      infoCell.appendChild(subSpan);

      const rightCell = document.createElement('span');
      rightCell.className = 'track-right';
      rightCell.textContent = item.duration
        ? formatTime(item.duration)
        : item.size
          ? formatBytes(item.size)
          : '';

      row.append(idxCell, infoCell, rightCell);

      const playLibItem = async () => {
        if (item.fullPath && api.desktopBridge && api.desktopBridge.inspectPaths) {
          try {
            await api.openExternalPathAtTime(item.fullPath, 0);
            renderLibrary();
          } catch (err) {
            api.errorHandler.notify(ErrorCategory.FILE_ACCESS, err);
          }
        } else {
          api.showNotice(p3t('libWebUnsupported'), true);
        }
      };

      row.addEventListener('click', playLibItem);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          playLibItem();
        }
      });

      frag.appendChild(row);
    });

    dom.libList.replaceChildren(frag);
    updateCounts();
  }

  async function addFolderToLibrary() {
    if (!api.desktopBridge || !api.desktopBridge.selectFolder) {
      api.showNotice(p3t('libWebUnsupported'), true);
      return;
    }
    try {
      const res = await api.desktopBridge.selectFolder();
      if (!res || !res.folderPath) return;
      const added = libraryManager.addOrUpdateFolder(
        res.folderPath,
        res.folderName,
        res.entries || []
      );
      renderLibrary();
      if (added) {
        api.showNotice(p3t('libFolderAdded', { name: added.name, count: added.items.length }));
      }
    } catch (err) {
      api.errorHandler.notify(ErrorCategory.FILE_ACCESS, err);
    }
  }

  async function rescanLibraryFolder(folderPath) {
    if (!api.desktopBridge || !api.desktopBridge.readFolder) return;
    try {
      const res = await api.desktopBridge.readFolder(folderPath);
      if (!res) {
        const existing = libraryManager.getFolders().find((f) => f.path === folderPath);
        api.showNotice(p3t('libFolderMissing', { name: existing ? existing.name : folderPath }), true);
        return;
      }
      const updated = libraryManager.addOrUpdateFolder(
        res.folderPath || folderPath,
        res.folderName,
        res.entries || []
      );
      renderLibrary();
      if (updated) {
        api.showNotice(
          p3t('libFolderRescanned', { name: updated.name, count: updated.items.length })
        );
      }
    } catch (err) {
      api.errorHandler.notify(ErrorCategory.FILE_ACCESS, err);
    }
  }

  async function rescanAllLibraryFolders() {
    const folders = [...libraryManager.getFolders()];
    for (const f of folders) {
      await rescanLibraryFolder(f.path);
    }
  }

  /* -------------------------------------------------------------------------
     4. Configurable Keyboard Shortcuts Editor
     ------------------------------------------------------------------------- */
  function renderShortcutsEditor() {
    if (!dom.shortcutsList) return;
    const isAr = api.getLang() === 'ar';
    const bindings = shortcutsManager.getAllBindings();
    const frag = document.createDocumentFragment();

    for (const item of bindings) {
      const row = document.createElement('div');
      row.className = 'sc-editor-row';

      const label = document.createElement('span');
      label.className = 'shortcut-desc';
      label.textContent = isAr ? item.labelAr : item.labelEn;

      const right = document.createElement('div');
      right.className = 'sc-editor-controls';

      const isCapturing = uiState.capturingActionId === item.id;
      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = `shortcut-key sc-bind-btn${isCapturing ? ' is-capturing' : ''}${item.isCustom ? ' is-custom' : ''}`;
      keyBtn.textContent = isCapturing ? p3t('scPressKey') : item.key || '—';
      keyBtn.addEventListener('click', () => {
        uiState.capturingActionId = isCapturing ? null : item.id;
        uiState.pendingConflict = null;
        hideConflictBar();
        renderShortcutsEditor();
      });

      right.appendChild(keyBtn);

      if (item.isCustom) {
        const resetOne = document.createElement('button');
        resetOne.type = 'button';
        resetOne.className = 'p3-icon-btn';
        resetOne.title = p3t('scResetAll');
        resetOne.textContent = '↺';
        resetOne.addEventListener('click', () => {
          shortcutsManager.resetBinding(item.id);
          renderShortcutsEditor();
        });
        right.appendChild(resetOne);
      }

      row.append(label, right);
      frag.appendChild(row);
    }

    dom.shortcutsList.replaceChildren(frag);
  }

  function hideConflictBar() {
    if (dom.shortcutsConflictBar) dom.shortcutsConflictBar.hidden = true;
  }

  function handleShortcutCaptureKeydown(e) {
    if (!uiState.capturingActionId) return false;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      uiState.capturingActionId = null;
      uiState.pendingConflict = null;
      hideConflictBar();
      renderShortcutsEditor();
      return true;
    }

    const combo = normalizeKeyCombo(e);
    if (!combo) return true; // Modifier only

    const actionId = uiState.capturingActionId;
    const res = shortcutsManager.setBinding(actionId, combo, { allowOverride: false });
    const isAr = api.getLang() === 'ar';

    if (!res.ok && res.reason === 'conflict') {
      uiState.pendingConflict = { actionId, combo, conflict: res.conflict };
      if (dom.shortcutsConflictBar && dom.shortcutsConflictText) {
        const conflictLabel = isAr ? res.conflict.labelAr : res.conflict.labelEn;
        dom.shortcutsConflictText.textContent = p3t('scConflictMsg', {
          key: combo,
          action: conflictLabel,
        });
        dom.shortcutsConflictBar.hidden = false;
      }
      return true;
    }

    if (res.ok) {
      uiState.capturingActionId = null;
      uiState.pendingConflict = null;
      hideConflictBar();
      renderShortcutsEditor();
      const target = shortcutsManager.getAllBindings().find((b) => b.id === actionId);
      api.showNotice(
        p3t('scUpdated', {
          action: target ? (isAr ? target.labelAr : target.labelEn) : actionId,
          key: combo,
        })
      );
    }
    return true;
  }

  function matchAndDispatchShortcut(e) {
    if (handleShortcutCaptureKeydown(e)) return true;
    if (isTypingTarget(e.target)) return false;

    const actionId = shortcutsManager.matchAction(e);
    if (!actionId) return false;

    const handlers = {
      playPause: () => api.togglePlayPause(),
      stop: () => api.stopPlayback(),
      seekBackward: () => api.skipBySeconds(-5),
      seekForward: () => api.skipBySeconds(5),
      volumeUp: () => api.adjustVolume(0.05),
      volumeDown: () => api.adjustVolume(-0.05),
      mute: () => api.toggleMute(),
      fullscreen: () => api.toggleFullscreen(),
      pip: () => api.togglePictureInPicture?.(),
      nextTrack: () => api.playNextTrack(),
      prevTrack: () => api.playPrevTrack(),
      subEarlier: () => api.adjustSubtitleOffset(-0.25),
      subLater: () => api.adjustSubtitleOffset(0.25),
      audioOutput: () => api.toggleAudioOutputPopover(),
      miniPlayer: () => toggleMiniPlayer(),
      cast: () => api.openCastModal(),
      snapshot: () => api.captureVideoSnapshot(),
      abLoop: () => api.cycleABLoop(),
      bookmark: () => api.addBookmarkAtCurrentTime(),
      settings: () => openSettingsModal(),
    };

    if (handlers[actionId]) {
      e.preventDefault();
      handlers[actionId]();
      return true;
    }
    return false;
  }

  /* -------------------------------------------------------------------------
     5. Mini Player Mode (Compact Floating HUD reusing existing engine)
     ------------------------------------------------------------------------- */
  function applyMiniPlayerVisuals(enabled, alwaysOnTop) {
    uiState.miniActive = Boolean(enabled);
    if (typeof alwaysOnTop === 'boolean') uiState.miniAlwaysOnTop = alwaysOnTop;

    document.documentElement.classList.toggle('is-mini-player', uiState.miniActive);
    if (!uiState.miniActive) {
      document.documentElement.classList.remove('is-mini-audio', 'is-mini-paused');
    }
    if (dom.miniPlayerHud) dom.miniPlayerHud.hidden = !uiState.miniActive;
    if (dom.miniPlayerBtn) {
      dom.miniPlayerBtn.classList.toggle('is-active', uiState.miniActive);
      dom.miniPlayerBtn.setAttribute('aria-pressed', String(uiState.miniActive));
    }
    if (dom.miniPinBtn) {
      dom.miniPinBtn.classList.toggle('is-active', uiState.miniAlwaysOnTop);
      dom.miniPinBtn.setAttribute('aria-pressed', String(uiState.miniAlwaysOnTop));
    }
    if (dom.miniSizeBtn) {
      dom.miniSizeBtn.textContent = MINI_SIZE_PRESETS[uiState.miniSizeIdx]?.label || 'M';
    }
    syncMiniPlayerPlaybackUI();
  }

  function toggleMiniPlayer(forceState) {
    const next = typeof forceState === 'boolean' ? forceState : !uiState.miniActive;
    const savedMini = getStore().windowLayout?.mini;
    const pin = typeof savedMini?.alwaysOnTop === 'boolean' ? savedMini.alwaysOnTop : true;
    applyMiniPlayerVisuals(next, pin);
    api.postToShell('aaz-tab-mini-mode', { enabled: next, alwaysOnTop: pin });
  }

  function toggleMiniAlwaysOnTop() {
    const nextPin = !uiState.miniAlwaysOnTop;
    uiState.miniAlwaysOnTop = nextPin;
    if (dom.miniPinBtn) {
      dom.miniPinBtn.classList.toggle('is-active', nextPin);
      dom.miniPinBtn.setAttribute('aria-pressed', String(nextPin));
    }
    api.postToShell('aaz-tab-mini-mode', { enabled: uiState.miniActive, alwaysOnTop: nextPin });
  }

  function cycleMiniSizePreset() {
    uiState.miniSizeIdx = (uiState.miniSizeIdx + 1) % MINI_SIZE_PRESETS.length;
    const preset = MINI_SIZE_PRESETS[uiState.miniSizeIdx];
    if (dom.miniSizeBtn) dom.miniSizeBtn.textContent = preset.label;
    api.postToShell('aaz-window-action', {
      action: 'mini-preset',
      width: preset.width,
      height: preset.height,
    });
  }

  function syncMiniPlayerTimeUI() {
    if (!uiState.miniActive) return;
    const cur = Number.isFinite(api.media.currentTime) ? api.media.currentTime : 0;
    const dur = Number.isFinite(api.media.duration) && api.media.duration > 0 ? api.media.duration : 0;
    if (dom.miniSeekSlider && !uiState.miniSeeking) {
      dom.miniSeekSlider.disabled = dur <= 0;
      dom.miniSeekSlider.value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : '0';
    }
    if (dom.miniTimeLabel) {
      dom.miniTimeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
  }

  function syncMiniPlayerPlaybackUI() {
    if (!dom.miniPlayerHud) return;
    const track = api.getCurrentTrack();
    if (dom.miniTrackTitle) {
      dom.miniTrackTitle.textContent = track ? track.displayName || track.name : 'AAZ Player';
    }
    const isPaused = api.media.paused;
    const isAudioMode = !track || track.kind !== 'video';
    if (uiState.miniActive) {
      document.documentElement.classList.toggle('is-mini-audio', isAudioMode);
      document.documentElement.classList.toggle('is-mini-paused', isPaused);
    }
    if (dom.miniPlayIcon) dom.miniPlayIcon.style.display = isPaused ? '' : 'none';
    if (dom.miniPauseIcon) dom.miniPauseIcon.style.display = isPaused ? 'none' : '';
    const isMuted = api.media.muted || api.media.volume === 0;
    if (dom.miniVolIcon) dom.miniVolIcon.style.display = isMuted ? 'none' : '';
    if (dom.miniMuteIcon) dom.miniMuteIcon.style.display = isMuted ? '' : 'none';
    if (dom.miniVolSlider) {
      dom.miniVolSlider.value = String(api.media.muted ? 0 : api.media.volume);
    }
    if (dom.miniMuteBtn) {
      dom.miniMuteBtn.classList.toggle('is-active', isMuted);
    }
    syncMiniPlayerTimeUI();
  }

  /* -------------------------------------------------------------------------
     6. Playback Settings Modal + Backup/Restore + Hardware Accel Readout
     ------------------------------------------------------------------------- */
  function syncSettingsModalUI() {
    const cfg = settingsManager.get();
    if (dom.setDefaultSpeed) dom.setDefaultSpeed.value = String(cfg.defaultPlaybackRate);
    if (dom.setDefaultVolume) dom.setDefaultVolume.value = String(cfg.defaultVolume);
    if (dom.setDefaultVolumeVal) {
      dom.setDefaultVolumeVal.textContent = `${Math.round(cfg.defaultVolume * 100)}%`;
    }
    if (dom.setResumeToggle) dom.setResumeToggle.checked = Boolean(cfg.resumePreviousPosition);
    if (dom.setSubtitleLang) dom.setSubtitleLang.value = cfg.defaultSubtitleLang;
    if (dom.setDefaultAspect) dom.setDefaultAspect.value = cfg.defaultAspectRatio;
    if (dom.setHistoryRecToggle) dom.setHistoryRecToggle.checked = Boolean(cfg.recordWatchHistory);

    // Populate audio output devices
    if (dom.setAudioDevice) {
      const devices = api.getAudioDevices();
      const frag = document.createDocumentFragment();
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = p3t('setAudioSysDefault');
      frag.appendChild(defOpt);
      for (const dev of devices) {
        if (!dev.deviceId || dev.deviceId === 'default') continue;
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || dev.deviceId;
        frag.appendChild(opt);
      }
      dom.setAudioDevice.replaceChildren(frag);
      dom.setAudioDevice.value = cfg.preferredAudioDeviceId || '';
    }

    // Hardware acceleration status readout
    const hw = detectHardwareAcceleration();
    if (dom.setHwBadge) {
      dom.setHwBadge.textContent = hw.available
        ? `${p3t('setHwActive')} (${hw.backend})`
        : p3t('setHwSoftware');
      dom.setHwBadge.classList.toggle('is-ok', hw.available);
    }
    if (dom.setHwRenderer) {
      dom.setHwRenderer.textContent = hw.renderer;
    }
  }

  function openSettingsModal() {
    if (!dom.settingsModal) return;
    syncSettingsModalUI();
    dom.settingsModal.hidden = false;
  }

  function closeSettingsModal() {
    if (dom.settingsModal) dom.settingsModal.hidden = true;
  }

  /* -------------------------------------------------------------------------
     7. Buffering / Loading Indicator
     ------------------------------------------------------------------------- */
  function setBufferingVisible(visible) {
    if (!dom.stageBuffering) return;
    dom.stageBuffering.hidden = !visible;
  }

  /* -------------------------------------------------------------------------
     8. Event Wiring
     ------------------------------------------------------------------------- */
  function bindEvents() {
    // Buffering listeners on <video>
    api.media.addEventListener('waiting', () => {
      if (api.getCurrentTrack()) setBufferingVisible(true);
    });
    api.media.addEventListener('loadstart', () => {
      if (api.getCurrentTrack()) setBufferingVisible(true);
    });
    api.media.addEventListener('canplay', () => setBufferingVisible(false));
    api.media.addEventListener('playing', () => {
      setBufferingVisible(false);
      syncMiniPlayerPlaybackUI();
      const tr = api.getCurrentTrack();
      if (tr) {
        historyManager.recordPlay(tr, api.media.currentTime, api.media.duration);
        renderHistory();
      }
      if (api.getSidebarTab() === 'library') renderLibrary();
    });
    api.media.addEventListener('pause', () => {
      setBufferingVisible(false);
      syncMiniPlayerPlaybackUI();
    });
    api.media.addEventListener('volumechange', syncMiniPlayerPlaybackUI);
    api.media.addEventListener('loadedmetadata', () => {
      const tr = api.getCurrentTrack();
      if (tr && tr.fullPath && Number.isFinite(api.media.duration) && api.media.duration > 0) {
        libraryManager.updateItemDuration(tr.fullPath, api.media.duration);
        if (api.getSidebarTab() === 'library') renderLibrary();
      }
      syncMiniPlayerPlaybackUI();
    });
    api.media.addEventListener('timeupdate', () => {
      syncMiniPlayerTimeUI();
      const now = Date.now();
      if (now - uiState.lastHistoryPersistAt < 4000) return;
      const tr = api.getCurrentTrack();
      if (!tr || api.media.paused) return;
      uiState.lastHistoryPersistAt = now;
      historyManager.updateProgress(tr, api.media.currentTime, api.media.duration);
    });
    api.media.addEventListener('ended', () => {
      setBufferingVisible(false);
      const tr = api.getCurrentTrack();
      if (tr) {
        historyManager.updateProgress(tr, api.media.duration || api.media.currentTime, api.media.duration);
        renderHistory();
      }
    });
    api.media.addEventListener('error', () => setBufferingVisible(false));

    // Media -> Open Recent / Watch History footer controls
    if (dom.historyPauseMenuBtn) {
      dom.historyPauseMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = settingsManager.get().recordWatchHistory;
        settingsManager.update({ recordWatchHistory: !cur });
        renderHistory();
        syncSettingsModalUI();
      });
    }
    if (dom.historyClearMenuBtn) {
      dom.historyClearMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (historyManager.getEntries().length === 0) return;
        historyManager.clearAll();
        renderHistory();
        if (api.closeAllMenus) api.closeAllMenus();
        api.showNotice(p3t('histCleared'));
      });
    }

    // Library controls
    if (dom.libAddFolderBtn) {
      dom.libAddFolderBtn.addEventListener('click', addFolderToLibrary);
    }
    if (dom.libRescanAllBtn) {
      dom.libRescanAllBtn.addEventListener('click', rescanAllLibraryFolders);
    }
    let libSearchTimer = null;
    if (dom.libSearchInput) {
      dom.libSearchInput.addEventListener('input', (e) => {
        clearTimeout(libSearchTimer);
        libSearchTimer = setTimeout(() => {
          uiState.librarySearch = e.target.value || '';
          renderLibrary();
        }, 140);
      });
    }
    dom.libTypeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.libraryType = btn.dataset.libType || 'all';
        dom.libTypeBtns.forEach((b) => {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-selected', String(active));
        });
        renderLibrary();
      });
    });
    if (dom.libSortBtn) {
      const sortOrder = ['name', 'date', 'duration'];
      dom.libSortBtn.addEventListener('click', () => {
        const nextIdx = (sortOrder.indexOf(uiState.librarySort) + 1) % sortOrder.length;
        uiState.librarySort = sortOrder[nextIdx];
        updateLibSortButtonUI();
        renderLibrary();
      });
    }

    // Saved Playlists Search (debounced)
    let savedSearchTimer = null;
    if (dom.savedSearchInput) {
      dom.savedSearchInput.addEventListener('input', (e) => {
        clearTimeout(savedSearchTimer);
        savedSearchTimer = setTimeout(() => {
          uiState.savedSearch = (e.target.value || '').trim().toLowerCase();
          api.renderSavedPlaylists();
        }, 140);
      });
    }

    // Mini Player controls
    if (dom.miniPlayerBtn) {
      dom.miniPlayerBtn.addEventListener('click', () => toggleMiniPlayer());
    }
    if (dom.miniExpandBtn) {
      dom.miniExpandBtn.addEventListener('click', () => toggleMiniPlayer(false));
    }
    if (dom.miniSizeBtn) {
      dom.miniSizeBtn.addEventListener('click', cycleMiniSizePreset);
    }
    if (dom.miniPinBtn) {
      dom.miniPinBtn.addEventListener('click', toggleMiniAlwaysOnTop);
    }
    if (dom.miniMinBtn) {
      dom.miniMinBtn.addEventListener('click', () => {
        api.postToShell('aaz-window-action', { action: 'minimize' });
      });
    }
    if (dom.miniCloseBtn) {
      dom.miniCloseBtn.addEventListener('click', () => {
        api.postToShell('aaz-window-action', { action: 'close' });
      });
    }
    if (dom.miniSeekSlider) {
      const commitMiniSeek = () => {
        const dur = Number.isFinite(api.media.duration) && api.media.duration > 0 ? api.media.duration : 0;
        if (dur > 0) {
          const frac = Math.max(0, Math.min(1, Number(dom.miniSeekSlider.value) / 1000));
          api.media.currentTime = frac * dur;
        }
        uiState.miniSeeking = false;
        syncMiniPlayerTimeUI();
      };
      dom.miniSeekSlider.addEventListener('pointerdown', () => {
        uiState.miniSeeking = true;
      });
      dom.miniSeekSlider.addEventListener('input', () => {
        uiState.miniSeeking = true;
        const dur = Number.isFinite(api.media.duration) && api.media.duration > 0 ? api.media.duration : 0;
        if (dur > 0 && dom.miniTimeLabel) {
          const preview = (Number(dom.miniSeekSlider.value) / 1000) * dur;
          dom.miniTimeLabel.textContent = `${formatTime(preview)} / ${formatTime(dur)}`;
        }
      });
      dom.miniSeekSlider.addEventListener('change', commitMiniSeek);
      dom.miniSeekSlider.addEventListener('pointerup', () => {
        if (uiState.miniSeeking) commitMiniSeek();
      });
    }
    if (dom.miniPlayBtn) {
      dom.miniPlayBtn.addEventListener('click', () => api.togglePlayPause());
    }
    if (dom.miniPrevBtn) {
      dom.miniPrevBtn.addEventListener('click', () => api.playPrevTrack());
    }
    if (dom.miniNextBtn) {
      dom.miniNextBtn.addEventListener('click', () => api.playNextTrack());
    }
    if (dom.miniMuteBtn) {
      dom.miniMuteBtn.addEventListener('click', () => api.toggleMute());
    }
    if (dom.miniVolSlider) {
      dom.miniVolSlider.addEventListener('input', (e) => {
        api.setVolume(parseFloat(e.target.value));
      });
    }
    if (dom.miniDragBar) {
      let dragArmed = null;
      const cleanupMiniDrag = () => {
        dragArmed = null;
        window.removeEventListener('mousemove', onMiniMove);
        window.removeEventListener('mouseup', cleanupMiniDrag);
        window.removeEventListener('blur', cleanupMiniDrag);
      };
      const onMiniMove = (ev) => {
        if (!dragArmed) return;
        if ((ev.buttons & 1) === 0) {
          cleanupMiniDrag();
          return;
        }
        if (Math.hypot(ev.screenX - dragArmed.x, ev.screenY - dragArmed.y) >= 5) {
          cleanupMiniDrag();
          if (api.desktopBridge && api.desktopBridge.startWindowDrag) {
            api.desktopBridge
              .startWindowDrag()
              .then(() => api.postToShell('aaz-window-action', { action: 'mini-drag-end' }))
              .catch(() => {});
          }
        }
      };
      dom.miniDragBar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        if (e.detail >= 2) {
          cleanupMiniDrag();
          return;
        }
        dragArmed = { x: e.screenX, y: e.screenY };
        window.addEventListener('mousemove', onMiniMove);
        window.addEventListener('mouseup', cleanupMiniDrag);
        window.addEventListener('blur', cleanupMiniDrag);
      });
      dom.miniDragBar.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        cleanupMiniDrag();
        toggleMiniPlayer(false);
      });
    }

    // Shortcuts Modal controls
    if (dom.shortcutsResetAllBtn) {
      dom.shortcutsResetAllBtn.addEventListener('click', () => {
        shortcutsManager.resetAll();
        uiState.capturingActionId = null;
        uiState.pendingConflict = null;
        hideConflictBar();
        renderShortcutsEditor();
        api.showNotice(p3t('scResetDone'));
      });
    }
    if (dom.shortcutsConflictOverrideBtn) {
      dom.shortcutsConflictOverrideBtn.addEventListener('click', () => {
        if (!uiState.pendingConflict) return;
        const { actionId, combo } = uiState.pendingConflict;
        shortcutsManager.setBinding(actionId, combo, { allowOverride: true });
        uiState.capturingActionId = null;
        uiState.pendingConflict = null;
        hideConflictBar();
        renderShortcutsEditor();
      });
    }

    // Settings Modal controls
    if (dom.openSettingsBtn) {
      dom.openSettingsBtn.addEventListener('click', openSettingsModal);
    }
    if (dom.closeSettingsBtn) {
      dom.closeSettingsBtn.addEventListener('click', closeSettingsModal);
    }
    if (dom.settingsModal) {
      dom.settingsModal.addEventListener('click', (e) => {
        if (e.target === dom.settingsModal) closeSettingsModal();
      });
    }

    if (dom.setDefaultSpeed) {
      dom.setDefaultSpeed.addEventListener('change', (e) => {
        const rate = parseFloat(e.target.value) || 1;
        settingsManager.update({ defaultPlaybackRate: rate });
        api.setPlaybackRate(rate);
        api.showNotice(p3t('setSavedNotice'));
      });
    }
    if (dom.setDefaultVolume) {
      dom.setDefaultVolume.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        if (dom.setDefaultVolumeVal) {
          dom.setDefaultVolumeVal.textContent = `${Math.round(vol * 100)}%`;
        }
        settingsManager.update({ defaultVolume: vol });
        api.setVolume(vol);
      });
    }
    if (dom.setResumeToggle) {
      dom.setResumeToggle.addEventListener('change', (e) => {
        settingsManager.update({ resumePreviousPosition: e.target.checked });
        api.showNotice(p3t('setSavedNotice'));
      });
    }
    if (dom.setSubtitleLang) {
      dom.setSubtitleLang.addEventListener('change', (e) => {
        settingsManager.update({ defaultSubtitleLang: e.target.value });
        api.showNotice(p3t('setSavedNotice'));
      });
    }
    if (dom.setOpenSubStyleBtn) {
      dom.setOpenSubStyleBtn.addEventListener('click', () => {
        closeSettingsModal();
        api.openSubtitleModal();
      });
    }
    if (dom.setOpenThemesBtn) {
      dom.setOpenThemesBtn.addEventListener('click', () => {
        closeSettingsModal();
        if (api.openThemeGalleryModal) api.openThemeGalleryModal();
      });
    }
    if (dom.setDefaultAspect) {
      dom.setDefaultAspect.addEventListener('change', (e) => {
        settingsManager.update({ defaultAspectRatio: e.target.value });
        api.setVideoAspect(e.target.value);
        api.showNotice(p3t('setSavedNotice'));
      });
    }
    if (dom.setAudioDevice) {
      dom.setAudioDevice.addEventListener('change', async (e) => {
        const devId = e.target.value || '';
        settingsManager.update({ preferredAudioDeviceId: devId });
        const label = e.target.selectedOptions?.[0]?.textContent || '';
        await api.selectAudioOutput(devId, label);
      });
    }
    if (dom.setHistoryRecToggle) {
      dom.setHistoryRecToggle.addEventListener('change', (e) => {
        settingsManager.update({ recordWatchHistory: e.target.checked });
        renderHistory();
        api.showNotice(p3t('setSavedNotice'));
      });
    }
    if (dom.setResetBtn) {
      dom.setResetBtn.addEventListener('click', () => {
        const def = settingsManager.reset();
        api.setPlaybackRate(def.defaultPlaybackRate);
        api.setVolume(def.defaultVolume);
        api.setVideoAspect(def.defaultAspectRatio);
        syncSettingsModalUI();
        renderHistory();
        api.showNotice(p3t('setSavedNotice'));
      });
    }

    // JSON Backup Export & Restore
    if (dom.setExportBackupBtn) {
      dom.setExportBackupBtn.addEventListener('click', () => {
        const json = api.storageManager.exportBackupJson({
          theme: api.getTheme(),
          skin: api.getSkin ? api.getSkin() : 'foliage',
          lang: api.getLang(),
          subtitleStyle: api.getSubtitleStyle(),
        });
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aaz-player-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        api.showNotice(p3t('setBackupExported'));
      });
    }
    if (dom.setImportBackupBtn && dom.backupImportInput) {
      dom.setImportBackupBtn.addEventListener('click', () => {
        dom.backupImportInput.value = '';
        dom.backupImportInput.click();
      });
      dom.backupImportInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const res = api.storageManager.importBackupJson(text);
          if (!res.ok) {
            api.errorHandler.notifyMessage('backupInvalid');
            return;
          }
          storeCache = res.state;
          api.onBackupRestored(res.state, res.prefs);
          renderHistory();
          renderLibrary();
          renderShortcutsEditor();
          syncSettingsModalUI();
          api.showNotice(p3t('setBackupRestored'));
        } catch (err) {
          api.errorHandler.notify(ErrorCategory.STORAGE, err);
        }
      });
    }
  }

  bindEvents();

  // Apply persisted default aspect ratio on startup
  const initialCfg = settingsManager.get();
  if (initialCfg.defaultAspectRatio && initialCfg.defaultAspectRatio !== 'default') {
    api.setVideoAspect(initialCfg.defaultAspectRatio);
  }

  return {
    settingsManager,
    historyManager,
    libraryManager,
    shortcutsManager,
    p3t,
    getSavedSearchQuery: () => uiState.savedSearch,
    shouldResumePosition: () => settingsManager.get().resumePreviousPosition,
    applyTranslations,
    renderHistory,
    renderLibrary,
    renderShortcutsEditor,
    syncSettingsModalUI,
    syncMiniPlayerPlaybackUI,
    applyMiniPlayerVisuals,
    toggleMiniPlayer,
    openSettingsModal,
    closeSettingsModal,
    matchAndDispatchShortcut,
    invalidateStoreCache,
    isCapturingShortcut: () => Boolean(uiState.capturingActionId),
    cancelShortcutCapture: () => {
      uiState.capturingActionId = null;
      uiState.pendingConflict = null;
      hideConflictBar();
    },
  };
}
