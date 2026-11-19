import { analyzeSpeech, rebuildAudioWithoutSpeech } from './vad.js';

/**
 * Analyse mouvement + audio, découpe en 3–4 segments naturels,
 * marque reverse-safe (vidéo seulement), prépare ordres d'assemblage.
 */

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
    const rebuilt = rebuildAudioWithoutSpeech(audioBuffer, speech.keep);
    keepMap = rebuilt.map;
  }

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await waitVideoMeta(video);
  const duration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : audioBuffer.duration || 1;

  const motion = await sampleMotion(video, duration, opts.samples || 48);
  URL.revokeObjectURL(url);
  video.removeAttribute('src');
  video.load();
  await audioCtx.close().catch(() => {});

  // Segments sur la timeline source ; les zones parole sont sautées à la lecture
  const cuts = pickCutPoints(motion, duration, opts.segmentCount || 4);
  let segments = buildSegments(cuts, duration, motion);
  if (speech?.regions?.length) {
    segments = punchSpeechHoles(segments, speech.regions);
  }
  const assemblies = buildAssemblies(segments);

  return {
    duration,
    sourceDuration: duration,
    speech,
    keepMap,
    skipRegions: speech?.regions || [],
    speechFiltered: !!speechFilter,
    segments,
    assemblies,
    motionPeaks: motion
  };
}

function punchSpeechHoles(segments, regions) {
  const out = [];
  let id = 0;
  for (const seg of segments) {
    let cursor = seg.start;
    const hits = regions
      .filter((r) => r.end > seg.start && r.start < seg.end)
      .sort((a, b) => a.start - b.start);
    for (const r of hits) {
      const from = Math.max(cursor, seg.start);
      const to = Math.min(r.start, seg.end);
      if (to - from >= 0.35) {
        out.push({
          ...seg,
          id: id++,
          start: from,
          end: to,
          mid: (from + to) / 2
        });
      }
      cursor = Math.max(cursor, r.end);
    }
    if (seg.end - cursor >= 0.35) {
      out.push({
        ...seg,
        id: id++,
        start: cursor,
        end: seg.end,
        mid: (cursor + seg.end) / 2
      });
    }
  }
  return out.length ? out : segments;
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

async function sampleMotion(video, duration, samples) {
  const canvas = document.createElement('canvas');
  const w = 80;
  const h = 45;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const peaks = [];
  let prev = null;
  for (let i = 0; i < samples; i += 1) {
    const t = (i / Math.max(1, samples - 1)) * Math.max(0.01, duration - 0.05);
    video.currentTime = t;
    await waitSeek(video);
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let energy = 0;
    if (prev) {
      for (let p = 0; p < data.length; p += 4) {
        const d =
          Math.abs(data[p] - prev[p]) + Math.abs(data[p + 1] - prev[p + 1]) + Math.abs(data[p + 2] - prev[p + 2]);
        energy += d;
      }
      energy /= data.length / 4 * 3 * 255;
    }
    prev = new Uint8ClampedArray(data);
    peaks.push({ t, energy });
  }
  return peaks;
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

function pickCutPoints(motion, duration, count) {
  const target = Math.max(3, Math.min(4, count));
  const scored = motion
    .filter((m) => m.t > duration * 0.12 && m.t < duration * 0.88)
    .map((m) => ({ t: m.t, score: 1 / (0.02 + m.energy) }));
  scored.sort((a, b) => b.score - a.score);
  const picks = [];
  for (const s of scored) {
    if (picks.every((p) => Math.abs(p - s.t) > duration / (target + 1) * 0.55)) {
      picks.push(s.t);
      if (picks.length >= target - 1) break;
    }
  }
  while (picks.length < target - 1) {
    picks.push(((picks.length + 1) / target) * duration);
  }
  picks.sort((a, b) => a - b);
  return [0, ...picks, duration];
}

function buildSegments(cuts, duration, motion) {
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i];
    const end = cuts[i + 1];
    const mid = (start + end) / 2;
    const local = motion.filter((m) => m.t >= start && m.t <= end);
    const avg = local.length ? local.reduce((a, m) => a + m.energy, 0) / local.length : 0.05;
    const variance =
      local.length > 1
        ? local.reduce((a, m) => a + (m.energy - avg) ** 2, 0) / local.length
        : 0;
    // Reverse-safe : peu de variance / mouvement doux (pas de gestes directionnels forts)
    const reverseSafe = avg < 0.08 && variance < 0.0025 && end - start >= 0.8;
    segments.push({
      id: i,
      start,
      end,
      mid,
      reverseSafe,
      avgMotion: avg
    });
  }
  if (!segments.length) {
    segments.push({ id: 0, start: 0, end: duration, mid: duration / 2, reverseSafe: false, avgMotion: 0 });
  }
  return segments;
}

function buildAssemblies(segments) {
  const ids = segments.map((s) => s.id);
  const rev = (id) => {
    const s = segments.find((x) => x.id === id);
    return s?.reverseSafe ? { id, reverse: true } : { id, reverse: false };
  };
  const fwd = (id) => ({ id, reverse: false });
  const assemblies = [
    ids.map(fwd),
    [...ids].reverse().map(fwd),
    ids.map(rev),
    interleave(ids).map(fwd),
    shuffleStable(ids).map(rev)
  ];
  return assemblies.map((steps, i) => ({ id: i, steps }));
}

function interleave(ids) {
  const a = [];
  let i = 0;
  let j = ids.length - 1;
  while (i <= j) {
    a.push(ids[i]);
    if (i !== j) a.push(ids[j]);
    i += 1;
    j -= 1;
  }
  return a;
}

function shuffleStable(ids) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = (i * 3 + 1) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Mappe un temps "nettoyé" vers le temps source si keepMap présent. */
export function mapCleanToSource(t, keepMap) {
  if (!keepMap?.length) return t;
  for (const m of keepMap) {
    if (t >= m.dstStart && t <= m.dstEnd + 0.0001) {
      const ratio = (t - m.dstStart) / Math.max(0.0001, m.dstEnd - m.dstStart);
      return m.srcStart + ratio * (m.srcEnd - m.srcStart);
    }
  }
  return t;
}
