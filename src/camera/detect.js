/** Distance 2D relative à la taille de la main. En dessous, les doigts comptent comme joints. */
export const TOUCH_RATIO = 0.24;
/** Les bouts de doigts doivent être bien plus proches que les poignets. */
const WRIST_FACTOR = 0.28;
/** Longueur typique du poignet à la base du majeur, pour passer des pixels aux centimètres. */
const PALM_CM = 9;
const HOLD_FRAMES = 2;
const RELEASE_FRAMES = 4;
const CLAP_MIN_GAP = 120;
const CLAP_MAX_GAP = 1100;
const CLAP_DEBOUNCE = 100;
const CLAP_COOLDOWN = 700;

export function gap(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Poignet (0) → articulation du majeur (9) : échelle de la main dans l'image. */
export function handSpan(hand) {
  return gap(hand[0], hand[9]);
}

/** Écart entre deux points, en centimètres, d'après la taille des deux mains. */
export function pairCentimeters(handA, handB, pointA, pointB) {
  const span = Math.max((handSpan(handA) + handSpan(handB)) / 2, 0.04);
  return (gap(pointA, pointB) / span) * PALM_CM;
}

export function evaluateHands(hands) {
  const count = hands?.length || 0;
  if (count < 2) {
    return { hands: count, thumbGap: null, indexGap: null, thumbs: false, indexes: false };
  }

  const [a, b] = hands;
  const span = Math.max((handSpan(a) + handSpan(b)) / 2, 0.04);
  const wristGap = gap(a[0], b[0]);
  const thumbAbs = gap(a[4], b[4]);
  const indexAbs = gap(a[8], b[8]);
  const thumbGap = thumbAbs / span;
  const indexGap = indexAbs / span;
  const meeting = (distance) => wristGap > 0.02 && distance < wristGap * WRIST_FACTOR;
  const centimeters = (distance) => (distance / span) * PALM_CM;
  const othersClear = centimeters(gap(a[12], b[12])) > 4
    && centimeters(gap(a[16], b[16])) > 4
    && centimeters(gap(a[20], b[20])) > 4;

  const pose = {
    hands: 2,
    thumbGap,
    indexGap,
    thumbs: thumbGap < TOUCH_RATIO && meeting(thumbAbs),
    indexes: indexGap < TOUCH_RATIO && meeting(indexAbs),
    othersClear,
    triangle: false,
  };
  pose.triangle = triangleShape(a, b, pose);
  return pose;
}

function alongFinger(hand, mcp, tip, minReach) {
  const span = Math.max(handSpan(hand), 0.04);
  const baseX = hand[mcp].x - hand[0].x;
  const baseY = hand[mcp].y - hand[0].y;
  const tipX = hand[tip].x - hand[0].x;
  const tipY = hand[tip].y - hand[0].y;
  const base = Math.hypot(baseX, baseY);
  const reach = Math.hypot(tipX, tipY);
  if (base < span * 0.2 || reach < span * minReach) return false;
  const align = (baseX * tipX + baseY * tipY) / (base * reach);
  return align > 0.8 && reach > base * 1.12;
}

function triangleArea(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5;
}

function tipInsideTriangle(point, a, b, c) {
  const side = (p, q, r) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const ab = side(point, a, b);
  const bc = side(point, b, c);
  const ca = side(point, c, a);
  if (Math.abs(ab) <= 1e-4 || Math.abs(bc) <= 1e-4 || Math.abs(ca) <= 1e-4) return false;
  const hasNeg = ab < 0 || bc < 0 || ca < 0;
  const hasPos = ab > 0 || bc > 0 || ca > 0;
  return !(hasNeg && hasPos);
}

/** Index et pouces prolongent la main et se touchent. Les autres bouts restent hors du triangle. */
function triangleShape(a, b, pose) {
  if (!pose.thumbs || !pose.indexes) return false;
  const span = Math.max((handSpan(a) + handSpan(b)) / 2, 0.04);
  const openCorner = (hand) => gap(hand[4], hand[8]) > span * 0.9
    && alongFinger(hand, 5, 8, 0.85)
    && alongFinger(hand, 2, 4, 0.5);
  if (!openCorner(a) || !openCorner(b)) return false;
  const apex = { x: (a[8].x + b[8].x) / 2, y: (a[8].y + b[8].y) / 2 };
  if (triangleArea(apex, a[0], b[0]) < span * span * 0.2) return false;
  for (const hand of [a, b]) {
    for (const tip of [12, 16, 20]) {
      if (tipInsideTriangle(hand[tip], apex, a[0], b[0])) return false;
    }
  }
  return true;
}

export function triangleHands(hands) {
  if (!hands || hands.length < 2) return false;
  return !!evaluateHands(hands).triangle;
}

/** Triangle seulement si pouces et index se touchent sur la même image, doigts écartés. */
export function isTriangle(pose) {
  if (Array.isArray(pose)) return triangleHands(pose);
  return !!(pose && pose.triangle);
}

/** Pouce et index proches, majeur annulaire et auriculaire un peu écartés. */
export function isThumbIndexPinch(hand) {
  if (!hand || hand.length < 21) return false;
  const span = Math.max(handSpan(hand), 0.04);
  const centimeters = (distance) => (distance / span) * PALM_CM;
  const stuck = gap(hand[4], hand[8]) < span * 0.46;
  const spread = (a, b) => centimeters(gap(hand[a], hand[b])) > 2;
  return stuck && spread(12, 16) && spread(16, 20) && spread(12, 20);
}

/** Côté vu dans le miroir : la main gauche de la personne est à gauche de l’écran. */
export function pinchSides(hands, handedness) {
  const sides = { left: false, right: false };
  (hands || []).forEach((hand, index) => {
    if (!isThumbIndexPinch(hand)) return;
    const label = handedness?.[index]?.[0]?.categoryName || handedness?.[index]?.categoryName || "";
    if (label === "Left") sides.left = true;
    else if (label === "Right") sides.right = true;
    else if (1 - hand[0].x < 0.5) sides.left = true;
    else sides.right = true;
  });
  return sides;
}

const MIN_HAND_SPAN = 0.09;

/** Ignore une main trop petite, ou bien plus petite que l’autre : ce n’est pas une vraie main au premier plan. */
export function visibleHands(landmarks, handedness) {
  const hands = landmarks || [];
  const spans = hands.map((hand) => handSpan(hand));
  const largest = spans.reduce((max, span) => Math.max(max, span), 0);
  const kept = [];
  const sides = [];
  hands.forEach((hand, index) => {
    const span = spans[index];
    const score = handedness?.[index]?.[0]?.score;
    if (span < MIN_HAND_SPAN) return;
    if (largest > 0.16 && span < largest * 0.45) return;
    if (typeof score === "number" && score < 0.5) return;
    kept.push(hand);
    sides.push(handedness?.[index] || []);
  });
  return { landmarks: kept, handedness: sides };
}

/** Les quatre doigts repliés dans la paume, pouce fermé dessus. */
export function isClosedFist(hand) {
  if (!hand || hand.length < 21) return false;
  const span = Math.max(handSpan(hand), 0.04);
  const curled = (tip, mcp) => gap(hand[0], hand[tip]) < gap(hand[0], hand[mcp]) * 1.15
    && gap(hand[tip], hand[mcp]) < span * 0.9;
  const thumbIn = gap(hand[4], hand[9]) < span * 0.95 && gap(hand[4], hand[0]) < span * 1.25;
  return curled(8, 5) && curled(12, 9) && curled(16, 13) && curled(20, 17) && thumbIn;
}

/** Poing fermé, main gauche ou main droite vues dans le miroir. */
export function fistSides(hands, handedness) {
  const sides = { left: false, right: false };
  (hands || []).forEach((hand, index) => {
    if (!isClosedFist(hand)) return;
    const label = handedness?.[index]?.[0]?.categoryName || handedness?.[index]?.categoryName || "";
    if (label === "Left") sides.left = true;
    else if (label === "Right") sides.right = true;
    else if (1 - hand[0].x < 0.5) sides.left = true;
    else sides.right = true;
  });
  return sides;
}

function fingerExtended(hand, tip, pip) {
  const span = Math.max(handSpan(hand), 0.04);
  const tipDistance = gap(hand[0], hand[tip]);
  const pipDistance = gap(hand[0], hand[pip]);
  return tipDistance > pipDistance * 1.22 && tipDistance > span * 1.25;
}

function fingerStraight(hand, mcp, pip, tip) {
  const ax = hand[pip].x - hand[mcp].x;
  const ay = hand[pip].y - hand[mcp].y;
  const bx = hand[tip].x - hand[pip].x;
  const by = hand[tip].y - hand[pip].y;
  const base = Math.hypot(ax, ay);
  const reach = Math.hypot(bx, by);
  if (base < 0.02 || reach < 0.02) return false;
  return (ax * bx + ay * by) / (base * reach) > 0.62;
}

function fingerGapCm(hand, first, second) {
  const span = Math.max(handSpan(hand), 0.04);
  return (gap(hand[first], hand[second]) / span) * PALM_CM;
}

/** Pouce vers le haut, index tendu, les trois autres doigts fermés. */
export function isPointed(hand) {
  if (!hand || hand.length < 21) return false;
  const span = Math.max(handSpan(hand), 0.04);
  const tipDistance = gap(hand[0], hand[8]);
  const pipDistance = gap(hand[0], hand[6]);
  const indexOut = tipDistance > pipDistance * 1.2 && tipDistance > span * 0.9;
  const dx = hand[4].x - hand[2].x;
  const dy = hand[4].y - hand[2].y;
  const thumbLen = Math.hypot(dx, dy);
  const tipDx = hand[4].x - hand[3].x;
  const tipDy = hand[4].y - hand[3].y;
  const thumbUp = dy < 0 && tipDy < 0
    && thumbLen > span * 0.4
    && Math.abs(dy) > Math.abs(dx) * 2
    && Math.abs(tipDy) > Math.abs(tipDx) * 1.6;
  const folded = (tip, mcp) => gap(hand[0], hand[tip]) < gap(hand[0], hand[mcp]) * 1.35;
  return indexOut && thumbUp && folded(12, 9) && folded(16, 13) && folded(20, 17);
}

/** Côté de la main qui pointe : pouce en haut, index tendu. */
export function pointSides(hands, handedness) {
  const sides = { left: false, right: false };
  (hands || []).forEach((hand, index) => {
    if (!isPointed(hand)) return;
    const label = handedness?.[index]?.[0]?.categoryName || handedness?.[index]?.categoryName || "";
    if (label === "Left") sides.left = true;
    else if (label === "Right") sides.right = true;
    else if (1 - hand[0].x < 0.5) sides.left = true;
    else sides.right = true;
  });
  return sides;
}

function indexAxis(hand) {
  const dx = hand[8].x - hand[5].x;
  const dy = hand[8].y - hand[5].y;
  const len = Math.hypot(dx, dy);
  if (len < 0.02) return null;
  const ax = hand[6].x - hand[5].x;
  const ay = hand[6].y - hand[5].y;
  const bx = hand[8].x - hand[6].x;
  const by = hand[8].y - hand[6].y;
  const base = Math.hypot(ax, ay);
  const reach = Math.hypot(bx, by);
  if (base < 0.02 || reach < 0.02) return null;
  if ((ax * bx + ay * by) / (base * reach) < 0.9) return null;
  return { x: dx / len, y: dy / len };
}

/** Les deux index sont tendus sur la même ligne, en face l’un de l’autre. */
function indexesAligned(a, b) {
  const da = indexAxis(a);
  const db = indexAxis(b);
  if (!da || !db) return false;
  return da.x * db.x + da.y * db.y < -0.92;
}

/** Les deux mains pointent, leurs index se touchent et sont alignés. */
export function pointedIndexesTouch(hands) {
  const pointed = (hands || []).filter((hand) => isPointed(hand));
  if (pointed.length < 2) return false;
  const [a, b] = pointed;
  const span = Math.max((handSpan(a) + handSpan(b)) / 2, 0.04);
  const wristGap = gap(a[0], b[0]);
  const indexAbs = gap(a[8], b[8]);
  const touching = wristGap > 0.02 && indexAbs / span < TOUCH_RATIO && indexAbs < wristGap * WRIST_FACTOR;
  return touching && indexesAligned(a, b);
}
export function isOpenPalm(hand) {
  if (!hand || hand.length < 21) return false;
  if (isClosedFist(hand) || handHalfShut(hand)) return false;
  const straight = fingerExtended(hand, 8, 6) && fingerStraight(hand, 5, 6, 8)
    && fingerExtended(hand, 12, 10) && fingerStraight(hand, 9, 10, 12)
    && fingerExtended(hand, 16, 14) && fingerStraight(hand, 13, 14, 16)
    && fingerExtended(hand, 20, 18) && fingerStraight(hand, 17, 18, 20);
  if (!straight) return false;
  const spread = fingerGapCm(hand, 8, 12) > 1.45
    && fingerGapCm(hand, 12, 16) > 1.45
    && fingerGapCm(hand, 16, 20) > 1.45
    && fingerGapCm(hand, 8, 20) > 4.2;
  const thumbOut = fingerGapCm(hand, 4, 5) > 2.1;
  return spread && thumbOut;
}

/** Signe dans l’image brute. Négatif : intérieur de la main droite face caméra. */
function palmWind(hand) {
  const span = Math.max(handSpan(hand), 0.04);
  const ax = hand[5].x - hand[0].x;
  const ay = hand[5].y - hand[0].y;
  const bx = hand[17].x - hand[0].x;
  const by = hand[17].y - hand[0].y;
  return (ax * by - ay * bx) / (span * span);
}

function handSide(hand, handednessEntry) {
  const label = handednessEntry?.[0]?.categoryName || handednessEntry?.categoryName || "";
  if (label === "Left" || label === "Right") return label;
  return 1 - hand[0].x < 0.5 ? "Left" : "Right";
}

/** Intérieur de la main tourné vers la caméra, pas le dos. */
export function palmFacesCamera(hand, side) {
  const wind = palmWind(hand);
  if (Math.abs(wind) < 0.2) return false;
  if (side === "Right") return wind < 0;
  if (side === "Left") return wind > 0;
  return false;
}

/** Main ouverte, intérieur face à la caméra, côté gauche ou droit. */
export function openSides(hands, handedness) {
  const sides = { left: false, right: false };
  (hands || []).forEach((hand, index) => {
    const side = handSide(hand, handedness?.[index]);
    if (!isOpenPalm(hand) || !palmFacesCamera(hand, side)) return;
    if (side === "Left") sides.left = true;
    else sides.right = true;
  });
  return sides;
}

const FINGER_TIPS = [4, 8, 12, 16, 20];
const BURN_ON = 0.52;
const BURN_OFF = 0.78;

function burnWorst(a, b) {
  const span = Math.max((handSpan(a) + handSpan(b)) / 2, 0.04);
  let worst = 0;
  for (const tip of FINGER_TIPS) worst = Math.max(worst, gap(a[tip], b[tip]) / span);
  return worst;
}

/** Écart poignet→bout, comparé au poignet→articulation. Tendue ≈ 2,2, poing ≈ 1. */
function fingerReach(hand, tip, mcp) {
  return gap(hand[0], hand[tip]) / Math.max(gap(hand[0], hand[mcp]), 0.02);
}

/** La main a fait environ 80 % du chemin vers un poing. Ouverte ≈ 2,4, poing ≈ 1. */
export function handHalfShut(hand) {
  if (!hand || hand.length < 21) return false;
  const reaches = [
    fingerReach(hand, 8, 5),
    fingerReach(hand, 12, 9),
    fingerReach(hand, 16, 13),
    fingerReach(hand, 20, 17),
  ];
  const mean = reaches.reduce((sum, value) => sum + value, 0) / reaches.length;
  return mean <= 1.28;
}

/** Paumes face à face, dans le même sens, ou vers la caméra. Une main fermée à environ 80 % coupe le geste. */
export function burnMatch(hands, held = false) {
  if (!hands || hands.length < 2) return null;
  const limit = held ? BURN_OFF : BURN_ON;
  let best = null;
  for (let i = 0; i < hands.length; i++) {
    for (let j = i + 1; j < hands.length; j++) {
      const a = hands[i];
      const b = hands[j];
      if (!a || !b || a.length < 21 || b.length < 21) continue;
      if (handSpan(a) < 0.08 || handSpan(b) < 0.08) continue;
      if (handHalfShut(a) || handHalfShut(b)) continue;
      const worst = burnWorst(a, b);
      if (worst < limit && (!best || worst < best.worst)) best = { a, b, order: FINGER_TIPS, worst };
    }
  }
  return best;
}

export function isBurns(hands, held = false) {
  return burnMatch(hands, held) != null;
}

/** Pouce avec pouce, index avec index, même si les traits se croisent. */
export function burnFollow(hands) {
  if (!hands || hands.length < 2) return null;
  const usable = [];
  for (const hand of hands) {
    if (hand && hand.length >= 21 && handSpan(hand) >= 0.08 && !handHalfShut(hand)) usable.push(hand);
  }
  if (usable.length < 2) return null;
  usable.sort((a, b) => handSpan(b) - handSpan(a));
  return { a: usable[0], b: usable[1], order: FINGER_TIPS };
}

export function createGesture() {
  return { hold: 0, release: 0, latched: false };
}

/** Retourne true une seule fois, au moment où le geste est confirmé. */
export function stepGesture(gesture, active) {
  if (active) {
    gesture.release = 0;
    gesture.hold += 1;
    if (!gesture.latched && gesture.hold >= HOLD_FRAMES) {
      gesture.latched = true;
      return true;
    }
    return false;
  }

  gesture.hold = 0;
  gesture.release += 1;
  if (gesture.release >= RELEASE_FRAMES) gesture.latched = false;
  return false;
}

export function createBandState() {
  return { hp: 0, lp: 0, prev: 0 };
}

/** Énergie aiguë (claquement) face à l’énergie grave (voix). */
export function frameFeatures(samples, sampleRate, band = createBandState()) {
  const hpCut = Math.exp((-2 * Math.PI * 2200) / sampleRate);
  const lpCut = Math.exp((-2 * Math.PI * 450) / sampleRate);
  let { hp, lp, prev } = band;
  let peak = 0;
  let highEnergy = 0;
  let lowEnergy = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    hp = hpCut * (hp + x - prev);
    lp = lpCut * lp + (1 - lpCut) * x;
    prev = x;
    highEnergy += hp * hp;
    lowEnergy += lp * lp;
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    if (i > 0 && (samples[i - 1] >= 0) !== (x >= 0)) crossings += 1;
  }
  band.hp = hp;
  band.lp = lp;
  band.prev = prev;
  return {
    peak,
    highRatio: highEnergy / (lowEnergy + 1e-8),
    zcr: crossings / samples.length,
  };
}

export function isClapSpectrum(features) {
  return features.peak >= 0.09
    && features.highRatio >= 1.15
    && features.zcr >= 0.08
    && features.zcr <= 0.75;
}

export function createImpulseState() {
  return { prevPeak: 0, startedAt: 0, maxPeak: 0, armed: false };
}

/**
 * Un vrai clap est un claquement aigu, très court.
 * Une voix ou un bruit qui dure est rejeté.
 */
export function consumeImpulse(state, features, now) {
  const spectral = isClapSpectrum(features);
  const attack = features.peak > state.prevPeak * 1.7 && features.peak - state.prevPeak > 0.045;
  state.prevPeak = features.peak;

  if (!state.armed) {
    if (spectral && attack) {
      state.armed = true;
      state.startedAt = now;
      state.maxPeak = features.peak;
    }
    return false;
  }

  state.maxPeak = Math.max(state.maxPeak, features.peak);
  const age = now - state.startedAt;
  const stillLoud = features.peak >= state.maxPeak * 0.5;

  if (stillLoud && !spectral) {
    state.armed = false;
    state.maxPeak = 0;
    return false;
  }

  if (stillLoud && age > 110) {
    state.armed = false;
    state.maxPeak = 0;
    return false;
  }

  if (!stillLoud && age >= 6 && age <= 110 && state.maxPeak >= 0.09) {
    state.armed = false;
    state.maxPeak = 0;
    return true;
  }

  if (!stillLoud) {
    state.armed = false;
    state.maxPeak = 0;
  }
  return false;
}

export function createClapState() {
  return {
    lastPeakAt: -Infinity,
    armedAt: 0,
    cooldownUntil: 0,
    stage: 0,
  };
}

/** Deux claps déjà reconnus, entre 120 ms et 1100 ms. */
export function evaluateClap(state, clapLike, now) {
  if (state.armedAt && now - state.armedAt > CLAP_MAX_GAP) {
    state.armedAt = 0;
    state.stage = 0;
  }

  if (!clapLike || now < state.cooldownUntil || now - state.lastPeakAt < CLAP_DEBOUNCE) {
    return false;
  }

  state.lastPeakAt = now;

  if (state.armedAt && now - state.armedAt >= CLAP_MIN_GAP) {
    state.armedAt = 0;
    state.stage = 0;
    state.cooldownUntil = now + CLAP_COOLDOWN;
    return true;
  }

  state.armedAt = now;
  state.stage = 1;
  return false;
}

function extendedFromWrist(hand, tip, pip) {
  const tipDistance = gap(hand[0], hand[tip]);
  const pipDistance = gap(hand[0], hand[pip]);
  return tipDistance > pipDistance * 1.22 && tipDistance > 0.03;
}

/** Index et majeur tendus et serrés, annulaire et auriculaire pliés, pouce sorti sans être à moitié fermé. */
export function isCornerShape(hand) {
  if (!hand || hand.length < 21) return false;
  const span = Math.max(handSpan(hand), 0.04);
  const indexReach = gap(hand[0], hand[8]);
  const middleReach = gap(hand[0], hand[12]);
  const indexUp = extendedFromWrist(hand, 8, 6) && indexReach > span * 0.85;
  const middleUp = extendedFromWrist(hand, 12, 10) && middleReach > span * 0.8;
  const stuck = gap(hand[8], hand[12]) < span * 0.3;
  const ringFolded = !extendedFromWrist(hand, 16, 14) && gap(hand[0], hand[16]) < indexReach * 0.72;
  const pinkyFolded = !extendedFromWrist(hand, 20, 18) && gap(hand[0], hand[20]) < indexReach * 0.72;
  const thumbReach = gap(hand[0], hand[4]);
  const thumbJoint = gap(hand[0], hand[3]);
  const thumbOut = thumbReach > thumbJoint * 0.95 && gap(hand[4], hand[5]) > span * 0.38;
  return indexUp && middleUp && stuck && ringFolded && pinkyFolded && thumbOut;
}

export function findCornerHand(hands) {
  if (!hands?.length) return null;
  for (const hand of hands) {
    if (isCornerShape(hand)) return hand;
  }
  return null;
}

/** Repère vu à l’écran : la vidéo est inversée en miroir. */
export function screenPoint(hand) {
  return { x: 1 - hand[0].x, y: hand[0].y };
}

export function createMoveState() {
  return { anchor: null, cooldownUntil: 0 };
}

const MOVE_DISTANCE_X = 0.09;
const MOVE_DISTANCE_Y = 0.12;

/** Déplacement net de la main qui tient la forme. Haut et bas demandent plus de course que gauche et droite. */
export function stepMove(state, point, active, now) {
  if (!active || !point) {
    state.anchor = null;
    return null;
  }
  if (!state.anchor) {
    state.anchor = { x: point.x, y: point.y };
    return null;
  }

  const dx = point.x - state.anchor.x;
  const dy = point.y - state.anchor.y;
  const horizontal = Math.abs(dx) >= MOVE_DISTANCE_X;
  const vertical = Math.abs(dy) >= MOVE_DISTANCE_Y;
  if ((!horizontal && !vertical) || now < state.cooldownUntil) return null;

  state.anchor = { x: point.x, y: point.y };
  state.cooldownUntil = now + 400;
  if (horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy))) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** 0 = loin, 1 = au contact. */
export function proximity(distance) {
  if (distance == null) return 0;
  const far = 1.6;
  const near = TOUCH_RATIO;
  return Math.max(0, Math.min(1, (far - distance) / (far - near)));
}
