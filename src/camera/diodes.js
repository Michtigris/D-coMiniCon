import {
  burnMatch,
  evaluateHands,
  fistSides,
  handHalfShut,
  handSpan,
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
  return { since: 0, fired: false, litUntil: 0 };
}

function midLit(hold, now) {
  return now < hold.litUntil;
}

function tickHold(hold, active, now) {
  if (active) {
    if (!hold.since) hold.since = now;
    if (!hold.fired && now - hold.since >= HOLD_MS) {
      hold.fired = true;
      hold.litUntil = now + LIT_MS;
    }
    return;
  }
  hold.since = 0;
  hold.fired = false;
}

function off() {
  return { diode1: false, diode2: false, diode3: false, diode4: false, diode5: false, diode6: false };
}

function handsOf(modes, id) {
  return modes[id] === 1 ? 1 : 2;
}

function sideDiode(hold, sides, mode, now, extraBoth = true) {
  const both = !!(sides?.left && sides?.right && extraBoth);
  tickHold(hold, both, now);
  if (mode === 1) {
    return !!(sides?.left || sides?.right || midLit(hold, now));
  }
  return midLit(hold, now);
}

export function createDiodeEngine() {
  const holds = {
    triangle: createHold(),
    pinch: createHold(),
    fist: createHold(),
    open: createHold(),
    point: createHold()
  };
  let burnsOn = false;
  let handsMode = { 3: 2, 4: 2, 5: 2 };

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
      const seen = visibleHands(landmarks, handedness);
      const n = seen.landmarks?.length || 0;

      if (n < 1) {
        for (const hold of Object.values(holds)) {
          hold.since = 0;
          hold.fired = false;
        }
        burnsOn = false;
        return off();
      }

      const two = n >= 2;
      const pose = two ? evaluateHands(seen.landmarks) : null;

      let diode1 = false;
      if (two) {
        const triangle = isTriangle(pose);
        tickHold(holds.triangle, triangle, now);
        diode1 = triangle || midLit(holds.triangle, now);
      } else {
        holds.triangle.since = 0;
        holds.triangle.fired = false;
      }

      let diode2 = false;
      if (two) {
        const match = burnMatch(landmarks, burnsOn);
        const shut = landmarks.some(
          (hand) => hand?.length >= 21 && handSpan(hand) >= 0.08 && handHalfShut(hand)
        );
        if (match) burnsOn = true;
        else if (shut) burnsOn = false;
        else burnsOn = false;
        diode2 = burnsOn;
      } else {
        burnsOn = false;
      }

      const mode3 = handsOf(handsMode, 3);
      const mode4 = handsOf(handsMode, 4);
      const mode5 = handsOf(handsMode, 5);

      let diode3 = false;
      if (n >= mode3) {
        const pinches = pinchSides(seen.landmarks, seen.handedness);
        diode3 = sideDiode(holds.pinch, pinches, mode3, now);
      } else {
        holds.pinch.since = 0;
        holds.pinch.fired = false;
      }

      let diode4 = false;
      if (n >= mode4) {
        const fists = fistSides(seen.landmarks, seen.handedness);
        diode4 = sideDiode(holds.fist, fists, mode4, now);
      } else {
        holds.fist.since = 0;
        holds.fist.fired = false;
      }

      let diode5 = false;
      if (diode1) {
        holds.open.since = 0;
        holds.open.fired = false;
      } else if (n >= mode5) {
        const opens = openSides(seen.landmarks, seen.handedness);
        diode5 = sideDiode(holds.open, opens, mode5, now);
      } else {
        holds.open.since = 0;
        holds.open.fired = false;
      }

      let diode6 = false;
      if (two) {
        const points = pointSides(seen.landmarks, seen.handedness);
        const indexesTouch = pointedIndexesTouch(seen.landmarks);
        tickHold(holds.point, !!(points?.left && points?.right && indexesTouch), now);
        diode6 = midLit(holds.point, now);
      } else {
        holds.point.since = 0;
        holds.point.fired = false;
      }

      return { diode1, diode2, diode3, diode4, diode5, diode6 };
    },
    reset() {
      for (const hold of Object.values(holds)) {
        hold.since = 0;
        hold.fired = false;
        hold.litUntil = 0;
      }
      burnsOn = false;
    }
  };
}
