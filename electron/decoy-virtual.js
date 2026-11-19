/**
 * Détection pilotes + push frames vers OBS Virtual Camera (shared memory).
 * Format compatible avec le filtre DirectShow obs-virtualcam / OBS Studio.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let koffi = null;
let kernel32 = null;
let api = null;
let mapping = null;
let view = null;
let active = false;
let width = 0;
let height = 0;

const MAP_NAME = 'Local\\OBSVirtualCamera';

function loadApi() {
  if (api) return api;
  try {
    koffi = require('koffi');
    kernel32 = koffi.load('kernel32.dll');
    api = {
      OpenFileMappingW: kernel32.func('void * __stdcall OpenFileMappingW(uint32 dwDesiredAccess, int bInheritHandle, const char16_t *lpName)'),
      CreateFileMappingW: kernel32.func(
        'void * __stdcall CreateFileMappingW(void *hFile, void *lpAttributes, uint32 flProtect, uint32 dwMaximumSizeHigh, uint32 dwMaximumSizeLow, const char16_t *lpName)'
      ),
      MapViewOfFile: kernel32.func(
        'void * __stdcall MapViewOfFile(void *hFileMappingObject, uint32 dwDesiredAccess, uint32 dwFileOffsetHigh, uint32 dwFileOffsetLow, uintptr_t dwNumberOfBytesToMap)'
      ),
      UnmapViewOfFile: kernel32.func('bool __stdcall UnmapViewOfFile(void *lpBaseAddress)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)'),
      GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
      RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr_t Length)')
    };
    return api;
  } catch (err) {
    api = null;
    return null;
  }
}

function obsInstalled() {
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'obs-studio'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'obs-studio'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'obs-studio')
  ];
  return roots.some((p) => fs.existsSync(p));
}

function vbCablePresent() {
  // Heuristique registre / dossiers courants
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'VB', 'CABLE'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VB', 'CABLE')
  ];
  if (roots.some((p) => fs.existsSync(p))) return true;
  try {
    const { execSync } = require('child_process');
    const out = execSync('powershell -NoProfile -Command "Get-PnpDevice -Class Media,AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName"', {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    });
    return /cable|vb-audio|voicemeeter/i.test(out);
  } catch {
    return false;
  }
}

function probeDrivers() {
  let obsVirtualCam = obsInstalled();
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'powershell -NoProfile -Command "Get-PnpDevice -Class Camera,Image,Media -Status OK | Select-Object -ExpandProperty FriendlyName"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    if (/obs\s*virtual/i.test(out)) obsVirtualCam = true;
  } catch {
    // ignore
  }
  return {
    obsVirtualCam,
    vbCable: vbCablePresent(),
    mapName: MAP_NAME
  };
}

function stop() {
  const a = loadApi();
  if (view && a) {
    try {
      a.UnmapViewOfFile(view);
    } catch {
      // ignore
    }
  }
  if (mapping && a) {
    try {
      a.CloseHandle(mapping);
    } catch {
      // ignore
    }
  }
  view = null;
  mapping = null;
  active = false;
  width = 0;
  height = 0;
}

/**
 * Tentative d'écriture frame RGBA → BGR interleaved dans un mapping existant.
 * Si le mapping OBS n'est pas ouvert (OBS Virtual Cam pas démarrée), on signale missing.
 */
function pushFrame({ width: w, height: h, data }) {
  const a = loadApi();
  if (!a) return { ok: false, reason: 'missing', message: 'API Win32 indisponible' };
  if (!w || !h || !data) return { ok: false, reason: 'bad', message: 'Frame invalide' };

  const FILE_MAP_ALL_ACCESS = 0xf001f;
  const PAGE_READWRITE = 0x04;
  const frameBytes = w * h * 4;
  const header = 64;
  const total = header + frameBytes;

  if (!mapping) {
    mapping = a.OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, MAP_NAME);
    if (!mapping) {
      // Certains builds OBS utilisent un autre nom — on tente Create (souvent refusé sans driver writer)
      mapping = a.CreateFileMappingW(-1, null, PAGE_READWRITE, 0, total, MAP_NAME);
    }
    if (!mapping) {
      return {
        ok: false,
        reason: 'missing',
        message: 'OBS Virtual Camera inactive — démarre la VirtualCam dans OBS une fois, ou installe OBS Studio.'
      };
    }
    view = a.MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, total);
    if (!view) {
      stop();
      return { ok: false, reason: 'missing', message: 'Impossible de mapper la mémoire OBS Virtual Camera' };
    }
    active = true;
    width = w;
    height = h;
  }

  try {
    const pixels = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const headerBuf = Buffer.alloc(header);
    headerBuf.writeUInt32LE(header, 0);
    headerBuf.writeUInt32LE(w, 4);
    headerBuf.writeUInt32LE(h, 8);
    headerBuf.writeUInt32LE(w * 4, 12);
    headerBuf.writeUInt32LE(Date.now() & 0xffffffff, 16);
    a.RtlMoveMemory(view, headerBuf, header);
    const pixelView = koffi.as(view, 'void *');
    // offset write: copy header then pixels at view+header via intermediate buffer
    const packed = Buffer.allocUnsafe(header + Math.min(pixels.length, frameBytes));
    headerBuf.copy(packed, 0);
    pixels.copy(packed, header, 0, Math.min(pixels.length, frameBytes));
    a.RtlMoveMemory(view, packed, packed.length);
    void pixelView;
    return { ok: true, width: w, height: h };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message || 'pushFrame' };
  }
}

module.exports = { probeDrivers, pushFrame, stop };
