import { findNextSegment } from './analyze.js';
import { segmentEndpoints } from './pose.js';

/**
 * Boucle intelligente : enchaîne micro-segments par position/direction,
 * reverse sélectif, anti-répétition, vitesse vidéo ajustée (audio coupé si rate ≠ 1).
 */

export function createLoopPlayer({ onFrame, onAudioLevel, externalAudioCtx, externalGain }) {
  let video = null;
  let url = null;
  let meta = null;
  let playing = false;
  let raf = 0;
  let audioCtx = null;
  let gain = null;
  let mediaSource = null;
  let analyser = null;
  let reverseCanvas = null;
  let reverseCtx = null;
  let current = null; // { seg, reverse, rate, key }
  let recentKeys = [];
  let segStartedAt = 0;
  let segDuration = 1;
  let entryHint = null;

  function ensureVideo() {
    if (video) return video;
    video = document.createElement('video');
    video.muted = false;
    video.volume = 0.0001;
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
        // already
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
    recentKeys = [];
    current = null;
  }

  function setEntry(hint) {
    entryHint = hint; // { seg, reverse, rate, t }
  }

  function pickFirst() {
    if (entryHint?.seg) {
      const h = entryHint;
      entryHint = null;
      return {
        seg: h.seg,
        reverse: !!h.reverse,
        rate: clampRate(h.rate || 1),
        t: Number.isFinite(h.t) ? h.t : null,
        key: `${h.seg.id}:${h.reverse ? 1 : 0}`
      };
    }
    const segs = meta?.segments || [];
    if (!segs.length) return null;
    return { seg: segs[0], reverse: false, rate: 1, t: null, key: `${segs[0].id}:0` };
  }

  async function play() {
    if (!video || !meta) return;
    playing = true;
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!current?.seg) current = pickFirst();
    advanceCurrent(true);
    tick();
  }

  function clampRate(r) {
    return Math.max(0.85, Math.min(1.15, Number(r) || 1));
  }

  function advanceCurrent(force) {
    if (!current?.seg) {
      current = pickFirst();
      if (!current) return;
    }
    const { seg, reverse, rate } = current;
    const key = current.key || `${seg.id}:${reverse ? 1 : 0}`;
    if (!force && key === recentKeys[recentKeys.length - 1]) return;
    recentKeys.push(key);
    if (recentKeys.length > 14) recentKeys.shift();

    const start = reverse ? seg.end : seg.start;
    const end = reverse ? seg.start : seg.end;
    // t exact = frame matchée (live→synt)
    let seekTo = reverse ? seg.end : seg.start;
    if (!reverse && Number.isFinite(current.t)) {
      seekTo = Math.max(seg.start, Math.min(seg.end - 0.05, current.t));
    }
    const remain = reverse ? Math.abs(seekTo - seg.start) : Math.abs(seg.end - seekTo);
    segDuration = Math.max(0.2, remain / Math.max(0.85, rate));
    segStartedAt = performance.now();
    const r = clampRate(rate);
    video.playbackRate = reverse ? 1 : r;
    // Son : jamais reverse, et pas de pitch bizarre → mute si rate hors ~1 ou reverse
    const rateOk = Math.abs(r - 1) < 0.04;
    video.muted = reverse || !rateOk;
    video.currentTime = seekTo;
    current.t = null; // one-shot
    video.play().catch(() => {});
  }

  /** Seek prêt avant de montrer la simu (évite 1ère frame random). */
  function prepareEntry(hint) {
    return new Promise((resolve) => {
      if (!video || !hint?.seg) {
        resolve(false);
        return;
      }
      setEntry(hint);
      current = pickFirst();
      if (!current) {
        resolve(false);
        return;
      }
      const seg = current.seg;
      let seekTo = current.reverse ? seg.end : seg.start;
      if (!current.reverse && Number.isFinite(hint.t)) {
        seekTo = Math.max(seg.start, Math.min(seg.end - 0.05, hint.t));
      }
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve(true);
      };
      video.addEventListener('seeked', done);
      video.currentTime = seekTo;
      // fallback si déjà pile
      setTimeout(() => {
        video.removeEventListener('seeked', done);
        resolve(true);
      }, 280);
    });
  }

  function tick() {
    if (!playing) return;
    raf = requestAnimationFrame(tick);
    if (!current?.seg) return;
    const { seg, reverse, rate } = current;
    const r = clampRate(rate);
    const elapsed = (performance.now() - segStartedAt) / 1000;

    if (reverse) {
      const t = seg.end - elapsed;
      if (t <= seg.start + 0.03) {
        goNext();
        return;
      }
      if (Math.abs(video.currentTime - t) > 0.1) video.currentTime = Math.max(seg.start, t);
      emitFrame(true);
    } else {
      const need = (seg.end - seg.start) / r;
      if (video.currentTime >= seg.end - 0.04 || elapsed >= need) {
        goNext();
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

  function goNext() {
    const segs = meta?.segments || [];
    const nxt = findNextSegment(segs, current.seg, current.reverse, recentKeys, null);
    if (!nxt) {
      current = pickFirst();
    } else {
      current = { seg: nxt.seg, reverse: nxt.reverse, rate: nxt.rate || 1, key: nxt.key };
    }
    advanceCurrent(true);
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

  function getCurrentPose() {
    if (!current?.seg) return null;
    const { end } = segmentEndpoints(current.seg, current.reverse);
    // approx progress
    const u = Math.max(0, Math.min(1, (performance.now() - segStartedAt) / 1000 / segDuration));
    return {
      x: current.seg.x0 + (current.seg.x1 - current.seg.x0) * (current.reverse ? 1 - u : u),
      y: current.seg.y0 + (current.seg.y1 - current.seg.y0) * (current.reverse ? 1 - u : u),
      dx: end.dx,
      dy: end.dy,
      speed: end.speed
    };
  }

  function playBridge(hint) {
    if (!hint?.seg) return;
    current = {
      seg: hint.seg,
      reverse: !!hint.reverse,
      rate: clampRate(hint.rate || 1),
      key: `bridge:${hint.seg.id}:${hint.reverse ? 1 : 0}`
    };
    advanceCurrent(true);
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
  }

  function dispose() {
    stop();
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    mediaSource = null;
    if (!externalAudioCtx) audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  return {
    load,
    play,
    stop,
    dispose,
    setEntry,
    prepareEntry,
    playBridge,
    getCurrentPose,
    get playing() {
      return playing;
    },
    get current() {
      return current;
    }
  };
}
