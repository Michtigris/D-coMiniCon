import { createDiodeEngine } from './diodes.js';
import { isVirtualDeviceLabel, preferredRealDeviceId, realVideoInputs } from '../decoy/devices.js';

const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';

const DIODE_KEYS = ['diode1', 'diode2', 'diode3', 'diode4', 'diode5', 'diode6'];

/**
 * Timing diodes (300 ms hold / 3 s lit) = DETECTOR.
 * Ici : front montant → action, puis 2 s global + 5 s par déclencheur.
 */
const GLOBAL_COOLDOWN_MS = 2000;
const ACTION_COOLDOWN_MS = 5000;

/** Cadence : fluide → chargé (ms entre frames). */
const WAIT_MIN = 8;
const WAIT_MAX = 120;
const SLOW_FRAME_MS = 40;
const HEAVY_FRAME_MS = 70;
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60000;
/** Partage caméra : regarde ~2 s, puis lâche ~4 s (CodeCapture / Discord / Chrome). */
const HOLD_MS = 2000;
const LEND_MS = 4000;
const BUSY_LEND_MS = 20000;
const GUM_TIMEOUT_MS = 1200;

let landmarker = null;
let loadPromise = null;
let video = null;
let detectCanvas = null;
let detectCtx = null;
let stream = null;
let running = false;
let starting = false;
let visionTimer = 0;
let retryTimer = 0;
let visionClock = 0;
let engine = null;
let prev = null;
let config = null;
let firing = new Set();
let waitMs = WAIT_MIN;
let slowStreak = 0;
let skipCounter = 0;
let retryDelay = RETRY_BASE_MS;
let yielded = false;
let holdStarted = 0;
/** Flux cam partagé (My Decoy) — on analyse sans ouvrir/stopper la cam. */
let sharedStream = null;
/** @type {Record<string, boolean>} */
let prevFlags = Object.create(null);
/** @type {Record<string, number>} */
let coolUntil = Object.create(null);
let globalCoolUntil = 0;

function resetHoldState() {
  prevFlags = Object.create(null);
  // coolUntil + globalCoolUntil conservés : survivent à un yield caméra
}

function masterOn(cfg) {
  return !!(cfg && cfg.enabled);
}

function anyDiodeOn(cfg) {
  if (!cfg?.diodes) return false;
  return Object.values(cfg.diodes).some((d) => d && d.on);
}

function shouldRun(cfg) {
  return masterOn(cfg) && anyDiodeOn(cfg);
}

function clearTimers() {
  clearTimeout(visionTimer);
  visionTimer = 0;
  clearTimeout(retryTimer);
  retryTimer = 0;
}

function releaseTracks() {
  // Ne jamais stopper un flux appartenant à My Decoy
  if (sharedStream) {
    stream = null;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // ignore
      }
    }
    return;
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.onended = null;
        track.stop();
      } catch {
        // ignore
      }
    }
  }
  stream = null;
  if (video) {
    try {
      video.srcObject = null;
    } catch {
      // ignore
    }
  }
}

function scheduleRetry(forcedDelay) {
  clearTimeout(retryTimer);
  retryTimer = 0;
  if (sharedStream || !shouldRun(config)) return;
  const delay = forcedDelay != null ? forcedDelay : retryDelay;
  if (forcedDelay == null) {
    retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.6));
  }
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    if (sharedStream || !shouldRun(config) || running || starting) return;
    startCamera().catch(() => {
      // reste en yield ; prochain retry déjà planifié via yieldCamera
    });
  }, delay);
}

function yieldCamera(reason) {
  // En mode partagé : on ne “lend” pas — My Decoy garde la cam ouverte
  if (sharedStream) {
    if (reason === 'detect-error' || reason === 'device-lost') {
      // tente de se recoller au flux partagé
      running = false;
      starting = false;
      clearTimeout(visionTimer);
      visionTimer = 0;
      if (shouldRun(config)) startFromShared().catch(() => {});
    }
    return;
  }
  running = false;
  starting = false;
  clearTimeout(visionTimer);
  visionTimer = 0;
  releaseTracks();
  engine?.reset();
  engine = null;
  prev = null;
  visionClock = 0;
  waitMs = WAIT_MIN;
  slowStreak = 0;
  skipCounter = 0;
  holdStarted = 0;
  resetHoldState();
  yielded = true;
  if (!shouldRun(config)) return;
  if (reason === 'lend') {
    retryDelay = RETRY_BASE_MS;
    scheduleRetry(LEND_MS);
    return;
  }
  if (
    reason === 'NotReadableError' ||
    reason === 'TrackStartError' ||
    reason === 'AbortError' ||
    reason === 'busy'
  ) {
    scheduleRetry(BUSY_LEND_MS);
    return;
  }
  scheduleRetry();
}

function adaptCadence(spent) {
  if (spent > HEAVY_FRAME_MS) {
    slowStreak += 2;
    waitMs = Math.min(WAIT_MAX, waitMs + 16);
  } else if (spent > SLOW_FRAME_MS) {
    slowStreak += 1;
    waitMs = Math.min(WAIT_MAX, waitMs + 8);
  } else if (spent < 20 && slowStreak === 0) {
    waitMs = Math.max(WAIT_MIN, waitMs - 2);
  } else {
    slowStreak = Math.max(0, slowStreak - 1);
    if (slowStreak === 0) waitMs = Math.max(WAIT_MIN, waitMs - 1);
  }
}

function shouldSkipFrame() {
  if (slowStreak < 3) return false;
  // Sous charge : 1 frame sur 2, puis 2 sur 3 si vraiment pire.
  const every = slowStreak >= 8 ? 3 : 2;
  skipCounter = (skipCounter + 1) % every;
  return skipCounter !== 0;
}

async function ensureLandmarker() {
  if (landmarker) return landmarker;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const vision = await import(`${VISION}/+esm`);
    const { FilesetResolver, HandLandmarker } = vision;
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    landmarker = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.35
    });
    return landmarker;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

function ensureDom() {
  if (!video) {
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
  }
  if (!detectCanvas) {
    detectCanvas = document.createElement('canvas');
    detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
  }
}

function bindTrackYield(mediaStream) {
  for (const track of mediaStream.getVideoTracks()) {
    track.onended = () => {
      if (running || starting) yieldCamera('track-ended');
    };
  }
}

/** getUserMedia avec timeout — sinon Windows bloque l’UI quand Discord tient la cam. */
function getUserMediaTimed(constraints, ms = GUM_TIMEOUT_MS) {
  let timer = 0;
  let late = false;
  const gum = navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    if (late) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      const err = new Error('getUserMedia late');
      err.name = 'AbortError';
      throw err;
    }
    return stream;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      const err = new Error('getUserMedia timeout');
      err.name = 'AbortError';
      reject(err);
    }, ms);
  });
  return Promise.race([gum, timeout]).finally(() => clearTimeout(timer));
}

/** Caméra seule — jamais de micro, jamais de caméra virtuelle My Decoy / OBS. */
async function openCamera() {
  const reals = await realVideoInputs();
  const deviceId = preferredRealDeviceId(reals);
  // Une seule tentative courte : si Discord tient la cam, on lâche tout de suite.
  const attempts = [
    deviceId
      ? { video: { deviceId: { ideal: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }
      : { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false }
  ];
  let last = null;
  for (const constraints of attempts) {
    try {
      const media = await getUserMediaTimed(constraints, GUM_TIMEOUT_MS);
      const label = media.getVideoTracks()[0]?.label || '';
      if (isVirtualDeviceLabel(label)) {
        for (const t of media.getTracks()) t.stop();
        const err = new Error('virtual device');
        err.name = 'NotFoundError';
        throw err;
      }
      return media;
    } catch (err) {
      last = err;
      const name = err?.name || '';
      if (
        name === 'NotAllowedError' ||
        name === 'SecurityError' ||
        name === 'NotReadableError' ||
        name === 'TrackStartError' ||
        name === 'AbortError'
      ) {
        throw err;
      }
    }
  }
  throw last || new Error('Caméra indisponible');
}

async function fireAction(diodeId) {
  const key = String(diodeId);
  const diode = config?.diodes?.[key];
  if (!diode?.on || !diode.action || diode.action === 'none') return;
  if (firing.has(key)) return;
  firing.add(key);
  try {
    if (diode.action === 'shortcut' && diode.shortcut) {
      await window.deco.cameraShortcut(diode.shortcut);
    } else if (diode.action === 'app' && diode.app) {
      await window.deco.cameraOpenApp(diode.app);
    } else if (diode.action === 'url' && diode.url) {
      await window.deco.cameraOpenUrl(diode.url);
    }
  } catch {
    // silencieux
  } finally {
    firing.delete(key);
  }
}

function stepTriggers(flags, now) {
  // Triangle > mains ouvertes (déjà filtré dans diodes, ceinture).
  const effective = { ...flags };
  if (effective.diode1) effective.diode5 = false;

  for (const key of DIODE_KEYS) {
    const id = key.slice(5);
    const on = !!effective[key];
    const was = !!prevFlags[id];
    const cooledSelf = now >= (coolUntil[id] || 0);
    const cooledGlobal = now >= globalCoolUntil;
    // Front montant uniquement (le hold 300 ms est déjà dans diodes = DETECTOR).
    if (on && !was && cooledSelf && cooledGlobal) {
      coolUntil[id] = now + ACTION_COOLDOWN_MS;
      globalCoolUntil = now + GLOBAL_COOLDOWN_MS;
      fireAction(id);
    }
    prevFlags[id] = on;
  }
}

function look() {
  if (!running) return;
  const started = performance.now();
  try {
    if (!stream || stream.getVideoTracks().every((t) => t.readyState !== 'live')) {
      yieldCamera('device-lost');
      return;
    }
    // Lâche la caméra régulièrement SEULEMENT si on l’a ouverte nous-mêmes
    if (!sharedStream && holdStarted && started - holdStarted >= HOLD_MS) {
      yieldCamera('lend');
      return;
    }
    const skip = shouldSkipFrame();
    if (!skip && video.readyState >= 2 && video.videoWidth && landmarker && engine) {
      const targetWidth = 320;
      const targetHeight = Math.max(1, Math.round(video.videoHeight * (targetWidth / video.videoWidth)));
      if (detectCanvas.width !== targetWidth || detectCanvas.height !== targetHeight) {
        detectCanvas.width = targetWidth;
        detectCanvas.height = targetHeight;
      }
      detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);
      visionClock = Math.max(visionClock + 1, Math.round(performance.now()));
      const result = landmarker.detectForVideo(detectCanvas, visionClock);
      const flags = engine.process(result);
      stepTriggers(flags, performance.now());
      prev = flags; // debug / futur
    }
  } catch {
    yieldCamera('detect-error');
    return;
  }
  const spent = performance.now() - started;
  adaptCadence(spent);
  const pause = spent > HEAVY_FRAME_MS ? Math.max(waitMs, 80) : waitMs;
  visionTimer = setTimeout(look, pause);
}

async function startFromShared() {
  if (!sharedStream || running || starting) return;
  if (!shouldRun(config)) return;
  starting = true;
  clearTimeout(retryTimer);
  retryTimer = 0;
  try {
    ensureDom();
    stream = sharedStream;
    video.srcObject = sharedStream;
    await video.play().catch(() => {});
    await ensureLandmarker();
    engine = createDiodeEngine();
    engine.setHandsMode({
      3: config?.diodes?.['3']?.hands,
      4: config?.diodes?.['4']?.hands,
      5: config?.diodes?.['5']?.hands
    });
    prev = null;
    visionClock = 0;
    waitMs = WAIT_MIN;
    slowStreak = 0;
    skipCounter = 0;
    resetHoldState();
    yielded = false;
    holdStarted = performance.now();
    running = true;
    starting = false;
    visionTimer = setTimeout(look, 30);
  } catch {
    starting = false;
    running = false;
  }
}

async function startCamera() {
  if (sharedStream) {
    await startFromShared();
    return;
  }
  if (running || starting) return;
  if (!shouldRun(config)) return;
  starting = true;
  clearTimeout(retryTimer);
  retryTimer = 0;
  try {
    ensureDom();
    // Cam d’abord (échec rapide si Discord l’a) — MediaPipe seulement si OK
    stream = await openCamera();
    bindTrackYield(stream);
    video.srcObject = stream;
    await video.play().catch(() => {});
    await ensureLandmarker();
    engine = createDiodeEngine();
    engine.setHandsMode({
      3: config?.diodes?.['3']?.hands,
      4: config?.diodes?.['4']?.hands,
      5: config?.diodes?.['5']?.hands
    });
    prev = null;
    visionClock = 0;
    waitMs = WAIT_MIN;
    slowStreak = 0;
    skipCounter = 0;
    resetHoldState();
    yielded = false;
    retryDelay = RETRY_BASE_MS;
    holdStarted = performance.now();
    running = true;
    starting = false;
    visionTimer = setTimeout(look, 30);
  } catch (err) {
    starting = false;
    releaseTracks();
    const name = err?.name || '';
    if (
      name === 'NotReadableError' ||
      name === 'TrackStartError' ||
      name === 'AbortError' ||
      name === 'NotFoundError' ||
      name === 'NotAllowedError' ||
      name === 'SecurityError'
    ) {
      yieldCamera(
        name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError'
          ? 'busy'
          : name
      );
      return;
    }
    yieldCamera('start-failed');
  }
}

function stopCamera() {
  running = false;
  starting = false;
  clearTimers();
  releaseTracks();
  engine?.reset();
  engine = null;
  prev = null;
  visionClock = 0;
  waitMs = WAIT_MIN;
  slowStreak = 0;
  skipCounter = 0;
  resetHoldState();
  yielded = false;
  retryDelay = RETRY_BASE_MS;
}

export function syncCameraActions(next) {
  config = next && typeof next === 'object' ? next : null;
  if (engine) {
    engine.setHandsMode({
      3: config?.diodes?.['3']?.hands,
      4: config?.diodes?.['4']?.hands,
      5: config?.diodes?.['5']?.hands
    });
  }
  if (shouldRun(config)) {
    if (!running && !starting) {
      startCamera().catch(() => {});
    }
  } else {
    stopCamera();
  }
}

/**
 * Branche le scraper sur le flux My Decoy (1 seule ouverture cam).
 * Détection + Decoy live/rec/virtuel en parallèle, sans clignoter.
 */
export function attachSharedStream(mediaStream) {
  clearTimeout(retryTimer);
  retryTimer = 0;
  // stoppe notre éventuelle ouverture perso sans toucher au flux partagé
  const wasShared = sharedStream;
  sharedStream = null;
  stopCamera();
  sharedStream = mediaStream || null;
  if (!sharedStream) return;
  if (shouldRun(config)) startFromShared().catch(() => {});
  void wasShared;
}

export function detachSharedStream() {
  const had = !!sharedStream;
  sharedStream = null;
  stopCamera();
  if (had && shouldRun(config)) startCamera().catch(() => {});
}

/** @deprecated alias */
export function setDecoyCameraHold(on) {
  if (!on) detachSharedStream();
}

export function cameraRunning() {
  return running;
}

export function cameraYielded() {
  return yielded;
}

/** Libère tout de suite la webcam (autres apps). */
export function lendCameraNow() {
  if (running || starting || stream) yieldCamera('lend');
}
