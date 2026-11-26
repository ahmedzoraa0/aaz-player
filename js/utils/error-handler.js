/**
 * Centralized bilingual Error Handling utility for Hamza (Phase 2 Task 3).
 *
 * Translates low-level browser, MediaError, filesystem, subtitle, playlist,
 * DLNA/Cast, and updater exceptions into clear, actionable user-facing messages
 * without exposing raw stack traces or internal system details.
 */

export const ErrorCategory = Object.freeze({
  MEDIA_LOAD: 'media_load',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  SUBTITLE: 'subtitle',
  PLAYLIST: 'playlist',
  NETWORK_DLNA: 'network_dlna',
  FILE_ACCESS: 'file_access',
  UPDATE: 'update',
  STORAGE: 'storage',
  AUDIO_OUTPUT: 'audio_output',
});

const MESSAGES = {
  en: {
    [ErrorCategory.MEDIA_LOAD]: 'Could not load this media file. It may be moved, corrupted, or in an unsupported codec.',
    [ErrorCategory.UNSUPPORTED_FORMAT]: 'This media format or codec is not supported by your playback engine.',
    [ErrorCategory.SUBTITLE]: 'Could not load subtitle file. Please verify it is a valid .SRT or .VTT file.',
    [ErrorCategory.PLAYLIST]: 'Could not import playlist. The file appears empty or improperly formatted.',
    [ErrorCategory.NETWORK_DLNA]: 'Network casting failed. Ensure your TV or device is on the same local Wi-Fi network.',
    [ErrorCategory.FILE_ACCESS]: 'Could not access the selected file or folder. Please check permissions or re-open it.',
    [ErrorCategory.UPDATE]: 'Update check or installation failed. Please verify your internet connection and try again.',
    [ErrorCategory.STORAGE]: 'Could not save settings locally. Browser storage may be full or restricted.',
    [ErrorCategory.AUDIO_OUTPUT]: 'Selected audio output device is unavailable. Switched back to System Default Output.',
    mediaAborted: 'Media loading was interrupted before completion.',
    mediaNetwork: 'A network or local stream error interrupted playback.',
    mediaDecode: 'Could not decode this media file. The codec or file structure may be damaged.',
    mediaSrcNotSupported: 'This file format or audio/video codec is not supported.',
    backupInvalid: 'Invalid backup file. Please choose a valid همزة JSON backup.',
    unknown: 'An unexpected playback error occurred.',
  },
  ar: {
    [ErrorCategory.MEDIA_LOAD]: 'تعذر تحميل ملف الوسائط. ربما تم نقله أو تلفه أو أن الترميز غير مدعوم.',
    [ErrorCategory.UNSUPPORTED_FORMAT]: 'صيغة الوسائط أو الترميز غير مدعوم بواسطة مشغل الوسائط.',
    [ErrorCategory.SUBTITLE]: 'تعذر تحميل ملف الترجمة. تأكد أنه ملف .SRT أو .VTT سليم.',
    [ErrorCategory.PLAYLIST]: 'تعذر استيراد قائمة التشغيل. الملف فارغ أو غير صالح.',
    [ErrorCategory.NETWORK_DLNA]: 'فشل البث عبر الشبكة المحلية. تأكد أن التلفاز والجهاز على نفس شبكة الواي فاي.',
    [ErrorCategory.FILE_ACCESS]: 'تعذر الوصول إلى الملف أو المجلد المحدد. تحقق من الصلاحيات أو أعد فتحه.',
    [ErrorCategory.UPDATE]: 'تعذر التحقق من التحديثات أو تثبيتها. تحقق من الاتصال بالإنترنت وحاول مجدداً.',
    [ErrorCategory.STORAGE]: 'تعذر حفظ الإعدادات محلياً. ربما امتلأت مساحة التخزين أو تم تقييدها.',
    [ErrorCategory.AUDIO_OUTPUT]: 'جهاز إخراج الصوت المحدد غير متاح حالياً. تم الرجوع تلقائياً إلى مخرج النظام الافتراضي.',
    mediaAborted: 'تم إيقاف تحميل الوسائط قبل اكتماله.',
    mediaNetwork: 'حدث خطأ في البث أو الشبكة أثناء التشغيل.',
    mediaDecode: 'تعذر فك ترميز هذا الملف. قد يكون الترميز غير مدعوم أو الملف تالفاً.',
    mediaSrcNotSupported: 'صيغة هذا الملف أو ترميز الصوت/الفيديو غير مدعوم.',
    backupInvalid: 'ملف النسخة الاحتياطية غير صالح. يرجى اختيار ملف JSON صحيح خاص بـ همزة.',
    unknown: 'حدث خطأ غير متوقع أثناء التشغيل.',
  },
};

export function mapMediaElementError(mediaError, lang = 'en') {
  const dict = MESSAGES[lang === 'ar' ? 'ar' : 'en'];
  const code = mediaError && typeof mediaError.code === 'number' ? mediaError.code : 0;
  switch (code) {
    case 1:
      return dict.mediaAborted;
    case 2:
      return dict.mediaNetwork;
    case 3:
      return dict.mediaDecode;
    case 4:
      return dict.mediaSrcNotSupported;
    default:
      return dict[ErrorCategory.MEDIA_LOAD];
  }
}

export function formatUserError(category, error, lang = 'en', detail = '') {
  const dict = MESSAGES[lang === 'ar' ? 'ar' : 'en'];
  const raw =
    typeof error === 'string'
      ? error
      : error && typeof error.message === 'string'
        ? error.message
        : '';

  // Map well-known safe backend errors without leaking internal stack traces
  const lower = raw.toLowerCase();
  if (category === ErrorCategory.NETWORK_DLNA) {
    if (lower.includes('no_lan_ip') || lower.includes('no private local network')) {
      return lang === 'ar'
        ? 'لم يتم العثور على عنوان شبكة محلية (واي فاي أو LAN). اتصل بشبكة محلية أولاً لبدء البث.'
        : 'No local Wi-Fi or LAN IPv4 address was detected. Connect to a local network to cast.';
    }
    if (lower.includes('lan_bind_failed') || lower.includes('bind local streaming')) {
      return lang === 'ar'
        ? 'تعذر بدء خادم البث على محوّل الشبكة المحلية. تحقق من إعدادات الشبكة وجدار الحماية.'
        : 'Could not bind the local streaming server to your LAN adapter. Check network or firewall settings.';
    }
    if (lower.includes('private') || lower.includes('local lan') || lower.includes('not a discovered')) {
      return lang === 'ar'
        ? 'تم حظر عنوان البث لأسباب أمنية — يُسمح فقط بأجهزة الشبكة المحلية.'
        : 'Cast target blocked for security — only local LAN devices are permitted.';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return lang === 'ar'
        ? 'انتهت مهلة الاتصال بالجهاز. تأكد أن الجهاز قيد التشغيل وعلى نفس الشبكة.'
        : 'Connection to the cast device timed out. Make sure it is powered on and on the same network.';
    }
  }

  if (category === ErrorCategory.UPDATE) {
    if (lower.includes('signature') || lower.includes('minisig') || lower.includes('signing public key')) {
      return lang === 'ar'
        ? 'تم رفض التحديث لعدم وجود توقيع رقمي موثوق أو فشله في التحقق. تم إلغاء التثبيت لحمايتك.'
        : 'Update refused: missing or invalid cryptographic signature. Installation was aborted for your safety.';
    }
    if (lower.includes('checksum') || lower.includes('sha-256') || lower.includes('digest')) {
      return lang === 'ar'
        ? 'فشل التحقق الأمني من ملف التحديث (غياب أو عدم تطابق SHA-256). تم إلغاء التثبيت لحمايتك.'
        : 'Update integrity check failed (missing or mismatched SHA-256). Installation was aborted for your safety.';
    }
    if (lower.includes('https') || lower.includes('untrusted') || lower.includes('host')) {
      return lang === 'ar'
        ? 'تم رفض رابط التحديث لأنه لا ينتمي لمصدر GitHub الموثوق.'
        : 'Update URL was rejected because it is not from the trusted GitHub release host.';
    }
  }

  if (category === ErrorCategory.FILE_ACCESS) {
    if (lower.includes('not found') || lower.includes('no such file') || lower.includes('missing')) {
      return lang === 'ar'
        ? 'الملف غير موجود في المسار المحفوظ. ربما تم نقله أو حذفه.'
        : 'File was not found at its saved location. It may have been moved or deleted.';
    }
  }

  const base = dict[category] || dict.unknown;
  if (detail) {
    const cleanDetail = String(detail).slice(0, 120);
    return `${base} (${cleanDetail})`;
  }
  return base;
}

export function createErrorHandler({ showToast, getLang }) {
  return {
    log(context, error) {
      const label = context ? `[AAZ:${context}]` : '[AAZ]';
      if (error !== undefined && error !== null) {
        console.warn(label, error);
      } else {
        console.warn(label);
      }
    },
    notify(category, error, detail = '') {
      const lang = typeof getLang === 'function' ? getLang() : 'en';
      const userMsg = formatUserError(category, error, lang, detail);
      if (error) {
        console.warn(`[AAZ Error:${category}]`, error);
      }
      if (typeof showToast === 'function') {
        showToast(userMsg, 'error');
      }
      return userMsg;
    },
    notifyMediaError(mediaError, trackTitle = '') {
      const lang = typeof getLang === 'function' ? getLang() : 'en';
      const base = mapMediaElementError(mediaError, lang);
      const msg = trackTitle ? `${base} — ${String(trackTitle).slice(0, 60)}` : base;
      console.warn('[AAZ MediaError]', mediaError);
      if (typeof showToast === 'function') {
        showToast(msg, 'error');
      }
      return msg;
    },
    notifyMessage(key, fallback = '') {
      const lang = typeof getLang === 'function' ? getLang() : 'en';
      const dict = MESSAGES[lang === 'ar' ? 'ar' : 'en'];
      const msg = dict[key] || fallback || dict.unknown;
      if (typeof showToast === 'function') {
        showToast(msg, 'error');
      }
      return msg;
    },
  };
}
