import { virtualAudioOutputs } from './devices.js';

/**
 * Sortie virtuelle :
 * - Vidéo : frames RGB → main process (OBS Virtual Cam shared memory via koffi)
 * - Audio : WebAudio → élément HTML audio avec setSinkId (CABLE Input)
 */

export function createVirtualOutput() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const audioEl = new Audio();
  audioEl.autoplay = true;
  audioEl.volume = 1;

  let audioCtx = null;
  let dest = null;
  let liveSource = null;
  let simSource = null;
  let liveGain = null;
  let simGainNode = null;
  let pushing = false;
  let raf = 0;
  let sinkId = '';
  let frameBusy = false;
  let lastPush = 0;
  let status = { video: 'idle', audio: 'idle', detail: '' };
  const pushCanvas = document.createElement('canvas');
  pushCanvas.width = 640;
  pushCanvas.height = 360;
  const pushCtx = pushCanvas.getContext('2d', { willReadFrequently: true });

  function ensureAudioGraph() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    dest = audioCtx.createMediaStreamDestination();
    liveGain = audioCtx.createGain();
    simGainNode = audioCtx.createGain();
    liveGain.gain.value = 1;
    simGainNode.gain.value = 0;
    liveGain.connect(dest);
    simGainNode.connect(dest);
    audioEl.srcObject = dest.stream;
  }

  async function setAudioSink(deviceId) {
    ensureAudioGraph();
    sinkId = deviceId || '';
    if (!sinkId) {
      const outs = await virtualAudioOutputs();
      sinkId = outs[0]?.deviceId || '';
    }
    if (sinkId && audioEl.setSinkId) {
      try {
        await audioEl.setSinkId(sinkId);
        status.audio = 'ok';
        status.detail = '';
        await audioEl.play().catch(() => {});
        return true;
      } catch (err) {
        status.audio = 'error';
        status.detail = err?.message || 'setSinkId impossible';
        return false;
      }
    }
    status.audio = 'missing';
    status.detail = 'Aucun CABLE Input / VB-Audio détecté';
    // fallback : joue quand même en local pour preview interne
    await audioEl.play().catch(() => {});
    return false;
  }

  function attachLiveStream(stream) {
    ensureAudioGraph();
    try {
      liveSource?.disconnect();
    } catch {
      // ignore
    }
    if (!stream?.getAudioTracks?.().length) return;
    liveSource = audioCtx.createMediaStreamSource(stream);
    liveSource.connect(liveGain);
  }

  function setGains(live, sim) {
    ensureAudioGraph();
    const now = audioCtx.currentTime;
    // Suivi serré du mixer (equal-power) — pas de 2e courbe qui décale
    liveGain.gain.setTargetAtTime(Math.max(0, Math.min(1, live)), now, 0.015);
    simGainNode.gain.setTargetAtTime(Math.max(0, Math.min(1, sim)), now, 0.015);
  }

  function drawSource(source) {
    if (!source) return;
    const w = canvas.width;
    const h = canvas.height;
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch {
      // ignore
    }
  }

  async function pushFrame() {
    const now = performance.now();
    if (frameBusy || now - lastPush < 66) return; // ~15 fps
    frameBusy = true;
    lastPush = now;
    try {
      pushCtx.drawImage(canvas, 0, 0, pushCanvas.width, pushCanvas.height);
      const image = pushCtx.getImageData(0, 0, pushCanvas.width, pushCanvas.height);
      const result = await window.deco.decoyPushFrame({
        width: pushCanvas.width,
        height: pushCanvas.height,
        data: image.data
      });
      if (result?.ok) status.video = 'ok';
      else {
        status.video = result?.reason === 'missing' ? 'missing' : 'error';
        status.detail = result?.message || status.detail;
      }
    } catch (err) {
      status.video = 'error';
      status.detail = err?.message || 'push frame';
    } finally {
      frameBusy = false;
    }
  }

  function start(getCompositeCanvas) {
    if (pushing) return;
    pushing = true;
    const loop = () => {
      if (!pushing) return;
      raf = requestAnimationFrame(loop);
      const src = typeof getCompositeCanvas === 'function' ? getCompositeCanvas() : null;
      if (src) drawSource(src);
      pushFrame();
    };
    loop();
  }

  function stop() {
    pushing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    try {
      window.deco.decoyStopVirtual();
    } catch {
      // ignore
    }
  }

  function dispose() {
    stop();
    try {
      liveSource?.disconnect();
      simSource?.disconnect();
    } catch {
      // ignore
    }
    audioEl.srcObject = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  function getMicLevel() {
    return 0;
  }

  return {
    canvas,
    attachLiveStream,
    setAudioSink,
    setGains,
    start,
    stop,
    dispose,
    getMicLevel,
    getStatus: () => ({ ...status, sinkId }),
    get audioContext() {
      ensureAudioGraph();
      return audioCtx;
    },
    get simGainNode() {
      ensureAudioGraph();
      return simGainNode;
    }
  };
}
