/*
 * From a stretch of audio to a reading.
 *
 * Three questions in order, and the app refuses to answer a later one until it
 * is sure of the earlier:
 *
 *   1. Which two notes are sounding?
 *   2. What interval is that, and so which two partials are beating?
 *   3. How fast?
 *
 * Question 1 is the only hard one, and it is worth saying why it is asked at
 * all. The beat itself does not care what the notes are called — it is just two
 * frequencies a few cycles apart. But to hear that beat and nothing else, the
 * app has to know where in the spectrum to point, and a sounding third is full
 * of other things beating: each note's own strings against each other, sympathy
 * from strings nobody struck, the room. Pointing at the right band is what makes
 * this different from listening harder.
 */
(function (global) {
  "use strict";

  const Iv = global.Intervals;
  const D = global.DSP;

  /* Where a lower note may be looked for. Below this a piano's fundamental is
   * mostly absent and the partials are too close to sort out; above it, nothing
   * a temperament is laid on. */
  const SEARCH_LO_HZ = 100;
  const SEARCH_HI_HZ = 1500;

  /* Partials used to recognise a note. Six is enough to be sure and few enough
   * that the stiffness allowance below stays narrow. */
  const SEARCH_PARTIALS = 6;

  /* The stiffest string this will allow for when hunting a partial. Generous —
   * a small spinet in the tenor — and the window is one-sided because stiffness
   * only ever pushes a partial sharp, never flat. */
  const MAX_B = 0.0008;

  /* How far above the noise floor a partial has to be to count as present. */
  const PRESENT = 4;

  /* A partial this far below the note's own strongest one is also called absent.
   * On a clean recording the noise floor is so low that everything clears it,
   * including leakage from a partial two hundred hertz away, so presence has to
   * be judged against the note as well as against the room. */
  const PRESENT_SHARE = 0.03;

  /* What an absent partial costs, as a share of the strongest one.
   *
   * This is the whole defence against subharmonics, and it is worth spelling
   * out. Half of a note's frequency has that note's every partial sitting on its
   * even numbers, so a search that only adds up what it finds scores f0/2 almost
   * as well as f0 — and then names a third from F3 an octave lower than it is.
   * What f0/2 does *not* have is anything on its odd numbers. Charging for the
   * gaps is what tells the two apart. */
  const ABSENCE = 0.35;

  /* The fundamental must carry at least this share of the note's strongest
   * partial. A subharmonic's "fundamental" is an empty stretch of spectrum, so
   * this alone disqualifies it; a real note above a hundred hertz has no trouble
   * with it. */
  const FUNDAMENTAL_SHARE = 0.1;

  /* Spans the spectrum can tell apart. An octave is left out on purpose: the
   * upper note's partials are a subset of the lower's, so nothing in the
   * spectrum distinguishes an octave from one note played alone. Octaves are
   * available by picking them. */
  const AUTO_SPANS = [3, 4, 5, 7, 8, 9, 16, 19];

  function partialWindow(f0, n) {
    const lo = n * f0;
    return [lo * 0.997, lo * Math.sqrt(1 + MAX_B * n * n)];
  }

  function maxIn(mags, binHz, loHz, hiHz) {
    const lo = Math.max(1, Math.floor(loHz / binHz));
    const hi = Math.min(mags.length - 1, Math.ceil(hiHz / binHz));
    let best = 0;
    for (let i = lo; i <= hi; i++) if (mags[i] > best) best = mags[i];
    return best;
  }

  /*
   * How well a fundamental of `f0` explains what is in the spectrum.
   *
   * Amplitudes are square-rooted before they are added. Without that, one loud
   * partial outvotes five quiet ones, and the loudest thing in a piano's
   * spectrum is frequently a partial of some *other* note — so the score has to
   * reward a complete series rather than a strong single line.
   */
  function scoreF0(mags, binHz, f0, floor) {
    const top = (mags.length - 1) * binHz;
    const amps = [];
    let peak = 0;
    for (let n = 1; n <= SEARCH_PARTIALS; n++) {
      const w = partialWindow(f0, n);
      if (w[1] >= top) break;
      const a = maxIn(mags, binHz, w[0], w[1]);
      amps.push(a);
      if (a > peak) peak = a;
    }
    if (amps.length < 4 || !(peak > 0)) return null;

    const there = Math.max(PRESENT * floor, PRESENT_SHARE * peak);
    const cost = ABSENCE * Math.sqrt(peak);
    let score = 0;
    let present = 0;
    for (let i = 0; i < amps.length; i++) {
      if (amps[i] > there) { score += Math.sqrt(amps[i]); present++; }
      else score -= cost;
    }
    return {
      score: score,
      present: present,
      fundamental: amps[0],
      peak: peak,
      hasRoot: amps[0] > Math.max(PRESENT * floor, FUNDAMENTAL_SHARE * peak),
    };
  }

  /*
   * The best fundamental on a grid.
   *
   * No preference for high or low is applied afterwards, and none is needed.
   * The octave below is ruled out by the absence charge and the demand for a
   * real fundamental; the octave above is ruled out by arithmetic, because it
   * has to do without the loudest partials the note has and so cannot score as
   * well. A tie-break here would only be a way of getting it wrong twice.
   */
  function bestF0(mags, binHz, floor, loHz, hiHz) {
    const cents = 2;
    const steps = Math.floor((1200 * Math.log2(hiHz / loHz)) / cents);
    let best = null;
    for (let i = 0; i <= steps; i++) {
      const f0 = loHz * Math.pow(2, (i * cents) / 1200);
      const s = scoreF0(mags, binHz, f0, floor);
      if (!s || !s.hasRoot || s.present < 3) continue;
      if (!best || s.score > best.score) best = { hz: f0, score: s.score, present: s.present };
    }
    if (!best) return null;

    // Now pin it down properly: the grid is only good to a couple of cents.
    //
    // Symmetrically, which is the whole point of doing it separately. The
    // windows used for scoring run from slightly flat to distinctly sharp,
    // because that is where stiffness puts a partial — but a *fundamental* is
    // not displaced by stiffness, and searching for it in a one-sided window
    // dragged every note about ten cents flat. The beat rate barely noticed,
    // since both notes were dragged together; the piano's reported pitch was
    // wrong by the width of the thing it was reporting.
    //
    // Wide enough for the peak to sit inside it with a bin to spare on each
    // side, so the parabola has something to fit. There is nothing else near a
    // fundamental to be confused by — the next partial is an octave up.
    const slack = Math.max(best.hz * 0.012, 3 * binHz);
    const p = D.peakNear(mags, binHz, best.hz - slack, best.hz + slack);
    return p ? { hz: p.hz, amp: p.amp, score: best.score } : null;
  }

  function suppress(mags, binHz, f0) {
    const top = (mags.length - 1) * binHz;
    for (let n = 1; n <= 16; n++) {
      const w = partialWindow(f0, n);
      if (w[0] > top) break;
      const p = D.peakNear(mags, binHz, w[0], Math.min(w[1], top));
      if (!p) continue;
      const c = Math.round(p.hz / binHz);
      for (let i = c - 3; i <= c + 3; i++) if (i >= 0 && i < mags.length) mags[i] = 0;
    }
  }

  /*
   * Find the two notes sounding, if there are two.
   *
   * The second is found by taking the first out of the spectrum and looking
   * again. Their shared partial — the one that is beating, the whole reason we
   * are here — goes out with the first note, so the second is recognised from
   * the partials it does not share. That it still has five of those is why this
   * works at all.
   */
  function findNotes(mags, binHz) {
    const floor = D.noiseFloor(mags);
    if (!(floor > 0)) return null;
    const a = bestF0(mags, binHz, floor, SEARCH_LO_HZ, SEARCH_HI_HZ);
    if (!a) return null;

    const rest = Float64Array.from(mags);
    suppress(rest, binHz, a.hz);
    const b = bestF0(rest, binHz, floor, SEARCH_LO_HZ, SEARCH_HI_HZ);
    if (!b) return { one: a };

    const lowHz = Math.min(a.hz, b.hz);
    const highHz = Math.max(a.hz, b.hz);
    const exact = 12 * Math.log2(highHz / lowHz);
    const semitones = Math.round(exact);
    // A temperament interval is never a quarter-tone out. If the span does not
    // land near a whole number of semitones, two notes were not what was heard.
    if (Math.abs(exact - semitones) > 0.35) return { one: a };
    if (AUTO_SPANS.indexOf(semitones) < 0) return { one: a, unsupported: semitones };
    return { lowHz: lowHz, highHz: highHz, semitones: semitones, offBy: exact - semitones };
  }

  /*
   * How long a window the beat needs.
   *
   * Thirds and sixths beat fast and are settled in under a second and a half.
   * Fourths and fifths beat less than once a second, and asking a rate like that
   * from a short window is asking it to tell a beat from the note simply dying
   * away. So the window follows the interval — and the slow intervals pay for it
   * in how long the reading takes to appear, which is the honest trade.
   */
  function windowFor(sampleRate, semitones, lowHz) {
    const want = Iv.etBeatRate(semitones, lowHz) || 6;
    const seconds = Math.min(4.5, Math.max(1.4, 5 / Math.max(0.4, want)));
    // Rounded rather than rounded up: the sizes available are a factor of two
    // apart, and taking the nearer one keeps a third's reading at about a second
    // and a half instead of three, which is the difference between a meter that
    // follows the pin and one that lags behind it.
    const n = 1 << Math.round(Math.log2(seconds * sampleRate));
    return Math.min(1 << 18, n);
  }

  /*
   * Measure the beat of a known interval whose lower note is at `lowHz`.
   *
   * Shared by both routes into the app: whether the interval was recognised
   * from the audio or picked on screen, from here on it is the same measurement.
   */
  function measure(samples, end, sampleRate, lowHz, semitones, opts) {
    opts = opts || {};
    const iv = Iv.interval(semitones);
    if (!iv) return null;

    // The window is chosen from what equal temperament would have this interval
    // beating at, which is a guess about a piano that may not deserve it. When
    // the guess is wrong the symptom is one of two things: a rate pinned to the
    // bottom of what the window can see, or a rate that does not hold together.
    // Both have the same answer — listen for longer — and both are real states
    // for a piano to be in, so the app tries again rather than shrugging.
    //
    // Twice, at most. Past that the window is longer than a note usefully lasts,
    // and the reading is handed back as it is for the screen to qualify.
    let len = windowFor(sampleRate, semitones, lowHz);
    for (let tries = 0; ; tries++) {
      const m = attempt(len);
      if (!m || m.short) return m;
      const unsure = m.atFloor || (m.beatHz !== undefined && !m.clean);
      const longer = len * 2;
      if (!unsure) return m;
      if (tries >= 2 || longer > (1 << 19) || end - longer < 0) {
        if (m.atFloor) {
          return { tooSlow: true, lowHz: lowHz, semitones: semitones,
                   slowerThan: m.floorHz, windowSeconds: len / sampleRate };
        }
        return m;
      }
      len = longer;
    }

    function attempt(len) {
    const start = end - len;
    if (start < 0) return { short: true, need: len / sampleRate };

    const mags = D.magnitudes(samples, start, len);
    const binHz = sampleRate / len;
    const floor = D.noiseFloor(mags);

    // Where the coincidence would be with no stiffness, and where stiffness can
    // push it. One-sided: stiff strings run sharp, never flat.
    const pure = iv.low * lowHz;
    const found = D.peakNear(mags, binHz, pure * 0.995, pure * Math.sqrt(1 + MAX_B * iv.low * iv.low));
    if (!found || found.amp < PRESENT * floor) {
      return { quiet: true, lowHz: lowHz, semitones: semitones, expectedHz: pure };
    }

    const frameLen = D.frameLenFor(sampleRate, lowHz);
    const hop = Math.max(32, Math.round(sampleRate / 200));
    const traj = D.trajectory(samples, start, len, sampleRate, found.hz, frameLen, hop);
    if (!traj) return { quiet: true, lowHz: lowHz, semitones: semitones, expectedHz: pure };

    const beat = D.detectBeat(traj, opts);
    if (!beat) {
      return { steady: true, lowHz: lowHz, semitones: semitones, coincidenceHz: found.hz, traj: traj };
    }
    if (beat.atFloor) return { atFloor: true, floorHz: beat.floorHz };

    // The independent check: pull the two partials apart in the spectrum and
    // subtract. Only meaningful when they are further apart than the window can
    // resolve, which is roughly three beats a second here.
    const resolvable = 3 * binHz;
    const split = D.splitPair(mags, binHz, found.hz, Math.min(lowHz * 0.45, 40));
    let agrees = null;
    if (split && split.hz > resolvable) {
      agrees = Math.abs(split.hz - beat.hz) < Math.max(0.35, 0.12 * beat.hz);
    }

    const other = D.secondRate(traj, beat, opts);
    // A second rate of its own, as deep as the one we want, is another pair of
    // strings beating in the same band — almost always a unison that needs
    // pulling together before the interval can be read at all.
    //
    // The bar is high, and it was raised after real recordings were put through
    // this. Every note on a piano has three strings and none of them are exactly
    // together, so there is always a second rate in there somewhere; at a lower
    // bar this warned about the unisons of a grand that had just been tuned,
    // which is the kind of false alarm that gets an app ignored when it is
    // right.
    const muddled = !!(other && other.depth > 0.85 * beat.depth && other.depth > 0.12);

    return {
      lowHz: lowHz,
      semitones: semitones,
      interval: iv,
      coincidenceHz: found.hz,
      expectedHz: pure,
      beatHz: beat.hz,
      explained: beat.explained,
      depth: beat.depth,
      clean: beat.clean,
      split: split,
      agrees: agrees,
      other: other,
      muddled: muddled,
      traj: traj,
      // The swell with the note's own dying-away taken out of it — what the
      // rate was actually read from, and so the honest thing to draw.
      residual: beat.residual,
      windowSeconds: len / sampleRate,
      binHz: binHz,
    };
    }
  }

  /*
   * The whole chain: listen, work out what it is, measure it.
   *
   * `pick` forces the interval when the technician has chosen one on screen;
   * without it the notes are recognised from the audio.
   */
  function read(samples, end, sampleRate, pick) {
    const noteLen = Math.min(1 << 15, 1 << Math.floor(Math.log2(end)));
    if (end < noteLen) return { waiting: true };

    let lowHz;
    let semitones;
    let notes = null;

    if (pick && pick.semitones) {
      semitones = pick.semitones;
      // Even when the interval is chosen, the lower note is measured rather
      // than assumed: a piano is not where the keyboard says it is, and the band
      // this points at has to be where the string actually put it.
      const mags = D.magnitudes(samples, end - noteLen, noteLen);
      const binHz = sampleRate / noteLen;
      const floor = D.noiseFloor(mags);
      const want = pick.lowHz;
      const p = D.peakNear(mags, binHz, want * 0.94, want * 1.06);
      if (!p || p.amp < PRESENT * floor) return { silent: true };
      lowHz = p.hz;
    } else {
      const mags = D.magnitudes(samples, end - noteLen, noteLen);
      const binHz = sampleRate / noteLen;
      notes = findNotes(mags, binHz);
      if (!notes) return { silent: true };
      if (!notes.semitones) {
        return {
          oneNote: notes.one ? notes.one.hz : null,
          unsupported: notes.unsupported || null,
        };
      }
      lowHz = notes.lowHz;
      semitones = notes.semitones;
    }

    const m = measure(samples, end, sampleRate, lowHz, semitones);
    if (!m) return { silent: true };

    // Everything below is naming and context, and it has to survive a
    // measurement that did not come off. The band can be too quiet, the beat too
    // slow for the note to have lasted, the window not filled yet — all ordinary
    // at a piano, all of them leaving no beat rate behind. The screen still
    // wants to say which two notes it is waiting on, so the names are worked out
    // either way and only the parts that need a measurement are guarded.
    m.semitones = semitones;
    m.lowHz = lowHz;
    const iv = Iv.interval(semitones);
    if (notes) {
      m.highHz = notes.highHz;
      m.spanOffBy = notes.offBy;
    } else {
      m.highHz = lowHz * Math.pow(2, semitones / 12);
    }

    // Naming, and only naming. Nothing measured above depends on any of this.
    const a4 = Iv.inferA4(lowHz, m.highHz, semitones);
    const lo = Iv.nearestKey(lowHz, a4);
    const hi = Iv.nearestKey(m.highHz, a4);
    m.a4 = a4;
    m.lowName = lo ? Iv.keyName(lo.key) : "?";
    m.highName = hi ? Iv.keyName(hi.key) : "?";
    m.lowKey = lo ? lo.key : null;

    // Two targets, because they answer different questions. See intervals.js.
    m.wantHere = Iv.etBeatRate(semitones, lowHz);
    m.wantTable = lo ? Iv.etBeatRate(semitones, Iv.keyNominalHz(lo.key, 440)) : null;

    // How wide the interval actually is against a pure one, in cents. Not the
    // number to tune by — the beat rate is — but it says which way and by how
    // much when the beat rate alone is ambiguous. Only meaningful when both
    // notes were found rather than one measured and the other assumed.
    if (iv && notes) {
      const pureRatio = iv.low / iv.high;
      m.widthCents = 1200 * Math.log2(m.highHz / lowHz / pureRatio);
    }

    return m;
  }

  global.Listen = {
    read: read,
    measure: measure,
    findNotes: findNotes,
    windowFor: windowFor,
    AUTO_SPANS: AUTO_SPANS,
    SEARCH_LO_HZ: SEARCH_LO_HZ,
    SEARCH_HI_HZ: SEARCH_HI_HZ,
  };
})(typeof window !== "undefined" ? window : globalThis);
