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
    tabHistory: 'History',
    miniBtnTitle: 'Mini Player Mode (Ctrl+Shift+M)',
    settingsBtnTitle: 'Playback Settings (Ctrl+,)',
    miniReturn: 'Full Player',
    miniPin: 'Always on Top',
    bufferingLabel: 'Buffering...',
    savedSearchPh: 'Search saved playlists...',
    savedCtxDuplicate: 'Duplicate Playlist',
    savedDuplicated: 'Duplicated playlist "{name}".',
    savedNoMatch: 'No saved playlists match your search.',
    histTitle: 'Watch History',
    histSearchPh: 'Search watch history...',
    histFilterAll: 'All',
    histFilterProgress: 'In Progress',
    histFilterDone: 'Completed',
    histPauseOn: 'History Recording: On',
    histPauseOff: 'History Paused',
    histClearAll: 'Clear All',
    histCleared: 'Watch history cleared.',
    histRemoved: 'Removed from history.',
    histEmptyTitle: 'No watch history yet',
    histEmptyDesc: 'Tracks you play will appear here so you can resume where you left off.',
    histPausedNote: 'Watch history recording is paused in privacy mode.',
    histCompleted: 'Completed',
    histMarkDone: 'Mark Completed',
    histMarkUndone: 'Mark Incomplete',
    histResumeAt: 'Resume at',
    histCannotReopenWeb: 'Open the original folder again in browser mode to replay this item.',
    libTitle: 'Media Library',
    libAddFolder: '+ Add Folder',
    libRescan: 'Rescan',
    libRemoveFolder: 'Remove folder',
    libAllFolders: 'All Folders',
    libSearchPh: 'Search library files...',
    libSortName: 'Name',
    libSortDate: 'Date',
    libSortDur: 'Duration',
    libEmptyTitle: 'Your Media Library is empty',
    libEmptyDesc: 'Add your favorite media folders to browse, search, filter, and play instantly. AAZ Player only scans folders you choose.',
    libFolderAdded: 'Added "{name}" ({count} items) to Media Library.',
    libFolderRescanned: 'Rescanned "{name}" ({count} items).',
    libFolderRemoved: 'Removed "{name}" from Media Library.',
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
    tabHistory: 'السجل',
    miniBtnTitle: 'المشغل المصغر (Ctrl+Shift+M)',
    settingsBtnTitle: 'إعدادات التشغيل (Ctrl+,)',
    miniReturn: 'الوضع الكامل',
    miniPin: 'تثبيت في الأعلى',
    bufferingLabel: 'جارٍ التحميل...',
    savedSearchPh: 'ابحث في القوائم المحفوظة...',
    savedCtxDuplicate: 'تكرار القائمة',
    savedDuplicated: 'تم تكرار القائمة "{name}".',
    savedNoMatch: 'لا توجد قوائم محفوظة تطابق البحث.',
    histTitle: 'سجل المشاهدة',
    histSearchPh: 'ابحث في سجل المشاهدة...',
    histFilterAll: 'الكل',
    histFilterProgress: 'قيد المشاهدة',
    histFilterDone: 'مكتمل',
    histPauseOn: 'تسجيل السجل: مفعّل',
    histPauseOff: 'السجل متوقف مؤقتاً',
    histClearAll: 'مسح السجل',
    histCleared: 'تم مسح سجل المشاهدة.',
    histRemoved: 'تمت الإزالة من السجل.',
    histEmptyTitle: 'سجل المشاهدة فارغ',
    histEmptyDesc: 'ستظهر المقاطع التي تشغلها هنا لمتابعة المشاهدة من حيث توقفت.',
    histPausedNote: 'تسجيل سجل المشاهدة متوقف مؤقتاً في وضع الخصوصية.',
    histCompleted: 'مكتمل',
    histMarkDone: 'تحديد كمكتمل',
    histMarkUndone: 'إلغاء الاكتمال',
    histResumeAt: 'استئناف عند',
    histCannotReopenWeb: 'أعد فتح المجلد الأصلي في وضع المتصفح لتشغيل هذا الملف.',
    libTitle: 'مكتبة الوسائط',
    libAddFolder: '+ إضافة مجلد',
    libRescan: 'تحديث',
    libRemoveFolder: 'إزالة المجلد',
    libAllFolders: 'كل المجلدات',
    libSearchPh: 'ابحث في ملفات المكتبة...',
    libSortName: 'الاسم',
    libSortDate: 'التاريخ',
    libSortDur: 'المدة',
    libEmptyTitle: 'مكتبة الوسائط فارغة',
    libEmptyDesc: 'أضف مجلدات الوسائط المفضلة لديك للتصفح والبحث والتشغيل الفوري. يقوم البرنامج بفحص المجلدات التي تختارها فقط.',
    libFolderAdded: 'تمت إضافة "{name}" ({count} ملف) إلى المكتبة.',
    libFolderRescanned: 'تم تحديث "{name}" ({count} ملف).',
    libFolderRemoved: 'تمت إزالة "{name}" من المكتبة.',
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
    storeCache = api.storageManager.load();
    return storeCache;
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
    lastHistoryPersistAt: 0,
  };

  // Grab DOM nodes safely
  const dom = {
    // Sidebar tabs & panels
    tabLibraryBtn: document.getElementById('tabLibraryBtn'),
    tabHistoryBtn: document.getElementById('tabHistoryBtn'),
    libraryTabCount: document.getElementById('libraryTabCount'),
    historyTabCount: document.getElementById('historyTabCount'),
    panelLibrary: document.getElementById('panelLibrary'),
    panelHistory: document.getElementById('panelHistory'),
    // Saved search
    savedSearchInput: document.getElementById('savedSearchInput'),
    // History UI
    historySearchInput: document.getElementById('historySearchInput'),
    historyFilterBtns: document.querySelectorAll('[data-hist-filter]'),
    historyPauseBtn: document.getElementById('historyPauseBtn'),
    historyClearBtn: document.getElementById('historyClearBtn'),
    historyList: document.getElementById('historyList'),
    // Library UI
    libAddFolderBtn: document.getElementById('libAddFolderBtn'),
    libRescanAllBtn: document.getElementById('libRescanAllBtn'),
    libFolderChips: document.getElementById('libFolderChips'),
    libSearchInput: document.getElementById('libSearchInput'),
    libTypeBtns: document.querySelectorAll('[data-lib-type]'),
    libSortSelect: document.getElementById('libSortSelect'),
    libList: document.getElementById('libList'),
    // Mini player HUD & triggers
    miniPlayerBtn: document.getElementById('miniPlayerBtn'),
    miniPlayerHud: document.getElementById('miniPlayerHud'),
    miniDragBar: document.getElementById('miniDragBar'),
    miniTrackTitle: document.getElementById('miniTrackTitle'),
    miniPinBtn: document.getElementById('miniPinBtn'),
    miniExpandBtn: document.getElementById('miniExpandBtn'),
    miniPrevBtn: document.getElementById('miniPrevBtn'),
    miniPlayBtn: document.getElementById('miniPlayBtn'),
    miniPlayIcon: document.getElementById('miniPlayIcon'),
    miniPauseIcon: document.getElementById('miniPauseIcon'),
    miniNextBtn: document.getElementById('miniNextBtn'),
    miniMuteBtn: document.getElementById('miniMuteBtn'),
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
    if (dom.historySearchInput) dom.historySearchInput.placeholder = p3t('histSearchPh');
    if (dom.libSearchInput) dom.libSearchInput.placeholder = p3t('libSearchPh');
    if (dom.miniPlayerBtn) dom.miniPlayerBtn.title = p3t('miniBtnTitle');
    if (dom.openSettingsBtn) dom.openSettingsBtn.title = p3t('settingsBtnTitle');
    if (dom.miniPinBtn) dom.miniPinBtn.title = p3t('miniPin');
    if (dom.miniExpandBtn) dom.miniExpandBtn.title = p3t('miniReturn');
    if (dom.stageBufferingText) dom.stageBufferingText.textContent = p3t('bufferingLabel');

    updateCounts();
    renderHistory();
    renderLibrary();
    renderShortcutsEditor();
    syncSettingsModalUI();
  }

  function updateCounts() {
    if (dom.historyTabCount) {
      dom.historyTabCount.textContent = String(historyManager.getEntries().length);
    }
    if (dom.libraryTabCount) {
      const total = libraryManager.getFolders().reduce((acc, f) => acc + (f.items?.length || 0), 0);
      dom.libraryTabCount.textContent = String(total);
    }
  }

  /* -------------------------------------------------------------------------
     2. Watch History Rendering & Playback
     ------------------------------------------------------------------------- */
  function renderHistory() {
    if (!dom.historyList) return;
    const isRec = settingsManager.get().recordWatchHistory;
    if (dom.historyPauseBtn) {
      dom.historyPauseBtn.textContent = isRec ? p3t('histPauseOn') : p3t('histPauseOff');
      dom.historyPauseBtn.classList.toggle('is-active', !isRec);
      dom.historyPauseBtn.setAttribute('aria-pressed', String(!isRec));
    }

    const entries = historyManager.query({
      search: uiState.historySearch,
      filter: uiState.historyFilter,
    });

    const frag = document.createDocumentFragment();

    if (!isRec) {
      const banner = document.createElement('div');
      banner.className = 'p3-inline-note';
      banner.textContent = p3t('histPausedNote');
      frag.appendChild(banner);
    }

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state p3-empty';
      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = p3t('histEmptyTitle');
      const desc = document.createElement('div');
      desc.className = 'empty-desc';
      desc.textContent = p3t('histEmptyDesc');
      empty.append(title, desc);
      frag.appendChild(empty);
      dom.historyList.replaceChildren(frag);
      updateCounts();
      return;
    }

    const lang = api.getLang();
    for (const item of entries) {
      const row = document.createElement('div');
      row.className = `p3-card${item.completed ? ' is-completed' : ''}`;
      row.setAttribute('tabindex', '0');

      const top = document.createElement('div');
      top.className = 'p3-card-top';

      const badge = document.createElement('span');
      badge.className = `p3-kind-tag is-${item.kind}`;
      badge.textContent = item.kind === 'audio' ? 'AUD' : 'VID';

      const titleEl = document.createElement('div');
      titleEl.className = 'p3-card-title';
      titleEl.textContent = item.title;
      titleEl.title = item.fullPath || item.title;

      const actions = document.createElement('div');
      actions.className = 'p3-card-actions';

      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = `p3-icon-btn${item.completed ? ' is-active' : ''}`;
      doneBtn.title = item.completed ? p3t('histMarkUndone') : p3t('histMarkDone');
      doneBtn.textContent = item.completed ? '✓' : '○';
      doneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        historyManager.toggleCompleted(item.id);
        renderHistory();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'p3-icon-btn is-danger';
      delBtn.title = p3t('histRemoved');
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        historyManager.removeEntry(item.id);
        renderHistory();
        api.showNotice(p3t('histRemoved'));
      });

      actions.append(doneBtn, delBtn);
      top.append(badge, titleEl, actions);

      const meta = document.createElement('div');
      meta.className = 'p3-card-meta';
      const pct =
        item.duration > 0 ? Math.min(100, Math.round((item.lastTime / item.duration) * 100)) : 0;
      const statusText = item.completed
        ? p3t('histCompleted')
        : `${p3t('histResumeAt')} ${formatTime(item.lastTime)}${item.duration ? ` / ${formatTime(item.duration)}` : ''}`;
      meta.textContent = `${statusText} · ${formatRelativeDate(item.lastPlayedAt, lang)}`;

      const barWrap = document.createElement('div');
      barWrap.className = 'p3-progress-track';
      const barFill = document.createElement('div');
      barFill.className = 'p3-progress-fill';
      barFill.style.width = `${item.completed ? 100 : pct}%`;
      barWrap.appendChild(barFill);

      row.append(top, meta, barWrap);

      const triggerPlay = () => playHistoryItem(item);
      row.addEventListener('click', triggerPlay);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerPlay();
        }
      });

      frag.appendChild(row);
    }

    dom.historyList.replaceChildren(frag);
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
     3. Media Library Rendering & Folder Management
     ------------------------------------------------------------------------- */
  function renderLibrary() {
    if (!dom.libList) return;
    const folders = libraryManager.getFolders();

    // Render folder chips
    if (dom.libFolderChips) {
      const chipFrag = document.createDocumentFragment();
      if (folders.length > 0) {
        const allChip = document.createElement('button');
        allChip.type = 'button';
        allChip.className = `p3-folder-chip${!uiState.libraryFolderFilter ? ' is-active' : ''}`;
        allChip.textContent = p3t('libAllFolders');
        allChip.addEventListener('click', () => {
          uiState.libraryFolderFilter = '';
          renderLibrary();
        });
        chipFrag.appendChild(allChip);

        for (const f of folders) {
          const wrap = document.createElement('div');
          wrap.className = `p3-folder-chip-wrap${uiState.libraryFolderFilter === f.path ? ' is-active' : ''}`;

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'p3-folder-chip-label';
          btn.textContent = `${f.name} (${f.items?.length || 0})`;
          btn.title = f.path;
          btn.addEventListener('click', () => {
            uiState.libraryFolderFilter = uiState.libraryFolderFilter === f.path ? '' : f.path;
            renderLibrary();
          });

          const rescanBtn = document.createElement('button');
          rescanBtn.type = 'button';
          rescanBtn.className = 'p3-chip-mini';
          rescanBtn.title = p3t('libRescan');
          rescanBtn.textContent = '↻';
          rescanBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            rescanLibraryFolder(f.path);
          });

          const remBtn = document.createElement('button');
          remBtn.type = 'button';
          remBtn.className = 'p3-chip-mini is-danger';
          remBtn.title = p3t('libRemoveFolder');
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
      empty.className = 'empty-state p3-empty';
      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = p3t('libEmptyTitle');
      const desc = document.createElement('div');
      desc.className = 'empty-desc';
      desc.textContent = p3t('libEmptyDesc');
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = p3t('libAddFolder');
      addBtn.addEventListener('click', () => addFolderToLibrary());
      empty.append(title, desc, addBtn);
      frag.appendChild(empty);
      dom.libList.replaceChildren(frag);
      updateCounts();
      return;
    }

    if (items.length === 0) {
      const noRes = document.createElement('div');
      noRes.className = 'no-results';
      noRes.textContent = p3t('savedNoMatch');
      frag.appendChild(noRes);
      dom.libList.replaceChildren(frag);
      updateCounts();
      return;
    }

    const lang = api.getLang();
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'p3-card';
      row.setAttribute('tabindex', '0');

      const top = document.createElement('div');
      top.className = 'p3-card-top';

      const badge = document.createElement('span');
      badge.className = `p3-kind-tag is-${item.kind}`;
      badge.textContent = item.kind === 'audio' ? 'AUD' : 'VID';

      const titleEl = document.createElement('div');
      titleEl.className = 'p3-card-title';
      titleEl.textContent = item.title;
      titleEl.title = item.fullPath || item.name;

      top.append(badge, titleEl);

      const meta = document.createElement('div');
      meta.className = 'p3-card-meta';
      const parts = [item.folderName];
      if (item.duration) parts.push(formatTime(item.duration));
      if (item.size) parts.push(formatBytes(item.size));
      if (item.mtimeMs) parts.push(formatRelativeDate(item.mtimeMs, lang));
      meta.textContent = parts.filter(Boolean).join(' · ');

      row.append(top, meta);

      const playLibItem = async () => {
        if (item.fullPath && api.desktopBridge && api.desktopBridge.inspectPaths) {
          try {
            await api.openExternalPathAtTime(item.fullPath, 0);
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
    }

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
      if (!res) return;
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
    if (dom.miniPlayerHud) dom.miniPlayerHud.hidden = !uiState.miniActive;
    if (dom.miniPlayerBtn) {
      dom.miniPlayerBtn.classList.toggle('is-active', uiState.miniActive);
      dom.miniPlayerBtn.setAttribute('aria-pressed', String(uiState.miniActive));
    }
    if (dom.miniPinBtn) {
      dom.miniPinBtn.classList.toggle('is-active', uiState.miniAlwaysOnTop);
      dom.miniPinBtn.setAttribute('aria-pressed', String(uiState.miniAlwaysOnTop));
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

  function syncMiniPlayerPlaybackUI() {
    if (!dom.miniPlayerHud) return;
    const track = api.getCurrentTrack();
    if (dom.miniTrackTitle) {
      dom.miniTrackTitle.textContent = track ? track.displayName || track.name : 'AAZ Player';
    }
    const isPaused = api.media.paused;
    if (dom.miniPlayIcon) dom.miniPlayIcon.style.display = isPaused ? '' : 'none';
    if (dom.miniPauseIcon) dom.miniPauseIcon.style.display = isPaused ? 'none' : '';
    if (dom.miniVolSlider) {
      dom.miniVolSlider.value = String(api.media.muted ? 0 : api.media.volume);
    }
    if (dom.miniMuteBtn) {
      dom.miniMuteBtn.classList.toggle('is-active', api.media.muted || api.media.volume === 0);
    }
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
        if (api.getSidebarTab() === 'history') renderHistory();
        else updateCounts();
      }
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
      }
      syncMiniPlayerPlaybackUI();
    });
    api.media.addEventListener('timeupdate', () => {
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
        if (api.getSidebarTab() === 'history') renderHistory();
      }
    });
    api.media.addEventListener('error', () => setBufferingVisible(false));

    // History controls (debounced search)
    let histSearchTimer = null;
    if (dom.historySearchInput) {
      dom.historySearchInput.addEventListener('input', (e) => {
        clearTimeout(histSearchTimer);
        histSearchTimer = setTimeout(() => {
          uiState.historySearch = e.target.value || '';
          renderHistory();
        }, 140);
      });
    }
    dom.historyFilterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.historyFilter = btn.dataset.histFilter || 'all';
        dom.historyFilterBtns.forEach((b) =>
          b.classList.toggle('is-active', b === btn)
        );
        renderHistory();
      });
    });
    if (dom.historyPauseBtn) {
      dom.historyPauseBtn.addEventListener('click', () => {
        const cur = settingsManager.get().recordWatchHistory;
        settingsManager.update({ recordWatchHistory: !cur });
        renderHistory();
        syncSettingsModalUI();
      });
    }
    if (dom.historyClearBtn) {
      dom.historyClearBtn.addEventListener('click', () => {
        if (historyManager.getEntries().length === 0) return;
        historyManager.clearAll();
        renderHistory();
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
        dom.libTypeBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
        renderLibrary();
      });
    });
    if (dom.libSortSelect) {
      dom.libSortSelect.addEventListener('change', (e) => {
        uiState.librarySort = e.target.value || 'name';
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
    if (dom.miniPinBtn) {
      dom.miniPinBtn.addEventListener('click', toggleMiniAlwaysOnTop);
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
    if (dom.miniDragBar && api.desktopBridge && api.desktopBridge.startWindowDrag) {
      dom.miniDragBar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        api.desktopBridge.startWindowDrag().catch(() => {});
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
    isCapturingShortcut: () => Boolean(uiState.capturingActionId),
    cancelShortcutCapture: () => {
      uiState.capturingActionId = null;
      uiState.pendingConflict = null;
      hideConflictBar();
    },
  };
}
