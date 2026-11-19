import {
  preferredRealDeviceId,
  realAudioInputs,
  realVideoInputs,
  virtualAudioOutputs,
  virtualVideoOutputs
} from './devices.js';

/**
 * Ouverture des flux réels (jamais les virtuels).
 */

export async function openRealAV(opts = {}) {
  const videos = await realVideoInputs();
  const audios = await realAudioInputs();
  if (!videos.length) throw new Error('Aucune webcam réelle trouvée');
  if (!audios.length) throw new Error('Aucun micro réel trouvé');

  const videoId = preferredRealDeviceId(videos, opts.videoDeviceId);
  const audioId = preferredRealDeviceId(audios, opts.audioDeviceId);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: videoId ? { exact: videoId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: {
      deviceId: audioId ? { exact: audioId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      opts.onTrackEnded?.(track.kind);
    });
  }

  return {
    stream,
    videoDeviceId: videoId,
    audioDeviceId: audioId,
    videoLabel: videos.find((d) => d.deviceId === videoId)?.label || 'Webcam',
    audioLabel: audios.find((d) => d.deviceId === audioId)?.label || 'Micro'
  };
}

export async function probeVirtualDrivers() {
  const cams = await virtualVideoOutputs();
  const outs = await virtualAudioOutputs();
  let native = null;
  try {
    native = await window.deco.decoyProbeDrivers();
  } catch {
    native = { obsVirtualCam: false, vbCable: false };
  }
  return {
    obsVirtualCam: !!(native?.obsVirtualCam || cams.length),
    vbCable: !!(native?.vbCable || outs.length),
    cameraDevices: cams,
    audioDevices: outs,
    help: {
      camera:
        'Installe OBS Studio (Virtual Camera) — Discord / Chrome verront « OBS Virtual Camera ».',
      audio:
        'Installe VB-Audio Cable — choisis « CABLE Input » comme sortie My Decoy / entrée Discord.'
    }
  };
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.onended = null;
      track.stop();
    } catch {
      // ignore
    }
  }
}
