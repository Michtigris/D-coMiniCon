/** CRUD capsules via IPC Electron. */

function api() {
  return window.deco;
}

export async function listCapsules() {
  const rows = await api().decoyList();
  return Array.isArray(rows) ? rows : [];
}

export async function saveCapsule({ name, blob, analysis, durationMs }) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return api().decoySave({
    name: String(name || 'Capsule').slice(0, 80),
    mime: blob.type || 'video/webm',
    data: buf,
    analysis: analysis || null,
    durationMs: durationMs || 0
  });
}

export async function renameCapsule(id, name) {
  return api().decoyRename(id, String(name || '').slice(0, 80));
}

export async function updateAnalysis(id, analysis) {
  if (api().decoyUpdateAnalysis) return api().decoyUpdateAnalysis(id, analysis);
  return null;
}

export async function deleteCapsule(id) {
  return api().decoyDelete(id);
}

export async function loadCapsuleBlob(id) {
  const row = await api().decoyRead(id);
  if (!row?.data) return null;
  const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  const blob = new Blob([bytes], { type: row.mime || 'video/webm' });
  return { blob, meta: row };
}
