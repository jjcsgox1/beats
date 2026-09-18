/*
 * Made-up piano notes, so the measurement can be graded.
 *
 * The point of this file is that it knows the answer. An interval built here
 * beats at a rate we chose, to as many decimal places as we like, so when the
 * app reads 6.43 the question of whether that is right has an actual answer
 * rather than an opinion.
 *
 * These tones are not meant to sound convincing. They are meant to have the
 * features that break a beat counter: stiff partials that sit sharp of where
 * the arithmetic puts them, partials that decay at different rates, three
 * strings per note that are never quite together, and a noise floor.
 */
(function (global) {
  "use strict";

  const TAU = 2 * Math.PI;

  /** Where partial `n` of a stiff string actually sits. */
  function partialHz(f0, b, n) {
    return n * f0 * Math.sqrt(1 + b * n * n);
  }

  /*
   * One note. `strings` slightly detuned copies, `spreadCents` how far apart —
   * a unison that is not quite together, which is the commonest reason a real
   * interval reading goes wrong.
   */
  function note(out, sampleRate, opts) {
    const f0 = opts.f0;
    const b = opts.b || 0;
    const partials = opts.partials || 10;
    const amp = opts.amp === undefined ? 1 : opts.amp;
    const strings = opts.strings || 1;
    const spread = opts.spreadCents || 0;
    // Roughly what a tenor string does: the fundamental takes many seconds to
    // fade and the partials above it go a little faster. An earlier version of
    // this file killed the upper partials within a second or two, which made
    // every test a test of what the app does with a note that has already gone.
    const decay = opts.decay === undefined ? 0.35 : opts.decay;
    const phase = opts.phase || 0;

    for (let s = 0; s < strings; s++) {
      // Spread them evenly around the centre, so the note's pitch is unchanged.
      const off = strings === 1 ? 0 : spread * (s / (strings - 1) - 0.5);
      const sf0 = f0 * Math.pow(2, off / 1200);
      for (let n = 1; n <= partials; n++) {
        const hz = partialHz(sf0, b, n);
        if (hz > sampleRate * 0.45) break;
        // Quieter and shorter-lived as they go up, which is what a string does.
        const a = (amp / strings) * Math.pow(n, -1.2);
        const d = decay * (1 + 0.12 * (n - 1));
        const w = TAU * hz;
        const p = phase + 0.7 * n + 1.3 * s;
        for (let i = 0; i < out.length; i++) {
          const t = i / sampleRate;
          out[i] += a * Math.exp(-d * t) * Math.sin(w * t + p);
        }
      }
    }
    return out;
  }

  /*
   * An interval whose beat rate we chose.
   *
   * The upper note is not placed at some interval in cents and its beat rate
   * measured afterwards — it is placed *so that* the coincident partials come
   * out exactly `beatHz` apart. Solve the upper fundamental from where its
   * partial has to land and the answer is exact by construction, stiffness and
   * all.
   */
  function interval(sampleRate, seconds, opts) {
    const iv = global.Intervals.interval(opts.semitones);
    if (!iv) throw new Error("no such interval: " + opts.semitones);
    const bLow = opts.bLow || 0;
    const bHigh = opts.bHigh === undefined ? bLow : opts.bHigh;

    const lowPartial = partialHz(opts.lowHz, bLow, iv.low);
    const wantHigh = lowPartial + opts.beatHz;
    const highHz = wantHigh / (iv.high * Math.sqrt(1 + bHigh * iv.high * iv.high));

    const n = Math.round(sampleRate * seconds);
    const out = new Float32Array(n);
    note(out, sampleRate, {
      f0: opts.lowHz, b: bLow, amp: opts.lowAmp === undefined ? 1 : opts.lowAmp,
      strings: opts.strings || 1, spreadCents: opts.spreadCents || 0,
      decay: opts.decay, partials: opts.partials,
    });
    note(out, sampleRate, {
      f0: highHz, b: bHigh, amp: opts.highAmp === undefined ? 1 : opts.highAmp,
      strings: opts.strings || 1, spreadCents: opts.spreadCents || 0,
      decay: opts.decay, partials: opts.partials, phase: 0.4,
    });

    if (opts.snrDb !== undefined) addNoise(out, opts.snrDb);
    return { samples: out, highHz: highHz, truth: opts.beatHz };
  }

  /* White noise at a stated signal-to-noise ratio against the r.m.s. signal. */
  function addNoise(buf, snrDb) {
    let energy = 0;
    for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
    const rms = Math.sqrt(energy / buf.length);
    const level = rms * Math.pow(10, -snrDb / 20);
    let seed = 12345;
    for (let i = 0; i < buf.length; i++) {
      // Deterministic, so a failing test fails again.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const u = seed / 0x7fffffff;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = seed / 0x7fffffff;
      buf[i] += level * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(TAU * v);
    }
  }

  global.Synth = {
    partialHz: partialHz,
    note: note,
    interval: interval,
    addNoise: addNoise,
  };
})(typeof window !== "undefined" ? window : globalThis);
