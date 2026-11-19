/** Labels / ids à ne jamais utiliser pour DécoMiniCon interne. */
const VIRTUAL_LABEL_RE =
  /décominicon|decominicon|obs\s*virtual|virtual\s*cam|vb-?audio|cable\s*(input|output)|voicemeeter|decoy/i;

export function isVirtualDeviceLabel(label = '') {
  return VIRTUAL_LABEL_RE.test(String(label || ''));
}

export function isVirtualDevice(device) {
  if (!device) return false;
  return isVirtualDeviceLabel(device.label) || isVirtualDeviceLabel(device.deviceId);
}

export async function listMediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

export async function realVideoInputs() {
  const all = await listMediaDevices();
  return all.filter((d) => d.kind === 'videoinput' && !isVirtualDevice(d));
}

export async function realAudioInputs() {
  const all = await listMediaDevices();
  return all.filter((d) => d.kind === 'audioinput' && !isVirtualDevice(d));
}

export async function virtualVideoOutputs() {
  const all = await listMediaDevices();
  return all.filter((d) => d.kind === 'videoinput' && /obs\s*virtual|décominicon\s*cam|decominicon\s*cam/i.test(d.label || ''));
}

export async function virtualAudioOutputs() {
  const all = await listMediaDevices();
  return all.filter(
    (d) =>
      d.kind === 'audiooutput' &&
      /cable\s*input|vb-?audio|voicemeeter|décominicon\s*mic|decominicon\s*mic/i.test(d.label || '')
  );
}

export function preferredRealDeviceId(devices, preferredId) {
  if (preferredId && devices.some((d) => d.deviceId === preferredId)) return preferredId;
  return devices[0]?.deviceId || undefined;
}
