import { createDiodeEngine } from './diodes.js';

const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';

const DIODE_KEYS = ['diode1', 'diode2', 'diode3', 'diode4', 'diode5', 'diode6'];

/** Pose ≥ 300 ms ; 2 s cooldown global après tout tir ; 5 s sur la même action. */
const HOLD_MS = 300;
const GLOBAL_COOLDOWN_MS = 2000;
const ACTION_COOLDOWN_MS = 5000;

/** Cadence : fluide → chargé (ms entre frames). */
const WAIT_MIN = 8;
const WAIT_MAX = 120;
const SLOW_FRAME_MS = 40;
const HEAVY_FRAME_MS = 70;
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60000;

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
/** @type {Record<string, number>} */
let holdSince = Object.create(null);
/** @type {Record<string, boolean>} */
let firedThisHold = Object.create(null);
/** @type {Record<string, number>} */
let coolUntil = Object.create(null);
let globalCoolUntil = 0;

function resetHoldState() {
  holdSince = Object.create(null);
  firedThisHold = Object.create(null);
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

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = 0;
  if (!shouldRun(config)) return;
  const delay = retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.6));
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    if (!shouldRun(config) || running || starting) return;
    startCamera().catch(() => {
      // reste en yield ; prochain retry déjà planifié via yieldCamera
    });
  }, delay);
}

function yieldCamera(reason) {
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
  resetHoldState();
  yielded = true;
  if (shouldRun(config)) scheduleRetry();
  void reason;
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

/** Caméra seule — jamais de micro. */
async function openCamera() {
  const attempts = [
    { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { width: { ideal: 320 }, height: { ideal: 240 } }, audio: false },
    { video: true, audio: false }
  ];
  let last = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      last = err;
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw err;
      if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
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
  // Triangle > mains ouvertes si les deux matchent.
  const effective = { ...flags };
  if (effective.diode1) effective.diode5 = false;

  for (const key of DIODE_KEYS) {
    const id = key.slice(5);
    const on = !!effective[key];
    if (on) {
      if (!holdSince[id]) holdSince[id] = now;
      const held = now - holdSince[id] >= HOLD_MS;
      const cooledSelf = now >= (coolUntil[id] || 0);
      const cooledGlobal = now >= globalCoolUntil;
      if (held && cooledSelf && cooledGlobal && !firedThisHold[id]) {
        firedThisHold[id] = true;
        coolUntil[id] = now + ACTION_COOLDOWN_MS;
        globalCoolUntil = now + GLOBAL_COOLDOWN_MS;
        fireAction(id);
      }
    } else {
      holdSince[id] = 0;
      firedThisHold[id] = false;
    }
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
      prev = flags;
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

async function startCamera() {
  if (running || starting) return;
  if (!shouldRun(config)) return;
  starting = true;
  clearTimeout(retryTimer);
  retryTimer = 0;
  try {
    ensureDom();
    await ensureLandmarker();
    stream = await openCamera();
    bindTrackYield(stream);
    video.srcObject = stream;
    await video.play();
    engine = createDiodeEngine();
    prev = null;
    visionClock = 0;
    waitMs = WAIT_MIN;
    slowStreak = 0;
    skipCounter = 0;
    resetHoldState();
    yielded = false;
    retryDelay = RETRY_BASE_MS;
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
      yieldCamera(name);
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
  if (shouldRun(config)) {
    if (!running && !starting) {
      startCamera().catch(() => {});
    }
  } else {
    stopCamera();
  }
}

export function cameraRunning() {
  return running;
}

export function cameraYielded() {
  return yielded;
}
