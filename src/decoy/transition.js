/**
 * Transitions Live ↔ Simulation guidées par la pose.
 * Si les poses sont proches → fondu court + léger blur.
 * Si éloignées → le moteur doit d’abord caler un pont ; ici on adoucit quand même.
 */

function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - (-2 * t + 2) ** 5 / 2;
}

function equalPower(t) {
  const a = Math.max(0, Math.min(1, t));
  return { a: Math.cos(a * 0.5 * Math.PI), b: Math.sin(a * 0.5 * Math.PI) };
}

export function createTransitionMixer({ width = 640, height = 480 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const blurCanvas = document.createElement('canvas');
  const blurCtx = blurCanvas.getContext('2d');

  let mode = 'live';
  let from = 'live';
  let to = 'live';
  let progress = 1;
  let durationMs = 900;
  let startedAt = 0;
  let liveVideo = null;
  let simSource = null;
  let liveGain = 1;
  let simGain = 0;
  let poseFit = 1; // 0 = mauvais match, 1 = excellent
  let listeners = new Set();

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(getState());
      } catch {
        // ignore
      }
    }
  }

  function getState() {
    return {
      mode,
      from,
      to,
      progress,
      liveGain,
      simGain,
      transitioning: mode === 'xfade',
      poseFit
    };
  }

  function setLiveVideo(el) {
    liveVideo = el;
  }

  function setSimSource(el) {
    simSource = el;
  }

  function setDuration(ms) {
    durationMs = Math.max(280, Math.min(2200, Number(ms) || 900));
  }

  function setPoseFit(score) {
    // score poseScore ~0 bon, ~2 mauvais → fit 1..0
    const s = Number(score);
    if (!Number.isFinite(s)) {
      poseFit = 0.5;
      return;
    }
    poseFit = Math.max(0, Math.min(1, 1 - s / 1.8));
  }

  function go(target, ms) {
    if (ms != null) setDuration(ms);
    // durée plus courte si poses alignées
    if (ms == null) {
      const fitMs = 500 + (1 - poseFit) * 900;
      setDuration(fitMs);
    }
    const current = mode === 'xfade' ? to : mode;
    to = target === 'sim' ? 'sim' : 'live';
    if (current === to && progress >= 1 && mode !== 'xfade') {
      liveGain = to === 'live' ? 1 : 0;
      simGain = to === 'sim' ? 1 : 0;
      emit();
      return;
    }
    from = current;
    if (from === to) {
      mode = to;
      progress = 1;
      liveGain = to === 'live' ? 1 : 0;
      simGain = to === 'sim' ? 1 : 0;
      emit();
      return;
    }
    mode = 'xfade';
    progress = 0;
    startedAt = performance.now();
    emit();
  }

  function toggle(ms) {
    const target = (mode === 'xfade' ? to : mode) === 'sim' ? 'live' : 'sim';
    go(target, ms);
  }

  function drawLayer(source, alpha, blurPx) {
    if (!source || alpha < 0.01) return;
    const w = canvas.width;
    const h = canvas.height;
    if (blurPx > 0.35) {
      if (blurCanvas.width !== w) blurCanvas.width = w;
      if (blurCanvas.height !== h) blurCanvas.height = h;
      blurCtx.clearRect(0, 0, w, h);
      blurCtx.filter = `blur(${blurPx.toFixed(2)}px)`;
      try {
        blurCtx.drawImage(source, 0, 0, w, h);
      } catch {
        blurCtx.filter = 'none';
        return;
      }
      blurCtx.filter = 'none';
      ctx.globalAlpha = alpha;
      ctx.drawImage(blurCanvas, 0, 0, w, h);
    } else {
      ctx.globalAlpha = alpha;
      try {
        ctx.drawImage(source, 0, 0, w, h);
      } catch {
        // ignore
      }
    }
  }

  function tick() {
    if (mode === 'xfade') {
      const t = (performance.now() - startedAt) / durationMs;
      progress = Math.max(0, Math.min(1, t));
      const eased = easeInOutQuint(progress);
      const gains = equalPower(eased);
      if (to === 'sim') {
        liveGain = gains.a;
        simGain = gains.b;
      } else {
        liveGain = gains.b;
        simGain = gains.a;
      }
      if (progress >= 1) {
        mode = to;
        liveGain = to === 'live' ? 1 : 0;
        simGain = to === 'sim' ? 1 : 0;
      }
    }

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0a1218';
    ctx.fillRect(0, 0, w, h);

    const mid = mode === 'xfade' ? Math.sin(progress * Math.PI) : 0;
    // moins de blur si bon match pose
    const blurPx = mid * Math.max(1.2, w * 0.01) * (1.15 - poseFit * 0.7);

    if (liveGain >= simGain) {
      drawLayer(liveVideo, liveGain, blurPx * liveGain);
      drawLayer(simSource, simGain, blurPx * simGain);
    } else {
      drawLayer(simSource, simGain, blurPx * simGain);
      drawLayer(liveVideo, liveGain, blurPx * liveGain);
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  function resize(w, h) {
    if (w > 0 && h > 0) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  return {
    canvas,
    setLiveVideo,
    setSimSource,
    setDuration,
    setPoseFit,
    go,
    toggle,
    tick,
    resize,
    onChange,
    getState,
    get liveGain() {
      return liveGain;
    },
    get simGain() {
      return simGain;
    },
    get mode() {
      return mode === 'xfade' ? to : mode;
    }
  };
}
