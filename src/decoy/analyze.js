import { analyzeSpeech, rebuildAudioWithoutSpeech } from './vad.js';
import { poseFromImageData, poseScore, segmentEndpoints } from './pose.js';

/**
 * Analyse dense : position / direction / vitesse + micro-segments chaînés.
 */

const SAMPLE_FPS = 8;
const MIN_SEG = 0.35;
const MAX_SEG = 1.1;
const W = 96;
const H = 54;

export async function analyzeCapsuleBlob(blob, opts = {}) {
  const arrayBuf = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  let audioBuffer = null;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  } catch {
    audioBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  }

  const speechFilter = opts.speechFilter !== false;
  let speech = null;
  let keepMap = null;
  if (speechFilter) {
    speech = analyzeSpeech(audioBuffer, opts.vad || {});
    keepMap = rebuildAudioWithoutSpeech(audioBuffer, speech.keep).map;
  }

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await waitVideoMeta(video);
  const duration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : audioBuffer.duration || 1;

  const track = await samplePoseTrack(video, duration);
  URL.revokeObjectURL(url);
  video.removeAttribute('src');
  video.load();
  await audioCtx.close().catch(() => {});

  let segments = buildMicroSegments(track, duration);
  if (speech?.regions?.length) {
    segments = punchSpeechHoles(segments, speech.regions);
  }
  // ré-index
  segments = segments.map((s, i) => ({ ...s, id: i }));

  return {
    duration,
    sourceDuration: duration,
    speech,
    keepMap,
    skipRegions: speech?.regions || [],
    speechFiltered: !!speechFilter,
    segments,
    track,
    version: 2
  };
}

async function samplePoseTrack(video, duration) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = Math.max(24, Math.min(240, Math.round(duration * SAMPLE_FPS)));
  const track = [];
  let prevData = null;
  let prevCentroid = null;
  let prevT = 0;
  for (let i = 0; i < n; i += 1) {
    const t = (i / Math.max(1, n - 1)) * Math.max(0.01, duration - 0.04);
    video.currentTime = t;
    await waitSeek(video);
    ctx.drawImage(video, 0, 0, W, H);
    const image = ctx.getImageData(0, 0, W, H);
    const dt = i === 0 ? 33 : (t - prevT) * 1000;
    const pose = poseFromImageData(image, prevData, prevCentroid, dt);
    prevData = new Uint8ClampedArray(image.data);
    prevCentroid = { x: pose.x, y: pose.y };
    prevT = t;
    track.push({ t, ...pose });
  }
  return track;
}

function buildMicroSegments(track, duration) {
  if (!track.length) {
    return [
      {
        id: 0,
        start: 0,
        end: duration,
        mid: duration / 2,
        reverseSafe: false,
        avgMotion: 0,
        x0: 0.5,
        y0: 0.45,
        dx0: 0,
        dy0: 0,
        speed0: 0,
        x1: 0.5,
        y1: 0.45,
        dx1: 0,
        dy1: 0,
        speed1: 0
      }
    ];
  }

  const cuts = [0];
  let last = 0;
  for (let i = 1; i < track.length - 1; i += 1) {
    const t = track[i].t;
    const len = t - last;
    if (len < MIN_SEG) continue;
    // coupe sur creux d’énergie ou longueur max
    const valley = track[i].energy < 0.03 || track[i].speed < 0.12;
    if ((valley && len >= MIN_SEG) || len >= MAX_SEG) {
      cuts.push(t);
      last = t;
    }
  }
  if (duration - last >= MIN_SEG * 0.7) cuts.push(duration);
  else if (cuts.length) cuts[cuts.length - 1] = duration;
  else cuts.push(duration);

  const segments = [];
  for (let c = 0; c < cuts.length - 1; c += 1) {
    const start = cuts[c];
    const end = cuts[c + 1];
    if (end - start < 0.25) continue;
    const local = track.filter((p) => p.t >= start && p.t <= end);
    if (!local.length) continue;
    const a = local[0];
    const b = local[local.length - 1];
    const avgMotion = local.reduce((s, p) => s + (p.energy || 0), 0) / local.length;
    const avgSpeed = local.reduce((s, p) => s + (p.speed || 0), 0) / local.length;
    const dirVar = directionVariance(local);
    const reverseSafe = avgSpeed < 0.55 && dirVar < 0.35 && end - start >= 0.45;
    segments.push({
      id: segments.length,
      start,
      end,
      mid: (start + end) / 2,
      reverseSafe,
      avgMotion,
      avgSpeed,
      x0: a.x,
      y0: a.y,
      dx0: a.dx,
      dy0: a.dy,
      speed0: a.speed,
      x1: b.x,
      y1: b.y,
      dx1: b.dx,
      dy1: b.dy,
      speed1: b.speed
    });
  }
  return segments.length
    ? segments
    : [
        {
          id: 0,
          start: 0,
          end: duration,
          mid: duration / 2,
          reverseSafe: false,
          avgMotion: 0,
          avgSpeed: 0,
          x0: 0.5,
          y0: 0.45,
          dx0: 0,
          dy0: 0,
          speed0: 0,
          x1: 0.5,
          y1: 0.45,
          dx1: 0,
          dy1: 0,
          speed1: 0
        }
      ];
}

function directionVariance(local) {
  if (local.length < 2) return 0;
  let mx = 0;
  let my = 0;
  for (const p of local) {
    mx += p.dx;
    my += p.dy;
  }
  mx /= local.length;
  my /= local.length;
  let v = 0;
  for (const p of local) {
    v += (p.dx - mx) ** 2 + (p.dy - my) ** 2;
  }
  return v / local.length;
}

function punchSpeechHoles(segments, regions) {
  const out = [];
  for (const seg of segments) {
    let cursor = seg.start;
    const hits = regions
      .filter((r) => r.end > seg.start && r.start < seg.end)
      .sort((a, b) => a.start - b.start);
    for (const r of hits) {
      const from = Math.max(cursor, seg.start);
      const to = Math.min(r.start, seg.end);
      if (to - from >= 0.3) out.push(sliceSeg(seg, from, to));
      cursor = Math.max(cursor, r.end);
    }
    if (seg.end - cursor >= 0.3) out.push(sliceSeg(seg, cursor, seg.end));
  }
  return out.length ? out : segments;
}

function sliceSeg(seg, start, end) {
  const u0 = (start - seg.start) / Math.max(0.001, seg.end - seg.start);
  const u1 = (end - seg.start) / Math.max(0.001, seg.end - seg.start);
  const lerp = (a, b, u) => a + (b - a) * u;
  return {
    ...seg,
    start,
    end,
    mid: (start + end) / 2,
    x0: lerp(seg.x0, seg.x1, u0),
    y0: lerp(seg.y0, seg.y1, u0),
    x1: lerp(seg.x0, seg.x1, u1),
    y1: lerp(seg.y0, seg.y1, u1)
  };
}

/**
 * Meilleure entrée : cherche dans la track dense (frame exacte), pas seulement début de segment.
 */
export function findBestEntry(library, livePose) {
  let best = null;
  let bestScore = 1e9;
  for (const pack of library) {
    const analysis = pack.analysis || {};
    const segs = analysis.segments || [];
    const track = analysis.track || [];

    // 1) match sur frames de la track
    for (const frame of track) {
      const score = poseScore(livePose, frame);
      if (score >= bestScore) continue;
      const seg = segs.find((s) => frame.t >= s.start - 0.02 && frame.t <= s.end + 0.02) || segs[0];
      if (!seg) continue;
      bestScore = score;
      best = {
        capsuleId: pack.id,
        seg,
        reverse: false,
        t: frame.t,
        rate: Math.max(0.85, Math.min(1.15, (livePose.speed + 0.08) / (frame.speed + 0.08))),
        score: bestScore
      };
    }

    // 2) reverse-safe : comparer pose miroir
    for (const seg of segs) {
      if (!seg.reverseSafe) continue;
      const { start } = segmentEndpoints(seg, true);
      const score = poseScore(livePose, start);
      if (score < bestScore) {
        bestScore = score;
        best = {
          capsuleId: pack.id,
          seg,
          reverse: true,
          t: seg.end,
          rate: Math.max(0.85, Math.min(1.15, (livePose.speed + 0.08) / (start.speed + 0.08))),
          score: bestScore
        };
      }
    }
  }
  return best;
}

/** Pont : part de fromPose, arrive vers toPose. */
export function findBestBridge(library, fromPose, toPose) {
  let best = null;
  let bestScore = 1e9;
  for (const pack of library) {
    const segs = pack.analysis?.segments || [];
    for (const seg of segs) {
      for (const reverse of [false, true]) {
        if (reverse && !seg.reverseSafe) continue;
        const { start, end } = segmentEndpoints(seg, reverse);
        const s = poseScore(fromPose, start) * 0.55 + poseScore(toPose, end) * 0.45;
        if (s < bestScore) {
          bestScore = s;
          best = {
            capsuleId: pack.id,
            seg,
            reverse,
            rate: Math.max(0.85, Math.min(1.15, (fromPose.speed + 0.08) / (start.speed + 0.08))),
            score: bestScore
          };
        }
      }
    }
  }
  return best;
}

/** Prochain segment après current, anti-répétition / anti reverse immédiat. */
export function findNextSegment(segments, current, reverse, recentKeys, preferPose) {
  const { end } = segmentEndpoints(current, reverse);
  let best = null;
  let bestScore = 1e9;
  for (const seg of segments) {
    for (const rev of [false, true]) {
      if (rev && !seg.reverseSafe) continue;
      const key = `${seg.id}:${rev ? 1 : 0}`;
      // pas le même extrait juste inversé enchaîné
      if (seg.id === current.id && rev !== reverse) continue;
      if (recentKeys.includes(key)) continue;
      const { start } = segmentEndpoints(seg, rev);
      let score = poseScore(end, start);
      if (preferPose) score = score * 0.7 + poseScore(preferPose, start) * 0.3;
      // pénalité répétition douce
      score += recentKeys.filter((k) => k.startsWith(`${seg.id}:`)).length * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = { seg, reverse: rev, rate: 1, score: bestScore, key };
      }
    }
  }
  if (best) return best;
  // fallback : ignore recent
  for (const seg of segments) {
    const { start } = segmentEndpoints(seg, false);
    const score = poseScore(end, start);
    if (score < bestScore) {
      bestScore = score;
      best = { seg, reverse: false, rate: 1, score: bestScore, key: `${seg.id}:0` };
    }
  }
  return best;
}

function waitVideoMeta(video) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Lecture capsule impossible'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onErr);
    video.load();
  });
}

function waitSeek(video) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
  });
}

export function sampleLivePose(videoEl, sampler) {
  if (!videoEl || !sampler) return null;
  return sampler.sampleFromSource(videoEl);
}
