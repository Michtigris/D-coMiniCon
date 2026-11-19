/**
 * VAD basique (énergie) + règles d'exclusion parole.
 * Audio jamais lu à l'envers — on coupe des fenêtres temporelles.
 */

const FRAME = 1024;

export function analyzeSpeech(audioBuffer, opts = {}) {
  const sampleRate = audioBuffer.sampleRate || 48000;
  const channel = audioBuffer.getChannelData(0);
  const threshold = opts.threshold ?? 0.02;
  const minSpeechMs = opts.minSpeechMs ?? 180;
  const maxSpeechRatio = opts.maxSpeechRatio ?? 0.35;
  const marginSec = opts.marginSec ?? 1;

  const energies = [];
  for (let i = 0; i + FRAME <= channel.length; i += FRAME) {
    let sum = 0;
    for (let j = 0; j < FRAME; j += 1) {
      const v = channel[i + j];
      sum += v * v;
    }
    energies.push(Math.sqrt(sum / FRAME));
  }

  const frameDur = FRAME / sampleRate;
  const speechFlags = energies.map((e) => e >= threshold);
  const regions = [];
  let start = -1;
  for (let i = 0; i < speechFlags.length; i += 1) {
    if (speechFlags[i] && start < 0) start = i;
    if ((!speechFlags[i] || i === speechFlags.length - 1) && start >= 0) {
      const end = speechFlags[i] && i === speechFlags.length - 1 ? i + 1 : i;
      const durMs = (end - start) * frameDur * 1000;
      if (durMs >= minSpeechMs) {
        regions.push({
          start: Math.max(0, start * frameDur - marginSec),
          end: Math.min(audioBuffer.duration, end * frameDur + marginSec)
        });
      }
      start = -1;
    }
  }

  const merged = mergeRegions(regions);
  const speechSec = merged.reduce((acc, r) => acc + (r.end - r.start), 0);
  const ratio = audioBuffer.duration > 0 ? speechSec / audioBuffer.duration : 0;
  const keep = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor + 0.05) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < audioBuffer.duration - 0.05) keep.push({ start: cursor, end: audioBuffer.duration });

  return {
    regions: merged,
    keep,
    speechRatio: ratio,
    overLimit: ratio > maxSpeechRatio,
    duration: audioBuffer.duration
  };
}

function mergeRegions(regions) {
  if (!regions.length) return [];
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end + 0.15) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/** Applique les fenêtres "keep" à un AudioBuffer (concat). */
export function rebuildAudioWithoutSpeech(audioBuffer, keep) {
  const ctxSampleRate = audioBuffer.sampleRate;
  if (!keep?.length) {
    return {
      buffer: audioBuffer,
      map: [{ srcStart: 0, srcEnd: audioBuffer.duration, dstStart: 0, dstEnd: audioBuffer.duration }]
    };
  }
  let total = 0;
  for (const k of keep) total += Math.max(0, k.end - k.start);
  const frames = Math.max(1, Math.floor(total * ctxSampleRate));
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, frames, ctxSampleRate);
  const out = offline.createBuffer(audioBuffer.numberOfChannels, frames, ctxSampleRate);
  const map = [];
  let dstCursor = 0;
  for (const k of keep) {
    const startFrame = Math.floor(k.start * ctxSampleRate);
    const endFrame = Math.min(audioBuffer.length, Math.floor(k.end * ctxSampleRate));
    const len = Math.max(0, endFrame - startFrame);
    if (len <= 0) continue;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
      const src = audioBuffer.getChannelData(ch).subarray(startFrame, endFrame);
      out.getChannelData(ch).set(src, dstCursor);
    }
    const dstStart = dstCursor / ctxSampleRate;
    const dstEnd = (dstCursor + len) / ctxSampleRate;
    map.push({ srcStart: k.start, srcEnd: k.end, dstStart, dstEnd });
    dstCursor += len;
  }
  return { buffer: out, map };
}
