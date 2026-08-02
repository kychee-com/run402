const SCORE_TEMPO = 96;
const SCORE_LOOKAHEAD_SECONDS = 0.16;
const SCORE_SCHEDULER_INTERVAL_MS = 50;
const SCORE_ROOTS = [38, 41, 43, 45];
const SCORE_MODE = [0, 2, 3, 5, 7, 9, 10];

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToFrequency(note) {
  return 440 * (2 ** ((note - 69) / 12));
}

export function createScorePlan(seedText) {
  const seed = hashString(seedText || 'run402');
  const random = mulberry32(seed);
  const root = SCORE_ROOTS[seed % SCORE_ROOTS.length];
  const arp = Array.from({ length: 16 }, (_, index) => {
    const degree = SCORE_MODE[Math.floor(random() * SCORE_MODE.length)];
    const octave = index % 8 >= 5 || random() > 0.74 ? 12 : 0;
    return degree + octave;
  });
  const bass = [0, 0, 5, 3].map((degree, index) => SCORE_MODE[(degree + (seed >>> (index * 3))) % SCORE_MODE.length]);
  const chord = [0, SCORE_MODE[2], SCORE_MODE[4], SCORE_MODE[6]];
  return { seed, root, arp, bass, chord, tempo: SCORE_TEMPO };
}

export function scoreLayersAtProgress(progress) {
  const resolved = Math.min(1, Math.max(0, Number(progress) || 0));
  return {
    pulse: true,
    arpStride: resolved < 0.18 ? 4 : resolved < 0.48 ? 2 : 1,
    shimmer: resolved >= 0.58,
    brightness: 520 + resolved * 2600,
  };
}

function disconnectAfter(source, nodes) {
  source.addEventListener('ended', () => {
    source.disconnect();
    nodes.forEach((node) => node.disconnect());
  }, { once: true });
}

export function createSynthScore({ seed = 'run402', audioContextFactory } = {}) {
  const plan = createScorePlan(seed);
  const stepDuration = 60 / plan.tempo / 2;
  let context = null;
  let master = null;
  let dryBus = null;
  let delay = null;
  let delayFeedback = null;
  let scheduler = null;
  let nextStepTime = 0;
  let stepIndex = 0;
  let enabled = true;
  let playing = false;
  let progress = 0;
  let destroyed = false;
  let noiseBuffer = null;
  let lastImpactAt = -Infinity;

  const createContext = audioContextFactory || (() => {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Context ? new Context({ latencyHint: 'playback' }) : null;
  });

  function setMasterLevel(level, duration = 0.16) {
    if (!context || !master) return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(level, now + duration);
  }

  function ensureGraph() {
    if (context || destroyed) return context;
    try {
      context = createContext();
    } catch {
      context = null;
    }
    if (!context) return null;

    master = context.createGain();
    master.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.24;
    master.connect(compressor);
    compressor.connect(context.destination);

    dryBus = context.createGain();
    dryBus.gain.value = 0.72;
    dryBus.connect(master);

    delay = context.createDelay(1);
    delay.delayTime.value = stepDuration * 1.5;
    delayFeedback = context.createGain();
    delayFeedback.gain.value = 0.24;
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(master);
    return context;
  }

  function connectVoice(output, send = 0) {
    output.connect(dryBus);
    if (send > 0) {
      const sendGain = context.createGain();
      sendGain.gain.value = send;
      output.connect(sendGain);
      sendGain.connect(delay);
      return sendGain;
    }
    return null;
  }

  function scheduleTone({
    midi,
    time,
    duration,
    gain = 0.08,
    type = 'triangle',
    attack = 0.015,
    filterFrequency = 1800,
    send = 0,
    detune = 0,
  }) {
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = midiToFrequency(midi);
    oscillator.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFrequency, time);
    filter.Q.value = 0.72;
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.exponentialRampToValueAtTime(gain, time + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(filter);
    filter.connect(envelope);
    const sendGain = connectVoice(envelope, send);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.04);
    disconnectAfter(oscillator, [filter, envelope, ...(sendGain ? [sendGain] : [])]);
  }

  function schedulePad(time, layers) {
    plan.chord.forEach((offset, index) => {
      scheduleTone({
        midi: plan.root + 12 + offset,
        time: time + index * 0.018,
        duration: stepDuration * 14,
        gain: 0.018,
        type: index % 2 ? 'triangle' : 'sine',
        attack: 0.7,
        filterFrequency: Math.min(2200, layers.brightness * 0.68),
        send: 0.25,
        detune: index % 2 ? 4 : -4,
      });
    });
  }

  function scheduleStep(time) {
    const layers = scoreLayersAtProgress(progress);
    if (stepIndex % 4 === 0 && layers.pulse) {
      const bassOffset = plan.bass[Math.floor(stepIndex / 4) % plan.bass.length];
      scheduleTone({
        midi: plan.root + bassOffset,
        time,
        duration: stepDuration * 2.8,
        gain: 0.065,
        type: 'triangle',
        attack: 0.025,
        filterFrequency: 420 + progress * 520,
      });
    }
    if (stepIndex % layers.arpStride === 0) {
      const offset = plan.arp[stepIndex % plan.arp.length];
      scheduleTone({
        midi: plan.root + 24 + offset,
        time,
        duration: stepDuration * 1.45,
        gain: 0.032 + progress * 0.022,
        type: 'triangle',
        attack: 0.008,
        filterFrequency: layers.brightness,
        send: 0.34,
      });
    }
    if (layers.shimmer && stepIndex % 8 === 6) {
      scheduleTone({
        midi: plan.root + 43 + plan.arp[(stepIndex + 3) % plan.arp.length] % 12,
        time,
        duration: stepDuration * 3.4,
        gain: 0.015,
        type: 'sine',
        attack: 0.02,
        filterFrequency: 5200,
        send: 0.62,
      });
    }
    if (stepIndex % 16 === 0) schedulePad(time, layers);
    stepIndex += 1;
  }

  function tick() {
    if (!context || !playing || !enabled || destroyed) return;
    while (nextStepTime < context.currentTime + SCORE_LOOKAHEAD_SECONDS) {
      scheduleStep(nextStepTime);
      nextStepTime += stepDuration;
    }
  }

  function startScheduler() {
    if (scheduler != null) return;
    scheduler = globalThis.setInterval(tick, SCORE_SCHEDULER_INTERVAL_MS);
  }

  function stopScheduler() {
    if (scheduler == null) return;
    globalThis.clearInterval(scheduler);
    scheduler = null;
  }

  function setProgress(nextProgress) {
    progress = Math.min(1, Math.max(0, Number(nextProgress) || 0));
  }

  function setPlaying(nextPlaying) {
    playing = Boolean(nextPlaying);
    if (!playing || !enabled || destroyed) {
      setMasterLevel(0, 0.12);
      stopScheduler();
      return;
    }
    if (!ensureGraph()) return;
    context.resume?.().catch(() => {});
    stepIndex = Math.max(0, Math.floor(progress * 90));
    nextStepTime = context.currentTime + 0.035;
    setMasterLevel(0.34, 0.28);
    startScheduler();
    tick();
  }

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (!enabled) {
      setMasterLevel(0, 0.09);
      stopScheduler();
    }
  }

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(context.sampleRate * 0.75);
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    const random = mulberry32(plan.seed ^ 0x85ebca6b);
    for (let index = 0; index < length; index += 1) channel[index] = random() * 2 - 1;
    return noiseBuffer;
  }

  function triggerRupture(time) {
    const sub = context.createOscillator();
    const subGain = context.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(82, time);
    sub.frequency.exponentialRampToValueAtTime(29, time + 0.64);
    subGain.gain.setValueAtTime(0.0001, time);
    subGain.gain.exponentialRampToValueAtTime(0.19, time + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.7);
    sub.connect(subGain);
    subGain.connect(master);
    sub.start(time);
    sub.stop(time + 0.74);
    disconnectAfter(sub, [subGain]);

    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = getNoiseBuffer();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, time);
    filter.frequency.exponentialRampToValueAtTime(110, time + 0.42);
    noiseGain.gain.setValueAtTime(0.12, time);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.46);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(time);
    noise.stop(time + 0.5);
    disconnectAfter(noise, [filter, noiseGain]);
  }

  function triggerRepair(time) {
    [0, 7, 15].forEach((offset, index) => {
      scheduleTone({
        midi: plan.root + 36 + offset,
        time: time + index * 0.055,
        duration: 1.15 + index * 0.22,
        gain: 0.038 - index * 0.006,
        type: 'sine',
        attack: 0.006,
        filterFrequency: 6200,
        send: 0.74,
      });
    });
  }

  function triggerStructuralEvent(kind) {
    if (!context || !playing || !enabled || destroyed) return;
    const now = context.currentTime;
    if (now - lastImpactAt < 0.075) return;
    lastImpactAt = now;
    if (kind === 'repair') triggerRepair(now);
    else triggerRupture(now);
  }

  function destroy() {
    destroyed = true;
    stopScheduler();
    if (!context) return;
    setMasterLevel(0, 0.04);
    globalThis.setTimeout(() => context?.close?.().catch(() => {}), 80);
  }

  return {
    destroy,
    setEnabled,
    setPlaying,
    setProgress,
    triggerStructuralEvent,
    getState: () => ({ enabled, playing, progress, contextState: context?.state || 'uninitialized' }),
  };
}
