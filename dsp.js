/*
 * The measurement, with no opinions on top of it.
 *
 * Two jobs, and they are deliberately separate:
 *
 *   - Look at a stretch of audio and say what frequencies are in it. That is
 *     the FFT and the peak-finding, and it is ordinary.
 *
 *   - Follow one narrow band of it through time and say how fast its loudness
 *     is rising and falling. That is `trajectory` and `detectBeat`, and it is
 *     the actual point of this app.
 *
 * The second one is worth a word. When two partials a few cycles apart are
 * added together, the sum gets loud and quiet at exactly their difference —
 * that rising and falling *is* the beat, the same thing the ear hears. So the
 * app does not try to measure two frequencies and subtract them. It listens to
 * one band and counts how often it swells, which is both closer to what a
 * technician is doing and far more tolerant of a noisy room.
 *
 * (The subtracting method is also here, as `splitPair`, but only as a second
 * opinion. Two independent methods agreeing is worth more than either alone.)
 */
(function (global) {
  "use strict";

  const TAU = 2 * Math.PI;

  /* --- FFT --------------------------------------------------------------- */

  const twiddleCache = new Map();

  /*
   * Twiddle factors for a transform of length `n`, computed once per length.
   *
   * Built as a table rather than accumulated by repeated complex multiplication
   * inside the butterfly loops. At the sizes used here — 65536 points, so 32768
   * multiplications deep in the last stage — accumulated rounding is visible in
   * the result, and the whole reason for a window this long is to separate two
   * partials a couple of hertz apart.
   */
  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      const half = n >> 1;
      const cos = new Float64Array(half);
      const sin = new Float64Array(half);
      for (let i = 0; i < half; i++) {
        const a = (-TAU * i) / n;
        cos[i] = Math.cos(a);
        sin[i] = Math.sin(a);
      }
      t = { cos: cos, sin: sin };
      twiddleCache.set(n, t);
    }
    return t;
  }

  /** In-place complex FFT. `n` must be a power of two. */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    const t = twiddles(n);
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const stride = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const c = t.cos[k * stride];
          const s = t.sin[k * stride];
          const a = i + k;
          const b = a + half;
          const vr = re[b] * c - im[b] * s;
          const vi = re[b] * s + im[b] * c;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
        }
      }
    }
  }

  const windowCache = new Map();

  /*
   * Hann. Chosen for its sidelobes rather than its main lobe: a piano note's
   * partials differ in strength by a factor of hundreds, and a window that lets
   * a loud partial leak across the spectrum will put a convincing false peak
   * right where a quiet one was meant to be.
   */
  function hann(n) {
    let w = windowCache.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (n - 1));
      windowCache.set(n, w);
    }
    return w;
  }

  /*
   * Amplitude at each bin of `len` samples starting at `start`.
   *
   * Scaled so a sinusoid of amplitude A reads A at its own bin, give or take
   * the scalloping loss that `peakNear` then undoes.
   */
  function magnitudes(samples, start, len) {
    const w = hann(len);
    const re = new Float64Array(len);
    const im = new Float64Array(len);
    let norm = 0;
    for (let i = 0; i < len; i++) {
      re[i] = (samples[start + i] || 0) * w[i];
      norm += w[i];
    }
    fft(re, im);
    const half = len >> 1;
    const out = new Float64Array(half);
    const scale = 2 / norm;
    for (let i = 0; i < half; i++) out[i] = Math.hypot(re[i], im[i]) * scale;
    return out;
  }

  /*
   * The strongest peak between two frequencies, to better than bin resolution.
   *
   * A peak almost never sits on a bin centre, so the three bins around the
   * largest are fitted with a parabola. On a clean partial this is good to a
   * small fraction of a bin, which matters because everything downstream is
   * pointed at the frequency this returns.
   */
  function peakNear(mags, binHz, loHz, hiHz) {
    const lo = Math.max(1, Math.ceil(loHz / binHz));
    const hi = Math.min(mags.length - 2, Math.floor(hiHz / binHz));
    if (hi < lo) return null;
    let best = lo;
    for (let i = lo; i <= hi; i++) if (mags[i] > mags[best]) best = i;
    const a = mags[best - 1];
    const b = mags[best];
    const c = mags[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
    const d = Math.abs(shift) < 1 ? shift : 0;
    return {
      hz: (best + d) * binHz,
      amp: b - 0.25 * (a - c) * d,
      bin: best,
    };
  }

  /*
   * A level the spectrum sits at when nothing in particular is happening.
   *
   * The median rather than the mean, so the partials themselves — which are the
   * loud minority — do not raise the floor they are being measured against.
   */
  function noiseFloor(mags) {
    const copy = Array.prototype.slice.call(mags);
    copy.sort(function (x, y) { return x - y; });
    return copy[copy.length >> 1] || 0;
  }

  /* --- following one band through time ----------------------------------- */

  /*
   * Follow the amplitude and phase of whatever sits near `hz`, frame by frame.
   *
   * Multiplying the signal by an oscillator at `hz` and averaging over a window
   * leaves exactly what one FFT bin would have carried, without computing the
   * thousands of bins that would be thrown away. Cheap enough to do two hundred
   * times a second, which is what makes it possible to watch a band swell and
   * fade rather than take one still photograph of it.
   *
   * `frameLen` sets how wide the band is: the first null of a Hann window falls
   * at 2*sampleRate/frameLen either side of `hz`. That number has to come out
   * below the spacing of the lower note's partials, or the partial next door
   * joins in and beats against everything. `frameLenFor` works it out.
   */
  function trajectory(samples, start, count, sampleRate, hz, frameLen, hop) {
    const w = hann(frameLen);
    let norm = 0;
    for (let i = 0; i < frameLen; i++) norm += w[i];
    norm /= 2; // a real signal splits its energy across ±frequency
    if (norm <= 0) return null;

    const step = (TAU * hz) / sampleRate;
    const cosT = new Float64Array(frameLen);
    const sinT = new Float64Array(frameLen);
    for (let i = 0; i < frameLen; i++) {
      cosT[i] = Math.cos(-step * i) * w[i];
      sinT[i] = Math.sin(-step * i) * w[i];
    }

    const frames = Math.floor((count - frameLen) / hop) + 1;
    if (frames < 8) return null;
    const t = new Float64Array(frames);
    const mag = new Float64Array(frames);
    const re = new Float64Array(frames);
    const im = new Float64Array(frames);

    for (let j = 0; j < frames; j++) {
      const at = start + j * hop;
      let sr = 0;
      let si = 0;
      for (let i = 0; i < frameLen; i++) {
        const x = samples[at + i];
        sr += x * cosT[i];
        si += x * sinT[i];
      }
      // Refer phase to one clock shared by every frame, not to the frame's own
      // start, so successive looks can be compared with each other.
      const p = -step * (j * hop);
      const c = Math.cos(p);
      const s = Math.sin(p);
      t[j] = (j * hop) / sampleRate;
      re[j] = (sr * c - si * s) / norm;
      im[j] = (sr * s + si * c) / norm;
      mag[j] = Math.hypot(re[j], im[j]);
    }
    return { t: t, mag: mag, re: re, im: im, rate: sampleRate / hop };
  }

  /*
   * How long a frame has to be to keep the neighbours out.
   *
   * The band must be narrower than the gap between the lower note's partials,
   * which is its fundamental. Comfortably narrower, hence the 2.2 rather than
   * 2 — leakage does not stop dead at the first null.
   */
  function frameLenFor(sampleRate, spacingHz) {
    const want = Math.round((2.2 * sampleRate) / Math.max(40, spacingHz));
    return Math.min(4096, Math.max(256, 1 << Math.ceil(Math.log2(want))));
  }

  /* --- counting the beat -------------------------------------------------- */

  /*
   * Slowest and fastest beat worth looking for.
   *
   * The fast end is set by the piano rather than by the arithmetic: a minor
   * third at the top of the temperament octave beats past fourteen times a
   * second, and thirds higher up are faster still. Anything past about twenty
   * has stopped being a beat you could count and become roughness.
   */
  const BEAT_MIN_HZ = 0.3;
  const BEAT_MAX_HZ = 22.0;

  /*
   * Cycles that must fit in the window before a rate is believable.
   *
   * Two and a half rather than one and a half, which was the earlier figure and
   * was too generous. A single rise and fall is what a note does anyway as it is
   * struck and decays; it takes several before the thing can be called a beat
   * rather than an envelope. The cost is that the slow intervals need a longer
   * listen, which they were going to need regardless.
   */
  const MIN_BEAT_CYCLES = 2.5;

  /* Smallest swell that counts, in natural-log amplitude — about 12 percent. */
  const MIN_BEAT_DEPTH = 0.1;

  /*
   * Share of the wobble one rate must account for before the reading goes on the
   * display as a number rather than as a shrug.
   *
   * Set from recordings of a real piano rather than from synthetic tones, which
   * is why it is not higher. On made-up notes a beat explains eighty or ninety
   * percent of what is there and a strict threshold costs nothing. On a real
   * grand — three strings a note, a room, the rest of the instrument ringing in
   * sympathy — a perfectly good reading explains forty to seventy, and a
   * threshold set from the synthetic figures would refuse to show most of them.
   *
   * Graded against known rates on real recordings, everything above this line
   * came out within two tenths of a beat and everything well below it was out by
   * one or more, which is the split this number exists to make.
   */
  const CLEAN_ENOUGH = 0.4;

  /*
   * Subtract the best-fitting parabola, leaving whatever wobbles faster than
   * the note's own envelope does.
   */
  function detrend(t, y, n) {
    let mt = 0;
    for (let i = 0; i < n; i++) mt += t[i];
    mt /= n;
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, sy = 0, sxy = 0, sx2y = 0;
    for (let i = 0; i < n; i++) {
      const x = t[i] - mt;
      const x2 = x * x;
      s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
      sy += y[i]; sxy += x * y[i]; sx2y += x2 * y[i];
    }
    // [ n  s1 s2 ][c0]   [ sy  ]
    // [ s1 s2 s3 ][c1] = [ sxy ]
    // [ s2 s3 s4 ][c2]   [ sx2y]
    const m = [n, s1, s2, s1, s2, s3, s2, s3, s4];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7])
              - m[1] * (m[3] * m[8] - m[5] * m[6])
              + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (!isFinite(det) || Math.abs(det) < 1e-18) return null;
    const v = [sy, sxy, sx2y];
    const c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a = m.slice();
      a[k] = v[0]; a[k + 3] = v[1]; a[k + 6] = v[2];
      c[k] = (a[0] * (a[4] * a[8] - a[5] * a[7])
            - a[1] * (a[3] * a[8] - a[5] * a[6])
            + a[2] * (a[3] * a[7] - a[4] * a[6])) / det;
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = t[i] - mt;
      out[i] = y[i] - (c[0] + c[1] * x + c[2] * x * x);
    }
    return out;
  }

  /*
   * Find the rate at which a band's loudness rises and falls.
   *
   * Works on the logarithm of the amplitude, where a piano note's decay is a
   * straight line and can be taken out by subtracting one. What is left is the
   * beat, plus whatever else was going on.
   *
   * Returns the rate, how much of the leftover wobble that one rate accounts
   * for, and how deep the swell is. A rate that explains only part of what it
   * sees is not a reading, and the caller is expected to treat it as one only
   * if `explained` is high.
   */
  function detectBeat(traj, opts) {
    opts = opts || {};
    const minHz = opts.minHz || BEAT_MIN_HZ;
    const maxHz = opts.maxHz || BEAT_MAX_HZ;
    const t = traj.t;
    const mag = traj.mag;
    const n = mag.length;
    if (n < 16) return null;

    let peak = 0;
    for (let i = 0; i < n; i++) if (mag[i] > peak) peak = mag[i];
    if (!(peak > 0)) return null;

    // Two evenly matched partials cancel almost completely at the bottom of
    // each beat. Left alone those nulls run to negative infinity in the log and
    // swamp everything else, so they are clipped — which also keeps the shape
    // closer to a sinusoid and stops its own harmonics competing for the answer.
    const floor = peak * 0.05;
    const logs = new Float64Array(n);
    for (let i = 0; i < n; i++) logs[i] = Math.log(Math.max(mag[i], floor));

    // Remove the envelope.
    //
    // A decaying string is a straight line in this domain, and a straight line
    // was what an earlier version subtracted. It was not enough: a struck note
    // does not decay evenly — it is still settling at the start and its several
    // strings drift apart as it goes — and the slow bend that leaves behind
    // piles up at the bottom of the search, where it was duly reported as a very
    // slow beat. A parabola takes the bend with it. It cannot take a real beat
    // with it, because by the time a rate is allowed to be reported at all it
    // has been through two and a half cycles, and no parabola fits that.
    const resid = detrend(t, logs, n);
    if (!resid) return null;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += resid[i] * resid[i];
    if (energy <= 1e-12) return null; // perfectly steady: one note, or one that sounds like it

    const span = t[n - 1] - t[0];
    if (!(span > 0)) return null;
    const ceiling = Math.min(maxHz, traj.rate / 2);
    // Claiming a rate from less than a couple of cycles is indistinguishable
    // from claiming the note got quieter and then slightly less quiet, so how
    // slow we may look is set by how long we watched.
    const bottom = Math.max(minHz, MIN_BEAT_CYCLES / span);
    if (bottom >= ceiling) return null;

    function strengthAt(f) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const a = TAU * f * t[i];
        re += resid[i] * Math.cos(a);
        im -= resid[i] * Math.sin(a);
      }
      return (2 * Math.hypot(re, im)) / n;
    }

    const steps = 400;
    let bestHz = bottom;
    let bestAmp = 0;
    for (let i = 0; i <= steps; i++) {
      const f = bottom + ((ceiling - bottom) * i) / steps;
      const a = strengthAt(f);
      if (a > bestAmp) { bestAmp = a; bestHz = f; }
    }
    // Sharpen the winner. The coarse grid is only about a twentieth of a beat
    // wide, which is the same size as the accuracy being claimed on screen.
    const grid = (ceiling - bottom) / steps;
    for (let i = -20; i <= 20; i++) {
      const f = bestHz + (grid * i) / 20;
      if (f < bottom || f > ceiling) continue;
      const a = strengthAt(f);
      if (a > bestAmp) { bestAmp = a; bestHz = f; }
    }

    // Half of a beat rate is always a candidate for the answer, because a swell
    // that is deep and peaked rather than smooth carries energy at twice its own
    // rate, and that harmonic can be the larger of the two. Getting this wrong
    // reports a seven-beat third as a fourteen-beat one, which is worse than
    // reporting nothing, so the subharmonic is checked explicitly and preferred
    // whenever it holds a decent share of the strength.
    const halfHz = bestHz / 2;
    if (halfHz >= bottom) {
      let hAmp = 0;
      let hHz = halfHz;
      for (let i = -20; i <= 20; i++) {
        const f = halfHz + (grid * i) / 10;
        if (f < bottom || f > ceiling) continue;
        const a = strengthAt(f);
        if (a > hAmp) { hAmp = a; hHz = f; }
      }
      if (hAmp > 0.55 * bestAmp) { bestAmp = hAmp; bestHz = hHz; }
    }

    const explained = Math.min(1, (n * bestAmp * bestAmp) / 2 / energy);
    // A winner sitting on the bottom of the range is not a measurement of
    // anything. It means the slowest rate we were willing to look for was the
    // best available, which is what happens when the real beat is slower still —
    // and reporting the bottom of one's own search as a result is the most
    // confident way to be wrong. The caller is expected to listen for longer.
    const atFloor = bestHz < bottom * 1.08;
    return {
      hz: bestHz,
      explained: explained,
      depth: bestAmp,
      floorHz: bottom,
      atFloor: atFloor,
      clean: !atFloor && explained > CLEAN_ENOUGH && bestAmp > MIN_BEAT_DEPTH,
      residual: resid,
    };
  }

  /*
   * The strongest rate that is not the one already found, nor a harmonic of it.
   *
   * A note with its own unison out beats in the same band as the interval does,
   * and the two are not distinguishable by ear at the moment you most need them
   * to be. They are distinguishable here: two separate rates, both strong. When
   * that happens the honest thing is to say the unison needs attention rather
   * than to report whichever came out larger.
   */
  function secondRate(traj, found, opts) {
    opts = opts || {};
    const maxHz = opts.maxHz || BEAT_MAX_HZ;
    const t = traj.t;
    const n = traj.mag.length;
    const resid = found.residual;
    const span = t[n - 1] - t[0];
    const bottom = Math.max(opts.minHz || BEAT_MIN_HZ, MIN_BEAT_CYCLES / span);
    const ceiling = Math.min(maxHz, traj.rate / 2);

    function near(f, g) { return Math.abs(f - g) < Math.max(0.6, 0.12 * g); }

    let bestHz = 0;
    let bestAmp = 0;
    const steps = 400;
    for (let i = 0; i <= steps; i++) {
      const f = bottom + ((ceiling - bottom) * i) / steps;
      if (near(f, found.hz) || near(f, 2 * found.hz) || near(f, 3 * found.hz)) continue;
      let re = 0;
      let im = 0;
      for (let k = 0; k < n; k++) {
        const a = TAU * f * t[k];
        re += resid[k] * Math.cos(a);
        im -= resid[k] * Math.sin(a);
      }
      const amp = (2 * Math.hypot(re, im)) / n;
      if (amp > bestAmp) { bestAmp = amp; bestHz = f; }
    }
    return bestAmp > 0 ? { hz: bestHz, depth: bestAmp } : null;
  }

  /*
   * The second opinion: separate the two partials outright and subtract them.
   *
   * Only possible when they are far enough apart for the window to tell them
   * apart, which for a window of a second and a half means about three beats a
   * second — every third and every sixth, but no fourth or fifth. Where it does
   * work it is completely independent of the method above, because it uses
   * where the energy is and not how it changes, so the two agreeing rules out
   * most of the ways either could be fooled.
   */
  function splitPair(mags, binHz, centreHz, spanHz) {
    const lo = Math.max(1, Math.floor((centreHz - spanHz) / binHz));
    const hi = Math.min(mags.length - 2, Math.ceil((centreHz + spanHz) / binHz));
    if (hi - lo < 6) return null;

    const peaks = [];
    for (let i = lo + 1; i < hi; i++) {
      if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) {
        const a = mags[i - 1];
        const b = mags[i];
        const c = mags[i + 1];
        const denom = a - 2 * b + c;
        const d = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
        peaks.push({ hz: (i + (Math.abs(d) < 1 ? d : 0)) * binHz, amp: b });
      }
    }
    if (peaks.length < 2) return null;
    peaks.sort(function (p, q) { return q.amp - p.amp; });
    const first = peaks[0];
    // The second must be a genuine neighbour, not the skirt of the first.
    let second = null;
    for (let i = 1; i < peaks.length; i++) {
      const gap = Math.abs(peaks[i].hz - first.hz);
      if (gap >= 2.5 * binHz && peaks[i].amp > 0.12 * first.amp) { second = peaks[i]; break; }
    }
    if (!second) return null;
    return {
      hz: Math.abs(first.hz - second.hz),
      lower: Math.min(first.hz, second.hz),
      upper: Math.max(first.hz, second.hz),
      balance: Math.min(first.amp, second.amp) / first.amp,
    };
  }

  global.DSP = {
    TAU: TAU,
    fft: fft,
    hann: hann,
    magnitudes: magnitudes,
    peakNear: peakNear,
    noiseFloor: noiseFloor,
    trajectory: trajectory,
    frameLenFor: frameLenFor,
    detectBeat: detectBeat,
    secondRate: secondRate,
    splitPair: splitPair,
    BEAT_MIN_HZ: BEAT_MIN_HZ,
    BEAT_MAX_HZ: BEAT_MAX_HZ,
  };
})(typeof window !== "undefined" ? window : globalThis);
