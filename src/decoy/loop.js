/**
 * Boucle naturelle : alterne segments, reverse vidéo seulement,
 * raccords soft, rotation d'assemblages anti-répétition.
 * Les zones parole (skipRegions) sont déjà retirées des segments à l'analyse.
 */

export function createLoopPlayer({ onFrame, onAudioLevel, getTransitionMs, externalAudioCtx, externalGain }) {
  let video = null;
  let url = null;
  let meta = null;
  let assemblyIndex = 0;
  let stepIndex = 0;
  let playing = false;
  let raf = 0;
  let audioCtx = null;
  let gain = null;
  let sourceNode = null;
  let mediaSource = null;
  let analyser = null;
  let reverseCanvas = null;
  let reverseCtx = null;
  let lastSegKey = '';
  let segStartedAt = 0;
  let segDuration = 1;

  function ensureVideo() {
    if (video) return video;
    video = document.createElement('video');
    video.muted = false;
    video.volume = 0.0001; // quasi muet localement ; le graphe WebAudio prend le relais
    video.playsInline = true;
    video.preload = 'auto';
    return video;
  }

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = externalAudioCtx || new AudioContext();
    gain = externalGain || audioCtx.createGain();
    if (!externalGain) gain.gain.value = 1;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    if (!externalGain) {
      gain.connect(analyser);
      analyser.connect(audioCtx.destination);
    } else {
      gain.connect(analyser);
    }
    if (video && !mediaSource) {
      try {
        mediaSource = audioCtx.createMediaElementSource(video);
        mediaSource.connect(gain);
      } catch {
        // déjà connecté
      }
    }
  }

  async function load(blob, analysis) {
    stop();
    meta = analysis;
    ensureVideo();
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    video.src = url;
    await video.play().catch(() => {});
    video.pause();
    assemblyIndex = 0;
    stepIndex = 0;
  }

  function currentAssembly() {
    const list = meta?.assemblies || [];
    if (!list.length) return { steps: [{ id: 0, reverse: false }] };
    return list[assemblyIndex % list.length];
  }

  function currentStep() {
    const asm = currentAssembly();
    const steps = asm.steps || [];
    if (!steps.length) return { id: 0, reverse: false };
    return steps[stepIndex % steps.length];
  }

  function segmentFor(step) {
    const segs = meta?.segments || [];
    return segs.find((s) => s.id === step.id) || segs[0] || { start: 0, end: meta?.duration || 1, reverseSafe: false };
  }

  async function play() {
    if (!video || !meta) return;
    playing = true;
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    advanceSegment(true);
    tick();
  }

  function advanceSegment(force) {
    const step = currentStep();
    const seg = segmentFor(step);
    const key = `${assemblyIndex}:${stepIndex}:${step.id}:${step.reverse}`;
    if (!force && key === lastSegKey) return;
    lastSegKey = key;
    const start = seg.start;
    const end = seg.end;
    segDuration = Math.max(0.2, end - start);
    segStartedAt = performance.now();
    video.playbackRate = 1;
    // Audio jamais reverse : même en reverse vidéo on garde le son forward (volume bas sur reverse)
    video.muted = !!(step.reverse && seg.reverseSafe);
    video.currentTime = step.reverse && seg.reverseSafe ? end : start;
    video.play().catch(() => {});
  }

  function tick() {
    if (!playing) return;
    raf = requestAnimationFrame(tick);
    const step = currentStep();
    const seg = segmentFor(step);
    const start = seg.start;
    const end = seg.end;
    const elapsed = (performance.now() - segStartedAt) / 1000;
    const reverse = !!(step.reverse && seg.reverseSafe);

    if (reverse) {
      const t = end - elapsed;
      if (t <= start + 0.02 || video.currentTime <= start + 0.02) {
        nextStep();
        return;
      }
      if (Math.abs(video.currentTime - t) > 0.08) video.currentTime = t;
      emitFrame(true);
    } else {
      if (video.currentTime >= end - 0.04 || elapsed >= segDuration) {
        nextStep();
        return;
      }
      emitFrame(false);
    }

    if (analyser && onAudioLevel) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      onAudioLevel(Math.sqrt(sum / data.length));
    }
  }

  function emitFrame(reversed) {
    if (!onFrame || !video) return;
    if (!reversed) {
      onFrame(video, 1);
      return;
    }
    if (!reverseCanvas) {
      reverseCanvas = document.createElement('canvas');
      reverseCtx = reverseCanvas.getContext('2d');
    }
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (reverseCanvas.width !== w) reverseCanvas.width = w;
    if (reverseCanvas.height !== h) reverseCanvas.height = h;
    reverseCtx.save();
    reverseCtx.translate(w, 0);
    reverseCtx.scale(-1, 1);
    reverseCtx.drawImage(video, 0, 0, w, h);
    reverseCtx.restore();
    onFrame(reverseCanvas, 1);
  }

  function nextStep() {
    const asm = currentAssembly();
    stepIndex += 1;
    if (stepIndex >= (asm.steps?.length || 1)) {
      stepIndex = 0;
      assemblyIndex = (assemblyIndex + 1) % Math.max(1, meta?.assemblies?.length || 1);
    }
    const xfade = typeof getTransitionMs === 'function' ? getTransitionMs() : 400;
    // petit soft cut via opacity callback handled by transition engine; here just advance
    void xfade;
    advanceSegment(true);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    try {
      video?.pause();
    } catch {
      // ignore
    }
    lastSegKey = '';
  }

  function dispose() {
    stop();
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    try {
      sourceNode?.stop();
    } catch {
      // ignore
    }
    audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  function setOutputGain(v) {
    if (gain) gain.gain.value = Math.max(0, Math.min(1, v));
  }

  return { load, play, stop, dispose, setOutputGain, get playing() { return playing; } };
}
