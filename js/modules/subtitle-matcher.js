/**
 * Shared Subtitle Candidate Matching & Language Preference Scoring (F12).
 *
 * Honors `defaultSubtitleLang` ('auto' | 'ar' | 'en') alongside `uiLang` ('ar' | 'en').
 * Strict invariant: episode number and title compatibility ALWAYS outweigh language tags
 * so a preferred language tag can NEVER cause an unrelated episode's subtitle to be selected.
 */

import { stripExtension } from '../utils/file-utils.js';

const SUB_NOISE = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hd', 'sd', 'hdr', 'hdr10',
  'bluray', 'bdrip', 'brrip', 'webrip', 'webdl', 'web', 'dl', 'hdtv', 'dvdrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', '10bit', 'aac', 'ac3', 'dts',
  'yts', 'yify', 'rarbg', 'nf', 'amzn',
  'ar', 'ara', 'arabic', 'en', 'eng', 'english',
  'sub', 'subs', 'subtitle', 'subtitles', 'sdh', 'hi', 'forced', 'cc', 'default',
]);

const SUB_LANG_SUFFIX =
  /(?:[._\-\s\[(]+(?:ar|ara|arabic|en|eng|english|sdh|hi|forced|cc|sub|subs|default)[\])]*)+\s*$/i;
const SUB_ARABIC_RE =
  /(?:^|[._\-\s\[(])(ar|ara|arabic|عربي|عربية|ترجمة)(?:$|[._\-\s\])])/i;
const SUB_ENGLISH_RE =
  /(?:^|[._\-\s\[(])(en|eng|english)(?:$|[._\-\s\])])/i;
const SUB_EP_RE = /\b(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|ep?\s*\d{1,3})\b/i;

export function normalizeSubtitleMediaName(name) {
  const noExt = stripExtension(String(name || ''));
  const stripped = noExt.replace(SUB_LANG_SUFFIX, '').trim();
  return (stripped || noExt)
    .toLowerCase()
    .replace(/[._\-\[\](){}+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSubtitleEpisodeTag(norm) {
  const m = String(norm || '').match(SUB_EP_RE);
  if (!m) return '';
  return m[1]
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^ep(\d)/, 'e$1');
}

export function detectSubtitleLanguageTag(filename) {
  const stem = stripExtension(String(filename || ''));
  if (SUB_ARABIC_RE.test(stem)) return 'ar';
  if (SUB_ENGLISH_RE.test(stem)) return 'en';
  return 'unknown';
}

export function resolveEffectiveSubtitleLang(preferredLang = 'auto', uiLang = 'en') {
  if (preferredLang === 'ar') return 'ar';
  if (preferredLang === 'en') return 'en';
  return uiLang === 'ar' ? 'ar' : 'en';
}

function normalizeDirPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^fs:/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function getDirFromKeyOrPath(str) {
  const norm = normalizeDirPath(str);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(0, idx) : '';
}

/**
 * Selects the highest-scoring matching subtitle from a map/iterable of loaded subtitles.
 *
 * @param {object} track - Current video track ({ key, name, fullPath, folderPath })
 * @param {Map<string, object>} subtitlesByBaseKey
 * @param {{ preferredLang?: string, uiLang?: string, videosInSameDir?: number }} [options]
 */
export function selectBestSubtitleCandidate(track, subtitlesByBaseKey, options = {}) {
  if (!track || !subtitlesByBaseKey || subtitlesByBaseKey.size === 0) return null;

  const preferredLang = options.preferredLang || 'auto';
  const uiLang = options.uiLang === 'ar' ? 'ar' : 'en';
  const targetLang = resolveEffectiveSubtitleLang(preferredLang, uiLang);
  const videosInSameDir = Number.isFinite(options.videosInSameDir) ? options.videosInSameDir : 1;

  const vRaw = stripExtension(track.name || '').toLowerCase();
  const vNorm = normalizeSubtitleMediaName(track.name || '');
  const vEp = extractSubtitleEpisodeTag(vNorm);
  const vTokens = new Set(vNorm.split(' ').filter((w) => w.length > 1 && !SUB_NOISE.has(w)));
  const trackDir = track.fullPath
    ? getDirFromKeyOrPath(track.fullPath)
    : normalizeDirPath(track.folderPath || getDirFromKeyOrPath(track.key || ''));

  let bestEntry = null;
  let bestScore = 0;

  for (const [baseKey, subEntry] of subtitlesByBaseKey.entries()) {
    if (!subEntry) continue;
    const subName = subEntry.name || String(baseKey).split('/').pop() || String(baseKey);
    const sRaw = stripExtension(subName).toLowerCase();
    const subDir = subEntry.fullPath
      ? getDirFromKeyOrPath(subEntry.fullPath)
      : getDirFromKeyOrPath(baseKey);

    let dirPenalty = 0;
    if (subDir === trackDir) {
      dirPenalty = 0;
    } else if (trackDir && subDir.startsWith(`${trackDir}/`)) {
      dirPenalty = 20;
    } else if (!trackDir && /^(subs?|subtitles?|arabic|ar|en|cc)(\/|$)/i.test(subDir)) {
      dirPenalty = 20;
    } else if (trackDir && trackDir.startsWith(`${subDir}/`)) {
      dirPenalty = 50;
    } else {
      dirPenalty = 85;
    }

    const sNorm = normalizeSubtitleMediaName(subName);
    const sEp = extractSubtitleEpisodeTag(sNorm);

    // Hard episode mismatch guard: NEVER match a different episode regardless of language tag
    if (vEp && sEp && vEp !== sEp) {
      continue;
    }

    let score = 0;
    if (vRaw && sRaw && vRaw === sRaw) {
      score = 1000;
    } else if (vNorm && sNorm && vNorm === sNorm) {
      score = 960;
    } else if (
      vNorm &&
      sNorm &&
      (sNorm.startsWith(vNorm) || vNorm.startsWith(sNorm)) &&
      Math.min(vNorm.length, sNorm.length) >= 4
    ) {
      score = 840;
    } else if (
      vNorm &&
      sNorm &&
      (vNorm.includes(sNorm) || sNorm.includes(vNorm)) &&
      Math.min(vNorm.length, sNorm.length) >= 5
    ) {
      score = 780;
    } else {
      const sTokens = new Set(sNorm.split(' ').filter((w) => w.length > 1 && !SUB_NOISE.has(w)));
      let overlap = 0;
      for (const tok of sTokens) {
        if (vTokens.has(tok)) overlap += 1;
      }

      if (vEp && sEp && vEp === sEp) {
        score = overlap > 0 ? 790 + Math.min(60, overlap * 15) : 700;
      } else if (vTokens.size > 0 && sTokens.size > 0 && overlap > 0) {
        const ratio = (2 * overlap) / (vTokens.size + sTokens.size);
        if (ratio >= 0.48 || (overlap >= 2 && overlap / Math.min(vTokens.size, sTokens.size) >= 0.65)) {
          score = Math.round(520 + ratio * 240);
        }
      }
    }

    if (score === 0 && videosInSameDir <= 1 && dirPenalty <= 25 && subtitlesByBaseKey.size <= 4) {
      // Only use sole-video fallback if the subtitle does not belong to a conflicting episode
      if (!(vEp && sEp && vEp !== sEp)) {
        score = 420;
      }
    }
    if (score === 0) continue;

    // Language preference bonus: strong enough to pick between same-episode ar/en tracks
    // (including preferring movie.ar.srt over generic movie.srt when preferredLang is explicit),
    // yet small enough that it NEVER beats a higher-confidence match tier for a different file.
    const subLang = detectSubtitleLanguageTag(subName);
    if (subLang === targetLang) {
      score += preferredLang === 'auto' ? 45 : 65;
    } else if (subLang !== 'unknown' && subLang !== targetLang) {
      score -= preferredLang === 'auto' ? 10 : 20;
    }

    const finalScore = score - dirPenalty;
    if (finalScore >= 380 && finalScore > bestScore) {
      bestScore = finalScore;
      bestEntry = subEntry;
    }
  }

  return bestEntry;
}
