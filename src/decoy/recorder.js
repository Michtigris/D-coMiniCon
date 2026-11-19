/**
 * Enregistrement A/V synchronisé — uniquement en mode record explicite.
 */

export function createRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;
  let maxMs = 120000;
  let timer = 0;
  let stream = null;

  function recording() {
    return !!(mediaRecorder && mediaRecorder.state === 'recording');
  }

  async function start(liveStream, opts = {}) {
    if (recording()) throw new Error('Enregistrement déjà en cours');
    if (!liveStream) throw new Error('Pas de flux live');
    stream = liveStream;
    chunks = [];
    maxMs = Math.max(15000, Math.min(180000, Number(opts.maxMs) || 120000));
    const mime = pickMime();
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    startedAt = Date.now();
    mediaRecorder.start(250);
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop().catch(() => {});
    }, maxMs);
    return { ok: true, maxMs };
  }

  function elapsedMs() {
    if (!startedAt) return 0;
    return Date.now() - startedAt;
  }

  function stop() {
    return new Promise((resolve, reject) => {
      clearTimeout(timer);
      timer = 0;
      if (!mediaRecorder) {
        resolve(null);
        return;
      }
      const rec = mediaRecorder;
      if (rec.state === 'inactive') {
        mediaRecorder = null;
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const mime = rec.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: mime });
        const durationMs = elapsedMs();
        chunks = [];
        mediaRecorder = null;
        startedAt = 0;
        resolve({ blob, mime, durationMs });
      };
      rec.onerror = () => {
        mediaRecorder = null;
        reject(new Error('Échec enregistrement'));
      };
      try {
        rec.stop();
      } catch (err) {
        mediaRecorder = null;
        reject(err);
      }
    });
  }

  function cancel() {
    clearTimeout(timer);
    timer = 0;
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {
      // ignore
    }
    mediaRecorder = null;
    chunks = [];
    startedAt = 0;
  }

  return { start, stop, cancel, recording, elapsedMs };
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return '';
}
