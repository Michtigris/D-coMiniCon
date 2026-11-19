import { analyzeCapsuleBlob } from './analyze.js';
import * as capsulesApi from './capsules.js';
import { openRealAV, probeVirtualDrivers, stopStream } from './io.js';
import { createLoopPlayer } from './loop.js';
import { createRecorder } from './recorder.js';
import { createTransitionMixer } from './transition.js';
import { createVirtualOutput } from './virtual.js';

/**
 * Orchestrateur My Decoy :
 * - bus direct permanent
 * - record indépendant (y compris pendant sim)
 * - simulation via loop + transitions
 * - sortie virtuelle pour apps externes
 */

const listeners = new Set();

const state = {
  enabled: false,
  mode: 'live', // live | record | sim
  statusText: '',
  error: '',
  micLevel: 0,
  drivers: null,
  capsules: [],
  activeCapsuleId: null,
  recording: false,
  recordElapsedMs: 0,
  settings: defaultSettings()
};

let live = null;
let liveVideoEl = null;
let previewVideoEl = null;
let levelTimer = 0;
let recordTimer = 0;
let raf = 0;
let audioCtx = null;
let analyser = null;
let analyserSource = null;
const recorder = createRecorder();
const mixer = createTransitionMixer();
const virtualOut = createVirtualOutput();
let loopPlayer = null;

function ensureLoopPlayer() {
  if (loopPlayer) return loopPlayer;
  loopPlayer = createLoopPlayer({
    onFrame: (source) => {
      mixer.setSimSource(source);
    },
    onAudioLevel: () => {},
    getTransitionMs: () => state.settings.transitionMs,
    externalAudioCtx: virtualOut.audioContext,
    externalGain: virtualOut.simGainNode
  });
  return loopPlayer;
}
let simBlobCache = new Map();
let starting = false;

function defaultSettings() {
  return {
    recordSeconds: 90,
    transitionMs: 1400,
    speechFilter: true,
    hotkey: 'F9',
    maxSpeechRatio: 0.35,
    loopHoursTarget: 3
  };
}

function emit() {
  const snap = getState();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      // ignore
    }
  }
}

export function getState() {
  return {
    ...state,
    drivers: state.drivers,
    transitioning: mixer.getState().transitioning,
    virtual: virtualOut.getStatus()
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(getState());
  return () => listeners.delete(fn);
}

export function applySettings(patch) {
  state.settings = { ...state.settings, ...patch };
  mixer.setDuration(state.settings.transitionMs);
  emit();
}

async function refreshCapsules() {
  state.capsules = await capsulesApi.listCapsules();
  emit();
}

export async function enable(opts = {}) {
  if (state.enabled || starting) return getState();
  starting = true;
  state.error = '';
  try {
    if (opts.settings) applySettings(opts.settings);
    state.drivers = await probeVirtualDrivers();
    live = await openRealAV({
      videoDeviceId: opts.videoDeviceId,
      audioDeviceId: opts.audioDeviceId,
      onTrackEnded: (kind) => {
        state.error = kind === 'video' ? 'Caméra déconnectée' : 'Micro déconnecté';
        recoverDeviceLoss().catch(() => {});
        emit();
      }
    });

    liveVideoEl = document.createElement('video');
    liveVideoEl.muted = true;
    liveVideoEl.playsInline = true;
    liveVideoEl.srcObject = live.stream;
    await liveVideoEl.play().catch(() => {});
    mixer.setLiveVideo(liveVideoEl);
    if (liveVideoEl.videoWidth) mixer.resize(liveVideoEl.videoWidth, liveVideoEl.videoHeight);

    setupLevels(live.stream);
    virtualOut.attachLiveStream(live.stream);
    await virtualOut.setAudioSink(opts.audioSinkId);
    virtualOut.start(() => mixer.tick());
    startRenderLoop();

    state.enabled = true;
    state.mode = 'live';
    state.statusText = 'Direct → virtuel';
    mixer.go('live', 0);
    await refreshCapsules();
    if (state.activeCapsuleId) {
      // keep selection
    } else if (state.capsules[0]) {
      state.activeCapsuleId = state.capsules[0].id;
    }
    emit();
    return getState();
  } catch (err) {
    state.error = err?.message || 'Activation My Decoy impossible';
    await disable();
    emit();
    throw err;
  } finally {
    starting = false;
  }
}

export async function disable() {
  stopRenderLoop();
  clearInterval(levelTimer);
  levelTimer = 0;
  clearInterval(recordTimer);
  recordTimer = 0;
  recorder.cancel();
  loopPlayer?.dispose();
  loopPlayer = null;
  virtualOut.dispose();
  stopStream(live?.stream);
  live = null;
  if (liveVideoEl) {
    liveVideoEl.srcObject = null;
    liveVideoEl = null;
  }
  try {
    analyserSource?.disconnect();
  } catch {
    // ignore
  }
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  state.enabled = false;
  state.mode = 'live';
  state.recording = false;
  state.statusText = '';
  emit();
  return getState();
}

function setupLevels(stream) {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyserSource = audioCtx.createMediaStreamSource(stream);
  analyserSource.connect(analyser);
  clearInterval(levelTimer);
  levelTimer = setInterval(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    state.micLevel = Math.sqrt(sum / data.length);
    emit();
  }, 100);
}

function startRenderLoop() {
  stopRenderLoop();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const frame = mixer.tick();
    virtualOut.setGains(mixer.liveGain, mixer.simGain);
    if (previewVideoEl && frame) {
      // preview uses canvas stream once
    }
  };
  tick();
}

function stopRenderLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

export function bindPreview(videoEl) {
  previewVideoEl = videoEl;
  if (!videoEl) return;
  const stream = mixer.canvas.captureStream(30);
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.play().catch(() => {});
}

export async function startRecord() {
  if (!state.enabled || !live?.stream) throw new Error('My Decoy inactif');
  if (recorder.recording()) return;
  // Multi-capsule : on enregistre le LIVE même si simulation en cours
  const maxMs = Math.round((state.settings.recordSeconds || 90) * 1000);
  await recorder.start(live.stream, { maxMs });
  state.recording = true;
  state.mode = state.mode === 'sim' ? 'sim' : 'record';
  state.statusText = state.mode === 'sim' ? 'Simu + enregistrement' : 'Enregistrement';
  clearInterval(recordTimer);
  recordTimer = setInterval(() => {
    state.recordElapsedMs = recorder.elapsedMs();
    emit();
  }, 200);
  emit();
}

export async function stopRecord(name) {
  if (!recorder.recording()) return null;
  const result = await recorder.stop();
  clearInterval(recordTimer);
  recordTimer = 0;
  state.recording = false;
  state.recordElapsedMs = 0;
  if (!result?.blob) {
    state.mode = mixer.mode === 'sim' ? 'sim' : 'live';
    emit();
    return null;
  }

  state.statusText = 'Analyse capsule…';
  emit();
  const analysis = await analyzeCapsuleBlob(result.blob, {
    speechFilter: state.settings.speechFilter,
    vad: { maxSpeechRatio: state.settings.maxSpeechRatio, marginSec: 1 }
  });
  const saved = await capsulesApi.saveCapsule({
    name: name || `Capsule ${new Date().toLocaleString('fr-FR')}`,
    blob: result.blob,
    analysis,
    durationMs: result.durationMs
  });
  await refreshCapsules();
  if (saved?.id) state.activeCapsuleId = saved.id;
  state.mode = mixer.mode === 'sim' ? 'sim' : 'live';
  state.statusText = mixer.mode === 'sim' ? 'Simulation' : 'Direct → virtuel';
  emit();
  return saved;
}

export async function selectCapsule(id) {
  state.activeCapsuleId = id;
  if (state.mode === 'sim' || mixer.mode === 'sim') {
    await startSimulation(id, { soft: true });
  }
  emit();
}

export async function renameCapsule(id, name) {
  await capsulesApi.renameCapsule(id, name);
  await refreshCapsules();
}

export async function deleteCapsule(id) {
  await capsulesApi.deleteCapsule(id);
  simBlobCache.delete(id);
  if (state.activeCapsuleId === id) state.activeCapsuleId = state.capsules.find((c) => c.id !== id)?.id || null;
  await refreshCapsules();
  if ((state.mode === 'sim' || mixer.mode === 'sim') && state.activeCapsuleId) {
    await startSimulation(state.activeCapsuleId, { soft: true });
  } else if (state.mode === 'sim') {
    await stopSimulation();
  }
}

async function loadSim(id) {
  if (simBlobCache.has(id)) return simBlobCache.get(id);
  const loaded = await capsulesApi.loadCapsuleBlob(id);
  if (!loaded) throw new Error('Capsule introuvable');
  let analysis = loaded.meta?.analysis;
  if (!analysis) {
    analysis = await analyzeCapsuleBlob(loaded.blob, {
      speechFilter: state.settings.speechFilter,
      vad: { maxSpeechRatio: state.settings.maxSpeechRatio }
    });
  }
  const pack = { blob: loaded.blob, analysis };
  simBlobCache.set(id, pack);
  return pack;
}

export async function startSimulation(capsuleId, opts = {}) {
  if (!state.enabled) throw new Error('My Decoy inactif');
  const id = capsuleId || state.activeCapsuleId;
  if (!id) throw new Error('Aucune capsule sélectionnée');
  const pack = await loadSim(id);
  state.activeCapsuleId = id;
  // s'assurer que le graphe audio virtuel existe avant de brancher la capsule
  virtualOut.attachLiveStream(live.stream);
  const player = ensureLoopPlayer();
  await player.load(pack.blob, pack.analysis);
  await player.play();
  mixer.setDuration(state.settings.transitionMs);
  mixer.go('sim', opts.soft ? Math.max(700, state.settings.transitionMs * 0.75) : state.settings.transitionMs);
  state.mode = state.recording ? 'sim' : 'sim';
  state.statusText = state.recording ? 'Simu + enregistrement' : 'Simulation';
  emit();
}

export async function stopSimulation() {
  mixer.go('live', state.settings.transitionMs);
  loopPlayer?.stop();
  state.mode = state.recording ? 'record' : 'live';
  state.statusText = state.recording ? 'Enregistrement' : 'Direct → virtuel';
  emit();
}

export async function toggleSimulation() {
  if (!state.enabled) return getState();
  if (mixer.mode === 'sim' || mixer.getState().to === 'sim') {
    await stopSimulation();
  } else {
    await startSimulation();
  }
  return getState();
}

async function recoverDeviceLoss() {
  // tente de relancer le live sans couper brutalement trop longtemps
  try {
    stopStream(live?.stream);
    live = await openRealAV({
      onTrackEnded: () => {
        state.error = 'Périphérique perdu';
        emit();
      }
    });
    liveVideoEl.srcObject = live.stream;
    await liveVideoEl.play().catch(() => {});
    mixer.setLiveVideo(liveVideoEl);
    virtualOut.attachLiveStream(live.stream);
    setupLevels(live.stream);
    state.error = '';
    state.statusText = 'Direct récupéré';
    emit();
  } catch (err) {
    state.error = err?.message || 'Récupération impossible';
    emit();
  }
}

export async function refreshDrivers() {
  state.drivers = await probeVirtualDrivers();
  emit();
  return state.drivers;
}
