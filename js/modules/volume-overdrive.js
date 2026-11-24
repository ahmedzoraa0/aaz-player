/**
 * Volume Overdrive (100%..200%) staging.
 *
 * HTMLMediaElement.volume is capped at 1.0 by the web platform, so real
 * amplification above 100% must happen in a Web Audio gain stage. The staging
 * here is deliberately conservative and fully testable in Node:
 *
 * - Slider 0..1 maps straight to the media element volume (graph untouched).
 * - Slider 1..2 keeps the element at 1.0 and routes the signal through a
 *   WaveShaperNode whose curve is `ceiling * tanh(gain * x / ceiling)`:
 *   small-signal gain ~= the requested gain (real amplification), while peaks
 *   are smoothly limited so the output can never hard-clip past the ceiling,
 *   no matter how hot the source material is.
 *
 * This is a soft limiter, NOT hearing protection: above 100% the sound can be
 * uncomfortably loud on headphones and hot material will audibly compress or
 * distort. The UI says so; no safety is promised. OVERDRIVE_CEILING defines
 * the measured peak ceiling the tests verify against synthesized audio.
 */

export const MAX_VOLUME = 2;
export const OVERDRIVE_CEILING = 0.98;

export function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_VOLUME, Math.max(0, n));
}

/**
 * Split a slider value (0..2) into the element volume and the overdrive gain.
 */
export function resolveVolumeStages(value) {
  const clamped = clampVolume(value);
  const overdrive = clamped > 1;
  return {
    clamped,
    elementVolume: overdrive ? 1 : clamped,
    gain: overdrive ? clamped : 1,
    overdrive,
  };
}

/**
 * Soft-knee ceiling function shared by the WaveShaper curve and the tests.
 * Small-signal slope at x=0 equals `gain`; output is bounded by +/- ceiling
 * for any input in [-1, 1] (inputs beyond are clamped by the WaveShaper to
 * the curve endpoints, which are themselves within +/- ceiling).
 */
export function applyOverdriveCurve(x, gain, ceiling = OVERDRIVE_CEILING) {
  const g = Math.max(1, Number(gain) || 1);
  return ceiling * Math.tanh((g * Number(x || 0)) / ceiling);
}

/**
 * Build the WaveShaperNode curve for a requested overdrive gain.
 */
export function makeOverdriveCurve(gain, ceiling = OVERDRIVE_CEILING, size = 2048) {
  const n = Math.max(256, Math.floor(size));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = applyOverdriveCurve(x, gain, ceiling);
  }
  return curve;
}
