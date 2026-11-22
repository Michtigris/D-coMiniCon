/**
 * Pose légère (centroïde + direction + vitesse) sans modèle lourd.
 * Coords normalisées 0..1 (x droite, y bas).
 */

const W = 96;
const H = 54;

export function createPoseSampler() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let prev = null;
  let prevCentroid = null;
  let prevT = 0;

  function sampleFromSource(source, now = performance.now()) {
    if (!source) return null;
    try {
      ctx.drawImage(source, 0, 0, W, H);
    } catch {
      return null;
    }
    const data = ctx.getImageData(0, 0, W, H).data;
    const pose = poseFromFrames(prev, data, prevCentroid, now - prevT);
    prev = new Uint8ClampedArray(data);
    if (pose) {
      prevCentroid = { x: pose.x, y: pose.y };
      prevT = now;
    }
    return pose;
  }

  function reset() {
    prev = null;
    prevCentroid = null;
    prevT = 0;
  }

  return { sampleFromSource, reset, canvas, ctx };
}

export function poseFromImageData(imageData, prevData = null, prevCentroid = null, dtMs = 33) {
  return poseFromFrames(prevData, imageData.data || imageData, prevCentroid, dtMs);
}

function poseFromFrames(prevData, data, prevCentroid, dtMs) {
  let sumX = 0;
  let sumY = 0;
  let weight = 0;
  let energy = 0;
  let flowX = 0;
  let flowY = 0;
  let flowN = 0;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (r + g + b) / 3;
      let w = 0;
      if (prevData) {
        const d =
          Math.abs(r - prevData[i]) + Math.abs(g - prevData[i + 1]) + Math.abs(b - prevData[i + 2]);
        const mot = d / (3 * 255);
        energy += mot;
        if (mot > 0.045) {
          w = mot * mot;
          // biais centre (corps)
          const cx = x / W - 0.5;
          const cy = y / H - 0.5;
          w *= 1.15 - Math.min(1, Math.hypot(cx, cy));
        }
      } else {
        // fallback : zones un peu contrastées au centre
        const cx = x / W - 0.5;
        const cy = y / H - 0.45;
        const center = Math.max(0, 1 - Math.hypot(cx * 1.2, cy * 1.4));
        w = center * (0.25 + lum / 255);
      }
      if (w > 0) {
        sumX += x * w;
        sumY += y * w;
        weight += w;
      }
    }
  }

  if (weight < 0.0001) {
    return {
      x: prevCentroid?.x ?? 0.5,
      y: prevCentroid?.y ?? 0.45,
      dx: 0,
      dy: 0,
      speed: 0,
      energy: 0
    };
  }

  const x = sumX / weight / W;
  const y = sumY / weight / H;
  let dx = 0;
  let dy = 0;
  if (prevCentroid) {
    const dt = Math.max(0.016, (dtMs || 33) / 1000);
    dx = (x - prevCentroid.x) / dt;
    dy = (y - prevCentroid.y) / dt;
  }
  // micro optical-flow approx via neighborhood when prev exists
  if (prevData) {
    for (let y0 = 2; y0 < H - 2; y0 += 3) {
      for (let x0 = 2; x0 < W - 2; x0 += 3) {
        const i = (y0 * W + x0) * 4;
        const d =
          Math.abs(data[i] - prevData[i]) +
          Math.abs(data[i + 1] - prevData[i + 1]) +
          Math.abs(data[i + 2] - prevData[i + 2]);
        if (d < 40) continue;
        // compare lum to right/left/up/down in prev
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        let best = 1e9;
        let bx = 0;
        let by = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (!ox && !oy) continue;
            const j = ((y0 + oy) * W + (x0 + ox)) * 4;
            const pl = (prevData[j] + prevData[j + 1] + prevData[j + 2]) / 3;
            const err = Math.abs(lum - pl);
            if (err < best) {
              best = err;
              bx = ox;
              by = oy;
            }
          }
        }
        flowX += bx;
        flowY += by;
        flowN += 1;
      }
    }
  }
  if (flowN > 8) {
    dx = 0.65 * dx + 0.35 * (flowX / flowN) * 8;
    dy = 0.65 * dy + 0.35 * (flowY / flowN) * 8;
  }
  const speed = Math.hypot(dx, dy);
  return {
    x,
    y,
    dx,
    dy,
    speed,
    energy: energy / (W * H)
  };
}

export function poseScore(a, b, opts = {}) {
  if (!a || !b) return 1e9;
  // Position pèse beaucoup plus : “pas au même endroit” = fail
  const posW = opts.posW ?? 2.4;
  const dirW = opts.dirW ?? 0.75;
  const spdW = opts.spdW ?? 0.25;
  const pos = Math.hypot(a.x - b.x, a.y - b.y);
  const aSp = Math.max(0.05, a.speed || 0);
  const bSp = Math.max(0.05, b.speed || 0);
  const aDx = a.dx / aSp;
  const aDy = a.dy / aSp;
  const bDx = b.dx / bSp;
  const bDy = b.dy / bSp;
  const dir = 1 - Math.max(-1, Math.min(1, aDx * bDx + aDy * bDy)); // 0 = même direction
  const spd = Math.abs(Math.log((a.speed + 0.08) / (b.speed + 0.08)));
  // pénalité dure si trop loin en position
  const hard = pos > 0.12 ? (pos - 0.12) * 4 : 0;
  return posW * pos + dirW * dir + spdW * spd + hard;
}

/** Moyenne de plusieurs poses (échantillon live stable). */
export function averagePoses(poses) {
  const list = (poses || []).filter(Boolean);
  if (!list.length) return null;
  const out = { x: 0, y: 0, dx: 0, dy: 0, speed: 0, energy: 0 };
  for (const p of list) {
    out.x += p.x;
    out.y += p.y;
    out.dx += p.dx;
    out.dy += p.dy;
    out.speed += p.speed;
    out.energy += p.energy || 0;
  }
  const n = list.length;
  out.x /= n;
  out.y /= n;
  out.dx /= n;
  out.dy /= n;
  out.speed /= n;
  out.energy /= n;
  return out;
}

export function speedRatio(liveSpeed, segSpeed) {
  const a = Math.max(0.05, liveSpeed || 0.05);
  const b = Math.max(0.05, segSpeed || 0.05);
  return Math.max(0.85, Math.min(1.15, a / b));
}

export function reversePose(pose) {
  if (!pose) return pose;
  return {
    ...pose,
    // reverse horizontal mirror playback: x flips, dx flips
    x: 1 - pose.x,
    dx: -pose.dx
  };
}

export function segmentEndpoints(seg, reverse) {
  if (!reverse) {
    return {
      start: { x: seg.x0, y: seg.y0, dx: seg.dx0, dy: seg.dy0, speed: seg.speed0 },
      end: { x: seg.x1, y: seg.y1, dx: seg.dx1, dy: seg.dy1, speed: seg.speed1 }
    };
  }
  // reverse vidéo (miroir horizontal) : on lit de la fin vers le début
  return {
    start: reversePose({ x: seg.x1, y: seg.y1, dx: -seg.dx1, dy: -seg.dy1, speed: seg.speed1 }),
    end: reversePose({ x: seg.x0, y: seg.y0, dx: -seg.dx0, dy: -seg.dy0, speed: seg.speed0 })
  };
}
