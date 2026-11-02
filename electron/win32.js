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
    ShowWindow: user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hWnd, void *lpClassName, int nMaxCount)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)'),
    GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vKey)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(void *hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)')
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

module.exports = { sink, raise, leftButtonDown, keyDown, hideForeground };
