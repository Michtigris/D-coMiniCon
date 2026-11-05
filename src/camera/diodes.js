/**
 * Branchement fidèle des 6 diodes DETECTOR (js/app.js + js/detect.js).
 * Seuils / gestes = detect.js uniquement (aucun recalcul).
 *
 * handsMode 1|2 (diodes 3–5) :
 *  - 1 = gauche OU droite (côtés DETECTOR), après 300 ms de maintien
 *  - 2 = les deux côtés (pinch-both / fist-both / open-both)
 */
import {
  burnMatch,
  evaluateHands,
  fistSides,
  isTriangle,
  openSides,
  pinchSides,
  pointedIndexesTouch,
  pointSides,
  visibleHands
} from './detect.js';

const HOLD_MS = 300;
const LIT_MS = 3000;
const HANDS_FLEX = new Set([3, 4, 5]);

function createHold() {
  return { since: 0, fired: false };
}

/** watchBoth / watchTriangle / watchPointBoth (DETECTOR app.js) */
function watchHold(state, active, now) {
  if (active) {
    if (!state.since) state.since = now;
    if (!state.fired && now - state.since >= HOLD_MS) {
      state.fired = true;
      return true;
    }
    return false;
  }
  state.since = 0;
  state.fired = false;
  return false;
}

/** Côté tenu 300 ms d’affilée (anti faux-positif une main). */
function sideHeld(state, active, now) {
  if (active) {
    if (!state.since) state.since = now;
    return now - state.since >= HOLD_MS;
  }
  state.since = 0;
  return false;
}

function off() {
  return { diode1: false, diode2: false, diode3: false, diode4: false, diode5: false, diode6: false };
}

export function createDiodeEngine() {
  const bothHold = {
    triangle: createHold(),
    pinch: createHold(),
    fist: createHold(),
    open: createHold(),
    point: createHold()
  };
  const sideHold = {
    3: createHold(),
    4: createHold(),
    5: createHold(),
    6: createHold()
  };
  const litUntil = { 1: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let burnsArmed = false;
  let handsMode = { 3: 2, 4: 2, 5: 2 };

  function modeOf(id) {
    return handsMode[id] === 1 ? 1 : 2;
  }

  function groupDiode(id, sides, holdKey, now, bothExtra = true) {
    const both = !!(sides?.left && sides?.right && bothExtra);
    if (watchHold(bothHold[holdKey], both, now)) {
      litUntil[id] = now + LIT_MS;
    }
    const mid = now < litUntil[id];
    if (modeOf(id) === 1) {
      const any = !!(sides?.left || sides?.right);
      const side = sideHeld(sideHold[id], any, now);
      return !!(side || mid);
    }
    return mid;
  }

  return {
    setHandsMode(map) {
      const next = { 3: 2, 4: 2, 5: 2 };
      if (map && typeof map === 'object') {
        for (const id of HANDS_FLEX) {
          next[id] = Number(map[id]) === 1 ? 1 : 2;
        }
      }
      handsMode = next;
    },

    process(result) {
      const now = performance.now();
      const landmarks = result?.landmarks || [];
      const handedness = result?.handedness || [];
      // DETECTOR look() :
      // const seen = visibleHands(result.landmarks, result.handedness);
      // const pose = evaluateHands(seen.landmarks);
      const seen = visibleHands(landmarks, handedness);

      if (!seen.landmarks?.length) {
        for (const hold of Object.values(bothHold)) {
          hold.since = 0;
          hold.fired = false;
        }
        for (const hold of Object.values(sideHold)) {
          hold.since = 0;
        }
        burnsArmed = false;
        return off();
      }

      const pose = evaluateHands(seen.landmarks);

      // Diode 1 — watchTriangle(isTriangle(pose))
      if (watchHold(bothHold.triangle, isTriangle(pose), now)) {
        litUntil[1] = now + LIT_MS;
      }
      const diode1 = now < litUntil[1];

      // Diode 2 — burnMatch(result.landmarks brut, déjàAllumée)
      const match = burnMatch(landmarks, burnsArmed);
      burnsArmed = !!match;
      const diode2 = burnsArmed;

      // Diode 3 — pinchSides(seen…) + watchBoth("pinch")
      const pinches = pinchSides(seen.landmarks, seen.handedness);
      const diode3 = groupDiode(3, pinches, 'pinch', now);

      // Diode 4 — fistSides + watchBoth("fist")
      const fists = fistSides(seen.landmarks, seen.handedness);
      const diode4 = groupDiode(4, fists, 'fist', now);

      // Diode 5 — openSides + watchBoth("open") ; triangle gagne
      let diode5 = false;
      if (!diode1) {
        const opens = openSides(seen.landmarks, seen.handedness);
        diode5 = groupDiode(5, opens, 'open', now);
      } else {
        bothHold.open.since = 0;
        bothHold.open.fired = false;
        sideHold[5].since = 0;
      }

      // Diode 6 — pointSides + watchPointBoth(…, pointedIndexesTouch)
      const points = pointSides(seen.landmarks, seen.handedness);
      const indexesTouch = pointedIndexesTouch(seen.landmarks);
      const pointBoth = !!(points?.left && points?.right && indexesTouch);
      if (watchHold(bothHold.point, pointBoth, now)) {
        litUntil[6] = now + LIT_MS;
      }
      const pointSide = sideHeld(sideHold[6], !!(points?.left || points?.right), now);
      const diode6 = !!(pointSide || now < litUntil[6]);

      return { diode1, diode2, diode3, diode4, diode5, diode6 };
    },

    reset() {
      for (const hold of Object.values(bothHold)) {
        hold.since = 0;
        hold.fired = false;
      }
      for (const hold of Object.values(sideHold)) {
        hold.since = 0;
        hold.fired = false;
      }
      for (const key of Object.keys(litUntil)) litUntil[key] = 0;
      burnsArmed = false;
    }
  };
}
