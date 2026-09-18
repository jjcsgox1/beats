/*
 * What beats against what, and how fast it ought to.
 *
 * An interval beats because two partials — one from each note — land on nearly
 * the same frequency and are not quite identical. Which two depends only on the
 * interval: a major third puts the lower note's 5th partial against the upper
 * note's 4th, a minor third the 6th against the 5th, a major sixth the 5th
 * against the 3rd. That is the whole table below, and it is the only piano
 * knowledge this app has.
 *
 * Every rate here is arithmetic on pure harmonics — partial n of a note at f is
 * taken to be exactly n*f. Real strings are stiff and their partials run sharp
 * of that, so no real piano beats at these rates exactly. Which way it goes is
 * not the same for every interval, and `stiffnessEffect` below works it out
 * rather than waving at it. The app puts that on screen instead of correcting
 * for it silently, because correcting means measuring each string's stiffness,
 * which is a different instrument's job.
 */
(function (global) {
  "use strict";

  /*
   * Coincident partials by the size of the interval in semitones.
   *
   * `low` is the partial number taken from the lower note, `high` from the
   * upper. Their ratio is the pure interval: 5:4 is a just major third, and an
   * equal-tempered one is wider than that, which is why it beats at all.
   */
  const BY_SEMITONES = {
    3:  { name: "minor third",   low: 6, high: 5 },
    4:  { name: "major third",   low: 5, high: 4 },
    5:  { name: "fourth",        low: 4, high: 3 },
    7:  { name: "fifth",         low: 3, high: 2 },
    8:  { name: "minor sixth",   low: 8, high: 5 },
    9:  { name: "major sixth",   low: 5, high: 3 },
    12: { name: "octave",        low: 2, high: 1 },
    16: { name: "major tenth",   low: 5, high: 2 },
    19: { name: "twelfth",       low: 3, high: 1 },
    24: { name: "double octave", low: 4, high: 1 },
  };

  /* The spans the note-finder is allowed to propose, widest last. */
  const SPANS = Object.keys(BY_SEMITONES).map(Number).sort((a, b) => a - b);

  function interval(semitones) {
    return BY_SEMITONES[semitones] || null;
  }

  /*
   * How fast the interval beats if both notes are exactly where equal
   * temperament wants them, given where the *lower* note actually is.
   *
   * Anchoring to the lower note is deliberate. At the pin you have already set
   * the bottom note and are bringing the top one to it, so the question is
   * never "what would this beat on a piano at A440" but "what should this beat,
   * given the note I have already got". On a piano sitting a little off pitch
   * the two answers differ by about the same fraction as the pitch does — small,
   * but the app shows both rather than choosing for you.
   */
  function etBeatRate(semitones, lowHz) {
    const iv = interval(semitones);
    if (!iv || !(lowHz > 0)) return null;
    const highHz = lowHz * Math.pow(2, semitones / 12);
    return Math.abs(iv.high * highHz - iv.low * lowHz);
  }

  /*
   * Where the coincidence sits, if the strings were not stiff. The real one is
   * a little above this — never below — which is what lets the search for it be
   * one-sided.
   */
  function coincidenceHz(semitones, lowHz) {
    const iv = interval(semitones);
    if (!iv || !(lowHz > 0)) return null;
    return iv.low * lowHz;
  }

  /*
   * Is equal temperament's version of this interval wider or narrower than the
   * pure one? Fixed by the interval, not by the piano: thirds, fourths, sixths
   * and tenths are wide in equal temperament, fifths and twelfths narrow,
   * octaves neither.
   *
   * Returns +1 wide, -1 narrow, 0 pure.
   */
  function etDirection(semitones) {
    const iv = interval(semitones);
    if (!iv) return 0;
    const et = Math.pow(2, semitones / 12);
    const pure = iv.low / iv.high;
    if (Math.abs(et - pure) < 1e-9) return 0;
    return et > pure ? 1 : -1;
  }

  /*
   * Which way a real piano's stiffness moves this interval off the pure-partial
   * figure, if both notes sit exactly where equal temperament wants them.
   *
   * There is one fact behind every answer here. The coincident partial taken
   * from the *lower* note is always the higher-numbered of the two — 5 against
   * 4 in a third, 6 against 5 in a minor third, 2 against 1 in an octave — and
   * stiffness pushes a partial sharp in proportion to the square of its number.
   * So the lower note's side of the coincidence always rises more than the upper
   * note's.
   *
   * For an interval equal temperament makes wide, the beat is the upper partial
   * standing above the lower, and closing that gap from below makes it slower.
   * For one equal temperament makes narrow it is the other way about and the
   * beat gets faster. For the octave, where there would be no beat at all
   * between pure strings, it is the whole reason octaves have to be stretched.
   *
   * None of this is corrected for anywhere in the app. Correcting it means
   * measuring each string's stiffness, which is a different instrument's job;
   * saying which way it goes costs nothing and stops the printed figure looking
   * like a target that the piano is failing to meet.
   */
  function stiffnessEffect(semitones) {
    const d = etDirection(semitones);
    if (d > 0) return "slower";
    if (d < 0) return "faster";
    return "stretched";
  }

  /* --- naming notes ------------------------------------------------------ */

  const NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];
  const KEYS = 88;

  /** Key 1 is A0, key 49 is A4, key 88 is C8. */
  function keyNominalHz(key, a4Hz) {
    return a4Hz * Math.pow(2, (key - 49) / 12);
  }

  function keyName(key) {
    return NAMES[(key - 1) % 12] + Math.floor((key + 8) / 12);
  }

  /*
   * The key a sounding frequency is closest to, at a stated reference pitch,
   * along with how far off it is. Naming only — nothing measured depends on it,
   * so a piano half a semitone flat still gets a correct beat rate under a note
   * name that may be arguable.
   */
  function nearestKey(hz, a4Hz) {
    if (!(hz > 0)) return null;
    const exact = 49 + 12 * Math.log2(hz / a4Hz);
    const key = Math.min(KEYS, Math.max(1, Math.round(exact)));
    return { key: key, cents: 100 * (exact - key) };
  }

  /*
   * What reference pitch makes these notes sit closest to the keyboard.
   *
   * Two notes a known interval apart pin the pitch down between them: take each
   * note's implied A4 and average in the log domain. A piano at 438 reads as
   * 438 rather than as two notes that are both mysteriously flat — which is the
   * difference between an app that looks broken and one that doesn't.
   */
  function inferA4(lowHz, highHz, semitones) {
    if (!(lowHz > 0) || !(highHz > 0)) return 440;
    // Key numbers are unknown until a reference exists, so start from 440,
    // snap, and re-read the reference the snapped keys imply.
    const lo = nearestKey(lowHz, 440);
    const hi = nearestKey(highHz, 440);
    if (!lo || !hi) return 440;
    // Trust the span we identified over the individual snaps.
    if (hi.key - lo.key !== semitones) return 440;
    const a = lowHz / Math.pow(2, (lo.key - 49) / 12);
    const b = highHz / Math.pow(2, (hi.key - 49) / 12);
    return Math.sqrt(a * b);
  }

  global.Intervals = {
    BY_SEMITONES: BY_SEMITONES,
    SPANS: SPANS,
    KEYS: KEYS,
    interval: interval,
    etBeatRate: etBeatRate,
    coincidenceHz: coincidenceHz,
    etDirection: etDirection,
    stiffnessEffect: stiffnessEffect,
    keyNominalHz: keyNominalHz,
    keyName: keyName,
    nearestKey: nearestKey,
    inferA4: inferA4,
  };
})(typeof window !== "undefined" ? window : globalThis);
