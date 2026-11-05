let user32 = null;
let calls = null;

function load() {
  if (calls) return calls;
  const koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  calls = {
    koffi,
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'),
    GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hWnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hWnd)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hWnd, void *lpClassName, int nMaxCount)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vKey)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(void *hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)'),
    keybd_event: user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)')
  };
  return calls;
}

function hwndOf(win) {
  const api = load();
  return api.koffi.decode(win.getNativeWindowHandle(), 'void *');
}

function pointerKey(handle) {
  if (!handle) return '';
  const api = load();
  return api.koffi.address(handle).toString();
}

function readWide(fn, handle) {
  const buffer = Buffer.alloc(512);
  const length = fn(handle, buffer, 256);
  if (!length) return '';
  return buffer.toString('utf16le', 0, length * 2);
}

function sink(win) {
  const api = load();
  const flags = 0x0001 | 0x0002 | 0x0010;
  api.SetWindowPos(hwndOf(win), 1, 0, 0, 0, 0, flags);
}

function raise(win) {
  const api = load();
  const flags = 0x0001 | 0x0002 | 0x0010;
  // HWND_NOTOPMOST (-2) puis HWND_TOP (0) : sort du bas sans rester topmost.
  api.SetWindowPos(hwndOf(win), -2, 0, 0, 0, 0, flags);
  api.SetWindowPos(hwndOf(win), 0, 0, 0, 0, 0, flags);
}

function leftButtonDown() {
  const api = load();
  return (api.GetAsyncKeyState(0x01) & 0x8000) !== 0;
}

function keyDown(vk) {
  const api = load();
  return (api.GetAsyncKeyState(vk) & 0x8000) !== 0;
}

function hideForeground(windows) {
  const api = load();
  const hwnd = api.GetForegroundWindow();
  if (!hwnd) return { ok: false, reason: 'Aucune fenêtre au premier plan.' };
  const ours = new Set(windows.filter(Boolean).map((win) => pointerKey(hwndOf(win))));
  if (ours.has(pointerKey(hwnd))) {
    return { ok: false, reason: 'Passe sur le jeu, puis touche la barre.' };
  }
  const className = readWide(api.GetClassNameW, hwnd);
  const shell = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'MultitaskingViewFrame'];
  if (shell.includes(className)) {
    return { ok: false, reason: 'Pas de fenêtre de jeu au premier plan.' };
  }
  const title = readWide(api.GetWindowTextW, hwnd) || 'Fenêtre';
  api.ShowWindow(hwnd, 6);
  api.PostMessageW(hwnd, 0x0112, 0xf020, 0);
  return { ok: true, title };
}

const KEYEVENTF_KEYUP = 0x0002;

function sendChord(vks) {
  const api = load();
  const codes = (Array.isArray(vks) ? vks : []).map((n) => Number(n) & 0xff).filter((n) => n > 0);
  if (!codes.length) return { ok: false, reason: 'Raccourci vide' };
  for (const vk of codes) api.keybd_event(vk, 0, 0, 0);
  for (let i = codes.length - 1; i >= 0; i -= 1) {
    api.keybd_event(codes[i], 0, KEYEVENTF_KEYUP, 0);
  }
  return { ok: true };
}

function focusByTitle(query) {
  const api = load();
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { ok: false, reason: 'Nom vide' };
  let found = null;
  const cb = api.koffi.register((hwnd) => {
    if (!hwnd || !api.IsWindowVisible(hwnd)) return true;
    const title = readWide(api.GetWindowTextW, hwnd);
    if (!title) return true;
    if (title.toLowerCase().includes(needle)) {
      found = { hwnd, title };
      return false;
    }
    return true;
  }, 'bool __stdcall (void *hwnd, intptr_t lParam)');
  try {
    api.EnumWindows(cb, 0);
  } finally {
    api.koffi.unregister(cb);
  }
  if (!found) return { ok: false, reason: 'Fenêtre introuvable' };
  api.ShowWindow(found.hwnd, 9);
  api.SetForegroundWindow(found.hwnd);
  return { ok: true, title: found.title };
}

module.exports = { sink, raise, leftButtonDown, keyDown, hideForeground, sendChord, focusByTitle };
