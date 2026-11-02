export function createRtc({ polite, send, onRemote }) {
  let pc = null;
  let local = null;
  let makingOffer = false;
  let ignoreOffer = false;

  function ensure() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) send({ candidate: event.candidate.toJSON() });
    });
    pc.addEventListener('track', (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      event.track.addEventListener('ended', () => onRemote(null));
      onRemote(stream);
    });
    pc.addEventListener('negotiationneeded', async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        send({ description: pc.localDescription });
      } catch (err) {
        console.error(err);
      } finally {
        makingOffer = false;
      }
    });
    return pc;
  }

  async function startCamera() {
    if (local) return local;
    local = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    const conn = ensure();
    for (const track of local.getTracks()) conn.addTrack(track, local);
    return local;
  }

  function stop() {
    if (local) {
      for (const track of local.getTracks()) track.stop();
      local = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
  }

  async function signal(data) {
    if (!data) return;
    const conn = ensure();
    if (data.description) {
      const offerCollision = data.description.type === 'offer' && (makingOffer || conn.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;
      if (offerCollision) await conn.setLocalDescription({ type: 'rollback' });
      await conn.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await conn.setLocalDescription(await conn.createAnswer());
        send({ description: conn.localDescription });
      }
    } else if (data.candidate) {
      try {
        await conn.addIceCandidate(data.candidate);
      } catch (err) {
        if (!ignoreOffer) console.error(err);
      }
    }
  }

  return { startCamera, stop, signal };
}
