/*
 * The screen.
 *
 * Nothing is measured here — that is all in listen.js. What this file decides is
 * when a number has earned the right to be shown, and what to say when it has
 * not, which turns out to be most of the work.
 *
 * Two rules run through it.
 *
 * A number on its own is not a reading. Everything in this app is relative to
 * something — the beat to a pair of partials, the target to equal temperament,
 * equal temperament to a reference pitch, the reference pitch to whatever this
 * piano happens to be sitting at — and a figure shown without its frame reads as
 * a fault in the app the moment it disagrees with anything else. So the frame
 * goes on the screen next to the number it belongs to.
 *
 * And a reading that has gone is not a reading. A piano note dies while you are
 * still looking at the phone, so the last good one is held and *marked* as held,
 * rather than either vanishing or silently pretending to be live.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    listen: $("listen"), state: $("state"), heard: $("heard"),
    names: $("names"), kind: $("kind"), where: $("where"),
    rate: $("rate"), unit: $("unit"), wave: $("wave"), pulse: $("pulse"),
    targets: $("targets"), wantLabel: $("wantLabel"), wantHere: $("wantHere"),
    tableRow: $("tableRow"), wantTable: $("wantTable"),
    pitchRow: $("pitchRow"), pitch: $("pitch"),
    widthRow: $("widthRow"), widthLabel: $("widthLabel"), width: $("width"),
    frame: $("frame"), notice: $("notice"), mic: $("mic"),
    manual: $("manual"), pickLow: $("pickLow"), pickIv: $("pickIv"), pickClear: $("pickClear"),
  };

  /* How often to take a reading. Each one re-reads a window that mostly overlaps
   * the last, so going faster than this buys nothing but heat. */
  const EVERY_MS = 300;

  /* How long a finished reading stays on screen, greyed, after the note has gone.
   * Long enough to strike a note, set the pin and then look up. */
  const HOLD_MS = 6000;

  /* Readings kept for smoothing. The window each one is taken over is longer
   * than the gap between them, so consecutive readings share most of their audio
   * and a median over three is steadier than any of them without lagging. */
  const SMOOTH = 3;

  const S = {
    running: false,
    timer: null,
    history: [],
    last: null,
    lastAt: 0,
    a4: 440,
    pick: null,
  };

  /* --- the loop ---------------------------------------------------------- */

  el.listen.onclick = async () => {
    if (S.running) return stop();
    el.listen.disabled = true;
    el.listen.textContent = "Starting…";
    try {
      await Capture.start();
    } catch (err) {
      el.listen.disabled = false;
      el.listen.textContent = "Listen";
      note("bad", "The microphone was not available. " +
        (err && err.message ? err.message : "") +
        " On iPhone this page has to be opened over https, and permission has to be given " +
        "to the site rather than to the app.");
      return;
    }
    S.running = true;
    el.listen.disabled = false;
    el.listen.textContent = "Stop";
    el.state.textContent = "listening";
    el.state.className = "on";
    el.heard.hidden = false;
    showMic();
    tick();
  };

  function stop() {
    Capture.stop();
    S.running = false;
    clearTimeout(S.timer);
    el.listen.textContent = "Listen";
    el.state.textContent = "not listening";
    el.state.className = "";
    el.pulse.className = "";
  }

  function tick() {
    if (!S.running) return;
    try {
      read();
    } catch (err) {
      note("bad", "Something went wrong reading the sound: " + err.message);
    }
    S.timer = setTimeout(tick, EVERY_MS);
  }

  function read() {
    const sr = Capture.state.sampleRate;
    // Hand over as much as the measurement might ask for. It uses the end of
    // what it is given and will reach further back on its own when an interval
    // beats too slowly to settle in a short window.
    const want = Math.min(Capture.have(), Math.round(sr * 6.2));
    if (want < sr * 0.8) { setState("waiting for sound"); return; }
    const samples = Capture.latest(want);
    if (!samples) return;

    setState("listening");
    const r = Listen.read(samples, want, sr, S.pick);
    render(r);
  }

  /* --- what to put on the screen ------------------------------------------ */

  function render(r) {
    if (!r) return;

    if (r.a4) S.a4 = r.a4;

    if (r.beatHz !== undefined && r.clean) {
      S.history.push({ hz: r.beatHz, at: performance.now() });
      if (S.history.length > SMOOTH) S.history.shift();
      S.last = r;
      S.lastAt = performance.now();
      showReading(r, smoothed(), false);
      // Clear whatever the last tick complained about. Without this a warning
      // from a moment ago sits under a reading that has since come good, and
      // the screen contradicts itself.
      explain(r, false);
      return;
    }

    // Nothing to commit to this time round. If there was recently, keep it up
    // and say so; otherwise explain what is missing.
    const age = performance.now() - S.lastAt;
    if (S.last && age < HOLD_MS) {
      showReading(S.last, smoothed(), true);
      // A live problem worth naming still gets named over the held number.
      explain(r, true);
      return;
    }
    S.history.length = 0;
    S.last = null;
    blank(r);
    explain(r, false);
  }

  function smoothed() {
    const hz = S.history.map((h) => h.hz).sort((a, b) => a - b);
    if (!hz.length) return null;
    return hz[hz.length >> 1];
  }

  function showReading(r, hz, held) {
    const iv = r.interval || Intervals.interval(r.semitones);
    el.names.textContent = r.lowName + "  —  " + r.highName;
    el.kind.textContent = iv ? iv.name : "";
    el.where.textContent = iv
      ? ordinal(iv.low) + " partial against the " + ordinal(iv.high) +
        ", near " + Math.round(r.coincidenceHz) + " Hz"
      : "";

    el.rate.className = held ? "held" : "";
    el.rate.textContent = (hz === null ? r.beatHz : hz).toFixed(1);
    el.unit.textContent = held ? "beats per second · last reading" : "beats per second";

    drawWave(r.residual, held);
    beat(hz === null ? r.beatHz : hz, held);
    showTargets(r, hz === null ? r.beatHz : hz);
  }

  function blank(r) {
    el.rate.className = "none";
    el.rate.textContent = "—";
    el.unit.textContent = "beats per second";
    el.pulse.className = "";
    el.targets.hidden = true;
    clearWave();
    if (r && r.lowName && r.semitones) {
      const iv = Intervals.interval(r.semitones);
      el.names.textContent = r.lowName + "  —  " + r.highName;
      el.kind.textContent = iv ? iv.name : "";
      el.where.textContent = "";
    } else if (r && r.oneNote) {
      const k = Intervals.nearestKey(r.oneNote, S.a4);
      el.names.textContent = k ? Intervals.keyName(k.key) : "—";
      el.kind.textContent = "one note";
      el.where.textContent = "";
    } else {
      el.names.textContent = "—";
      el.kind.textContent = "";
      el.where.textContent = "";
    }
  }

  /*
   * The targets, and the frame every one of them needs.
   *
   * The first target is anchored to the lower note exactly where it is sounding
   * now, because that is the question actually being asked at the pin: the
   * bottom note is already set, and what is wanted is the rate that puts the top
   * one in equal temperament with it.
   *
   * The printed-table figure is anchored to A440 instead, and on a piano near
   * standard pitch the two are the same number to one decimal place. Showing
   * both then would be clutter, so the table row appears only when the piano is
   * far enough off pitch for them to differ — which is exactly when its absence
   * would look like the app disagreeing with the book.
   */
  function showTargets(r, shown) {
    // Tested against null rather than for truth, because an octave's answer is
    // zero — pure strings an octave apart do not beat at all — and that is the
    // single most worth-saying number in the table, not a missing one.
    if (r.wantHere === null || r.wantHere === undefined) { el.targets.hidden = true; return; }
    el.targets.hidden = false;

    el.wantHere.textContent = r.wantHere.toFixed(1);
    el.wantLabel.textContent = "equal temperament wants, from this " + r.lowName;

    const differs = r.wantTable && Math.abs(r.wantTable - r.wantHere) >= 0.1;
    el.tableRow.hidden = !differs;
    if (differs) el.wantTable.textContent = r.wantTable.toFixed(1);

    const offPitch = Math.abs(S.a4 - 440) >= 0.6;
    el.pitchRow.hidden = !offPitch;
    if (offPitch) el.pitch.textContent = "A4 ≈ " + S.a4.toFixed(1) + " Hz";

    if (r.widthCents === undefined) {
      el.widthRow.hidden = true;
    } else {
      el.widthRow.hidden = false;
      el.widthLabel.textContent = (r.widthCents >= 0 ? "wide of pure by" : "narrow of pure by");
      el.width.textContent = Math.abs(r.widthCents).toFixed(1) + "¢";
    }

    // The one thing that most needs saying, and it is not the same sentence for
    // every interval. See stiffnessEffect in intervals.js for why.
    const effect = Intervals.stiffnessEffect(r.semitones);
    const iv = Intervals.interval(r.semitones);
    const name = iv ? iv.name : "interval";
    let line = "The target is arithmetic on pure strings. Real strings are stiff, and at these " +
               "same pitches that makes a real " + name + " beat ";
    if (effect === "slower") line += "a little slower than the figure above.";
    else if (effect === "faster") line += "a little faster than the figure above.";
    else line += "at all, which is why octaves get stretched.";
    line += " How much depends on the instrument, and nothing here is corrected for it.";
    el.frame.textContent = line;
  }

  /*
   * What is wrong, in the words of the thing that is wrong with it.
   *
   * None of these are errors. Every one is an ordinary state for a piano and a
   * microphone to be in, and the app is more use saying which than it would be
   * showing a number it does not believe.
   */
  function explain(r, holding) {
    if (!r) return;
    if (r.muddled) {
      return note("warn", "Something else is beating in the same band — usually a unison that " +
        "is not together. Pull the unison in first; until then this reading is of both at once.");
    }
    if (r.tooSlow) {
      return note("warn", "Beating slower than " + r.slowerThan.toFixed(1) + " a second, which " +
        "needs a longer listen than the note gave. Strike it again and let it ring.");
    }
    if (r.beatHz !== undefined && !r.clean) {
      return note("warn", "Can't separate this cleanly — only " +
        Math.round(r.explained * 100) + "% of what the band is doing is that one rate. " +
        "Strike both notes together and let them ring.");
    }
    if (r.quiet) {
      return note("", "Both notes are there but the partials that beat against each other are " +
        "too faint to read. Play it a little louder, or closer to the phone.");
    }
    if (r.oneNote) {
      const k = Intervals.nearestKey(r.oneNote, S.a4);
      return note("", "Hearing one note" + (k ? ", around " + Intervals.keyName(k.key) : "") +
        ". Play the other one with it.");
    }
    if (r.unsupported) {
      return note("", "That is " + r.unsupported + " semitones apart, which this app has no " +
        "coincident partials for. Try a third, a sixth, a fourth or a fifth.");
    }
    if (r.silent || r.waiting) {
      return note("", holding ? "" : "Play two notes together.");
    }
    note("", "");
  }

  function note(kind, text) {
    if (!text) { el.notice.className = "hide"; el.notice.textContent = ""; return; }
    el.notice.className = kind;
    el.notice.textContent = text;
  }

  function setState(s) { if (S.running) el.state.textContent = s; }

  /* --- the beat, drawn ---------------------------------------------------- */

  /*
   * The amplitude of the coincident partials over the last second or two.
   *
   * This is the most useful thing on the screen and the cheapest to justify: it
   * is the beat itself, not a summary of it. If the humps on the trace rise and
   * fall in step with what the ear hears, the app is counting the same thing you
   * are. If they do not, that is visible immediately and without having to trust
   * anything.
   */
  function drawWave(wave, held) {
    const c = el.wave;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (!wave || wave.length < 4) return;

    // Scaled to whatever the deepest swell in this window was, and drawn about
    // a centre line. The note's decay has already been taken out upstream, so
    // the last hump is as tall as the first and the far end of the trace stays
    // countable instead of trailing into the floor as the note dies.
    let peak = 0;
    for (let i = 0; i < wave.length; i++) {
      const v = Math.abs(wave[i]);
      if (v > peak) peak = v;
    }
    if (!(peak > 0)) return;

    const pad = 4 * dpr;
    const mid = h / 2;
    const amp = mid - pad;

    ctx.strokeStyle = "#2f332a";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.strokeStyle = held ? "#5c6153" : "#b9d98a";
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < wave.length; i++) {
      const x = (i / (wave.length - 1)) * w;
      const y = mid - (wave[i] / peak) * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function clearWave() {
    const ctx = el.wave.getContext("2d");
    ctx.clearRect(0, 0, el.wave.width, el.wave.height);
  }

  /*
   * A dot flashing at the rate that was measured.
   *
   * It is not synchronised to the sound and cannot be — it is here so the rate
   * can be checked against the ear directly, which for a minor third at thirteen
   * a second is easier than counting either of them.
   */
  function beat(hz, held) {
    if (!hz || held || hz <= 0) { el.pulse.className = ""; return; }
    el.pulse.className = "beating";
    el.pulse.style.animationDuration = (1 / hz).toFixed(3) + "s";
  }

  /* --- picking it yourself ------------------------------------------------ */

  (function buildPicker() {
    const LOWEST = 25;  // A2
    const HIGHEST = 64; // C6
    for (let k = LOWEST; k <= HIGHEST; k++) {
      const o = document.createElement("option");
      o.value = String(k);
      o.textContent = Intervals.keyName(k);
      if (k === 33) o.selected = true; // F3, where a temperament usually starts
      el.pickLow.appendChild(o);
    }
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "listen for it";
    el.pickIv.appendChild(none);
    for (const s of Intervals.SPANS) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = Intervals.BY_SEMITONES[s].name;
      el.pickIv.appendChild(o);
    }
    el.pickLow.onchange = el.pickIv.onchange = applyPick;
    el.pickClear.onclick = () => { el.pickIv.value = ""; applyPick(); };
  })();

  function applyPick() {
    const semitones = parseInt(el.pickIv.value, 10);
    if (!semitones) {
      S.pick = null;
      el.manual.querySelector("summary").textContent = "Pick the interval yourself";
    } else {
      const key = parseInt(el.pickLow.value, 10);
      // The nominal frequency is only a place to start looking. listen.js finds
      // where the string actually is, which on a piano is not where the keyboard
      // says — and if it were, there would be nothing to tune.
      S.pick = { lowHz: Intervals.keyNominalHz(key, S.a4), semitones: semitones };
      const name = Intervals.BY_SEMITONES[semitones].name;
      el.manual.querySelector("summary").textContent =
        "Listening for " + (/^[aeiou]/.test(name) ? "an " : "a ") + name +
        " from " + Intervals.keyName(key);
    }
    S.history.length = 0;
    S.last = null;
  }

  /* --- the microphone, and what the browser did to it --------------------- */

  function showMic() {
    const on = Capture.processingWarning();
    if (!on) {
      el.mic.textContent = "Microphone raw at " +
        Math.round(Capture.state.sampleRate) + " Hz — no gain control, no noise suppression.";
      el.mic.style.color = "";
      return;
    }
    // Worth its own paragraph. Gain control turns the volume down when a sound
    // swells and up when it fades, and a beat is nothing but a swell and a fade.
    el.mic.style.color = "#e0b45f";
    el.mic.textContent = "This browser left " + on.join(" and ") + " switched on despite being " +
      "asked not to. Gain control in particular flattens exactly the rise and fall this app " +
      "measures, so beats may read slower and shallower than they are.";
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  window.addEventListener("pagehide", stop);

  // Stored on the phone so it opens in a house with no signal. Failing to
  // register is not worth telling anybody about — the app works either way.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
