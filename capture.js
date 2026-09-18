/*
 * The microphone, and nothing else.
 *
 * Two things here matter more than they look.
 *
 * The first is that every piece of "helpful" processing the browser offers is
 * turned off. Automatic gain control is the dangerous one: it works by turning
 * the volume down when a sound gets louder and up when it gets quieter, which is
 * precisely and exactly the thing this app measures. A beat is a swell, and gain
 * control exists to flatten swells. Left on, it would not make the reading
 * noisy — it would make it *small*, steadily and believably, which is far worse.
 * So the constraints are asked for, and then what was actually granted is read
 * back and put on the screen, because asking is not the same as getting.
 *
 * The second is that samples are taken through an AudioWorklet rather than an
 * AnalyserNode. An analyser hands over a window of its own choosing whenever it
 * is asked; the measurement here needs to choose its own window, several seconds
 * long, and to be certain the samples in it are consecutive and untouched.
 */
(function (global) {
  "use strict";

  /* How much audio to keep. The longest window the app asks for is about five
   * and a half seconds, and there has to be room to spare so a reading is never
   * built from samples that are being overwritten as it runs. */
  const KEEP_SECONDS = 9;

  /* Samples the worklet gathers before handing them over. At 48 kHz this is a
   * message about twelve times a second instead of three hundred and seventy. */
  const BLOCK = 4096;

  const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${BLOCK});
    this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i];
      if (this.at === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(${BLOCK});
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor("tap", Tap);
`;

  const S = {
    ctx: null,
    stream: null,
    node: null,
    source: null,
    ring: null,
    ringAt: 0,
    filled: 0,
    sampleRate: 0,
    running: false,
    settings: null,
  };

  async function start() {
    if (S.running) return S;

    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    const track = S.stream.getAudioTracks()[0];
    // What was asked for and what was granted are different questions.
    S.settings = track.getSettings ? track.getSettings() : {};

    S.ctx = new (global.AudioContext || global.webkitAudioContext)();
    if (S.ctx.state === "suspended") await S.ctx.resume();
    S.sampleRate = S.ctx.sampleRate;

    if (!S.ctx.audioWorklet) {
      stop();
      throw new Error("This browser cannot hand over raw microphone samples.");
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await S.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    S.ring = new Float32Array(Math.ceil(S.sampleRate * KEEP_SECONDS));
    S.ringAt = 0;
    S.filled = 0;

    S.node = new AudioWorkletNode(S.ctx, "tap");
    S.node.port.onmessage = (e) => write(e.data);
    S.source = S.ctx.createMediaStreamSource(S.stream);
    S.source.connect(S.node);
    // Safari will not run a worklet that is not connected to something, and the
    // destination is the only thing to connect to. A zero gain keeps the
    // microphone out of the speaker, which on a phone would otherwise howl.
    const mute = S.ctx.createGain();
    mute.gain.value = 0;
    S.node.connect(mute).connect(S.ctx.destination);

    S.running = true;
    return S;
  }

  function write(block) {
    const ring = S.ring;
    if (!ring) return;
    const n = block.length;
    let at = S.ringAt;
    if (at + n <= ring.length) {
      ring.set(block, at);
      at += n;
    } else {
      const first = ring.length - at;
      ring.set(block.subarray(0, first), at);
      ring.set(block.subarray(first), 0);
      at = n - first;
    }
    S.ringAt = at % ring.length;
    S.filled = Math.min(ring.length, S.filled + n);
  }

  /*
   * The most recent `n` samples, oldest first, copied out flat.
   *
   * Copied rather than handed over as a view, because the ring keeps being
   * written to while a measurement runs, and a reading built half from new audio
   * and half from old is a reading of nothing at all.
   */
  function latest(n) {
    if (!S.ring || S.filled < n) return null;
    const out = new Float32Array(n);
    const ring = S.ring;
    const end = S.ringAt;
    const start = (end - n + ring.length * 2) % ring.length;
    if (start + n <= ring.length) {
      out.set(ring.subarray(start, start + n));
    } else {
      const first = ring.length - start;
      out.set(ring.subarray(start), 0);
      out.set(ring.subarray(0, n - first), first);
    }
    return out;
  }

  function have() { return S.filled; }

  function stop() {
    if (S.node) { try { S.node.disconnect(); } catch (e) {} }
    if (S.source) { try { S.source.disconnect(); } catch (e) {} }
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    if (S.ctx) { try { S.ctx.close(); } catch (e) {} }
    S.node = S.source = S.stream = S.ctx = S.ring = null;
    S.running = false;
    S.filled = 0;
  }

  /*
   * What the browser actually did with the request, in words.
   *
   * Returns null when everything asked for was granted — there is nothing to
   * say and no reason to take up room on a small screen saying it.
   */
  function processingWarning() {
    const s = S.settings || {};
    const on = [];
    if (s.autoGainControl) on.push("automatic gain control");
    if (s.noiseSuppression) on.push("noise suppression");
    if (s.echoCancellation) on.push("echo cancellation");
    return on.length ? on : null;
  }

  global.Capture = {
    start: start,
    stop: stop,
    latest: latest,
    have: have,
    processingWarning: processingWarning,
    state: S,
    KEEP_SECONDS: KEEP_SECONDS,
  };
})(typeof window !== "undefined" ? window : globalThis);
