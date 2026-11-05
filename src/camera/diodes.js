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

export function createDiodeEngine() {
  const holds = {
    triangle: createHold(),
    pinch: createHold(),
    fist: createHold(),
    open: createHold(),
    point: createHold()
  };
  let burnsOn = false;

  return {
    process(result) {
      const now = performance.now();
      const landmarks = result?.landmarks || [];
      const handedness = result?.handedness || [];
      const seen = visibleHands(landmarks, handedness);
      const pose = evaluateHands(seen.landmarks);

      // Diode 1 : pose active tout de suite (le hold 300 ms / cooldown sont dans runner).
      const triangle = isTriangle(pose);
      tickHold(holds.triangle, triangle, now);
      const diode1 = triangle || midLit(holds.triangle, now);

      const match = burnMatch(landmarks, burnsOn);
      const shut = landmarks.some(
        (hand) => hand?.length >= 21 && handSpan(hand) >= 0.08 && handHalfShut(hand)
      );
      if (match) burnsOn = true;
      else if (shut) burnsOn = false;
      else burnsOn = false;
      const diode2 = burnsOn;

      const pinches = pinchSides(seen.landmarks, seen.handedness);
      tickHold(holds.pinch, !!(pinches?.left && pinches?.right), now);
      const diode3 = !!(pinches?.left || pinches?.right || midLit(holds.pinch, now));

      const fists = fistSides(seen.landmarks, seen.handedness);
      tickHold(holds.fist, !!(fists?.left && fists?.right), now);
      const diode4 = !!(fists?.left || fists?.right || midLit(holds.fist, now));

      // Mains ouvertes : triangle (diode 1) a la priorité.
      const opens = openSides(seen.landmarks, seen.handedness);
      const openBoth = !!(opens?.left && opens?.right);
      tickHold(holds.open, openBoth && !diode1, now);
      const diode5 = diode1
        ? false
        : !!(opens?.left || opens?.right || midLit(holds.open, now));

      const points = pointSides(seen.landmarks, seen.handedness);
      const indexesTouch = pointedIndexesTouch(seen.landmarks);
      tickHold(holds.point, !!(points?.left && points?.right && indexesTouch), now);
      const diode6 = !!(points?.left || points?.right || midLit(holds.point, now));

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
