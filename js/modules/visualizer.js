/**
 * Hamza Visualizer Engine.
 *
 * Draws on a full-bleed canvas that sits BEHIND the audio-stage content (title, buttons), so the
 * visuals blend with the stage background instead of living in a boxed rectangle. All geometry is
 * computed from the real canvas size (centred, symmetric, DPR-aware) and the colours come from the
 * active theme/skin CSS variables (or an optional preset palette).
 *
 * The engine is framework-free: the player supplies callbacks for audio data and play state.
 */

export const VIZ_MODES = Object.freeze([
  'spectrum',
  'silk',
  'halo',
  'stereo',
  'led',
  'heat',
  'ripple',
  'off',
]);
export const VIZ_PALETTES = Object.freeze(['theme', 'aurora', 'sunset', 'ocean', 'mono']);
export const DEFAULT_VIZ_MODE = 'spectrum';
export const DEFAULT_VIZ_PREFS = Object.freeze({
  palette: 'theme',
  sensitivity: 1,
  showLogo: true,
});

const LEGACY_MODE_MAP = Object.freeze({ wave: 'silk', orb: 'halo' });

/** Accepts current ids, maps legacy ids (wave/orb), falls back to the default. */
export function sanitizeVizMode(mode) {
  const raw = typeof mode === 'string' ? mode.trim() : '';
  const mapped = LEGACY_MODE_MAP[raw] || raw;
  return VIZ_MODES.includes(mapped) ? mapped : DEFAULT_VIZ_MODE;
}

export function sanitizeVizPrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sens = Number(src.sensitivity);
  return {
    palette: VIZ_PALETTES.includes(src.palette) ? src.palette : DEFAULT_VIZ_PREFS.palette,
    sensitivity: Number.isFinite(sens) ? Math.min(1.6, Math.max(0.5, sens)) : 1,
    showLogo: src.showLogo === false ? false : true,
  };
}

/** Log-spaced FFT bin ranges for `n` bands between ~40 Hz and ~16 kHz. */
export function computeBandRanges(n, binCount, sampleRate) {
  const count = Math.max(1, Math.floor(n));
  const bins = Math.max(2, Math.floor(binCount));
  const sr = sampleRate > 8000 ? sampleRate : 48000;
  const hzPerBin = sr / 2 / bins;
  const f0 = 40;
  const f1 = Math.min(16000, (sr / 2) * 0.92);
  const ranges = [];
  for (let i = 0; i < count; i++) {
    const a = f0 * Math.pow(f1 / f0, i / count);
    const b = f0 * Math.pow(f1 / f0, (i + 1) / count);
    const lo = Math.min(bins - 1, Math.max(0, Math.floor(a / hzPerBin)));
    const hi = Math.min(bins, Math.max(lo + 1, Math.floor(b / hzPerBin)));
    ranges.push([lo, hi]);
  }
  return ranges;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgba = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

const PRESET_PALETTES = {
  aurora: { lo: [32, 201, 151], mid: [64, 224, 208], hi: [167, 139, 250], cap: [224, 255, 240] },
  sunset: { lo: [244, 114, 61], mid: [251, 146, 60], hi: [244, 114, 182], cap: [254, 240, 138] },
  ocean: { lo: [14, 116, 144], mid: [34, 211, 238], hi: [129, 140, 248], cap: [224, 242, 254] },
  mono: { lo: [148, 163, 184], mid: [226, 232, 240], hi: [255, 255, 255], cap: [255, 255, 255] },
};

function createColorParser() {
  let ctx = null;
  return (value, fallback) => {
    if (!value || typeof document === 'undefined') return fallback;
    try {
      if (!ctx) {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 1;
        ctx = c.getContext('2d', { willReadFrequently: true });
      }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#010203';
      ctx.fillStyle = String(value).trim();
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      if (d[3] === 0) return fallback;
      return [d[0], d[1], d[2]];
    } catch {
      return fallback;
    }
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rad);
    return;
  }
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas              Full-bleed canvas (position:absolute behind the stage content).
 * @param {HTMLElement} [opts.hero]                    Element holding the title/buttons; visuals avoid its area.
 * @param {() => ({freq:Uint8Array|null,freqL?:Uint8Array|null,freqR?:Uint8Array|null,sampleRate?:number}|null)} opts.getSources
 *        Must refresh the analyser byte arrays and return them (or null when no audio graph).
 * @param {() => boolean} opts.isPlaying
 * @param {() => boolean} [opts.isVisible]
 * @param {string} [opts.logoUrl]
 */
export function createVisualizer(opts) {
  const { canvas, hero = null, getSources, isPlaying } = opts;
  const isVisible = opts.isVisible || (() => true);
  const parseColor = createColorParser();

  let mode = DEFAULT_VIZ_MODE;
  let prefs = { ...DEFAULT_VIZ_PREFS };
  let rafId = null;
  let destroyed = false;
  let lastColorKey = '';
  let colors = null;
  const reducedMotionQuery =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  /* ---------- logo ---------- */
  let logo = null;
  let logoReady = false;
  if (opts.logoUrl && typeof Image !== 'undefined') {
    logo = new Image();
    logo.decoding = 'async';
    logo.onload = () => {
      logoReady = true;
      if (!rafId) renderIdle();
    };
    logo.onerror = () => {
      logoReady = false;
    };
    logo.src = opts.logoUrl;
  }

  /* ---------- smoothing / caches ---------- */
  const levelCache = new Map();
  const capCache = new Map();
  const rangeCache = new Map();
  let bassEnv = 0;
  let bassAvg = 0;
  let lastBeatAt = -10;
  let beatPulse = 0;
  const ripples = [];
  let lastAutoRipple = 0;

  const heat = { canvas: null, ctx: null, cols: 220, rows: 110, lut: null, lutKey: '', acc: 0, lastT: 0 };

  function arr(cache, key, n) {
    let a = cache.get(key);
    if (!a || a.length !== n) {
      a = new Float32Array(n);
      cache.set(key, a);
    }
    return a;
  }

  function ranges(n, bins, sr) {
    const key = `${n}|${bins}|${Math.round(sr)}`;
    let r = rangeCache.get(key);
    if (!r) {
      r = computeBandRanges(n, bins, sr);
      rangeCache.set(key, r);
    }
    return r;
  }

  /** Smoothed [0..1] levels for `n` log bands. data===null -> synthetic idle/breathing levels. */
  function bandsFrom(key, n, data, sampleRate, S) {
    const out = arr(levelCache, key, n);
    if (data && data.length > 1) {
      const rs = ranges(n, data.length, sampleRate);
      for (let i = 0; i < n; i++) {
        const [lo, hi] = rs[i];
        let sum = 0;
        let peak = 0;
        for (let b = lo; b < hi; b++) {
          const v = data[b];
          sum += v;
          if (v > peak) peak = v;
        }
        const avg = sum / Math.max(1, hi - lo);
        let v = (0.55 * avg + 0.45 * peak) / 255;
        v = Math.pow(v, 1.3) * (0.8 + 0.55 * (i / n)) * prefs.sensitivity * 1.15;
        v = clamp(v, 0, 1);
        const prev = out[i];
        out[i] = v > prev ? lerp(prev, v, 0.75) : prev * 0.88 + v * 0.12;
      }
      return out;
    }
    for (let i = 0; i < n; i++) {
      const p = i / Math.max(1, n - 1);
      const shape = 1 - 0.55 * p;
      const target = S.playing
        ? 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(S.t * 2.1 + i * 0.5)) * shape
        : 0.05 + 0.045 * shape;
      out[i] = lerp(out[i], target, S.playing ? 0.12 : 1);
    }
    return out;
  }

  /* ---------- colours ---------- */
  function refreshColors() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const isLight = root.getAttribute('data-theme') === 'light';
    const key = `${prefs.palette}|${root.getAttribute('data-skin') || ''}|${isLight ? 'l' : 'd'}`;
    if (colors && key === lastColorKey) return;
    lastColorKey = key;
    const cs = getComputedStyle(root);
    const accent = parseColor(cs.getPropertyValue('--accent'), [61, 196, 121]);
    const gold = parseColor(cs.getPropertyValue('--gold'), [224, 190, 114]);
    let lo;
    let mid;
    let hi;
    let cap;
    if (prefs.palette !== 'theme' && PRESET_PALETTES[prefs.palette]) {
      const p = PRESET_PALETTES[prefs.palette];
      lo = p.lo;
      mid = p.mid;
      hi = p.hi;
      cap = p.cap;
      if (isLight) {
        lo = mix(lo, [0, 0, 0], 0.3);
        mid = mix(mid, [0, 0, 0], 0.25);
        hi = mix(hi, [0, 0, 0], 0.2);
        cap = mix(cap, [0, 0, 0], 0.4);
      }
    } else if (isLight) {
      lo = mix(accent, [0, 0, 0], 0.35);
      mid = accent;
      hi = mix(accent, [255, 255, 255], 0.18);
      cap = mix(gold, [0, 0, 0], 0.18);
    } else {
      lo = mix(accent, [0, 0, 0], 0.42);
      mid = accent;
      hi = mix(accent, [255, 255, 255], 0.55);
      cap = gold;
    }
    colors = { lo, mid, hi, cap, isLight, bg: parseColor(cs.getPropertyValue('--bg-canvas'), [6, 11, 8]) };
    heat.lutKey = '';
  }

  function colorAt(t) {
    const c = colors;
    if (t < 0.5) return mix(c.lo, c.mid, t * 2);
    return mix(c.mid, c.hi, (t - 0.5) * 2);
  }

  /* ---------- geometry ---------- */
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let heroInset = 0;

  function measure() {
    const rect = canvas.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const w = Math.max(0, Math.floor(cssW * dpr));
    const h = Math.max(0, Math.floor(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    heroInset = 0;
    if (hero) {
      const hr = hero.getBoundingClientRect();
      if (hr.height > 0 && cssH > 0) {
        // Visuals live above the text block (title / buttons overlay the lower part).
        heroInset = clamp(rect.bottom - hr.top, 0, cssH * 0.55);
      }
    }
    return w > 0 && h > 0;
  }

  /* ---------- frame ---------- */
  function buildState(forceIdle) {
    const reduced = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
    const playing = !forceIdle && !reduced && isPlaying();
    const S = {
      playing,
      reduced,
      t: playing ? performance.now() / 1000 : 0,
      hasData: false,
      src: null,
      beat: false,
    };
    if (playing) {
      let src = null;
      try {
        src = getSources();
      } catch {
        src = null;
      }
      if (src && src.freq && src.freq.length > 1) {
        S.src = src;
        S.hasData = true;
      }
    }
    const sr = (S.src && S.src.sampleRate) || 48000;
    S.sampleRate = sr;
    S.bands = (n, key = 'b') => bandsFrom(`${key}${n}`, n, S.hasData ? S.src.freq : null, sr, S);
    S.bandsL = (n, key = 'l') =>
      bandsFrom(`${key}${n}`, n, S.hasData && S.src.freqL ? S.src.freqL : S.hasData ? S.src.freq : null, sr, S);
    S.bandsR = (n, key = 'r') => {
      let data = S.hasData ? S.src.freq : null;
      if (S.hasData && S.src.freqR) {
        // Mono sources leave the R analyser silent: mirror L so both sides stay alive.
        let sumR = 0;
        let sumL = 0;
        const r = S.src.freqR;
        const l = S.src.freqL || S.src.freq;
        for (let i = 0; i < r.length; i += 4) {
          sumR += r[i];
          sumL += l[i];
        }
        data = sumR < sumL * 0.04 ? l : r;
      }
      return bandsFrom(`${key}${n}`, n, data, sr, S);
    };
    S.caps = (key, n) => arr(capCache, `${key}${n}`, n);

    // Bass envelope + simple beat detector (drives halo/ripple pulses).
    const low = S.bands(24, 'bass');
    let bass = 0;
    for (let i = 0; i < 5; i++) bass += low[i];
    bass /= 5;
    bassEnv = Math.max(bass, bassEnv * 0.9);
    bassAvg = lerp(bassAvg, bass, 0.04);
    if (playing && S.hasData && bass > 0.3 && bass > bassAvg * 1.28 && S.t - lastBeatAt > 0.22) {
      lastBeatAt = S.t;
      S.beat = true;
      beatPulse = 1;
    } else {
      beatPulse *= 0.9;
    }
    S.bass = bassEnv;
    S.pulse = beatPulse;
    return S;
  }

  function render(forceIdle) {
    if (destroyed) return;
    if (!measure()) return;
    refreshColors();
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    if (mode === 'off') return;

    const S = buildState(forceIdle);
    const areaH = Math.max(h * 0.42, h - heroInset * dpr);
    const c = { ctx, w, h, dpr, areaH, S, colors };
    ctx.save();
    switch (mode) {
      case 'silk':
        drawSilk(c);
        break;
      case 'halo':
        drawHalo(c);
        break;
      case 'stereo':
        drawStereo(c);
        break;
      case 'led':
        drawLed(c);
        break;
      case 'heat':
        drawHeat(c);
        break;
      case 'ripple':
        drawRipple(c);
        break;
      default:
        drawSpectrum(c);
    }
    ctx.restore();
  }

  /* ---------- styles ---------- */
  function vGrad(ctx, y0, y1, stops) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    stops.forEach(([o, col, a]) => g.addColorStop(o, rgba(col, a)));
    return g;
  }

  function drawSpectrum({ ctx, w, areaH, dpr, S, colors: pal }) {
    const bars = clamp(2 * Math.round(w / (15 * dpr) / 2), 24, 96);
    const half = bars / 2;
    const lv = S.bands(half, 'spec');
    const caps = S.caps('spec', half);
    const gap = Math.max(2 * dpr, w * 0.0035);
    const usable = w * 0.9;
    const barW = Math.max(2 * dpr, (usable - gap * (bars - 1)) / bars);
    const total = bars * barW + gap * (bars - 1);
    const x0 = (w - total) / 2;
    const baseY = areaH * 0.9;
    const maxH = areaH * 0.74;

    ctx.strokeStyle = (() => {
      const g = ctx.createLinearGradient(x0, 0, x0 + total, 0);
      g.addColorStop(0, rgba(pal.mid, 0));
      g.addColorStop(0.5, rgba(pal.mid, 0.4));
      g.addColorStop(1, rgba(pal.mid, 0));
      return g;
    })();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(x0, baseY);
    ctx.lineTo(x0 + total, baseY);
    ctx.stroke();

    const barGrad = vGrad(ctx, baseY, baseY - maxH, [
      [0, pal.lo, 0.8],
      [0.55, pal.mid, 0.95],
      [1, pal.hi, 1],
    ]);
    const refH = maxH * 0.3;
    const refGrad = vGrad(ctx, baseY + 2 * dpr, baseY + refH, [
      [0, pal.mid, 0.22],
      [1, pal.mid, 0],
    ]);
    const center = (bars - 1) / 2;

    for (let i = 0; i < bars; i++) {
      const idx = i < half ? half - 1 - i : i - half;
      const level = lv[idx];
      caps[idx] = Math.max(level, caps[idx] - 0.011);
      const edge = 1 - 0.6 * Math.pow(Math.abs(i - center) / (bars / 2), 2);
      const bh = Math.max(barW * 0.9, level * maxH);
      const x = x0 + i * (barW + gap);

      ctx.globalAlpha = edge;
      ctx.fillStyle = barGrad;
      roundRectPath(ctx, x, baseY - bh, barW, bh, barW / 2);
      ctx.fill();

      const capY = baseY - Math.max(bh + 5 * dpr, caps[idx] * maxH + 4 * dpr);
      ctx.fillStyle = rgba(pal.cap, 0.9);
      roundRectPath(ctx, x, capY, barW, Math.max(2 * dpr, barW * 0.35), barW / 4);
      ctx.fill();

      const rh = Math.min(refH, bh * 0.34);
      ctx.fillStyle = refGrad;
      roundRectPath(ctx, x, baseY + 2 * dpr, barW, rh, barW / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSilk({ ctx, w, areaH, dpr, S, colors: pal }) {
    const lv = S.bands(24, 'silk');
    const cy = areaH * 0.5;
    const amp = areaH * 0.3;
    const pts = 72;
    const t = S.t;
    const additive = !pal.isLight;
    if (additive) ctx.globalCompositeOperation = 'lighter';
    const layers = [
      { f: 1.0, sp: 0.55, ph: 0.0, k: 1.0, lw: 2.6, a: 0.9, c: pal.hi, fill: 0.1 },
      { f: 1.35, sp: -0.7, ph: 1.2, k: 0.85, lw: 2.0, a: 0.7, c: pal.mid, fill: 0.08 },
      { f: 0.8, sp: 0.4, ph: 2.4, k: 0.7, lw: 1.8, a: 0.55, c: pal.mid, fill: 0.06 },
      { f: 1.8, sp: -0.9, ph: 3.1, k: 0.5, lw: 1.4, a: 0.45, c: pal.lo, fill: 0 },
      { f: 2.3, sp: 1.1, ph: 4.0, k: 0.38, lw: 1.1, a: 0.35, c: pal.cap, fill: 0 },
    ];
    for (const L of layers) {
      const xs = new Float32Array(pts);
      const ys = new Float32Array(pts);
      for (let i = 0; i < pts; i++) {
        const p = i / (pts - 1);
        const env = Math.pow(Math.sin(Math.PI * p), 0.85);
        const d = Math.abs(p - 0.5) * 2;
        const li = lv[Math.min(lv.length - 1, Math.floor(d * (lv.length - 1)))];
        const level = 0.14 + li * 1.15 * L.k;
        const y =
          cy +
          Math.sin(p * Math.PI * 2 * L.f * 1.6 + t * L.sp * 2.2 + L.ph) * amp * env * level +
          Math.sin(p * Math.PI * 5.2 - t * L.sp * 1.4 + L.ph) * amp * 0.16 * env * (0.2 + S.bass);
        xs[i] = p * w;
        ys[i] = y;
      }
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < pts - 1; i++) {
        const mx = (xs[i] + xs[i + 1]) / 2;
        const my = (ys[i] + ys[i + 1]) / 2;
        ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
      }
      ctx.lineTo(xs[pts - 1], ys[pts - 1]);
      const stroke = ctx.createLinearGradient(0, 0, w, 0);
      stroke.addColorStop(0, rgba(L.c, 0));
      stroke.addColorStop(0.18, rgba(L.c, L.a));
      stroke.addColorStop(0.82, rgba(L.c, L.a));
      stroke.addColorStop(1, rgba(L.c, 0));
      ctx.strokeStyle = stroke;
      ctx.lineWidth = L.lw * dpr;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      if (L.fill > 0) {
        ctx.lineTo(xs[pts - 1], cy);
        ctx.lineTo(xs[0], cy);
        ctx.closePath();
        ctx.fillStyle = rgba(L.c, L.fill);
        ctx.fill();
      }
    }
  }

  function drawLogo(ctx, cx, cy, size, alpha = 1) {
    if (!prefs.showLogo || !logo || !logoReady) return false;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetY = size * 0.04;
    ctx.drawImage(logo, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
    return true;
  }

  function drawHalo({ ctx, w, areaH, dpr, S, colors: pal }) {
    const unit = Math.min(w * 0.9, areaH);
    const cx = w / 2;
    const cy = areaH * 0.5;
    const R = unit * 0.225 * (1 + S.pulse * 0.05 + S.bass * 0.04);
    const maxRay = unit * 0.2;
    const spokes = 120;
    const lv = S.bands(spokes / 2, 'halo');
    if (!pal.isLight) ctx.globalCompositeOperation = 'lighter';

    const glow = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R + maxRay * 1.5);
    glow.addColorStop(0, rgba(pal.mid, 0.18 + S.bass * 0.18));
    glow.addColorStop(1, rgba(pal.mid, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R + maxRay * 1.5, 0, Math.PI * 2);
    ctx.fill();

    const spin = S.playing ? S.t * 0.12 : 0;
    ctx.lineCap = 'round';
    const rayW = Math.max(2 * dpr, ((Math.PI * 2 * R) / spokes) * 0.5);
    ctx.lineWidth = rayW;
    for (let i = 0; i < spokes; i++) {
      const sym = i < spokes / 2 ? i : spokes - 1 - i; // mirrored left/right: bass at top, treble at bottom
      const lvl = lv[sym];
      const ang = (i / spokes) * Math.PI * 2 - Math.PI / 2;
      const len = rayW * 0.9 + lvl * maxRay;
      const r0 = R + 6 * dpr;
      ctx.strokeStyle = rgba(colorAt(sym / (spokes / 2)), 0.45 + lvl * 0.55);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
      ctx.stroke();
    }

    // Slowly rotating tick ring + crisp inner ring
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = rgba(pal.mid, 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(pal.hi, 0.35);
    ctx.setLineDash([2 * dpr, 7 * dpr]);
    ctx.lineDashOffset = -spin * 60 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalCompositeOperation = 'source-over';
    drawLogo(ctx, cx, cy, R * 1.36 * (1 + S.pulse * 0.04));
  }

  function drawStereo({ ctx, w, areaH, dpr, S, colors: pal }) {
    const perSide = clamp(Math.round(w / (2 * 22 * dpr)), 12, 36);
    const lvL = S.bandsL(perSide, 'stL');
    const lvR = S.bandsR(perSide, 'stR');
    const capsL = S.caps('stL', perSide);
    const capsR = S.caps('stR', perSide);
    const centerGap = Math.max(18 * dpr, w * 0.05);
    const sideW = (w * 0.9 - centerGap) / 2;
    const gap = Math.max(2 * dpr, sideW * 0.012);
    const barW = Math.max(2 * dpr, (sideW - gap * (perSide - 1)) / perSide);
    const baseY = areaH * 0.9;
    const maxH = areaH * 0.72;
    const leftStart = w / 2 - centerGap / 2 - sideW; // bass sits next to the centre gap
    const rightStart = w / 2 + centerGap / 2;
    const grad = vGrad(ctx, baseY, baseY - maxH, [
      [0, pal.lo, 0.8],
      [0.6, pal.mid, 0.95],
      [1, pal.hi, 1],
    ]);

    for (let i = 0; i < perSide; i++) {
      const lh = Math.max(barW * 0.9, lvL[i] * maxH);
      const rh = Math.max(barW * 0.9, lvR[i] * maxH);
      capsL[i] = Math.max(lvL[i], capsL[i] - 0.011);
      capsR[i] = Math.max(lvR[i], capsR[i] - 0.011);
      const fade = 1 - 0.5 * (i / perSide);
      ctx.globalAlpha = fade;
      ctx.fillStyle = grad;
      // left channel: bass nearest the centre, highs toward the outer edge
      const xl = leftStart + (perSide - 1 - i) * (barW + gap);
      roundRectPath(ctx, xl, baseY - lh, barW, lh, barW / 2);
      ctx.fill();
      const xr = rightStart + i * (barW + gap);
      roundRectPath(ctx, xr, baseY - rh, barW, rh, barW / 2);
      ctx.fill();
      ctx.fillStyle = rgba(pal.cap, 0.85);
      roundRectPath(ctx, xl, baseY - Math.max(lh + 5 * dpr, capsL[i] * maxH + 4 * dpr), barW, Math.max(2 * dpr, barW * 0.3), barW / 4);
      ctx.fill();
      roundRectPath(ctx, xr, baseY - Math.max(rh + 5 * dpr, capsR[i] * maxH + 4 * dpr), barW, Math.max(2 * dpr, barW * 0.3), barW / 4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(pal.mid, 0.7);
    ctx.font = `700 ${Math.round(11 * dpr)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText('L', leftStart + sideW, baseY + 7 * dpr);
    ctx.textAlign = 'left';
    ctx.fillText('R', rightStart, baseY + 7 * dpr);
  }

  function drawLed({ ctx, w, areaH, dpr, S, colors: pal }) {
    const cols = clamp(Math.round((w * 0.86) / (22 * dpr)), 16, 48);
    const lv = S.bands(cols, 'led');
    const caps = S.caps('led', cols);
    const gapX = Math.max(3 * dpr, w * 0.004);
    const usable = w * 0.86;
    const colW = Math.max(3 * dpr, (usable - gapX * (cols - 1)) / cols);
    const total = cols * colW + gapX * (cols - 1);
    const x0 = (w - total) / 2;
    const cellH = Math.max(4 * dpr, Math.min(colW * 0.55, 11 * dpr));
    const gapY = Math.max(2 * dpr, cellH * 0.35);
    const baseY = areaH * 0.9;
    const rows = clamp(Math.floor((areaH * 0.72) / (cellH + gapY)), 8, 22);

    for (let c = 0; c < cols; c++) {
      caps[c] = Math.max(lv[c], caps[c] - 0.014);
      const lit = Math.max(1, Math.round(lv[c] * rows));
      const capRow = Math.min(rows - 1, Math.floor(caps[c] * rows));
      const x = x0 + c * (colW + gapX);
      for (let r = 0; r < rows; r++) {
        const y = baseY - (r + 1) * cellH - r * gapY;
        const frac = r / (rows - 1);
        if (r === capRow && capRow >= lit && caps[c] > 0.1) {
          ctx.fillStyle = rgba(pal.cap, 0.95);
        } else if (r < lit) {
          ctx.fillStyle = rgba(colorAt(frac), 0.92);
        } else {
          ctx.fillStyle = rgba(pal.mid, 0.035 * (1 - frac * 0.6));
        }
        roundRectPath(ctx, x, y, colW, cellH, Math.min(colW, cellH) * 0.28);
        ctx.fill();
      }
    }
  }

  function ensureHeat() {
    if (heat.canvas) return;
    heat.canvas = document.createElement('canvas');
    heat.canvas.width = heat.cols;
    heat.canvas.height = heat.rows;
    heat.ctx = heat.canvas.getContext('2d', { willReadFrequently: true });
  }

  function buildHeatLut() {
    const key = lastColorKey;
    if (heat.lut && heat.lutKey === key) return;
    heat.lutKey = key;
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let col;
      let a;
      if (v < 0.35) {
        col = mix(colors.lo, colors.mid, v / 0.35);
        a = Math.pow(v / 0.35, 1.5) * 0.75;
      } else if (v < 0.75) {
        col = mix(colors.mid, colors.hi, (v - 0.35) / 0.4);
        a = 0.75 + ((v - 0.35) / 0.4) * 0.2;
      } else {
        col = mix(colors.hi, colors.cap, (v - 0.75) / 0.25);
        a = 0.95;
      }
      lut[i * 4] = col[0];
      lut[i * 4 + 1] = col[1];
      lut[i * 4 + 2] = col[2];
      lut[i * 4 + 3] = Math.round(a * 255);
    }
    heat.lut = lut;
  }

  function drawHeat({ ctx, w, areaH, dpr, S }) {
    ensureHeat();
    buildHeatLut();
    const hctx = heat.ctx;
    if (S.playing) {
      // Frame-rate independent scroll: ~44 columns per second
      const dt = heat.lastT ? Math.min(0.1, Math.max(0, S.t - heat.lastT)) : 0.016;
      heat.lastT = S.t;
      heat.acc += dt * 44;
      const steps = Math.min(6, Math.floor(heat.acc));
      heat.acc -= steps;
      if (steps > 0) {
        const lv = S.bands(heat.rows, 'heat');
        hctx.globalCompositeOperation = 'copy';
        hctx.drawImage(heat.canvas, -steps, 0);
        hctx.globalCompositeOperation = 'source-over';
        const col = hctx.createImageData(steps, heat.rows);
        for (let sx = 0; sx < steps; sx++) {
          for (let r = 0; r < heat.rows; r++) {
            const v = lv[heat.rows - 1 - r]; // bass at the bottom
            const idx = Math.min(255, Math.max(0, Math.round(v * 255))) * 4;
            const o = (r * steps + sx) * 4;
            col.data[o] = heat.lut[idx];
            col.data[o + 1] = heat.lut[idx + 1];
            col.data[o + 2] = heat.lut[idx + 2];
            col.data[o + 3] = heat.lut[idx + 3];
          }
        }
        hctx.putImageData(col, heat.cols - steps, 0);
      }
    } else {
      heat.lastT = 0;
    }
    const top = areaH * 0.05;
    const height = areaH * 0.88;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(heat.canvas, 0, 0, heat.cols, heat.rows, 0, top, w, height);
    ctx.globalAlpha = 1;
    // Feather the edges so the map melts into the stage background
    ctx.globalCompositeOperation = 'destination-out';
    const fadeV = ctx.createLinearGradient(0, top, 0, top + height);
    fadeV.addColorStop(0, 'rgba(0,0,0,1)');
    fadeV.addColorStop(0.18, 'rgba(0,0,0,0)');
    fadeV.addColorStop(0.8, 'rgba(0,0,0,0)');
    fadeV.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = fadeV;
    ctx.fillRect(0, top, w, height);
    const fadeH = ctx.createLinearGradient(0, 0, w, 0);
    fadeH.addColorStop(0, 'rgba(0,0,0,1)');
    fadeH.addColorStop(0.16, 'rgba(0,0,0,0)');
    fadeH.addColorStop(0.84, 'rgba(0,0,0,0)');
    fadeH.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = fadeH;
    ctx.fillRect(0, top, w, height);
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawRipple({ ctx, w, areaH, dpr, S, colors: pal }) {
    const unit = Math.min(w * 0.9, areaH);
    const cx = w / 2;
    const cy = areaH * 0.5;
    const R = unit * 0.17 * (1 + S.pulse * 0.07);
    const maxR = unit * 0.5;
    if (!pal.isLight) ctx.globalCompositeOperation = 'lighter';

    if (S.playing) {
      if (S.beat || S.t - lastAutoRipple > (S.hasData ? 2.4 : 1.3)) {
        ripples.push({ r: R * 1.05, a: 0.9, v: 0.8 + S.bass * 1.6 });
        lastAutoRipple = S.t;
        if (ripples.length > 9) ripples.shift();
      }
      for (const rp of ripples) {
        rp.r += rp.v * dpr * (unit / 520);
        rp.a *= 0.985;
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (ripples[i].r > R + maxR || ripples[i].a < 0.02) ripples.splice(i, 1);
    }
    if (!S.playing && ripples.length === 0) {
      ripples.push({ r: R * 1.6, a: 0.35, v: 0 }, { r: R * 2.2, a: 0.2, v: 0 });
    }
    for (const rp of ripples) {
      const k = clamp((rp.r - R) / maxR, 0, 1);
      ctx.strokeStyle = rgba(colorAt(k), rp.a * (1 - k));
      ctx.lineWidth = Math.max(1, (3.2 - 2.4 * k) * dpr);
      ctx.beginPath();
      ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    const ticks = 72;
    const lv = S.bands(ticks / 2, 'rip');
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2 * dpr, ((Math.PI * 2 * R) / ticks) * 0.45);
    for (let i = 0; i < ticks; i++) {
      const sym = i < ticks / 2 ? i : ticks - 1 - i;
      const ang = (i / ticks) * Math.PI * 2 - Math.PI / 2;
      const len = 3 * dpr + lv[sym] * unit * 0.07;
      const r0 = R + 5 * dpr;
      ctx.strokeStyle = rgba(colorAt(sym / (ticks / 2)), 0.5 + lv[sym] * 0.5);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
      ctx.stroke();
    }
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    glow.addColorStop(0, rgba(pal.mid, 0.22 + S.pulse * 0.2));
    glow.addColorStop(1, rgba(pal.mid, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    drawLogo(ctx, cx, cy, R * 1.5 * (1 + S.pulse * 0.06));
  }

  /* ---------- loop / lifecycle ---------- */
  function tick() {
    rafId = null;
    if (destroyed) return;
    if (!isPlaying() || !isVisible() || mode === 'off') {
      renderIdle();
      return;
    }
    render(false);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId !== null || destroyed) return;
    if (mode === 'off' || !isVisible()) {
      renderIdle();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    renderIdle();
  }

  function renderIdle() {
    if (destroyed) return;
    render(true);
  }

  function resize() {
    if (rafId === null) renderIdle();
  }

  function setMode(next) {
    const clean = sanitizeVizMode(next);
    if (clean === mode) return mode;
    mode = clean;
    ripples.length = 0;
    if (rafId === null) {
      if (isPlaying() && isVisible() && mode !== 'off') start();
      else renderIdle();
    }
    return mode;
  }

  function setPrefs(partial) {
    prefs = sanitizeVizPrefs({ ...prefs, ...(partial || {}) });
    lastColorKey = '';
    colors = null;
    if (rafId === null) renderIdle();
    return { ...prefs };
  }

  // Keep the picture correct when the stage resizes / theme or skin changes.
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    if (hero) resizeObserver.observe(hero);
  }
  let themeObserver = null;
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      lastColorKey = '';
      colors = null;
      if (rafId === null) renderIdle();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin'],
    });
  }

  return {
    setMode,
    getMode: () => mode,
    setPrefs,
    getPrefs: () => ({ ...prefs }),
    start,
    stop,
    renderIdle,
    resize,
    isRunning: () => rafId !== null,
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      if (resizeObserver) resizeObserver.disconnect();
      if (themeObserver) themeObserver.disconnect();
    },
  };
}
