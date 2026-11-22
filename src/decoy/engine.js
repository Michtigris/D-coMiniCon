import { analyzeCapsuleBlob, findBestBridge, findBestEntry } from './analyze.js';
import * as capsulesApi from './capsules.js';
import { openRealAV, probeVirtualDrivers, stopStream } from './io.js';
import { createLoopPlayer } from './loop.js';
import { averagePoses, createPoseSampler } from './pose.js';
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
    externalAudioCtx: virtualOut.audioContext,
    externalGain: virtualOut.simGainNode
  });
  return loopPlayer;
}
let simBlobCache = new Map();
let starting = false;
const livePoseSampler = createPoseSampler();
let bridging = false;

function defaultSettings() {
  return {
    recordSeconds: 90,
    transitionMs: 900,
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

export function getLiveStream() {
  return live?.stream || null;
}

export function bindPreview(videoEl) {
  previewVideoEl = videoEl;
  if (!videoEl) return;
  // Dimensionne + peint une frame avant captureStream (sinon écran noir)
  if (liveVideoEl?.videoWidth) {
    mixer.resize(liveVideoEl.videoWidth, liveVideoEl.videoHeight);
  } else {
    mixer.resize(640, 360);
  }
  mixer.tick();
  // Preview fiable : flux live direct (le composite reste pour la sortie virtuelle)
  if (live?.stream) {
    videoEl.srcObject = live.stream;
  } else {
    videoEl.srcObject = mixer.canvas.captureStream(30);
  }
  videoEl.muted = true;
  videoEl.playsInline = true;
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
  if (simBlobCache.has(id)) {
    const cached = simBlobCache.get(id);
    if (cached?.analysis?.version >= 2 && cached.analysis?.segments?.[0]?.x0 != null) return cached;
  }
  const loaded = await capsulesApi.loadCapsuleBlob(id);
  if (!loaded) throw new Error('Capsule introuvable');
  let analysis = loaded.meta?.analysis;
  const needsRebuild = !analysis || analysis.version < 2 || analysis.segments?.[0]?.x0 == null;
  if (needsRebuild) {
    state.statusText = 'Analyse capsule…';
    emit();
    analysis = await analyzeCapsuleBlob(loaded.blob, {
      speechFilter: state.settings.speechFilter,
      vad: { maxSpeechRatio: state.settings.maxSpeechRatio }
    });
    // Met à jour l’index disque sans dupliquer le fichier
    try {
      await capsulesApi.updateAnalysis(id, analysis);
    } catch {
      // cache mémoire suffit pour cette session
    }
  }
  const pack = { id, blob: loaded.blob, analysis };
  simBlobCache.set(id, pack);
  return pack;
}

async function buildLibrary(preferredId) {
  const ids = [];
  if (preferredId) ids.push(preferredId);
  for (const c of state.capsules || []) {
    if (!ids.includes(c.id)) ids.push(c.id);
  }
  const lib = [];
  for (const id of ids.slice(0, 8)) {
    try {
      lib.push(await loadSim(id));
    } catch {
      // skip
    }
  }
  return lib;
}

function sampleLiveNow() {
  if (!liveVideoEl) return { x: 0.5, y: 0.45, dx: 0, dy: 0, speed: 0, energy: 0 };
  return (
    livePoseSampler.sampleFromSource(liveVideoEl) || {
      x: 0.5,
      y: 0.45,
      dx: 0,
      dy: 0,
      speed: 0,
      energy: 0
    }
  );
}

async function sampleLiveStable() {
  livePoseSampler.reset();
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    samples.push(sampleLiveNow());
    await sleep(40);
  }
  return averagePoses(samples) || sampleLiveNow();
}

export async function startSimulation(capsuleId, opts = {}) {
  if (!state.enabled) throw new Error('My Decoy inactif');
  const preferred = capsuleId || state.activeCapsuleId;
  if (!preferred && !(state.capsules || []).length) throw new Error('Aucune capsule');

  virtualOut.attachLiveStream(live.stream);
  // Pose live stabilisée (sinon match sur une frame foireuse)
  const livePose = await sampleLiveStable();
  const library = await buildLibrary(preferred);
  if (!library.length) throw new Error('Capsule introuvable');

  const entry = findBestEntry(library, livePose) || {
    capsuleId: library[0].id,
    seg: library[0].analysis.segments[0],
    reverse: false,
    t: library[0].analysis.segments[0]?.start || 0,
    rate: 1,
    score: 2
  };

  const pack = library.find((p) => p.id === entry.capsuleId) || library[0];
  state.activeCapsuleId = pack.id;
  mixer.setPoseFit(entry.score);
  const player = ensureLoopPlayer();
  await player.load(pack.blob, pack.analysis);

  // Seek sur la bonne frame AVANT d’afficher la simu
  const hint = { seg: entry.seg, reverse: entry.reverse, rate: entry.rate, t: entry.t };
  await player.prepareEntry(hint);
  await player.play();

  const fit = Math.max(0, Math.min(1, 1 - (entry.score || 1) / 1.6));
  // bon match → cut / ultra court ; mauvais → un peu plus long mais toujours serré
  const ms = fit >= 0.7 ? 90 : fit >= 0.45 ? 160 : 260;
  if (fit >= 0.7) mixer.cut('sim');
  else mixer.go('sim', opts.soft ? Math.min(200, ms) : ms);
  state.mode = 'sim';
  state.statusText = state.recording ? 'Simu + enregistrement' : 'Simulation';
  emit();
}

export async function stopSimulation() {
  if (bridging) return;
  bridging = true;
  try {
    const livePose = await sampleLiveStable();
    const fromPose = loopPlayer?.getCurrentPose?.() || livePose;
    const library = await buildLibrary(state.activeCapsuleId);
    const bridge = findBestBridge(library, fromPose, livePose);
    if (bridge && loopPlayer) {
      mixer.setPoseFit(bridge.score);
      const pack = library.find((p) => p.id === bridge.capsuleId);
      if (pack && pack.id !== state.activeCapsuleId) {
        await loopPlayer.load(pack.blob, pack.analysis);
        await loopPlayer.play();
      }
      loopPlayer.playBridge(bridge);
      // laisse le pont aller jusqu’à la pose live, puis CUT (pas de fondu visible)
      const bridgeMs = Math.max(500, Math.min(1600, (bridge.seg.end - bridge.seg.start) * 1000 * 0.92));
      await sleep(bridgeMs);
    }
    mixer.cut('live');
    loopPlayer?.stop();
    state.mode = state.recording ? 'record' : 'live';
    state.statusText = state.recording ? 'Enregistrement' : 'Direct → virtuel';
    emit();
  } finally {
    bridging = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function toggleSimulation() {
  if (!state.enabled) return getState();
  if (bridging) return getState();
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
    // notifier le scraper pour se recoller au nouveau flux
    try {
      window.__decoyLiveStreamChanged?.(live.stream);
    } catch {
      // ignore
    }
    if (previewVideoEl) bindPreview(previewVideoEl);
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
