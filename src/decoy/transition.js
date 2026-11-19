/**
 * Transitions quasi invisibles Direct ↔ Simulation.
 * Equal-power crossfade audio + fondu vidéo avec léger flou au milieu.
 */

function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - (-2 * t + 2) ** 5 / 2;
}

function equalPower(t) {
  const a = Math.max(0, Math.min(1, t));
  return {
    a: Math.cos(a * 0.5 * Math.PI),
    b: Math.sin(a * 0.5 * Math.PI)
  };
}

export function createTransitionMixer({ width = 640, height = 480 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const blurCanvas = document.createElement('canvas');
  const blurCtx = blurCanvas.getContext('2d');

  let mode = 'live'; // live | sim | xfade
  let from = 'live';
  let to = 'live';
  let progress = 1;
  let durationMs = 1400;
  let startedAt = 0;
  let liveVideo = null;
  let simSource = null;
  let liveGain = 1;
  let simGain = 0;
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
      transitioning: mode === 'xfade'
    };
  }

  function setLiveVideo(el) {
    liveVideo = el;
  }

  function setSimSource(el) {
    simSource = el;
  }

  function setDuration(ms) {
    durationMs = Math.max(400, Math.min(2800, Number(ms) || 1400));
  }

  function go(target, ms) {
    if (ms != null) setDuration(ms);
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
    if (blurPx > 0.4) {
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
      const gains = equalPower(eased); // a: cos 1→0, b: sin 0→1
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

    // Flou max au milieu du fondu (~6% de la largeur visuelle)
    const mid = mode === 'xfade' ? Math.sin(progress * Math.PI) : 0;
    const blurPx = mid * Math.max(2, w * 0.012);

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
